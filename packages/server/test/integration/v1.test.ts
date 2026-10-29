import { type ApiRequest, contracts, createApiClient } from '@openrows/shared';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { fields, outbox, recordRevisions, type users } from '../../src/db/index.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import {
  addMember,
  createBase,
  createSession,
  createTableWithFields,
  createToken,
  createWorkspace,
} from '../helpers/factories.js';

type User = typeof users.$inferSelect;
/** A JSON answer, of whatever shape: the assertions check it. */
type Json = ReturnType<typeof JSON.parse>;

interface V1Record {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}

/**
 * The REST API v1 end to end as openrows_app: Airtable's shapes over the RecordService,
 * the query engine and the schema services; errors as `{ error: { type, message } }`; tables by
 * name only inside the base in the path; filterByFormula only as SQL; field permissions,
 * revisions and outbox events as for the app's own writes.
 */
describe('REST API v1', () => {
  const t = useTestDb();
  let app: ReturnType<typeof testApp>['app'];
  let owner: User;
  let editor: User;
  let ownerCookie: string;
  let editorCookie: string;
  let workspaceId: string;
  let baseId: string;
  let tableId: string;
  let siblingBaseId: string;

  type Caller = { cookie?: string; bearer?: string };
  const call = async (
    who: Caller,
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; body: Json }> => {
    const headers = new Headers();
    if (who.cookie) headers.set('cookie', `${SESSION_COOKIE}=${who.cookie}`);
    if (who.bearer) headers.set('authorization', `Bearer ${who.bearer}`);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const res = await app.request(path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const asOwner = (method: string, path: string, body?: unknown) =>
    call({ cookie: ownerCookie }, method, path, body);
  const records = () => `/api/v1/${baseId}/Projects`;

  beforeAll(async () => {
    app = testApp({ db: t.appDb }).app;
    const w = await createWorkspace(t.db);
    owner = w.owner;
    workspaceId = w.workspace.id;
    editor = await addMember(t.db, workspaceId, 'editor');
    ownerCookie = await createSession(t.db, owner);
    editorCookie = await createSession(t.db, editor);
    const base = await createBase(t.db, workspaceId, { name: 'Roadmap' });
    baseId = base.id;
    // A sibling base with a table of the same name, and its own "Secret" table.
    const sibling = await createBase(t.db, workspaceId, { name: 'Sibling' });
    siblingBaseId = sibling.id;
    await createTableWithFields(t.db, owner, sibling, 'Projects');
    await createTableWithFields(t.db, owner, sibling, 'Secret');

    const created = await asOwner('POST', `/api/v1/meta/bases/${baseId}/tables`, {
      name: 'Projects',
      description: 'Work in flight',
      fields: [
        { name: 'Name', type: 'singleLineText' },
        { name: 'Notes', type: 'multilineText' },
        { name: 'Points', type: 'number', options: { precision: 0 } },
        {
          name: 'Status',
          type: 'singleSelect',
          options: { choices: [{ name: 'Todo' }, { name: 'Doing' }, { name: 'Done' }] },
        },
        { name: 'Shipped', type: 'checkbox' },
        { name: 'Due', type: 'date' },
        { name: 'Code', type: 'singleLineText' },
      ],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    tableId = created.body.id;
  });

  it('describes bases, tables, fields (Airtable type names) and views', async () => {
    const bases = await asOwner('GET', '/api/v1/meta/bases');
    expect(bases.status).toBe(200);
    expect(bases.body.bases).toEqual(
      expect.arrayContaining([
        { id: baseId, name: 'Roadmap', permissionLevel: 'owner' },
        { id: siblingBaseId, name: 'Sibling', permissionLevel: 'owner' },
      ])
    );
    const editorBases = await call({ cookie: editorCookie }, 'GET', '/api/v1/meta/bases');
    expect(editorBases.body.bases).toContainEqual({
      id: baseId,
      name: 'Roadmap',
      permissionLevel: 'edit',
    });

    const tables = await asOwner('GET', `/api/v1/meta/bases/${baseId}/tables`);
    expect(tables.status).toBe(200);
    const [table] = tables.body.tables;
    expect(table).toMatchObject({ id: tableId, name: 'Projects', description: 'Work in flight' });
    const byName = Object.fromEntries(
      table.fields.map((f: { name: string }) => [f.name, f])
    ) as Record<string, { id: string; type: string; openrowsType: string; options: Json }>;
    expect(table.primaryFieldId).toBe(byName['Name']?.id);
    expect(byName['Notes']).toMatchObject({ type: 'multilineText', openrowsType: 'longText' });
    expect(byName['Status']?.type).toBe('singleSelect');
    expect(byName['Status']?.options.choices.map((c: { name: string }) => c.name)).toEqual([
      'Todo',
      'Doing',
      'Done',
    ]);
    expect(table.views).toEqual([expect.objectContaining({ type: 'grid' })]);
  });

  it('creates, reads, lists, updates, replaces and deletes records by field name', async () => {
    // One record (`fields`), then a batch (`records`); the trailing slash of Airtable's client.
    const one = await asOwner('POST', `${records()}/`, {
      fields: { Name: 'Alpha', Points: 3, Status: 'Todo', Shipped: true, Due: '2026-03-01' },
    });
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(one.body).toEqual({
      id: expect.any(String),
      createdTime: expect.any(String),
      fields: { Name: 'Alpha', Points: 3, Status: 'Todo', Shipped: true, Due: '2026-03-01' },
    });
    const batch = await asOwner('POST', records(), {
      records: [
        { fields: { Name: 'Beta', Points: 5, Status: 'Doing' } },
        { fields: { Name: 'Gamma', Points: 8, Notes: 'Big one' } },
      ],
    });
    expect(batch.status).toBe(200);
    expect(batch.body.records.map((r: V1Record) => r.fields['Name'])).toEqual(['Beta', 'Gamma']);
    // Empty cells are left out, as Airtable does.
    expect(batch.body.records[0].fields).not.toHaveProperty('Shipped');

    const got = await asOwner('GET', `${records()}/${one.body.id}`);
    expect(got.body).toEqual(one.body);
    const byId = await asOwner('GET', `${records()}/${one.body.id}?returnFieldsByFieldId=true`);
    expect(Object.keys(byId.body.fields).every((k) => /^[0-9a-f-]{36}$/.test(k))).toBe(true);
    const text = await asOwner('GET', `${records()}/${one.body.id}?cellFormat=string`);
    expect(text.body.fields).toMatchObject({ Name: 'Alpha', Status: 'Todo' });

    // The table by id works as by name.
    const list = await asOwner('GET', `/api/v1/${baseId}/${tableId}`);
    expect(list.status).toBe(200);
    expect(list.body.records.map((r: V1Record) => r.fields['Name'])).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
    ]);

    // PATCH changes only what's given; PUT clears the rest.
    const patched = await asOwner('PATCH', `${records()}/${one.body.id}`, {
      fields: { Points: 4 },
    });
    expect(patched.body.fields).toMatchObject({ Name: 'Alpha', Points: 4, Status: 'Todo' });
    const replaced = await asOwner('PUT', `${records()}/${one.body.id}`, {
      fields: { Name: 'Alpha 2' },
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body.fields).toEqual({ Name: 'Alpha 2' });

    const many = await asOwner('PATCH', records(), {
      records: batch.body.records.map((r: V1Record) => ({ id: r.id, fields: { Shipped: true } })),
    });
    expect(many.body.records.map((r: V1Record) => r.fields['Shipped'])).toEqual([true, true]);

    const gone = await asOwner('DELETE', `${records()}/${one.body.id}`);
    expect(gone.body).toEqual({ id: one.body.id, deleted: true });
    const ids = batch.body.records.map((r: V1Record) => r.id);
    const goneMany = await asOwner(
      'DELETE',
      `${records()}?${ids.map((id: string) => `records%5B%5D=${id}`).join('&')}`
    );
    expect(goneMany.status).toBe(200);
    expect(goneMany.body.records).toEqual(ids.map((id: string) => ({ id, deleted: true })));
    const after = await asOwner('GET', records());
    expect(after.body.records).toEqual([]);
    const missing = await asOwner('GET', `${records()}/${one.body.id}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatchObject({ type: 'NOT_FOUND', code: 'NOT_FOUND' });
  });

  describe('listing', () => {
    const names: string[] = [];
    beforeAll(async () => {
      const rows = Array.from({ length: 25 }, (_, i) => ({
        fields: {
          Name: `Item ${String(i).padStart(2, '0')}`,
          Points: i,
          Status: ['Todo', 'Doing', 'Done'][i % 3],
          Shipped: i % 2 === 0,
          Code: i % 5 === 0 ? `X-${i}` : '',
          ...(i < 3 ? { Notes: 'Needs review' } : {}),
        },
      }));
      for (let i = 0; i < rows.length; i += 10) {
        const res = await asOwner('POST', `/api/v1/${baseId}/Listing`, {
          records: rows.slice(i, i + 10),
        });
        if (res.status === 404) {
          // The table, made through the API on first use.
          await asOwner('POST', `/api/v1/meta/bases/${baseId}/tables`, {
            name: 'Listing',
            fields: [
              { name: 'Name', type: 'singleLineText' },
              { name: 'Notes', type: 'multilineText' },
              { name: 'Points', type: 'number' },
              {
                name: 'Status',
                type: 'singleSelect',
                options: { choices: [{ name: 'Todo' }, { name: 'Doing' }, { name: 'Done' }] },
              },
              { name: 'Shipped', type: 'checkbox' },
              { name: 'Code', type: 'singleLineText' },
            ],
          });
          i -= 10;
          continue;
        }
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      }
      names.push(...rows.map((r) => r.fields.Name));
    });
    const list = (query: string) => asOwner('GET', `/api/v1/${baseId}/Listing?${query}`);
    const namesOf = (body: { records: V1Record[] }) =>
      body.records.map((r) => r.fields['Name'] as string);

    it('pages with pageSize and offset, up to maxRecords', async () => {
      const first = await list('pageSize=10');
      expect(namesOf(first.body)).toEqual(names.slice(0, 10));
      expect(first.body.offset).toEqual(expect.any(String));
      const second = await list(`pageSize=10&offset=${encodeURIComponent(first.body.offset)}`);
      expect(namesOf(second.body)).toEqual(names.slice(10, 20));
      const capped = await list('pageSize=10&maxRecords=15');
      const rest = await list(`pageSize=10&maxRecords=15&offset=${capped.body.offset}`);
      expect(namesOf(rest.body)).toEqual(names.slice(10, 15));
      expect(rest.body.offset).toBeUndefined();
      expect((await list('pageSize=101')).status).toBe(422);
      const bad = await list('offset=nonsense');
      expect(bad.status).toBe(422);
      expect(bad.body.error.type).toBe('INVALID_REQUEST_UNKNOWN');
    });

    it('sorts, narrows fields and reads a view', async () => {
      const sorted = await list(
        'maxRecords=3&sort%5B0%5D%5Bfield%5D=Points&sort%5B0%5D%5Bdirection%5D=desc&fields%5B%5D=Name&fields%5B%5D=Points'
      );
      expect(sorted.body.records.map((r: V1Record) => r.fields)).toEqual([
        { Name: 'Item 24', Points: 24 },
        { Name: 'Item 23', Points: 23 },
        { Name: 'Item 22', Points: 22 },
      ]);
      const unknown = await list('fields%5B%5D=Nope');
      expect(unknown.status).toBe(422);
      expect(unknown.body.error.message).toContain('Nope');
      const tables = await asOwner('GET', `/api/v1/meta/bases/${baseId}/tables`);
      const view = tables.body.tables.find((x: { name: string }) => x.name === 'Listing').views[0];
      const viaView = await list(`view=${encodeURIComponent(view.name)}&pageSize=2`);
      expect(namesOf(viaView.body)).toEqual(names.slice(0, 2));
      expect((await list('view=Nope')).status).toBe(422);
      // The long-URL form of Airtable's client: the parameters in a POST body.
      const posted = await asOwner('POST', `/api/v1/${baseId}/Listing/listRecords`, {
        sort: [{ field: 'Points', direction: 'desc' }],
        maxRecords: 1,
      });
      expect(namesOf(posted.body)).toEqual(['Item 24']);
    });

    it('filters with filterByFormula as SQL', async () => {
      const where = async (formula: string) => {
        const res = await list(`filterByFormula=${encodeURIComponent(formula)}`);
        expect(res.status, `${formula}: ${JSON.stringify(res.body)}`).toBe(200);
        return namesOf(res.body);
      };
      expect(await where("{Name} = 'Item 03'")).toEqual(['Item 03']);
      expect(await where('AND({Points} >= 20, {Shipped})')).toEqual([
        'Item 20',
        'Item 22',
        'Item 24',
      ]);
      expect(await where("OR({Status} = 'Done', {Points} < 1)")).toHaveLength(9);
      expect(await where('NOT({Points} > 2)')).toEqual(['Item 00', 'Item 01', 'Item 02']);
      expect(await where("FIND('review', {Notes})")).toEqual(['Item 00', 'Item 01', 'Item 02']);
      expect(await where("{Code} != ''")).toEqual([
        'Item 00',
        'Item 05',
        'Item 10',
        'Item 15',
        'Item 20',
      ]);
      expect(await where('{Code} = BLANK()')).toHaveLength(20);
      expect(await where('AND(Points > 22, NOT(Shipped))')).toEqual(['Item 23']);
      expect(await where('5 < {Points}')).toHaveLength(19);
      expect(await where('TRUE()')).toHaveLength(25);
    });

    it('refuses formulas that would not run as SQL with 422 INVALID_FILTER_BY_FORMULA', async () => {
      for (const formula of [
        "LOWER({Name}) = 'item 01'",
        '{Points} * 2 > 10',
        'REGEX_MATCH({Name}, ".*")',
        '{Points} = {Points}',
        '{Nope} = 1',
        'AND(',
        "{Shipped} < 'x'",
      ]) {
        const res = await list(`filterByFormula=${encodeURIComponent(formula)}`);
        expect(res.status, formula).toBe(422);
        expect(res.body.error.type, formula).toBe('INVALID_FILTER_BY_FORMULA');
        expect(res.body.error.message, formula).toEqual(expect.any(String));
      }
    });
  });

  it('upserts on fieldsToMergeOn and typecasts', async () => {
    const path = `/api/v1/${baseId}/Projects`;
    await asOwner('POST', path, { fields: { Name: 'Upsert me', Code: 'U-1', Points: 1 } });
    const res = await asOwner('PATCH', path, {
      performUpsert: { fieldsToMergeOn: ['Code'] },
      records: [
        { fields: { Code: 'U-1', Points: 2 } },
        { fields: { Code: 'U-2', Name: 'New one' } },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.records.map((r: V1Record) => r.fields)).toEqual([
      { Name: 'Upsert me', Code: 'U-1', Points: 2 },
      { Name: 'New one', Code: 'U-2' },
    ]);
    expect(res.body.updatedRecords).toEqual([res.body.records[0].id]);
    expect(res.body.createdRecords).toEqual([res.body.records[1].id]);
    // Without typecast an unknown option is a 422; with it, a new option.
    const plain = await asOwner('POST', path, { fields: { Name: 'T', Status: 'Blocked' } });
    expect(plain.status).toBe(422);
    const cast = await asOwner('POST', path, {
      fields: { Name: 'T', Status: 'Blocked' },
      typecast: true,
    });
    expect(cast.status).toBe(200);
    expect(cast.body.fields['Status']).toBe('Blocked');
    // A token without schema.bases:write can't add options, whatever its user's role.
    const { token } = await createToken(t.db, owner, {
      scopes: ['data.records:read', 'data.records:write'],
      workspaceIds: [workspaceId],
    });
    const viaToken = await call({ bearer: token }, 'POST', path, {
      fields: { Name: 'T', Status: 'Waiting' },
      typecast: true,
    });
    expect(viaToken.status).toBe(422);
    expect(viaToken.body.error).toMatchObject({
      type: 'INVALID_MULTIPLE_CHOICE_OPTIONS',
      code: 'TYPECAST_FORBIDDEN',
    });
  });

  it('caps batches at 10 records and refuses unknown field names', async () => {
    const eleven = Array.from({ length: 11 }, () => ({ fields: { Name: 'x' } }));
    const big = await asOwner('POST', records(), { records: eleven });
    expect(big.status).toBe(422);
    expect(big.body.error.type).toBe('INVALID_REQUEST_UNKNOWN');
    const unknown = await asOwner('POST', records(), { fields: { Nope: 1 } });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.message).toContain('Unknown field name: "Nope"');
    const computed = await asOwner('POST', records(), { fields: { Name: 'x', Points: 'many' } });
    expect(computed.status).toBe(422);
  });

  it('names tables only inside the base in the path', async () => {
    // The sibling base's "Secret" table: not in this base.
    const res = await asOwner('GET', `/api/v1/${baseId}/Secret`);
    expect(res.status).toBe(404);
    expect(res.body.error.type).toBe('NOT_FOUND');
    // "Projects" exists in both: each base answers its own.
    const sibling = await asOwner('GET', `/api/v1/${siblingBaseId}/Projects`);
    const own = await asOwner('GET', `/api/v1/${baseId}/Projects`);
    expect(sibling.status).toBe(200);
    expect(sibling.body.records.map((r: V1Record) => r.id)).not.toEqual(
      expect.arrayContaining(own.body.records.map((r: V1Record) => r.id))
    );
    // The sibling's table by id under this base's path: 404.
    const tables = await asOwner('GET', `/api/v1/meta/bases/${siblingBaseId}/tables`);
    const secretId = tables.body.tables.find((x: { name: string }) => x.name === 'Secret').id;
    expect((await asOwner('GET', `/api/v1/${baseId}/${secretId}`)).status).toBe(404);
    // Another tenant can't reach the base at all.
    const other = await createWorkspace(t.db);
    const otherCookie = await createSession(t.db, other.owner);
    const cross = await call({ cookie: otherCookie }, 'GET', `/api/v1/${baseId}/Projects`);
    expect(cross.status).toBe(404);
    const anonymous = await call({}, 'GET', `/api/v1/${baseId}/Projects`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.type).toBe('AUTHENTICATION_REQUIRED');
  });

  it('applies field permissions: a locked field is 403 through v1 too', async () => {
    const path = `/api/v1/${baseId}/Projects`;
    const made = await asOwner('POST', path, { fields: { Name: 'Locked row', Points: 1 } });
    const [points] = await t.db
      .select()
      .from(fields)
      .where(sql`${fields.tableId} = ${tableId} AND ${fields.name} = 'Points'`);
    if (!points) throw new Error('no Points field');
    await t.db
      .update(fields)
      .set({ permissions: { edit: { level: 'creators' } } })
      .where(eq(fields.id, points.id));
    const asEditor = (method: string, p: string, body?: unknown) =>
      call({ cookie: editorCookie }, method, p, body);
    const patch = await asEditor('PATCH', `${path}/${made.body.id}`, { fields: { Points: 2 } });
    expect(patch.status).toBe(403);
    expect(patch.body.error).toMatchObject({
      type: 'INVALID_PERMISSIONS',
      code: 'EDIT_RESTRICTED',
    });
    const create = await asEditor('POST', path, { fields: { Name: 'x', Points: 2 } });
    expect(create.status).toBe(403);
    // PUT would clear Points, which the editor may not change.
    const put = await asEditor('PUT', `${path}/${made.body.id}`, { fields: { Name: 'Renamed' } });
    expect(put.status).toBe(403);
    // Other fields stay open; the owner still edits Points.
    const ok = await asEditor('PATCH', `${path}/${made.body.id}`, { fields: { Name: 'Renamed' } });
    expect(ok.status).toBe(200);
    expect(
      (await asOwner('PATCH', `${path}/${made.body.id}`, { fields: { Points: 9 } })).status
    ).toBe(200);
    await t.db
      .update(fields)
      .set({ permissions: { edit: { level: 'editors' } } })
      .where(eq(fields.id, points.id));
  });

  it('writes revisions and outbox events like the app', async () => {
    const path = `/api/v1/${baseId}/Projects`;
    const made = await asOwner('POST', path, { fields: { Name: 'Tracked' } });
    await asOwner('PATCH', `${path}/${made.body.id}`, { fields: { Name: 'Tracked 2' } });
    const events = await t.db
      .select({ kind: outbox.kind })
      .from(outbox)
      .where(sql`${outbox.payload}->>'recordId' = ${made.body.id}`)
      .orderBy(outbox.id);
    expect(events.map((e) => e.kind)).toEqual(['record.created', 'record.updated']);
    const revisions = await t.db
      .select({ kind: recordRevisions.kind, actorId: recordRevisions.actorId })
      .from(recordRevisions)
      .where(eq(recordRevisions.recordId, made.body.id));
    expect(revisions.map((r) => r.kind).sort()).toEqual(['created', 'updated']);
    expect(revisions.every((r) => r.actorId === owner.id)).toBe(true);
  });

  it('lists and posts comments', async () => {
    const path = `/api/v1/${baseId}/Projects`;
    const made = await asOwner('POST', path, { fields: { Name: 'Discussed' } });
    const first = await asOwner('POST', `${path}/${made.body.id}/comments`, { text: 'First' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      text: 'First',
      author: { id: owner.id, email: owner.email },
      lastUpdatedTime: null,
    });
    await asOwner('POST', `${path}/${made.body.id}/comments`, { text: 'Second' });
    const list = await asOwner('GET', `${path}/${made.body.id}/comments?pageSize=1`);
    expect(list.body.comments.map((x: { text: string }) => x.text)).toEqual(['Second']);
    expect(list.body.offset).toBe('1');
    const next = await asOwner('GET', `${path}/${made.body.id}/comments?offset=1`);
    expect(next.body.comments.map((x: { text: string }) => x.text)).toEqual(['First']);
    expect(next.body.offset).toBeNull();
  });

  it('follows token scopes and grants', async () => {
    const read = await createToken(t.db, owner, {
      scopes: ['data.records:read', 'schema.bases:read'],
      baseIds: [baseId],
    });
    const asRead = (method: string, path: string, body?: unknown) =>
      call({ bearer: read.token }, method, path, body);
    expect((await asRead('GET', records())).status).toBe(200);
    const write = await asRead('POST', records(), { fields: { Name: 'x' } });
    expect(write.status).toBe(403);
    expect(write.body.error.type).toBe('INVALID_PERMISSIONS');
    // Outside its grants: 404, and the base list leaves the sibling out.
    expect((await asRead('GET', `/api/v1/${siblingBaseId}/Projects`)).status).toBe(404);
    const bases = await asRead('GET', '/api/v1/meta/bases');
    expect(bases.body.bases.map((b: { id: string }) => b.id)).toEqual([baseId]);
    // Schema writes need schema.bases:write.
    const field = await asRead('POST', `/api/v1/meta/bases/${baseId}/tables/Projects/fields`, {
      name: 'Extra',
      type: 'number',
    });
    expect(field.status).toBe(403);
  });

  it('creates and renames fields', async () => {
    const made = await asOwner('POST', `/api/v1/meta/bases/${baseId}/tables/Projects/fields`, {
      name: 'Tags',
      type: 'multipleSelects',
      options: { choices: [{ name: 'a' }, { name: 'b' }] },
    });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    expect(made.body).toMatchObject({ name: 'Tags', type: 'multipleSelects' });
    const renamed = await asOwner(
      'PATCH',
      `/api/v1/meta/bases/${baseId}/tables/Projects/fields/${made.body.id}`,
      { name: 'Labels', description: 'Free labels' }
    );
    expect(renamed.body).toMatchObject({ name: 'Labels', description: 'Free labels' });
    const unknown = await asOwner('POST', `/api/v1/meta/bases/${baseId}/tables/Projects/fields`, {
      name: 'X',
      type: 'externalSyncSource',
    });
    expect(unknown.status).toBe(422);
    // A field of another table, under this table's path: 404.
    const listing = await asOwner('GET', `/api/v1/meta/bases/${baseId}/tables`);
    const other = listing.body.tables.find((x: { name: string }) => x.name === 'Listing');
    const wrong = await asOwner(
      'PATCH',
      `/api/v1/meta/bases/${baseId}/tables/Projects/fields/${other.fields[0].id}`,
      { name: 'Nope' }
    );
    expect(wrong.status).toBe(404);
    const values = await asOwner('POST', records(), { fields: { Name: 'Tagged', Labels: ['a'] } });
    expect(values.body.fields['Labels']).toEqual(['a']);
  });

  it('answers what the shared contracts say, endpoint by endpoint', async () => {
    // The typed client parses every answer with the contract's response schema.
    const api = createApiClient(contracts, async ({ method, url, body }: ApiRequest) => {
      const res = await call({ cookie: ownerCookie }, method, url, body);
      if (res.status >= 400) throw new Error(`${method} ${url}: ${JSON.stringify(res.body)}`);
      return { status: res.status, data: res.body };
    });
    const t1 = { baseId, tableIdOrName: 'Projects' };
    expect((await api.v1Meta.bases({})).bases.length).toBeGreaterThan(0);
    const { tables } = await api.v1Meta.tables({ params: { baseId } });
    const made = await api.v1Meta.createTable({
      params: { baseId },
      body: { name: 'Contracts', fields: [{ name: 'Title', type: 'number' }] },
    });
    expect(made.fields[0]).toMatchObject({ name: 'Title', type: 'number' });
    expect(made.primaryFieldId).toBe(made.fields[0]?.id);
    expect(tables.length).toBeGreaterThan(0);
    const field = await api.v1Meta.createField({
      params: { baseId, tableIdOrName: 'Contracts' },
      body: { name: 'Body', type: 'singleLineText' },
    });
    await api.v1Meta.updateField({
      params: { baseId, tableIdOrName: made.id, fieldId: field.id },
      body: { name: 'Text' },
    });
    const created = await api.v1Records.create({
      params: t1,
      body: { records: [{ fields: { Name: 'C1' } }, { fields: { Name: 'C2' } }] },
    });
    const ids = 'records' in created ? created.records.map((r) => r.id) : [];
    const [c1 = '', c2 = ''] = ids;
    await api.v1Records.list({ params: t1 });
    await api.v1Records.listPost({ params: t1, body: { pageSize: 1 } });
    await api.v1Records.get({ params: { ...t1, recordId: c1 } });
    await api.v1Records.update({
      params: { ...t1, recordId: c1 },
      body: { fields: { Points: 1 } },
    });
    await api.v1Records.replace({
      params: { ...t1, recordId: c1 },
      body: { fields: { Name: 'C1' } },
    });
    await api.v1Records.updateMany({
      params: t1,
      body: { records: [{ id: c1, fields: { Points: 2 } }] },
    });
    // PUT of a batch clears what it leaves out.
    const put = await api.v1Records.replaceMany({
      params: t1,
      body: { records: [{ id: c1, fields: { Name: 'C1 again' } }] },
    });
    expect(put.records[0]?.fields).toEqual({ Name: 'C1 again' });
    await api.v1Comments.create({ params: { ...t1, recordId: c1 }, body: { text: 'Hi' } });
    expect((await api.v1Comments.list({ params: { ...t1, recordId: c1 } })).comments).toHaveLength(
      1
    );
    await api.v1Records.delete({ params: { ...t1, recordId: c2 } });
  });

  it('is in the OpenAPI document with both security schemes', async () => {
    const res = await app.request('/api/openapi.json');
    const doc: Json = await res.json();
    expect(doc.paths['/api/v1/{baseId}/{tableIdOrName}']).toHaveProperty('get');
    expect(doc.paths['/api/v1/meta/bases']).toHaveProperty('get');
    expect(doc.components.securitySchemes).toMatchObject({
      session: { type: 'apiKey', in: 'cookie' },
      personalAccessToken: { type: 'http', scheme: 'bearer' },
    });
    expect(
      doc.paths['/api/v1/{baseId}/{tableIdOrName}'].get.responses['404'].content
    ).toHaveProperty('application/json');
  });
});
