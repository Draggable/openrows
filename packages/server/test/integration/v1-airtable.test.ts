import type { AddressInfo } from 'node:net';
import { type ServerType, serve } from '@hono/node-server';
import Airtable from 'airtable';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { users } from '../../src/db/index.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import {
  createBase,
  createTableWithFields,
  createToken,
  createWorkspace,
} from '../helpers/factories.js';

type User = typeof users.$inferSelect;

/**
 * Airtable compatibility: the official `airtable` npm client, pointed at a real HTTP
 * server with `endpointUrl` (`<app>/api`) and `apiVersion: '1.0.0'` (its URLs are
 * `/v<major>/<base>/<table>`), lists, creates, updates, replaces and deletes records with a
 * personal access token. The requests it made are recorded and checked against Airtable's
 * endpoints, so a change of either side shows here.
 */
describe('the airtable npm client against /api/v1', () => {
  const t = useTestDb();
  let server: ServerType;
  let endpointUrl: string;
  let owner: User;
  let baseId: string;
  let apiKey: string;
  const recorded: string[] = [];

  beforeAll(async () => {
    const { app } = testApp({ db: t.appDb });
    const w = await createWorkspace(t.db);
    owner = w.owner;
    const base = await createBase(t.db, w.workspace.id);
    baseId = base.id;
    await createTableWithFields(t.db, owner, base, 'Tasks');
    ({ token: apiKey } = await createToken(t.db, owner, { workspaceIds: [w.workspace.id] }));
    const port = await new Promise<number>((resolve) => {
      server = serve(
        {
          fetch: (req: Request) => {
            const url = new URL(req.url);
            recorded.push(`${req.method} ${url.pathname}`);
            return app.fetch(req);
          },
          port: 0,
          hostname: '127.0.0.1',
        },
        (info: AddressInfo) => resolve(info.port)
      );
    });
    endpointUrl = `http://127.0.0.1:${port}/api`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  const client = () =>
    new Airtable({ apiKey, endpointUrl, apiVersion: '1.0.0', noRetryIfRateLimited: true });

  it('lists, creates, updates, replaces and deletes records', async () => {
    const table = client().base(baseId)('Tasks');

    const created = await table.create([
      { fields: { Name: 'One', Notes: 'first' } },
      { fields: { Name: 'Two' } },
    ]);
    expect(created.map((r) => r.get('Name'))).toEqual(['One', 'Two']);
    const three = await table.create({ Name: 'Three' });
    expect(three.getId()).toMatch(/^[0-9a-f-]{36}$/);

    // Two pages of two, sorted, only the Name field.
    const all = await table
      .select({ pageSize: 2, sort: [{ field: 'Name', direction: 'desc' }], fields: ['Name'] })
      .all();
    expect(all.map((r) => r.get('Name'))).toEqual(['Two', 'Three', 'One']);
    expect(all[2]?.get('Notes')).toBeUndefined();
    const filtered = await table.select({ filterByFormula: "{Name} = 'Two'" }).firstPage();
    expect(filtered.map((r) => r.getId())).toEqual([created[1]?.getId()]);

    const found = await table.find(three.getId());
    expect(found.fields).toEqual({ Name: 'Three' });
    expect(found._rawJson.createdTime).toEqual(expect.any(String));

    const [one, two] = created.map((r) => r.getId()) as [string, string];
    const updated = await table.update([{ id: one, fields: { Notes: 'changed' } }]);
    expect(updated[0]?.fields).toEqual({ Name: 'One', Notes: 'changed' });
    const patched = await table.update(two, { Notes: 'second' });
    expect(patched.fields).toEqual({ Name: 'Two', Notes: 'second' });
    const replaced = await table.replace(one, { Name: 'One again' });
    expect(replaced.fields).toEqual({ Name: 'One again' });

    const deleted = await table.destroy([one, two]);
    expect(deleted.map((r) => r.getId())).toEqual([one, two]);
    const last = await table.destroy(three.getId());
    expect(last.getId()).toBe(three.getId());
    expect(await table.select().all()).toEqual([]);

    // Errors arrive as the client's AirtableError, with Airtable's types.
    await expect(table.find(three.getId())).rejects.toMatchObject({
      error: 'NOT_FOUND',
      statusCode: 404,
    });
    await expect(
      table.select({ filterByFormula: 'LOWER({Name}) = "one"' }).firstPage()
    ).rejects.toMatchObject({ error: 'INVALID_FILTER_BY_FORMULA', statusCode: 422 });
    await expect(client().base(baseId)('Nope').select().firstPage()).rejects.toMatchObject({
      statusCode: 404,
    });

    const ids = new Map<string, string>([
      [baseId, ':base'],
      [one, ':one'],
      [two, ':two'],
      [three.getId(), ':three'],
    ]);
    const normalized = recorded.map((line) =>
      line.replace(/[0-9a-f-]{36}/g, (id) => ids.get(id) ?? ':other')
    );
    expect(normalized).toEqual([
      'POST /api/v1/:base/Tasks/',
      'POST /api/v1/:base/Tasks/',
      'GET /api/v1/:base/Tasks',
      'GET /api/v1/:base/Tasks',
      'GET /api/v1/:base/Tasks',
      'GET /api/v1/:base/Tasks/:three',
      'PATCH /api/v1/:base/Tasks/',
      'PATCH /api/v1/:base/Tasks/:two',
      'PUT /api/v1/:base/Tasks/:one',
      'DELETE /api/v1/:base/Tasks',
      'DELETE /api/v1/:base/Tasks/:three',
      'GET /api/v1/:base/Tasks',
      'GET /api/v1/:base/Tasks/:three',
      'GET /api/v1/:base/Tasks',
      'GET /api/v1/:base/Nope',
    ]);
  });

  it('is refused without a valid token', async () => {
    const table = new Airtable({
      apiKey: 'or_pat_nope_nope',
      endpointUrl,
      apiVersion: '1.0.0',
    }).base(baseId)('Tasks');
    await expect(table.select().firstPage()).rejects.toMatchObject({
      error: 'AUTHENTICATION_REQUIRED',
      statusCode: 401,
    });
  });
});
