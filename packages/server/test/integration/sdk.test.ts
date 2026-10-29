import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type ServerType, serve } from '@hono/node-server';
import { OpenRows, OpenRowsError } from '@openrows/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { users } from '../../src/db/index.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { createBase, createToken, createWorkspace } from '../helpers/factories.js';

type User = typeof users.$inferSelect;
type App = ReturnType<typeof testApp>['app'];

/** Serves `app` on a random local port; answers its origin and the requests it got. */
async function listen(app: App) {
  const recorded: string[] = [];
  let server: ServerType | undefined;
  const port = await new Promise<number>((resolve) => {
    server = serve(
      {
        fetch: (req: Request) => {
          recorded.push(`${req.method} ${new URL(req.url).pathname}`);
          return app.fetch(req);
        },
        port: 0,
        hostname: '127.0.0.1',
      },
      (info: AddressInfo) => resolve(info.port)
    );
  });
  const close = () => new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  return { origin: `http://127.0.0.1:${port}`, recorded, close };
}

/**
 * @openrows/sdk against the real server over HTTP: every method of the client, with a
 * personal access token, the batching to 10, typecast, errors as OpenRowsError with the request
 * id, and the 429 retry after Retry-After.
 */
describe('@openrows/sdk against /api/v1', () => {
  const t = useTestDb();
  let owner: User;
  let workspaceId: string;
  let baseId: string;
  let apiKey: string;
  let http: Awaited<ReturnType<typeof listen>>;
  let hookPort: number;
  let hook: Server;
  const delivered: string[] = [];
  let openrows: OpenRows;

  beforeAll(async () => {
    hook = createServer((req, res) => {
      delivered.push(String(req.headers['x-openrows-event-type']));
      req.resume();
      req.on('end', () => res.writeHead(204).end());
    });
    hookPort = await new Promise<number>((resolve) =>
      hook.listen(0, '127.0.0.1', () => resolve((hook.address() as AddressInfo).port))
    );
    const { app } = testApp({
      db: t.appDb,
      config: {
        outbound: { allowHttp: true, extraPorts: [hookPort], allow: ['127.0.0.1'], deny: [] },
      },
    });
    http = await listen(app);
    const w = await createWorkspace(t.db);
    owner = w.owner;
    workspaceId = w.workspace.id;
    baseId = (await createBase(t.db, workspaceId, { name: 'SDK base' })).id;
    ({ token: apiKey } = await createToken(t.db, owner, { workspaceIds: [workspaceId] }));
    openrows = new OpenRows({ apiKey, baseUrl: http.origin });
  });

  afterAll(async () => {
    await http.close();
    await new Promise<void>((done) => hook.close(() => done()));
  });

  it('lists bases and manages tables and fields', async () => {
    expect(await openrows.bases.list()).toEqual([
      { id: baseId, name: 'SDK base', permissionLevel: 'owner' },
    ]);
    const made = await openrows.tables(baseId).create({
      name: 'Projects',
      fields: [
        { name: 'Name', type: 'singleLineText' },
        { name: 'Code', type: 'singleLineText' },
        { name: 'Points', type: 'number' },
      ],
    });
    expect(made.primaryFieldId).toBe(made.fields[0]?.id);

    const projects = openrows.base(baseId).table('Projects');
    const status = await projects.fields.create({
      name: 'State',
      type: 'singleSelect',
      options: { choices: [{ name: 'Todo' }] },
    });
    expect(status).toMatchObject({ type: 'singleSelect', openrowsType: 'singleSelect' });
    const renamed = await projects.fields.update(status.id, {
      name: 'Status',
      description: 'Where it is',
    });
    expect(renamed).toMatchObject({ name: 'Status', description: 'Where it is' });

    const tables = await openrows.base(baseId).tables.list();
    const table = tables.find((tb) => tb.id === made.id);
    expect(table?.fields.map((f) => f.name)).toEqual(['Name', 'Code', 'Points', 'Status']);
    expect(table?.views.length).toBeGreaterThan(0);
  });

  it('creates, reads, updates, replaces, upserts and deletes records, 10 per request', async () => {
    const projects = openrows.table<{ Name: string; Code: string; Points: number; Status: string }>(
      baseId,
      'Projects'
    );
    const before = http.recorded.length;
    const created = await projects.create(
      Array.from({ length: 23 }, (_, i) => ({
        fields: { Name: `P${String(i).padStart(2, '0')}`, Points: i },
      }))
    );
    expect(created.map((r) => r.fields.Name)).toEqual(
      Array.from({ length: 23 }, (_, i) => `P${String(i).padStart(2, '0')}`)
    );
    expect(http.recorded.slice(before)).toEqual(Array(3).fill(`POST /api/v1/${baseId}/Projects`));
    const one = await projects.create({ Name: 'Solo', Code: 'S-1' });
    expect(one.fields).toEqual({ Name: 'Solo', Code: 'S-1' });

    // select(): all pages, each page, the first page, for await; sort, fields, formula, view.
    const query = projects.select({
      pageSize: 10,
      sort: [{ field: 'Points', direction: 'desc' }],
      fields: ['Name', 'Points'],
      filterByFormula: '{Points} >= 0',
    });
    const all = await query.all();
    expect(all).toHaveLength(23);
    expect(all[0]?.fields).toEqual({ Name: 'P22', Points: 22 });
    const sizes: number[] = [];
    await query.eachPage((records) => {
      sizes.push(records.length);
    });
    expect(sizes).toEqual([10, 10, 3]);
    expect(await query.firstPage()).toHaveLength(10);
    let seen = 0;
    for await (const record of query) {
      expect(record.fields.Code).toBeUndefined();
      seen++;
    }
    expect(seen).toBe(23);
    const [view] = (await openrows.tables(baseId).list()).find((tb) => tb.name === 'Projects')
      ?.views ?? [{ name: '' }];
    expect(await projects.select({ view: view?.name, maxRecords: 5 }).all()).toHaveLength(5);

    const found = await projects.find(one.id);
    expect(found).toMatchObject({ id: one.id, fields: { Name: 'Solo', Code: 'S-1' } });
    const byId = await projects.find(one.id, { returnFieldsByFieldId: true });
    expect(Object.keys(byId.fields).every((k) => /^[0-9a-f-]{36}$/.test(k))).toBe(true);

    const patched = await projects.update(one.id, { Points: 7 });
    expect(patched.fields).toEqual({ Name: 'Solo', Code: 'S-1', Points: 7 });
    const replaced = await projects.replace(one.id, { Name: 'Solo again' });
    expect(replaced.fields).toEqual({ Name: 'Solo again' });
    const updated = await projects.update(
      created.slice(0, 12).map((r) => ({ id: r.id, fields: { Code: `C-${r.fields.Points}` } }))
    );
    expect(updated.map((r) => r.fields.Code)).toEqual(
      Array.from({ length: 12 }, (_, i) => `C-${i}`)
    );
    const replacedMany = await projects.replace([
      { id: created[0]?.id ?? '', fields: { Name: 'First' } },
    ]);
    expect(replacedMany[0]?.fields).toEqual({ Name: 'First' });

    const upserted = await projects.upsert(
      [{ fields: { Code: 'C-1', Points: 100 } }, { fields: { Code: 'NEW', Name: 'New one' } }],
      { fieldsToMergeOn: ['Code'] }
    );
    expect(upserted.updatedRecords).toEqual([created[1]?.id]);
    expect(upserted.createdRecords).toHaveLength(1);
    expect(upserted.records.map((r) => r.fields.Points)).toEqual([100, undefined]);

    // typecast adds a select option the field doesn't have yet.
    await expect(projects.create({ Name: 'T', Status: 'Blocked' })).rejects.toMatchObject({
      status: 422,
    });
    const cast = await projects.create({ Name: 'T', Status: 'Blocked' }, { typecast: true });
    expect(cast.fields.Status).toBe('Blocked');

    const deleted = await projects.destroy(created.slice(0, 12).map((r) => r.id));
    expect(deleted).toEqual(created.slice(0, 12).map((r) => ({ id: r.id, deleted: true })));
    expect(await projects.destroy(one.id)).toEqual({ id: one.id, deleted: true });
    await expect(projects.find(one.id)).rejects.toMatchObject({ status: 404, type: 'NOT_FOUND' });
  });

  it('lists and posts comments', async () => {
    const tasks = openrows.table(baseId, 'Projects');
    const record = await tasks.create({ Name: 'Discussed' });
    const comments = tasks.comments(record.id);
    const first = await comments.create('First!');
    expect(first).toMatchObject({ text: 'First!', author: { id: owner.id } });
    for (let i = 0; i < 3; i++) await comments.create(`Reply ${i}`);
    const page = await comments.page({ pageSize: 2 });
    expect(page.comments.map((c) => c.text)).toEqual(['Reply 2', 'Reply 1']);
    expect(page.offset).toEqual(expect.any(String));
    expect((await comments.all()).map((c) => c.text)).toEqual([
      'Reply 2',
      'Reply 1',
      'Reply 0',
      'First!',
    ]);
  });

  it('manages webhooks', async () => {
    const hooks = openrows.webhooks(baseId);
    const created = await hooks.create({
      url: `http://127.0.0.1:${hookPort}/hook`,
      events: ['record.created'],
    });
    expect(created.secret).toEqual(expect.any(String));
    const listed = await hooks.list();
    expect(listed.map((h) => h.id)).toEqual([created.id]);
    expect(listed[0]).not.toHaveProperty('secret');
    const updated = await hooks.update(created.id, { description: 'CRM', rotateSecret: true });
    expect(updated.description).toBe('CRM');
    expect(updated.secret).not.toBe(created.secret);
    const ping = await hooks.ping(created.id);
    expect(ping).toMatchObject({ eventType: 'ping', success: true, responseStatus: 204 });
    expect(delivered).toContain('ping');
    expect((await hooks.deliveries(created.id, { limit: 5 })).map((d) => d.id)).toEqual([ping.id]);
    await hooks.delete(created.id);
    expect(await openrows.base(baseId).webhooks.list()).toEqual([]);
  });

  it('throws OpenRowsError with the type, code and request id', async () => {
    const error = await openrows
      .table(baseId, 'Projects')
      .select({ filterByFormula: 'LOWER({Name}) = "x"' })
      .firstPage()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenRowsError);
    expect(error).toMatchObject({
      status: 422,
      type: 'INVALID_FILTER_BY_FORMULA',
      code: 'INVALID_FILTER_BY_FORMULA',
      requestId: expect.stringMatching(/.+/),
      request: `POST /api/v1/${baseId}/Projects/listRecords`,
    });
    await expect(openrows.table(baseId, 'Nope').select().all()).rejects.toMatchObject({
      status: 404,
      type: 'NOT_FOUND',
    });

    // A read-only token can't write; a bad token isn't signed in.
    const { token } = await createToken(t.db, owner, {
      scopes: ['data.records:read'],
      workspaceIds: [workspaceId],
    });
    const reader = new OpenRows({ apiKey: token, baseUrl: `${http.origin}/api` });
    expect(await reader.table(baseId, 'Projects').select({ maxRecords: 1 }).all()).toHaveLength(1);
    await expect(reader.table(baseId, 'Projects').create({ Name: 'x' })).rejects.toMatchObject({
      status: 403,
      type: 'INVALID_PERMISSIONS',
    });
    const stranger = new OpenRows({ apiKey: 'or_pat_nope', baseUrl: http.origin });
    await expect(stranger.bases.list()).rejects.toMatchObject({ status: 401 });
  });

  it('retries a 429 after Retry-After', async () => {
    // One request a second per base, no burst: the second request waits for its Retry-After.
    const limited = testApp({
      db: t.appDb,
      env: {
        API_RATE_LIMIT_BASE: '1',
        API_RATE_LIMIT_BASE_BURST: '1',
        API_RATE_LIMIT_TOKEN: '100',
        API_RATE_LIMIT_TOKEN_BURST: '100',
      },
    });
    const server = await listen(limited.app);
    try {
      const client = new OpenRows({ apiKey, baseUrl: server.origin });
      const waits: number[] = [];
      const sleep = client.http.sleep;
      client.http.sleep = (ms) => {
        waits.push(ms);
        return sleep(ms);
      };
      const table = client.table(baseId, 'Projects');
      await table.select({ maxRecords: 1 }).firstPage();
      await table.select({ maxRecords: 1 }).firstPage();
      expect(waits).toEqual([1000]);
      expect(server.recorded).toHaveLength(3);

      const impatient = new OpenRows({ apiKey, baseUrl: server.origin, maxRetries: 0 });
      await expect(
        impatient.table(baseId, 'Projects').select({ maxRecords: 1 }).firstPage()
      ).rejects.toMatchObject({
        status: 429,
        type: 'TOO_MANY_REQUESTS',
        limit: 'base',
        retryAfter: 1,
      });
    } finally {
      await server.close();
    }
  });
});
