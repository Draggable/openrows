import type { TokenScope } from '@openrows/shared';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCipher } from '../../src/auth/crypto.js';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { inScope } from '../../src/authz/scope.js';
import { runAutomationJob } from '../../src/automations/run.js';
import { qualified } from '../../src/data/columns.js';
import { automations, type bases, tables, type users } from '../../src/db/index.js';
import { memoryTransport } from '../../src/email/transport.js';
import { createField } from '../../src/fields/service.js';
import { createLogger } from '../../src/lib/logger.js';
import { createSafeFetch, outboundPolicy } from '../../src/lib/safe-fetch/index.js';
import { createTable, loadTable } from '../../src/tables/service.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import {
  addMember,
  createBase,
  createSession,
  createToken,
  createWorkspace,
} from '../helpers/factories.js';

type User = typeof users.$inferSelect;
type Json = ReturnType<typeof JSON.parse>;

/**
 * Automations in the REST API v1: list, get, runs, on/off and triggers, with the
 * `automations:*` token scopes on top of the base's creator role. Who may call each route per
 * role and tenant is in the authz matrix; this covers what the routes do.
 */
describe('REST API v1: automations', () => {
  const t = useTestDb();
  const logger = createLogger({ level: 'silent' });
  let app: ReturnType<typeof testApp>['app'];
  let config: ReturnType<typeof testApp>['config'];
  let owner: User;
  let creator: User;
  let editor: User;
  let workspaceId: string;
  let base: typeof bases.$inferSelect;
  let table: typeof tables.$inferSelect;
  let notesId: string;
  let buttonId: string;
  let recordId: string;
  let cookie: string;
  const tokens: Record<string, string> = {};

  const call = async (
    auth: string | null,
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; body: Json }> => {
    const headers = new Headers();
    if (auth) headers.set('authorization', `Bearer ${auth}`);
    else headers.set('cookie', `${SESSION_COOKIE}=${cookie}`);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const res = await app.request(path, {
      method,
      headers,
      ...(body !== undefined
        ? { body: typeof body === 'string' ? body : JSON.stringify(body) }
        : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const v1 = (path = '') => `/api/v1/bases/${base.id}/automations${path}`;

  const seen = new Set<string>();
  const runSent = async () => {
    const outbound = {
      cipher: createCipher(config.encryptionKey, 'automation-secret'),
      http: createSafeFetch(
        outboundPolicy({ allowHttp: false, extraPorts: [], allow: [], deny: [] })
      ),
      email: memoryTransport(),
      emailDailyLimit: 10,
    };
    const { rows } = await t.db.execute<{ id: string; data: unknown }>(
      sql`SELECT id, data FROM pgboss.job WHERE name = 'automations.run' ORDER BY created_on`
    );
    for (const job of rows) {
      if (seen.has(job.id)) continue;
      seen.add(job.id);
      await runAutomationJob({ db: t.appDb, logger, outbound }, job.data);
    }
  };

  /** An automation made in the app by the creator's session. */
  const make = async (trigger: Record<string, unknown>, enabled = true) => {
    const res = await call(null, 'POST', `/api/bases/${base.id}/automations`, {
      name: `${trigger['type']}`,
      enabled,
      trigger,
      actions: [
        {
          type: 'createRecord',
          tableId: table.id,
          fields: { [notesId]: 'From {{trigger.body.who}}' },
        },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; webhookUrl: string | null };
  };

  beforeAll(async () => {
    const built = testApp({ db: t.appDb });
    app = built.app;
    config = built.config;
    const w = await createWorkspace(t.db);
    owner = w.owner;
    workspaceId = w.workspace.id;
    creator = await addMember(t.db, workspaceId, 'creator');
    editor = await addMember(t.db, workspaceId, 'editor');
    cookie = await createSession(t.db, creator);
    base = await createBase(t.db, workspaceId, { name: 'Ops' });
    const made = await inScope(t.appDb, { userId: owner.id, workspaceId }, async (tx) => {
      const created = await createTable({ tx, workspaceId, userId: owner.id }, base, {
        name: 'Tasks',
      });
      const loaded = await loadTable(tx, created.id);
      const button = await createField({ tx, workspaceId, userId: owner.id }, loaded, {
        name: 'Approve',
        type: 'button',
        options: { label: 'Approve', action: 'runAutomation' },
      });
      return { created, loaded, button };
    });
    table = made.loaded;
    buttonId = made.button.id;
    notesId = made.created.fields.find((f) => f.name === 'Notes')?.id ?? '';
    const rec = await call(null, 'POST', `/api/tables/${table.id}/records`, {
      records: [{ fields: {} }],
    });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    recordId = rec.body.records[0].id;

    const grant = { workspaceIds: [workspaceId] };
    const mint = async (name: string, who: User, scopes: TokenScope[]) => {
      tokens[name] = (await createToken(t.db, who, { ...grant, scopes })).token;
    };
    await mint('read', creator, ['automations:read']);
    await mint('manage', creator, ['automations:manage']);
    await mint('run', creator, ['automations:run']);
    await mint('ownerAll', owner, ['automations:read', 'automations:manage', 'automations:run']);
    await mint('editorAll', editor, ['automations:read', 'automations:manage', 'automations:run']);
    await mint('records', creator, ['data.records:read', 'data.records:write']);
    tokens['elsewhere'] = (
      await createToken(t.db, creator, {
        workspaceIds: [(await createWorkspace(t.db)).workspace.id],
        scopes: ['automations:read'],
      })
    ).token;
  });

  it('lists and reads automations with automations:read, never their webhook URL', async () => {
    const hook = await make({ type: 'webhookReceived' });
    expect(hook.webhookUrl).toMatch(/\/hooks\/a\//);
    const list = await call(tokens['read'] ?? '', 'GET', v1());
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const found = (list.body.automations as Json[]).find((a) => a.id === hook.id);
    expect(found).toMatchObject({
      id: hook.id,
      enabled: true,
      trigger: { type: 'webhookReceived' },
    });
    expect(found).not.toHaveProperty('webhookUrl');
    expect(found).not.toHaveProperty('webhookSample');
    expect(JSON.stringify(list.body)).not.toContain('/hooks/a/');

    const one = await call(tokens['read'] ?? '', 'GET', v1(`/${hook.id}`));
    expect(one.status).toBe(200);
    expect(one.body).not.toHaveProperty('webhookUrl');
    expect((await call(tokens['read'] ?? '', 'GET', v1(`/${hook.id}/runs`))).body).toEqual({
      runs: [],
    });

    // Scopes, role and grants each narrow it.
    expect((await call(tokens['records'] ?? '', 'GET', v1())).status).toBe(403);
    expect((await call(tokens['editorAll'] ?? '', 'GET', v1())).status).toBe(403);
    expect((await call(tokens['elsewhere'] ?? '', 'GET', v1())).status).toBe(404);
    expect((await call(tokens['read'] ?? '', 'GET', v1(`/${uuidv7()}`))).status).toBe(404);
    // Errors keep the API's Airtable shape.
    const denied = await call(tokens['records'] ?? '', 'GET', v1());
    expect(denied.body.error).toMatchObject({ type: 'INVALID_PERMISSIONS' });
  });

  it('turns automations on and off with automations:manage; on makes them run as the caller', async () => {
    const auto = await make({ type: 'recordCreated', tableId: table.id }, false);
    const path = v1(`/${auto.id}`);
    expect((await call(tokens['read'] ?? '', 'PATCH', path, { enabled: true })).status).toBe(403);
    const on = await call(tokens['ownerAll'] ?? '', 'PATCH', path, { enabled: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body).toMatchObject({ enabled: true, createdBy: owner.id });
    const off = await call(tokens['manage'] ?? '', 'PATCH', path, { enabled: false });
    expect(off.body).toMatchObject({ enabled: false, createdBy: owner.id });
    // Only `enabled`: building stays in the app.
    expect((await call(tokens['manage'] ?? '', 'PATCH', path, { name: 'X' })).status).toBe(422);
    expect((await call(tokens['manage'] ?? '', 'PATCH', path, {})).status).toBe(422);
    // An automation without actions can't be turned on (the builder's rule).
    const [bare] = await t.db
      .insert(automations)
      .values({
        workspaceId,
        baseId: base.id,
        name: 'Bare',
        enabled: false,
        trigger: { type: 'webhookReceived' },
        actions: [],
        triggerType: 'webhookReceived',
        createdBy: creator.id,
      })
      .returning();
    const bareOn = await call(tokens['manage'] ?? '', 'PATCH', v1(`/${bare?.id}`), {
      enabled: true,
    });
    expect(bareOn.status).toBe(422);
  });

  it('triggers a webhook automation with a body, as a request to its URL would', async () => {
    const hook = await make({ type: 'webhookReceived' });
    const path = v1(`/${hook.id}/trigger`);
    expect((await call(tokens['read'] ?? '', 'POST', path, {})).status).toBe(403);
    const res = await call(tokens['run'] ?? '', 'POST', path, { body: { who: 'Zapier' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ queued: true, triggerId: expect.any(String) });
    await runSent();
    const runs = await call(tokens['read'] ?? '', 'GET', v1(`/${hook.id}/runs`));
    expect(runs.body.runs).toHaveLength(1);
    expect(runs.body.runs[0]).toMatchObject({
      status: 'succeeded',
      trigger: { type: 'webhookReceived', body: { who: 'Zapier' } },
    });
    const { rows } = await t.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ${qualified(table)} WHERE deleted_at IS NULL`
    );
    expect(rows[0]?.n).toBe(2);
    // The builder's sample follows, as for its URL.
    const [stored] = await t.db.select().from(automations).where(eq(automations.id, hook.id));
    expect(stored?.hookSample).toEqual({ who: 'Zapier' });

    expect((await call(tokens['run'] ?? '', 'POST', path, { recordId })).status).toBe(422);
    expect(
      (await call(tokens['run'] ?? '', 'POST', path, { body: {}, recordId, extra: 1 })).status
    ).toBe(422);
    const big = { body: { blob: 'x'.repeat(101 * 1024) } };
    expect((await call(tokens['run'] ?? '', 'POST', path, big)).status).toBe(413);
    // Turned off, it can't be triggered.
    await call(null, 'PATCH', `/api/bases/${base.id}/automations/${hook.id}`, { enabled: false });
    expect((await call(tokens['run'] ?? '', 'POST', path, {})).status).toBe(409);
  });

  it('triggers a button automation as a click on the record, with the caller’s rights', async () => {
    const auto = await make({ type: 'buttonClicked', tableId: table.id, fieldId: buttonId });
    const path = v1(`/${auto.id}/trigger`);
    expect((await call(tokens['run'] ?? '', 'POST', path, {})).status).toBe(422);
    expect((await call(tokens['run'] ?? '', 'POST', path, { recordId: uuidv7() })).status).toBe(
      404
    );
    const res = await call(tokens['run'] ?? '', 'POST', path, { recordId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await runSent();
    const runs = await call(tokens['read'] ?? '', 'GET', v1(`/${auto.id}/runs`));
    expect(runs.body.runs[0]).toMatchObject({ status: 'succeeded', triggeredBy: creator.id });

    // The table's "edit records" permission binds the caller, as it does the button.
    await t.db
      .update(tables)
      .set({ permissions: { editRecords: { level: 'specific', userIds: [owner.id], roles: [] } } })
      .where(eq(tables.id, table.id));
    const restricted = await call(tokens['run'] ?? '', 'POST', path, { recordId });
    expect(restricted.status, JSON.stringify(restricted.body)).toBe(403);
    await t.db.update(tables).set({ permissions: {} }).where(eq(tables.id, table.id));
  });

  it('only triggers webhook and button automations', async () => {
    const auto = await make({ type: 'recordCreated', tableId: table.id });
    const res = await call(tokens['run'] ?? '', 'POST', v1(`/${auto.id}/trigger`), {});
    expect(res.status).toBe(409);
    await call(null, 'PATCH', `/api/bases/${base.id}/automations/${auto.id}`, { enabled: false });
  });
});
