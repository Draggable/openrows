import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type ServerType, serve } from '@hono/node-server';
import { OpenRowsApi } from '@openrows/n8n-nodes-openrows/dist/credentials/OpenRowsApi.credentials.js';
import { OpenRows } from '@openrows/n8n-nodes-openrows/dist/nodes/OpenRows/OpenRows.node.js';
import { OpenRowsTrigger } from '@openrows/n8n-nodes-openrows/dist/nodes/OpenRows/OpenRowsTrigger.node.js';
import {
  executeContext,
  hookContext,
  httpHelper,
  loadOptionsContext,
  resolveExpression,
  rl,
  webhookContext,
} from '@openrows/n8n-nodes-openrows/dist/testing/harness.js';
import { sql } from 'drizzle-orm';
import type { IDataObject } from 'n8n-workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCipher } from '../../src/auth/crypto.js';
import { outbox } from '../../src/db/index.js';
import { createLogger } from '../../src/lib/logger.js';
import { createSafeFetch, outboundPolicy } from '../../src/lib/safe-fetch/index.js';
import { deliverWebhook } from '../../src/webhooks/deliver.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { createBase, createToken, createWorkspace } from '../helpers/factories.js';

type App = ReturnType<typeof testApp>['app'];

const ENCRYPTION_KEY = 'n8n-test-encryption-key-0123456789abcdef';

/** Serves `app` on a random local port. */
async function listen(app: App) {
  let server: ServerType | undefined;
  const port = await new Promise<number>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) =>
      resolve(info.port)
    );
  });
  const close = () => new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  return { origin: `http://127.0.0.1:${port}`, close };
}

interface Received {
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/**
 * The n8n community node against the real server over HTTP: the credential test, the
 * pickers, every record operation through /api/v1 with a personal access token, refusals (scope,
 * other tenant), and the trigger registering a webhook, verifying a real signed delivery
 * of a record created by the node, refusing a tampered one, and removing the webhook.
 */
describe('@openrows/n8n-nodes-openrows against /api/v1', () => {
  const t = useTestDb();
  const logger = createLogger({ level: 'silent' });
  const cipher = createCipher(ENCRYPTION_KEY, 'webhook-secret');
  const received: Received[] = [];
  let hook: Server;
  let hookPort: number;
  let http: Awaited<ReturnType<typeof listen>>;
  let workspaceId: string;
  let baseId: string;
  let otherBaseId: string;
  let tableId: string;
  let credentials: { baseUrl: string; apiKey: string };
  let readOnly: { baseUrl: string; apiKey: string };
  const node = new OpenRows();
  const trigger = new OpenRowsTrigger();
  const outbound = () => ({
    allowHttp: true,
    extraPorts: [hookPort],
    allow: ['127.0.0.1'],
    deny: [],
  });

  beforeAll(async () => {
    hook = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(200).end('OK');
      });
    });
    hookPort = await new Promise<number>((resolve) =>
      hook.listen(0, '127.0.0.1', () => resolve((hook.address() as AddressInfo).port))
    );
    const { app } = testApp({
      db: t.appDb,
      config: { outbound: outbound(), encryptionKey: ENCRYPTION_KEY },
    });
    http = await listen(app);
    const w = await createWorkspace(t.db);
    workspaceId = w.workspace.id;
    baseId = (await createBase(t.db, workspaceId, { name: 'CRM' })).id;
    const other = await createWorkspace(t.db);
    otherBaseId = (await createBase(t.db, other.workspace.id, { name: 'Theirs' })).id;
    const { token } = await createToken(t.db, w.owner, { workspaceIds: [workspaceId] });
    credentials = { baseUrl: `${http.origin}/`, apiKey: token };
    const read = await createToken(t.db, w.owner, {
      scopes: ['schema.bases:read', 'data.records:read'],
      workspaceIds: [workspaceId],
    });
    readOnly = { baseUrl: http.origin, apiKey: read.token };

