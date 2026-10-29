import { describe, expect, it } from 'vitest';
import { connect, jsonResponse, mockFetch, parsed, TEST_KEY, text } from '../test/helpers.js';
import {
  capped,
  formulaField,
  formulaString,
  MAX_OUTPUT_CHARS,
  searchFormula,
  TOOL_SCOPES,
} from './tools.js';

const BASE = '0195f1a0-0000-7000-8000-000000000001';
const REC = '0195f1a0-0000-7000-8000-0000000000aa';
const REC2 = '0195f1a0-0000-7000-8000-0000000000bb';
const TABLES = {
  tables: [
    {
      id: '0195f1a0-0000-7000-8000-0000000000t1',
      name: 'Tasks',
      primaryFieldId: 'f1',
      fields: [
        { id: 'f1', name: 'Name', type: 'singleLineText', openrowsType: 'singleLineText' },
        { id: 'f2', name: 'Notes', type: 'multilineText', openrowsType: 'longText' },
        { id: 'f3', name: 'Estimate', type: 'number', openrowsType: 'number' },
      ],
      views: [{ id: 'v1', name: 'Grid', type: 'grid' }],
    },
  ],
};
const record = (id: string, fields: Record<string, unknown>) => ({
  id,
  createdTime: '2026-10-27T00:00:00.000Z',
  fields,
});

