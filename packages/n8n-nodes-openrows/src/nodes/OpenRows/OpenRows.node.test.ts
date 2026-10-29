import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FakeApi, fakeApi, TOKEN } from '../../../test/fake-api';
import { OpenRowsApi } from '../../credentials/OpenRowsApi.credentials';
import {
  executeContext,
  httpHelper,
  loadOptionsContext,
  resolveExpression,
  rl,
  type Sent,
} from '../../testing/harness';
import { OpenRows } from './OpenRows.node';

/**
 * Every operation of the OpenRows node against a fake of the REST API v1 over real HTTP: the
 * requests it sends (paths, bodies, batching to 10, the bearer token) and the items it returns.
 */
describe('OpenRows node', () => {
  let api: FakeApi;
  let credentials: { baseUrl: string; apiKey: string };
  const node = new OpenRows();

  beforeAll(async () => {
    api = fakeApi();
    credentials = { baseUrl: `${await api.start()}/`, apiKey: TOKEN };
  });
  afterAll(() => api.stop());
  beforeEach(() => {
    api.requests.length = 0;
    for (const rows of api.records.values()) rows.length = 0;
  });

  const target = () => ({ resource: 'record', base: rl(api.baseId), table: rl(api.tasks.id) });
  const run = (
    params: Record<string, unknown> | ((i: number) => Record<string, unknown>),
    items = [{ json: {} }],
    continueOnFail = false
  ) => node.execute.call(executeContext({ params, items, credentials, continueOnFail }));
  const defineBelow = (value: Record<string, unknown>) => ({
    mappingMode: 'defineBelow',
    value,
    matchingColumns: [],
    schema: [],
  });

  describe('credentials', () => {
    const cred = new OpenRowsApi();

    it('sends the token as a bearer header and tests with GET /api/v1/meta/bases', async () => {
      const req = cred.test.request;
      const baseURL = resolveExpression(String(req.baseURL), credentials);
      expect(baseURL).toBe(credentials.baseUrl.replace(/\/$/, ''));
      const sent: Sent[] = [];
      const res = (await httpHelper(credentials, sent)('openRowsApi', {
        baseURL,
        url: String(req.url),
      })) as { bases: { id: string }[] };
      expect(res.bases.map((b) => b.id)).toContain(api.baseId);
      expect(sent[0]?.url).toMatch(/[^/]\/api\/v1\/meta\/bases$/);
      expect(api.requests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    });

    it('keeps the token in a password field', () => {
      const apiKey = cred.properties.find((p) => p.name === 'apiKey');
      expect(apiKey?.typeOptions?.password).toBe(true);
    });
  });

  describe('create', () => {
    it('creates one record per item, 10 per request, in order', async () => {
      const items = Array.from({ length: 12 }, (_, i) => ({ json: { n: i } }));
      const [out] = await run(
        (i) => ({
          ...target(),
          operation: 'create',
          columns: defineBelow({ Name: `Task ${i}`, Estimate: i }),
          options: { typecast: true },
        }),
        items
      );
      expect(out?.map((o) => o.json['Name'])).toEqual(items.map((_, i) => `Task ${i}`));
      expect(out?.map((o) => o.pairedItem)).toEqual(items.map((_, i) => ({ item: i })));
      expect(out?.[0]?.json).toMatchObject({ Name: 'Task 0', Estimate: 0 });
      expect(typeof out?.[0]?.json['id']).toBe('string');
      expect(typeof out?.[0]?.json['createdTime']).toBe('string');
      const posts = api.requests.filter((r) => r.method === 'POST');
      expect(posts.map((r) => (r.body as { records: unknown[] }).records.length)).toEqual([10, 2]);
      expect(posts[0]?.path).toBe(`/api/v1/${api.baseId}/${api.tasks.id}`);
      expect(posts[0]?.body).toMatchObject({ typecast: true });
    });

    it('auto-maps the item to the writable fields only', async () => {
      const [out] = await run(
        {
          ...target(),
          operation: 'create',
          columns: {
            mappingMode: 'autoMapInputData',
            value: null,
            matchingColumns: [],
            schema: [
              {
                id: 'Name',
                displayName: 'Name',
                display: true,
                required: false,
                defaultMatch: false,
              },
              {
                id: 'Done',
                displayName: 'Done',
                display: true,
                required: false,
                defaultMatch: false,
              },
              {
                id: 'Notes',
                displayName: 'Notes',
                display: true,
                required: false,
                defaultMatch: false,
                removed: true,
              },
            ],
          },
        },
        [{ json: { Name: 'Auto', Done: true, Notes: 'dropped', id: 'old', Score: 3 } }]
      );
      expect(api.requests.at(-1)?.body).toEqual({
        records: [{ fields: { Name: 'Auto', Done: true } }],
        typecast: false,
      });
      expect(out?.[0]?.json).toMatchObject({ Name: 'Auto', Done: true });
    });

    it('starts a new request when the table changes between items', async () => {
      await run(
        (i) => ({
          resource: 'record',
          base: rl(api.baseId),
          table: rl(i === 1 ? 'Numbers only' : api.tasks.id, i === 1 ? 'id' : 'list'),
          operation: 'create',
          columns: defineBelow(i === 1 ? { Count: 1 } : { Name: 'x' }),
        }),
        [{ json: {} }, { json: {} }, { json: {} }]
      );
      expect(api.requests.map((r) => r.path)).toEqual([
        `/api/v1/${api.baseId}/${api.tasks.id}`,
        `/api/v1/${api.baseId}/Numbers%20only`,
        `/api/v1/${api.baseId}/${api.tasks.id}`,
      ]);
    });
  });

  describe('get', () => {
    it('gets a record by id with its cells by name', async () => {
      const [record] = api.seed(api.tasks, { Name: 'Ship it', Done: true });
      const [out] = await run({ ...target(), operation: 'get', recordId: record?.id });
      expect(out).toEqual([
        {
          json: { Name: 'Ship it', Done: true, id: record?.id, createdTime: record?.createdTime },
          pairedItem: { item: 0 },
        },
      ]);
    });

    it("refuses what isn't a record id before calling the API", async () => {
      await expect(run({ ...target(), operation: 'get', recordId: '../meta' })).rejects.toThrow(
        NodeOperationError
      );
      expect(api.requests).toEqual([]);
    });

    it("throws the API's message, code and request id on a 404", async () => {
      const error = await run({
        ...target(),
        operation: 'get',
        recordId: '0195f0c2-0000-7000-8000-000000000000',
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NodeApiError);
      expect((error as NodeApiError).httpCode).toBe('404');
      expect((error as NodeApiError).message).toBe('Could not find record');
      expect((error as NodeApiError).description).toContain('req-404');
      expect(JSON.stringify(error)).not.toContain(TOKEN);
    });

    it('returns the error as an item with continue on fail', async () => {
      const [record] = api.seed(api.tasks, { Name: 'Kept' });
      const [out] = await run(
        (i) => ({
          ...target(),
          operation: 'get',
          recordId: i === 0 ? '0195f0c2-0000-7000-8000-000000000000' : record?.id,
        }),
        [{ json: {} }, { json: {} }],
        true
      );
      expect(out?.[0]).toEqual({
        json: { error: 'Could not find record' },
        pairedItem: { item: 0 },
      });
      expect(out?.[1]?.json['Name']).toBe('Kept');
    });
  });

  describe('get many', () => {
    it('pages through every record with return all', async () => {
      api.seed(api.tasks, ...Array.from({ length: 230 }, (_, i) => ({ Name: `R${i}` })));
      const [out] = await run({ ...target(), operation: 'getAll', returnAll: true });
      expect(out).toHaveLength(230);
      const bodies = api.requests.map((r) => r.body as { pageSize: number; offset?: string });
      expect(bodies.map((b) => [b.pageSize, b.offset])).toEqual([
        [100, undefined],
        [100, '100'],
        [100, '200'],
      ]);
    });

    it('stops at the limit and sends the filter, fields, sort and view', async () => {
      api.seed(api.tasks, ...Array.from({ length: 30 }, (_, i) => ({ Name: `R${i}` })));
      const view = api.tasks.views[0]?.id;
      const [out] = await run({
        ...target(),
        operation: 'getAll',
        returnAll: false,
        limit: 5,
        options: {
          filterByFormula: "{Status} = 'Todo'",
          fields: ['Name', 'Status'],
          sort: { rule: [{ field: 'Name', direction: 'desc' }] },
          view,
        },
      });
      expect(out).toHaveLength(5);
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]).toMatchObject({
        method: 'POST',
        path: `/api/v1/${api.baseId}/${api.tasks.id}/listRecords`,
        body: {
          pageSize: 5,
          filterByFormula: "{Status} = 'Todo'",
          fields: ['Name', 'Status'],
          sort: [{ field: 'Name', direction: 'desc' }],
          view,
        },
      });
    });

    it('waits out a 429 and sends the request again', async () => {
      api.seed(api.tasks, { Name: 'After the wait' });
      api.answerNext(
        429,
        { error: { type: 'TOO_MANY_REQUESTS', message: 'Slow down.' } },
        { 'retry-after': '0' }
      );
      const [out] = await run({ ...target(), operation: 'getAll', returnAll: true });
      expect(out?.map((o) => o.json['Name'])).toEqual(['After the wait']);
      expect(api.requests).toHaveLength(2);
    });

    it('gives up after repeated 429s', async () => {
      for (let n = 0; n < 4; n++) {
        api.answerNext(
          429,
          { error: { type: 'TOO_MANY_REQUESTS', message: 'Slow down.' } },
          { 'retry-after': '0' }
        );
      }
      await expect(run({ ...target(), operation: 'getAll', returnAll: true })).rejects.toThrow(
        'Slow down.'
      );
      expect(api.requests).toHaveLength(4);
    });

    it('refuses a credential URL that is not http(s)', async () => {
      const ctx = executeContext({
        params: { ...target(), operation: 'getAll', returnAll: true },
        credentials: { baseUrl: 'file:///etc', apiKey: TOKEN },
      });
      await expect(node.execute.call(ctx)).rejects.toThrow('http(s) URL');
    });
  });

  describe('search', () => {
    it('searches the text fields when none are picked, with the filter', async () => {
      api.seed(api.tasks, { Name: 'Found' });
      const [out] = await run({
        ...target(),
        operation: 'search',
        searchText: 'say "hi"',
        searchFields: [],
        returnAll: false,
        limit: 10,
        options: { filterByFormula: '{Done}' },
      });
      expect(out?.map((o) => o.json['Name'])).toEqual(['Found']);
      const list = api.requests.find((r) => r.path.endsWith('/listRecords'));
      expect((list?.body as { filterByFormula?: string } | undefined)?.filterByFormula).toBe(
        'AND({Done}, OR(SEARCH("say \\"hi\\"", {Name}), SEARCH("say \\"hi\\"", {Notes}), SEARCH("say \\"hi\\"", {Email})))'
      );
    });

    it('searches the picked fields only', async () => {
      await run({
        ...target(),
        operation: 'search',
        searchText: 'x',
        searchFields: ['Na}me'],
        returnAll: true,
      });
      expect(api.requests.map((r) => r.path)).toEqual([
        `/api/v1/${api.baseId}/${api.tasks.id}/listRecords`,
      ]);
      expect(api.requests[0]?.body).toMatchObject({ filterByFormula: 'SEARCH("x", {Na\\}me})' });
    });

    it('refuses empty or long search text and tables without text fields', async () => {
      const search = (extra: Record<string, unknown>) =>
        run({ ...target(), operation: 'search', returnAll: true, ...extra });
      await expect(search({ searchText: '  ' })).rejects.toThrow('Enter some text');
      await expect(search({ searchText: 'x'.repeat(201) })).rejects.toThrow('200 characters');
      await expect(search({ searchText: 'x', table: rl('Numbers only', 'id') })).rejects.toThrow(
        'no text fields'
      );
    });
  });

  describe('update', () => {
    it('updates the picked fields of records by id, batched', async () => {
      const seeded = api.seed(api.tasks, { Name: 'A', Done: false }, { Name: 'B', Done: false });
      const [out] = await run(
        (i) => ({
          ...target(),
          operation: 'update',
          recordId: seeded[i]?.id,
          columns: defineBelow({ Done: true }),
        }),
        [{ json: {} }, { json: {} }]
      );
      expect(out?.map((o) => [o.json['Name'], o.json['Done']])).toEqual([
        ['A', true],
        ['B', true],
      ]);
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]).toMatchObject({
        method: 'PATCH',
        body: {
          records: [
            { id: seeded[0]?.id, fields: { Done: true } },
            { id: seeded[1]?.id, fields: { Done: true } },
          ],
        },
      });
    });
  });

  describe('create or update', () => {
    it('upserts on the matching fields', async () => {
      const [existing] = api.seed(api.tasks, { Email: 'ada@example.com', Name: 'Ada' });
      const [out] = await run(
        (i) => ({
          ...target(),
          operation: 'upsert',
          columns: {
            ...defineBelow(
              i === 0
                ? { Email: 'ada@example.com', Name: 'Ada L.' }
                : { Email: 'bob@example.com', Name: 'Bob' }
            ),
            matchingColumns: ['Email'],
          },
        }),
        [{ json: {} }, { json: {} }]
      );
      expect(out?.[0]?.json).toMatchObject({ id: existing?.id, Name: 'Ada L.' });
      expect(out?.[1]?.json).toMatchObject({ Name: 'Bob' });
      expect(api.requests[0]?.body).toMatchObject({
        performUpsert: { fieldsToMergeOn: ['Email'] },
      });
      expect(api.records.get(api.tasks.id)).toHaveLength(2);
    });

    it('needs 1 to 3 matching fields, each with a value', async () => {
      const upsert = (matchingColumns: string[], value: Record<string, unknown>) =>
        run({
          ...target(),
          operation: 'upsert',
          columns: { ...defineBelow(value), matchingColumns },
        });
      await expect(upsert([], { Name: 'x' })).rejects.toThrow('1 to 3 fields');
      await expect(upsert(['A', 'B', 'C', 'D'], { Name: 'x' })).rejects.toThrow('1 to 3 fields');
      await expect(upsert(['Email'], { Name: 'x' })).rejects.toThrow('No value for "Email"');
      expect(api.requests).toEqual([]);
    });
  });

  describe('delete', () => {
    it('deletes records by id, 10 per request', async () => {
      const seeded = api.seed(api.tasks, ...Array.from({ length: 11 }, () => ({ Name: 'x' })));
      const [out] = await run(
        (i) => ({ ...target(), operation: 'delete', recordId: seeded[i]?.id }),
        seeded.map(() => ({ json: {} }))
      );
      expect(out?.map((o) => o.json)).toEqual(seeded.map((r) => ({ id: r.id, deleted: true })));
      expect(api.requests.map((r) => [r.method, r.query.split('&').length])).toEqual([
        ['DELETE', 10],
        ['DELETE', 1],
      ]);
      expect(api.requests[1]?.query).toBe(`records[]=${seeded[10]?.id}`);
      expect(api.records.get(api.tasks.id)).toEqual([]);
    });

    it('fails every item of a refused batch with continue on fail', async () => {
      const [kept] = api.seed(api.tasks, { Name: 'kept' });
      const missing = '0195f0c2-0000-7000-8000-000000000000';
      const [out] = await run(
        (i) => ({ ...target(), operation: 'delete', recordId: i === 0 ? missing : kept?.id }),
        [{ json: {} }, { json: {} }],
        true
      );
      expect(out?.map((o) => o.json)).toEqual([
        { error: 'Could not find record' },
        { error: 'Could not find record' },
      ]);
    });
  });

  describe('pickers', () => {
    const load = (params: Record<string, unknown>) => loadOptionsContext({ params, credentials });

    it('lists bases and tables, filtered', async () => {
      const bases = await node.methods.listSearch.searchBases.call(load({}), 'road');
      expect(bases.results).toEqual([{ name: 'Roadmap', value: api.baseId }]);
      const tables = await node.methods.listSearch.searchTables.call(
        load({ base: rl(api.baseId) })
      );
      expect(tables.results.map((t) => t.name)).toEqual(['Tasks', 'Numbers only']);
      expect(
        (await node.methods.listSearch.searchTables.call(load({ base: rl('') }))).results
      ).toEqual([]);
    });

    it('loads fields, search fields and views of the picked table', async () => {
      const ctx = load({ base: rl(api.baseId), table: rl('Tasks', 'id') });
      expect((await node.methods.loadOptions.getFields.call(ctx)).map((o) => o.value)).toContain(
        'Score'
      );
      expect(
        (await node.methods.loadOptions.getSearchFields.call(ctx)).map((o) => o.value)
      ).toEqual(['Name', 'Notes', 'Email']);
      expect(await node.methods.loadOptions.getViews.call(ctx)).toEqual([
        { name: 'Grid', value: api.tasks.views[0]?.id },
      ]);
    });

    it('maps the writable fields with their types; upserts match on plain ones', async () => {
      const ctx = load({ base: rl(api.baseId), table: rl(api.tasks.id) });
      const { fields } = await node.methods.resourceMapping.getColumns.call(ctx);
      expect(fields.map((f) => [f.id, f.type])).toEqual([
        ['Name', 'string'],
        ['Notes', 'string'],
        ['Email', 'string'],
        ['Estimate', 'number'],
        ['Done', 'boolean'],
        ['Due', 'dateTime'],
        ['Status', 'options'],
        ['Tags', 'array'],
      ]);
      expect(fields.find((f) => f.id === 'Status')?.options).toEqual([
        { name: 'Todo', value: 'Todo' },
        { name: 'Shipped', value: 'Shipped' },
      ]);
      expect(fields.every((f) => !f.canBeUsedToMatch)).toBe(true);
      const upsert = await node.methods.resourceMapping.getColumnsWithMatch.call(ctx);
      expect(upsert.fields.filter((f) => f.canBeUsedToMatch).map((f) => f.id)).toEqual([
        'Name',
        'Email',
        'Estimate',
        'Done',
        'Due',
        'Status',
      ]);
      const none = await node.methods.resourceMapping.getColumns.call(load({}));
      expect(none).toEqual({ fields: [], emptyFieldsNotice: 'Pick a base and a table first' });
    });
  });

  it('describes a community node with the record operations', () => {
    const operation = node.description.properties.find((p) => p.name === 'operation');
    expect(operation?.options?.map((o) => ('value' in o ? o.value : undefined)).sort()).toEqual([
      'create',
      'delete',
      'get',
      'getAll',
      'search',
      'update',
      'upsert',
    ]);
    expect(node.description.credentials).toEqual([{ name: 'openRowsApi', required: true }]);
  });
});