    const res = await fetch(`${http.origin}/api/v1/meta/bases/${baseId}/tables`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Contacts',
        fields: [
          { name: 'Name', type: 'singleLineText' },
          { name: 'Email', type: 'email' },
          { name: 'Estimate', type: 'number' },
          {
            name: 'Status',
            type: 'singleSelect',
            options: { choices: [{ name: 'Lead' }, { name: 'Customer' }] },
          },
          { name: 'Done', type: 'checkbox' },
          { name: 'Notes', type: 'multilineText' },
        ],
      }),
    });
    expect(res.status).toBe(200);
    tableId = ((await res.json()) as { id: string }).id;
  });

  afterAll(async () => {
    await http.close();
    await new Promise<void>((done) => hook.close(() => done()));
  });

  const target = () => ({ resource: 'record', base: rl(baseId), table: rl(tableId) });
  const run = (
    params: Record<string, unknown> | ((i: number) => Record<string, unknown>),
    items: { json: IDataObject }[] = [{ json: {} }],
    creds = credentials
  ) => node.execute.call(executeContext({ params, items, credentials: creds }));
  const fields = (value: Record<string, unknown>, matchingColumns: string[] = []) => ({
    mappingMode: 'defineBelow',
    value,
    matchingColumns,
    schema: [],
  });
  const json = async (p: ReturnType<typeof run>) => ((await p)[0] ?? []).map((o) => o.json);

  it('passes the credential test', async () => {
    const cred = new OpenRowsApi();
    const res = (await httpHelper(credentials)('openRowsApi', {
      baseURL: resolveExpression(String(cred.test.request.baseURL), credentials),
      url: String(cred.test.request.url),
    })) as { bases: { id: string }[] };
    expect(res.bases.map((b) => b.id)).toEqual([baseId]);
  });

  it('loads the base, table and column pickers', async () => {
    const ctx = loadOptionsContext({
      params: { base: rl(baseId), table: rl(tableId) },
      credentials,
    });
    expect((await node.methods.listSearch.searchBases.call(ctx)).results).toEqual([
      { name: 'CRM', value: baseId },
    ]);
    expect((await node.methods.listSearch.searchTables.call(ctx, 'cont')).results).toEqual([
      { name: 'Contacts', value: tableId },
    ]);
    const { fields: columns } = await node.methods.resourceMapping.getColumnsWithMatch.call(ctx);
    expect(columns.map((c) => [c.id, c.type, c.canBeUsedToMatch])).toEqual([
      ['Name', 'string', true],
      ['Email', 'string', true],
      ['Estimate', 'number', true],
      ['Status', 'options', true],
      ['Done', 'boolean', true],
      ['Notes', 'string', false],
    ]);
    expect(columns.find((c) => c.id === 'Status')?.options).toEqual([
      { name: 'Lead', value: 'Lead' },
      { name: 'Customer', value: 'Customer' },
    ]);
  });

  it('creates, lists, searches, gets, updates, upserts and deletes records', async () => {
    const created = await json(
      run(
        (i) => ({
          ...target(),
          operation: 'create',
          columns: fields({ Name: `Person ${i}`, Email: `p${i}@example.com`, Estimate: i }),
          options: { typecast: i === 0 },
        }),
        Array.from({ length: 12 }, () => ({ json: {} }))
      )
    );
    expect(created.map((r) => r['Name'])).toEqual(
      Array.from({ length: 12 }, (_, i) => `Person ${i}`)
    );
    const ids = created.map((r) => String(r['id']));

    expect(await json(run({ ...target(), operation: 'getAll', returnAll: true }))).toHaveLength(12);
    const top = await json(
      run({
        ...target(),
        operation: 'getAll',
        returnAll: false,
        limit: 3,
        options: {
          filterByFormula: '{Estimate} >= 5',
          sort: { rule: [{ field: 'Estimate', direction: 'desc' }] },
          fields: ['Name', 'Estimate'],
        },
      })
    );
    expect(top.map((r) => [r['Name'], r['Estimate'], r['Email']])).toEqual([
      ['Person 11', 11, undefined],
      ['Person 10', 10, undefined],
      ['Person 9', 9, undefined],
    ]);

    const found = await json(
      run({ ...target(), operation: 'search', searchText: 'P7@EXAMPLE', returnAll: true })
    );
    expect(found.map((r) => r['Name'])).toEqual(['Person 7']);

    const [got] = await json(run({ ...target(), operation: 'get', recordId: ids[3] }));
    expect(got).toMatchObject({ id: ids[3], Name: 'Person 3', Estimate: 3 });

    const [updated] = await json(
      run({
        ...target(),
        operation: 'update',
        recordId: ids[3],
        columns: fields({ Status: 'Customer', Done: true }),
      })
    );
    expect(updated).toMatchObject({ Name: 'Person 3', Status: 'Customer', Done: true });

    const upserted = await json(
      run(
        (i) => ({
          ...target(),
          operation: 'upsert',
          columns: fields(
            i === 0
              ? { Email: 'p0@example.com', Notes: 'Updated by n8n' }
              : { Email: 'new@example.com', Name: 'Newcomer' },
            ['Email']
          ),
        }),
        [{ json: {} }, { json: {} }]
      )
    );
    expect(upserted[0]).toMatchObject({ id: ids[0], Name: 'Person 0', Notes: 'Updated by n8n' });
    expect(upserted[1]).toMatchObject({ Name: 'Newcomer' });

    const deleted = await json(
      run(
        (i) => ({ ...target(), operation: 'delete', recordId: ids[i] }),
        ids.slice(0, 11).map(() => ({ json: {} }))
      )
    );
    expect(deleted).toEqual(ids.slice(0, 11).map((id) => ({ id, deleted: true })));
    const left = await json(run({ ...target(), operation: 'getAll', returnAll: true }));
    expect(left.map((r) => r['Name']).sort()).toEqual(['Newcomer', 'Person 11']);
  });

  it("is refused what the token's scopes or tenant don't allow", async () => {
    await expect(
      run(
        { ...target(), operation: 'create', columns: fields({ Name: 'No' }) },
        undefined,
        readOnly
      )
    ).rejects.toMatchObject({ httpCode: '403' });
    await expect(
      run({ ...target(), base: rl(otherBaseId), operation: 'getAll', returnAll: true })
    ).rejects.toMatchObject({ httpCode: '404' });
    await expect(
      run({
        ...target(),
        operation: 'get',
        recordId: '0195f0c2-0000-7000-8000-000000000000',
      })
    ).rejects.toMatchObject({ httpCode: '404' });
    await expect(
      run({ ...target(), operation: 'getAll', returnAll: true }, undefined, {
        baseUrl: http.origin,
        apiKey: 'or_pat_nope',
      })
    ).rejects.toMatchObject({ httpCode: '401' });
  });

  it('registers a webhook, verifies a real signed delivery and removes the webhook', async () => {
    const staticData: IDataObject = {};
    const webhookUrl = `http://127.0.0.1:${hookPort}/webhook/n8n`;
    const hooks = trigger.webhookMethods.default;
    const ctx = () =>
      hookContext({
        params: { base: rl(baseId), events: ['record.created'], tableIds: [tableId] },
        credentials,
        staticData,
        webhookUrl,
        workflowName: 'New contacts',
      });
    expect(await hooks.checkExists.call(ctx())).toBe(false);
    expect(await hooks.create.call(ctx())).toBe(true);
    expect(await hooks.checkExists.call(ctx())).toBe(true);
    expect(String(staticData['secret'])).toMatch(/^whsec_/);

    // The read-only token can't manage webhooks.
    await expect(
      hooks.create.call(
        hookContext({
          params: { base: rl(baseId), events: ['record.created'], tableIds: [] },
          credentials: readOnly,
          staticData: {},
          webhookUrl,
        })
      )
    ).rejects.toMatchObject({ httpCode: '403' });

    const [created] = await json(
      run({ ...target(), operation: 'create', columns: fields({ Name: 'Grace', Estimate: 5 }) })
    );
    const rows = await t.db
      .select()
      .from(outbox)
      .where(sql`${outbox.kind} = 'record.created' AND ${outbox.tableId} = ${tableId}`)
      .orderBy(sql`${outbox.id} DESC`)
      .limit(1);
    const event = rows[0];
    if (!event) throw new Error('no record.created event');
    const before = received.length;
    await deliverWebhook(
      {
        db: t.appDb,
        cipher,
        http: createSafeFetch(outboundPolicy(outbound())),
        logger,
        appUrl: 'http://localhost:5173',
      },
      { workspaceId, outboxId: event.id, subscriberId: String(staticData['webhookId']) },
      'job-n8n',
      1
    );
    const delivery = received[before];
    if (!delivery) throw new Error('nothing delivered');
    const headers = { 'x-openrows-signature': String(delivery.headers['x-openrows-signature']) };

    const ok = webhookContext({
      params: { simplify: true },
      staticData,
      rawBody: delivery.body,
      headers,
    });
    const result = await trigger.webhook.call(ok.context);
    expect(ok.responded).toEqual({});
    expect(result.workflowData?.[0]?.[0]?.json).toMatchObject({
      event: 'record.created',
      baseId,
      baseName: 'CRM',
      tableId,
      tableName: 'Contacts',
      recordId: created?.['id'],
      fields: { Name: 'Grace', Estimate: 5 },
      previousFields: null,
    });

    const tampered = webhookContext({
      params: { simplify: true },
      staticData,
      rawBody: Buffer.from(delivery.body.toString('utf8').replace('Grace', 'Mallory')),
      headers,
    });
    expect(await trigger.webhook.call(tampered.context)).toEqual({ noWebhookResponse: true });
    expect(tampered.responded.status).toBe(401);

    expect(await hooks.delete.call(ctx())).toBe(true);
    expect(staticData).toEqual({});
    const listed = await fetch(`${http.origin}/api/v1/bases/${baseId}/webhooks`, {
      headers: { authorization: `Bearer ${credentials.apiKey}` },
    });
    expect(((await listed.json()) as { webhooks: unknown[] }).webhooks).toEqual([]);
  });
});