describe('the MCP tools', () => {
  it('lists every tool, with read-only and destructive annotations', async () => {
    const { client, close } = await connect(mockFetch({}).fetch);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(TOOL_SCOPES).sort());
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of ['list_bases', 'describe_base', 'list_records', 'get_record']) {
      expect(byName[name]?.annotations?.readOnlyHint, name).toBe(true);
    }
    expect(byName['delete_records']?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(byName['create_records']?.annotations?.destructiveHint).toBe(false);
    for (const tool of tools) {
      expect(tool.description, tool.name).toContain(
        TOOL_SCOPES[tool.name as keyof typeof TOOL_SCOPES]
      );
    }
    await close();
  });

  it('offers only the tools the given scopes allow', async () => {
    const { client, call, close } = await connect(mockFetch({}).fetch, [
      'schema.bases:read',
      'data.records:read',
    ]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'describe_base',
      'get_record',
      'list_bases',
      'list_records',
    ]);
    const res = await call('create_records', {
      baseId: BASE,
      table: 'Tasks',
      records: [{ fields: { Name: 'x' } }],
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/create_records not found/);
    await close();
  });

  it('lists bases with the token', async () => {
    const api = mockFetch({
      'GET /api/v1/meta/bases': () =>
        jsonResponse(200, { bases: [{ id: BASE, name: 'Roadmap', permissionLevel: 'create' }] }),
    });
    const { call, close } = await connect(api.fetch);
    expect(parsed(await call('list_bases'))).toEqual({
      bases: [{ id: BASE, name: 'Roadmap', permissionLevel: 'create' }],
    });
    expect(api.requests[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_KEY}`);
    await close();
  });

  it('describes a base, or one table of it', async () => {
    const api = mockFetch({
      [`GET /api/v1/meta/bases/${BASE}/tables`]: () => jsonResponse(200, TABLES),
    });
    const { call, close } = await connect(api.fetch);
    expect(parsed(await call('describe_base', { baseId: BASE }))).toEqual(TABLES);
    expect(parsed(await call('describe_base', { baseId: BASE, table: 'Tasks' }))).toEqual(TABLES);
    const missing = await call('describe_base', { baseId: BASE, table: 'Nope' });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain('Tables: Tasks');
    await close();
  });

  it('lists records with a filter, a limit and paging', async () => {
    const api = mockFetch({
      [`POST /api/v1/${BASE}/Tasks/listRecords`]: () =>
        jsonResponse(200, { records: [record(REC, { Name: 'Ship' })], offset: 'next-page' }),
    });
    const { call, close } = await connect(api.fetch);
    const res = await call('list_records', {
      baseId: BASE,
      table: 'Tasks',
      filterByFormula: "{Status} = 'Done'",
      sort: [{ field: 'Name', direction: 'desc' }],
      fields: ['Name'],
      limit: 5,
      offset: 'prev',
    });
    expect(parsed(res)).toEqual({ records: [record(REC, { Name: 'Ship' })], offset: 'next-page' });
    expect(api.requests[0]?.body).toEqual({
      pageSize: 5,
      filterByFormula: "{Status} = 'Done'",
      fields: ['Name'],
      sort: [{ field: 'Name', direction: 'desc' }],
      offset: 'prev',
    });
    await close();
  });

  it('searches the text fields, combined with the filter', async () => {
    const api = mockFetch({
      [`GET /api/v1/meta/bases/${BASE}/tables`]: () => jsonResponse(200, TABLES),
      [`POST /api/v1/${BASE}/Tasks/listRecords`]: () => jsonResponse(200, { records: [] }),
    });
    const { call, close } = await connect(api.fetch);
    await call('list_records', {
      baseId: BASE,
      table: 'Tasks',
      search: 'say "hi"',
      filterByFormula: '{Estimate} > 3',
    });
    expect(api.requests[1]?.body).toEqual({
      pageSize: 20,
      filterByFormula:
        'AND({Estimate} > 3, OR(SEARCH("say \\"hi\\"", {Name}), SEARCH("say \\"hi\\"", {Notes})))',
    });
    await call('list_records', { baseId: BASE, table: 'Tasks', search: 'x', searchFields: ['A'] });
    expect(api.requests.at(-1)?.body).toEqual({
      pageSize: 20,
      filterByFormula: 'SEARCH("x", {A})',
    });
    await close();
  });

  it('gets, creates, updates and deletes records and comments, as the REST API v1', async () => {
    const api = mockFetch({
      [`GET /api/v1/${BASE}/Tasks/${REC}`]: () => jsonResponse(200, record(REC, { Name: 'A' })),
      [`POST /api/v1/${BASE}/Tasks`]: (r) =>
        jsonResponse(200, {
          records: (r.body as { records: { fields: object }[] }).records.map((x, i) =>
            record([REC, REC2][i] ?? REC, x.fields as Record<string, unknown>)
          ),
        }),
      [`PATCH /api/v1/${BASE}/Tasks`]: (r) =>
        jsonResponse(200, {
          records: (r.body as { records: { id: string; fields: object }[] }).records.map((x) =>
            record(x.id, x.fields as Record<string, unknown>)
          ),
        }),
      [`DELETE /api/v1/${BASE}/Tasks`]: (r) =>
        jsonResponse(200, {
          records: r.url.searchParams.getAll('records[]').map((id) => ({ id, deleted: true })),
        }),
      [`POST /api/v1/${BASE}/Tasks/${REC}/comments`]: (r) =>
        jsonResponse(200, {
          id: 'c1',
          author: { id: 'u1', name: 'Ada' },
          text: (r.body as { text: string }).text,
          createdTime: '2026-10-27T00:00:00.000Z',
          lastUpdatedTime: null,
        }),
    });
    const { call, close } = await connect(api.fetch);
    const args = { baseId: BASE, table: 'Tasks' };

    expect(parsed(await call('get_record', { ...args, recordId: REC }))).toEqual({
      record: record(REC, { Name: 'A' }),
    });

    const created = await call('create_records', {
      ...args,
      records: [{ fields: { Name: 'A' } }, { fields: { Name: 'B' } }],
      typecast: true,
    });
    expect(parsed(created)['records']).toHaveLength(2);
    expect(api.requests.at(-1)?.body).toEqual({
      records: [{ fields: { Name: 'A' } }, { fields: { Name: 'B' } }],
      typecast: true,
    });

    await call('update_records', { ...args, records: [{ id: REC, fields: { Name: 'Z' } }] });
    expect(api.requests.at(-1)?.body).toEqual({ records: [{ id: REC, fields: { Name: 'Z' } }] });

    expect(parsed(await call('delete_records', { ...args, recordIds: [REC, REC2] }))).toEqual({
      records: [
        { id: REC, deleted: true },
        { id: REC2, deleted: true },
      ],
    });

    const comment = await call('add_comment', { ...args, recordId: REC, text: 'Looks good' });
    expect(parsed(comment)['comment']).toMatchObject({ text: 'Looks good' });
    await close();
  });

  it('refuses bad input before calling the API', async () => {
    const api = mockFetch({});
    const { call, close } = await connect(api.fetch);
    const tooMany = Array.from({ length: 11 }, () => ({ fields: { Name: 'x' } }));
    for (const [tool, args] of [
      ['create_records', { baseId: BASE, table: 'Tasks', records: tooMany }],
      ['create_records', { baseId: BASE, table: 'Tasks', records: [] }],
      ['get_record', { baseId: 'not-a-uuid', table: 'Tasks', recordId: REC }],
      ['delete_records', { baseId: BASE, table: 'Tasks', recordIds: ['1 OR 1=1'] }],
      ['list_records', { baseId: BASE, table: 'Tasks', limit: 101 }],
      ['add_comment', { baseId: BASE, table: 'Tasks', recordId: REC, text: '   ' }],
      ['update_records', { baseId: BASE, table: 'Tasks', records: [{ fields: {} }] }],
    ] as const) {
      const res = await call(tool, args);
      expect(res.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
    }
    expect(api.requests).toEqual([]);
    await close();
  });

  it('reports API errors the agent can act on, without the token', async () => {
    const api = mockFetch({
      [`POST /api/v1/${BASE}/Tasks`]: () =>
        jsonResponse(403, {
          error: {
            type: 'FORBIDDEN',
            message: `This personal access token needs the data.records:write scope (${TEST_KEY}).`,
          },
        }),
      [`DELETE /api/v1/${BASE}/Tasks`]: () =>
        jsonResponse(
          429,
          { error: { type: 'RATE_LIMITED', message: 'Too many requests.' } },
          { 'retry-after': '120' }
        ),
    });
    const { call, close } = await connect(api.fetch);
    const res = await call('create_records', {
      baseId: BASE,
      table: 'Tasks',
      records: [{ fields: { Name: 'x' } }],
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('403 FORBIDDEN');
    expect(text(res)).toContain('data.records:write');
    expect(text(res)).toContain('Retrying will not help');
    expect(text(res)).not.toContain(TEST_KEY);
    const limited = await call('delete_records', {
      baseId: BASE,
      table: 'Tasks',
      recordIds: [REC],
    });
    expect(text(limited)).toContain('wait 120 s');
    await close();
  });
});

describe('answer size', () => {
  it('cuts long texts, then leaves records out, saying so', () => {
    const long = 'x'.repeat(150_000);
    const cut = JSON.parse(text(capped({ records: [{ fields: { a: long } }] }, 'records')));
    expect(cut.records[0].fields.a).toMatch(/^x{5000}… \[cut: 150000 characters in all\]$/);

    const many = Array.from({ length: 100 }, (_, i) => ({ id: i, fields: { a: 'y'.repeat(400) } }));
    const res = capped({ records: [...many, ...many, ...many, ...many], offset: 'o' }, 'records');
    const out = text(res);
    expect(out.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    const body = JSON.parse(out);
    expect(body.records.length).toBeLessThan(400);
    expect(body.truncated).toMatch(/were left out/);
    // Records left out would be skipped by the next page's offset: it's dropped.
    expect(body.offset).toBeUndefined();
  });
});

describe('formulas', () => {
  it('quotes text and field names', () => {
    expect(formulaString('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
    expect(formulaField('Odd } name\\')).toBe('{Odd \\} name\\\\}');
    expect(searchFormula('q', ['A'])).toBe('SEARCH("q", {A})');
  });
});
