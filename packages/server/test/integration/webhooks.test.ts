import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WebhookPayload } from '@openrows/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCipher } from '../../src/auth/crypto.js';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { inScope } from '../../src/authz/scope.js';
import { createComment, deleteComment } from '../../src/comments/service.js';
import {
  outbox,
  type tables,
  type users,
  webhookDeliveries,
  webhooks,
  workspaceMembers,
} from '../../src/db/index.js';
import { unlimitedEntitlements } from '../../src/edition/oss.js';
import { memoryTransport } from '../../src/email/transport.js';
import { builtinQueues, type RunningWorker, startWorker } from '../../src/jobs/runtime.js';
import { createLogger } from '../../src/lib/logger.js';
import { createSafeFetch, outboundPolicy } from '../../src/lib/safe-fetch/index.js';
import { deleteRecords, restoreRecords, updateRecords } from '../../src/records/service.js';
import { deliverWebhook, type WebhookDeliveryDeps } from '../../src/webhooks/deliver.js';
import { verifyWebhookSignature } from '../../src/webhooks/signature.js';
import { pruneWebhookDeliveries, webhookSubscriber } from '../../src/webhooks/subscriber.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import {
  addMember,
  createBase,
  createRecordsIn,
  createSession,
  createTableWithFields,
  createWorkspace,
} from '../helpers/factories.js';

type User = typeof users.$inferSelect;
type Table = typeof tables.$inferSelect;
type Json = ReturnType<typeof JSON.parse>;

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
  path: string;
}

/** A local receiver: records every request, answers with the next queued status (else 200). */
function receiver() {
  const received: Received[] = [];
  const statuses: number[] = [];
  let always: number | undefined;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        path: req.url ?? '',
      });
      const status = statuses.shift() ?? always ?? 200;
      res.writeHead(status, { 'content-type': 'text/plain' });
      res.end(status < 300 ? 'ok' : 'receiver says no');
    });
  });
  return {
    received,
    respondWith(...s: number[]) {
      statuses.push(...s);
    },
    alwaysRespond(status: number | undefined) {
      always = status;
    },
    start: () =>
      new Promise<number>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
      ),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function until<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 200));
  }
}

const ENCRYPTION_KEY = 'webhook-test-encryption-key-0123456789abcdef';

/**
 * Webhooks end to end as openrows_app: management through the REST API v1 (creators only,
 * URLs checked with the outbound rules, 10 per base, secrets shown once), delivery through the
 * outbox relay and the worker (one signed POST per event, retried on failure, the log, the
 * switch-off after failures with an email, the creator's access), never another base's events.
 */
describe('webhooks', () => {
  const t = useTestDb();
  const hook = receiver();
  const logger = createLogger({ level: 'silent' });
  let port: number;
  let app: ReturnType<typeof testApp>['app'];
  let owner: User;
  let creator: User;
  let editor: User;
  let cookies: Map<string, string>;
  let workspaceId: string;
  let baseId: string;
  let otherBaseId: string;
  let table: Table;
  let otherTable: Table;
  let notesFieldId: string;
  let recordId: string;
  let otherRecordId: string;
  const running: RunningWorker[] = [];
  const cipher = createCipher(ENCRYPTION_KEY, 'webhook-secret');

  const url = (path = '/hook') => `http://127.0.0.1:${port}${path}`;
  const outbound = () => ({ allowHttp: true, extraPorts: [port], allow: ['127.0.0.1'], deny: [] });

  const call = async (
    who: User,
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; body: Json }> => {
    const headers = new Headers({ cookie: `${SESSION_COOKIE}=${cookies.get(who.id)}` });
    if (body !== undefined) headers.set('content-type', 'application/json');
    const res = await app.request(path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const hooksOf = (base: string) => `/api/v1/bases/${base}/webhooks`;

  const deliveryDeps = (over: Partial<WebhookDeliveryDeps> = {}): WebhookDeliveryDeps => ({
    db: t.appDb,
    cipher,
    http: createSafeFetch(outboundPolicy(outbound())),
    logger,
    appUrl: 'http://localhost:5173',
    ...over,
  });

  /** Updates Notes of a record through the RecordService as the owner. */
  const editNotes = (tbl: Table, id: string, value: string) =>
    inScope(t.appDb, { userId: owner.id, workspaceId }, (tx) =>
      updateRecords(
        {
          tx,
          workspaceId,
          userId: owner.id,
          role: 'owner',
          entitlements: unlimitedEntitlements(),
          table: tbl,
        },
        [{ id, fields: { [tbl.id === table.id ? notesFieldId : otherNotes]: value } }]
      )
    );
  let otherNotes: string;

  const latestOutbox = async (kind: string, tableId: string) => {
    const rows = await t.db
      .select()
      .from(outbox)
      .where(sql`${outbox.kind} = ${kind} AND ${outbox.tableId} = ${tableId}`)
      .orderBy(sql`${outbox.id} DESC`)
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error(`no ${kind} event`);
    return row;
  };

  const createHook = async (body: Record<string, unknown>, base = baseId, who = creator) => {
    const res = await call(who, 'POST', hooksOf(base), body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; secret: string; previousSecretExpiresAt: string | null };
  };

  beforeAll(async () => {
    port = await hook.start();
    app = testApp({
      db: t.appDb,
      config: { outbound: outbound(), encryptionKey: ENCRYPTION_KEY },
    }).app;
    const w = await createWorkspace(t.db);
    owner = w.owner;
    workspaceId = w.workspace.id;
    creator = await addMember(t.db, workspaceId, 'creator');
    editor = await addMember(t.db, workspaceId, 'editor');
    cookies = new Map();
    for (const u of [owner, creator, editor]) cookies.set(u.id, await createSession(t.db, u));
    const base = await createBase(t.db, workspaceId, { name: 'Roadmap' });
    baseId = base.id;
    const made = await createTableWithFields(t.db, owner, base, 'Tasks');
    table = made.table;
    notesFieldId = made.field.id;
    recordId = (await createRecordsIn(t.db, owner, table)).record.id;
    const other = await createBase(t.db, workspaceId, { name: 'Other' });
    otherBaseId = other.id;
    const otherMade = await createTableWithFields(t.db, owner, other, 'Tasks');
    otherTable = otherMade.table;
    otherNotes = otherMade.field.id;
    otherRecordId = (await createRecordsIn(t.db, owner, otherTable)).record.id;
  });

  afterAll(async () => {
    await Promise.all(running.map((r) => r.stop(2_000)));
    await hook.stop();
  });

  describe('management', () => {
    it('creates a webhook, shows its secret once and lists it without', async () => {
      const created = await createHook({ url: url(), events: ['record.updated'] });
      expect(created.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
      expect(created).toMatchObject({
        url: url(),
        events: ['record.updated'],
        enabled: true,
        tableIds: null,
        createdBy: creator.id,
      });
      const listed = await call(creator, 'GET', hooksOf(baseId));
      expect(listed.status).toBe(200);
      const mine = listed.body.webhooks.find((h: { id: string }) => h.id === created.id);
      expect(mine).toBeDefined();
      expect(JSON.stringify(listed.body)).not.toContain(created.secret);
      // Stored encrypted, never in clear.
      const [row] = await t.db.select().from(webhooks).where(eq(webhooks.id, created.id));
      expect(row?.secretEncrypted.toString('utf8')).not.toContain(created.secret);
      expect(cipher.decrypt(row?.secretEncrypted ?? Buffer.alloc(0))).toBe(created.secret);
      await call(creator, 'DELETE', `${hooksOf(baseId)}/${created.id}`);
    });

    it('refuses URLs the outbound rules refuse, and filters outside the base', async () => {
      for (const bad of [
        'http://10.0.0.5/hook',
        'http://169.254.169.254/latest',
        `http://127.0.0.1:${port + 1}/x`,
        'http://user:pw@127.0.0.1/x',
        'ftp://example.com/x',
      ]) {
        const res = await call(creator, 'POST', hooksOf(baseId), {
          url: bad,
          events: ['record.created'],
        });
        expect(res.status, bad).toBe(422);
      }
      const foreignTable = await call(creator, 'POST', hooksOf(baseId), {
        url: url(),
        events: ['record.created'],
        tableIds: [otherTable.id],
      });
      expect(foreignTable.status).toBe(422);
      const foreignField = await call(creator, 'POST', hooksOf(baseId), {
        url: url(),
        events: ['record.updated'],
        fieldIds: [otherNotes],
      });
      expect(foreignField.status).toBe(422);
    });

    it('allows 10 webhooks per base', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        ids.push((await createHook({ url: url(`/n${i}`), events: ['table.created'] })).id);
      }
      const eleventh = await call(creator, 'POST', hooksOf(baseId), {
        url: url(),
        events: ['table.created'],
      });
      expect(eleventh.status).toBe(409);
      for (const id of ids) {
        expect((await call(creator, 'DELETE', `${hooksOf(baseId)}/${id}`)).status).toBe(204);
      }
    });

    it('rotates the secret, disables and enables again', async () => {
      const created = await createHook({ url: url(), events: ['record.deleted'] });
      const rotated = await call(creator, 'PATCH', `${hooksOf(baseId)}/${created.id}`, {
        rotateSecret: true,
      });
      expect(rotated.status).toBe(200);
      expect(rotated.body.secret).toMatch(/^whsec_/);
      expect(rotated.body.secret).not.toBe(created.secret);
      const off = await call(creator, 'PATCH', `${hooksOf(baseId)}/${created.id}`, {
        enabled: false,
      });
      expect(off.body).toMatchObject({ enabled: false });
      expect(off.body.secret).toBeUndefined();
      const on = await call(owner, 'PATCH', `${hooksOf(baseId)}/${created.id}`, { enabled: true });
      expect(on.body).toMatchObject({ enabled: true, consecutiveFailures: 0, createdBy: owner.id });
      await call(creator, 'DELETE', `${hooksOf(baseId)}/${created.id}`);
    });

    it('keeps signing with the old secret for 24 hours after a rotation (#124)', async () => {
      const created = await createHook({ url: url('/rotate'), events: ['record.deleted'] });
      const path = `${hooksOf(baseId)}/${created.id}`;
      expect(created.previousSecretExpiresAt).toBeNull();
      const signedWith = async () => {
        const before = hook.received.length;
        expect((await call(creator, 'POST', `${path}/ping`)).status).toBe(200);
        const got = hook.received[before];
        const header = String(got?.headers['x-openrows-signature']);
        return {
          v1: header.split(',').filter((p) => p.startsWith('v1=')).length,
          ok: (secret: string) => verifyWebhookSignature(secret, header, got?.body ?? ''),
        };
      };

      const rotated = await call(creator, 'PATCH', path, { rotateSecret: true });
      expect(rotated.status).toBe(200);
      const next = String(rotated.body.secret);
      const expires = Date.parse(rotated.body.previousSecretExpiresAt);
      expect(expires - Date.now()).toBeGreaterThan(23.9 * 3600 * 1000);
      expect(expires - Date.now()).toBeLessThanOrEqual(24 * 3600 * 1000);
      // Both secrets sign: a receiver still on the old one and one already on the new one pass.
      const during = await signedWith();
      expect(during.v1).toBe(2);
      expect(during.ok(created.secret)).toBe(true);
      expect(during.ok(next)).toBe(true);
      expect(during.ok('whsec_somethingelse')).toBe(false);

      // A day later only the new one signs.
      await t.db
        .update(webhooks)
        .set({ previousSecretExpiresAt: new Date(Date.now() - 1000) })
        .where(eq(webhooks.id, created.id));
      const after = await signedWith();
      expect(after.v1).toBe(1);
      expect(after.ok(created.secret)).toBe(false);
      expect(after.ok(next)).toBe(true);
      const listed = await call(creator, 'GET', hooksOf(baseId));
      expect(
        (listed.body.webhooks as { id: string; previousSecretExpiresAt: string | null }[]).find(
          (h) => h.id === created.id
        )?.previousSecretExpiresAt
      ).toBeNull();

      // Rotating again: the previous is the second secret; ending the grace drops it now.
      const third = await call(creator, 'PATCH', path, { rotateSecret: true });
      const again = await signedWith();
      expect(again.ok(next)).toBe(true);
      expect(again.ok(String(third.body.secret))).toBe(true);
      const ended = await call(creator, 'PATCH', path, { expirePreviousSecret: true });
      expect(ended.body).toMatchObject({ previousSecretExpiresAt: null });
      expect(ended.body.secret).toBeUndefined();
      const only = await signedWith();
      expect(only.v1).toBe(1);
      expect(only.ok(next)).toBe(false);
      expect(only.ok(String(third.body.secret))).toBe(true);
      // The secrets never leave the server again, and are never in the row in the clear.
      const [row] = await t.db.select().from(webhooks).where(eq(webhooks.id, created.id));
      expect(Buffer.from(row?.secretEncrypted ?? []).toString('utf8')).not.toContain('whsec_');
      await call(creator, 'DELETE', path);
    });

    it('is for creators only; another base’s webhook ids are 404', async () => {
      const created = await createHook({ url: url(), events: ['record.created'] });
      expect((await call(editor, 'GET', hooksOf(baseId))).status).toBe(403);
      expect(
        (await call(editor, 'POST', hooksOf(baseId), { url: url(), events: ['record.created'] }))
          .status
      ).toBe(403);
      // The id through another base's path: not found.
      const elsewhere = await call(creator, 'PATCH', `${hooksOf(otherBaseId)}/${created.id}`, {
        enabled: false,
      });
      expect(elsewhere.status).toBe(404);
      expect(
        (await call(creator, 'GET', `${hooksOf(otherBaseId)}/${created.id}/deliveries`)).status
      ).toBe(404);
      await call(creator, 'DELETE', `${hooksOf(baseId)}/${created.id}`);
    });

    it('pings: a signed test event, in the log', async () => {
      const created = await createHook({ url: url('/ping'), events: ['record.created'] });
      const before = hook.received.length;
      const ping = await call(creator, 'POST', `${hooksOf(baseId)}/${created.id}/ping`);
      expect(ping.status).toBe(200);
      expect(ping.body).toMatchObject({
        eventType: 'ping',
        success: true,
        responseStatus: 200,
        responseBody: 'ok',
      });
      const got = hook.received[before];
      expect(got?.path).toBe('/ping');
      const payload = JSON.parse(got?.body ?? '{}') as WebhookPayload;
      expect(payload).toMatchObject({ type: 'ping', base: { id: baseId, name: 'Roadmap' } });
      expect(
        verifyWebhookSignature(
          created.secret,
          String(got?.headers['x-openrows-signature']),
          got?.body ?? ''
        )
      ).toBe(true);
      const log = await call(creator, 'GET', `${hooksOf(baseId)}/${created.id}/deliveries`);
      expect(log.body.deliveries).toHaveLength(1);
      await call(creator, 'DELETE', `${hooksOf(baseId)}/${created.id}`);
    });
  });

  describe('delivery', () => {
    it('a record update produces exactly one signed delivery; a 500 is retried', async () => {
      const created = await createHook({
        url: url('/live'),
        events: ['record.updated'],
        tableIds: [table.id],
      });
      const otherHook = await createHook(
        { url: url('/other-base'), events: ['record.updated'] },
        otherBaseId
      );
      const queues = builtinQueues({
        db: t.appDb,
        logger,
        revisionDays: 365,
        webhooks: {
          cipher,
          http: createSafeFetch(outboundPolicy(outbound())),
          appUrl: 'http://localhost:5173',
        },
      });
      const deliver = queues['webhooks.deliver'];
      const relayQueue = queues['outbox.relay'];
      if (!deliver || !relayQueue) throw new Error('no webhook queues');
      // Retries a second apart instead of minutes.
      const { retryDelayMax: _max, ...spec } = deliver.spec;
      deliver.spec = { ...spec, retryDelay: 1, retryBackoff: false };
      const worker = await startWorker(
        { db: t.appDb, logger, revisionDays: 365 },
        {
          connectionString: t.appUrl,
          instanceName: 'webhooks',
          queues: { 'outbox.relay': relayQueue, 'webhooks.deliver': deliver },
          pollingIntervalSeconds: 0.5,
          cronMonitorIntervalSeconds: 1,
          cronWorkerIntervalSeconds: 1,
          maxConnections: 3,
        }
      );
      running.push(worker);
      const relay = () => worker.boss.send('outbox.relay', null);

      hook.respondWith(500);
      const start = hook.received.length;
      await editNotes(table, recordId, 'Shipped');
      await relay();
      const both = await until(async () => {
        await relay();
        const live = hook.received.slice(start).filter((r) => r.path === '/live');
        return live.length >= 2 ? live : undefined;
      });
      const [first, second] = both;
      // Same event, retried: the same id, both signed with the secret.
      expect(first?.headers['x-openrows-event-id']).toBe(second?.headers['x-openrows-event-id']);
      for (const r of both) {
        expect(
          verifyWebhookSignature(created.secret, String(r.headers['x-openrows-signature']), r.body)
        ).toBe(true);
        expect(r.headers['content-type']).toBe('application/json');
      }
      const payload = JSON.parse(second?.body ?? '{}') as WebhookPayload;
      expect(payload).toMatchObject({
        id: first?.headers['x-openrows-event-id'],
        type: 'record.updated',
        webhookId: created.id,
        base: { id: baseId, name: 'Roadmap' },
        table: { id: table.id, name: 'Tasks' },
        record: {
          id: recordId,
          before: { [notesFieldId]: null },
          after: { [notesFieldId]: 'Shipped' },
        },
        fields: { [notesFieldId]: { name: 'Notes', type: 'longText' } },
        actor: { id: owner.id },
      });

      // Then nothing more: exactly one delivered event, and none from the other base's webhook.
      await new Promise((r) => setTimeout(r, 2_500));
      const live = hook.received.slice(start).filter((r) => r.path === '/live');
      expect(live).toHaveLength(2);
      expect(hook.received.slice(start).some((r) => r.path === '/other-base')).toBe(false);

      const log = await call(creator, 'GET', `${hooksOf(baseId)}/${created.id}/deliveries`);
      expect(
        log.body.deliveries.map((d: Json) => [d.attempt, d.success, d.responseStatus])
      ).toEqual([
        [2, true, 200],
        [1, false, 500],
      ]);
      expect(log.body.deliveries[1].responseBody).toBe('receiver says no');
      const listed = await call(creator, 'GET', hooksOf(baseId));
      expect(listed.body.webhooks.find((h: Json) => h.id === created.id)).toMatchObject({
        consecutiveFailures: 0,
        lastSuccess: true,
      });

      // The other base's edit reaches only its own webhook.
      const before = hook.received.length;
      await editNotes(otherTable, otherRecordId, 'Elsewhere');
      await until(async () => {
        await relay();
        return hook.received.slice(before).some((r) => r.path === '/other-base');
      });
      await new Promise((r) => setTimeout(r, 1_500));
      expect(hook.received.slice(before).map((r) => r.path)).toEqual(['/other-base']);

      await worker.stop(2_000);
      await call(creator, 'DELETE', `${hooksOf(baseId)}/${created.id}`);
      await call(creator, 'DELETE', `${hooksOf(otherBaseId)}/${otherHook.id}`);
    });

    it('never delivers another base’s event, whatever the job says', async () => {
      const created = await createHook({ url: url('/strict'), events: ['record.updated'] });
      await editNotes(otherTable, otherRecordId, 'Not yours');
      const event = await latestOutbox('record.updated', otherTable.id);
      const before = hook.received.length;
      const outcome = await deliverWebhook(
        deliveryDeps(),
        { workspaceId, outboxId: event.id, subscriberId: created.id },
        'job-1',
        1
      );
      expect(outcome).toEqual({ skipped: 'event_gone' });
      expect(hook.received.length).toBe(before);
      // The relay doesn't match it either.
      const matches = await webhookSubscriber.match(
        [
          {
            id: event.id,
            txid: '0',
            workspaceId,
            baseId: otherBaseId,
            tableId: otherTable.id,
            kind: 'record.updated',
            actorId: owner.id,
            createdAt: event.createdAt,
          },
        ],
        t.appDb
      );
      expect(matches.map((m) => m.subscriberId)).not.toContain(created.id);
      await call(creator, 'DELETE', `${hooksOf(baseId)}/${created.id}`);
    });

    it('never delivers events from before the webhook was created', async () => {
      await editNotes(table, recordId, 'Before the webhook');
      const event = await latestOutbox('record.updated', table.id);
      const created = await createHook({ url: url('/late'), events: ['record.updated'] });
      const matches = await webhookSubscriber.match(
        [
          {
            id: event.id,
            txid: '0',
            workspaceId,
            baseId,
            tableId: table.id,
            kind: 'record.updated',
            actorId: owner.id,
            createdAt: event.createdAt,
          },
        ],
        t.appDb
      );
      expect(matches.map((m) => m.subscriberId)).not.toContain(created.id);
      const before = hook.received.length;
      expect(
        await deliverWebhook(
          deliveryDeps(),
          { workspaceId, outboxId: event.id, subscriberId: created.id },
          'job-6',
          1
        )
      ).toEqual({ skipped: 'filtered' });
      expect(hook.received.length).toBe(before);
      await call(creator, 'DELETE', `${hooksOf(baseId)}/${created.id}`);
    });

    it('filters by field and skips computed-only updates', async () => {
      const created = await createHook({
        url: url('/fields'),
        events: ['record.updated'],
        fieldIds: [notesFieldId],
      });
      const { rows } = await t.db.execute<{ id: string }>(
        sql`SELECT id FROM fields WHERE table_id = ${table.id} AND is_primary`
      );
      const primary = rows[0];
      await inScope(t.appDb, { userId: owner.id, workspaceId }, (tx) =>
        updateRecords(
          {
            tx,
            workspaceId,
            userId: owner.id,
            role: 'owner',
            entitlements: unlimitedEntitlements(),
            table,
          },
          [{ id: recordId, fields: { [primary?.id ?? '']: 'Renamed' } }]
        )
      );
      const event = await latestOutbox('record.updated', table.id);
      const outcome = await deliverWebhook(
        deliveryDeps(),
        { workspaceId, outboxId: event.id, subscriberId: created.id },
        'job-2',
        1
      );
      expect(outcome).toEqual({ skipped: 'filtered' });
      await call(creator, 'DELETE', `${hooksOf(baseId)}/${created.id}`);
    });

    it('turns a failing webhook off and emails its creator', async () => {
      const created = await createHook({ url: url('/down'), events: ['record.updated'] });
      hook.alwaysRespond(503);
      const email = memoryTransport();
      const deps = deliveryDeps({ email, failureLimit: { attempts: 3, windowMs: 0 } });
      await editNotes(table, recordId, 'Failing');
      const event = await latestOutbox('record.updated', table.id);
      const data = { workspaceId, outboxId: event.id, subscriberId: created.id };
      for (const attempt of [1, 2]) {
        await expect(deliverWebhook(deps, data, 'job-3', attempt)).rejects.toThrow(/503/);
      }
      // The third failure turns it off (and doesn't retry).
      expect(await deliverWebhook(deps, data, 'job-3', 3)).toEqual({
        delivered: true,
        status: 503,
      });
      hook.alwaysRespond(undefined);
      const [row] = await t.db.select().from(webhooks).where(eq(webhooks.id, created.id));
      expect(row).toMatchObject({
        enabled: false,
        disabledReason: 'failures',
        consecutiveFailures: 3,
        lastSuccess: false,
      });
      expect(email.sent).toHaveLength(1);
      expect(email.sent[0]?.to).toBe(creator.email);
      expect(email.sent[0]?.subject).toContain('Roadmap');
      expect(email.sent[0]?.text).toContain(`http://127.0.0.1:${port}/down`);
      // Off: later jobs send nothing.
      expect(await deliverWebhook(deps, data, 'job-3', 4)).toEqual({ skipped: 'disabled' });
      // Enabling again starts afresh.
      const on = await call(creator, 'PATCH', `${hooksOf(baseId)}/${created.id}`, {
        enabled: true,
      });
      expect(on.body).toMatchObject({
        enabled: true,
        disabledReason: null,
        consecutiveFailures: 0,
      });
      await call(creator, 'DELETE', `${hooksOf(baseId)}/${created.id}`);
    });

    it('turns a webhook off when its creator lost access to the base', async () => {
      const leaving = await addMember(t.db, workspaceId, 'creator');
      cookies.set(leaving.id, await createSession(t.db, leaving));
      const created = await createHook(
        { url: url('/gone'), events: ['record.updated'] },
        baseId,
        leaving
      );
      await t.db.delete(workspaceMembers).where(sql`${workspaceMembers.userId} = ${leaving.id}`);
      await editNotes(table, recordId, 'After they left');
      const event = await latestOutbox('record.updated', table.id);
      const before = hook.received.length;
      const outcome = await deliverWebhook(
        deliveryDeps(),
        { workspaceId, outboxId: event.id, subscriberId: created.id },
        'job-4',
        1
      );
      expect(outcome).toEqual({ skipped: 'creator_access' });
      expect(hook.received.length).toBe(before);
      const [row] = await t.db.select().from(webhooks).where(eq(webhooks.id, created.id));
      expect(row).toMatchObject({ enabled: false, disabledReason: 'creator_access' });
      await call(creator, 'DELETE', `${hooksOf(baseId)}/${created.id}`);
    });

    it('delivers deletions with the record before, and form submissions', async () => {
      const created = await createHook({
        url: url('/deleted'),
        events: ['record.deleted', 'record.created'],
      });
      const { deletedRecord } = await createRecordsIn(t.db, owner, table);
      const event = await latestOutbox('record.deleted', table.id);
      const before = hook.received.length;
      await deliverWebhook(
        deliveryDeps(),
        { workspaceId, outboxId: event.id, subscriberId: created.id },
        'job-5',
        1
      );
      const payload = JSON.parse(hook.received[before]?.body ?? '{}') as WebhookPayload;
      expect(payload.type).toBe('record.deleted');
      expect(payload.record).toMatchObject({ id: deletedRecord.id, after: null });
      expect(payload.record?.before).toBeTypeOf('object');
      await call(creator, 'DELETE', `${hooksOf(baseId)}/${created.id}`);
    });

    it('delivers record restores and comments (#126)', async () => {
      const created = await createHook({
        url: url('/restored'),
        events: ['record.restored', 'comment.created', 'comment.deleted'],
      });
      const ctx = (tx: Parameters<Parameters<typeof inScope>[2]>[0]) => ({
        tx,
        workspaceId,
        userId: owner.id,
        role: 'owner' as const,
        entitlements: unlimitedEntitlements(),
        table,
      });
      const deliver = async (kind: string, jobId: string) => {
        const event = await latestOutbox(kind, table.id);
        const before = hook.received.length;
        await deliverWebhook(
          deliveryDeps(),
          { workspaceId, outboxId: event.id, subscriberId: created.id },
          jobId,
          1
        );
        return JSON.parse(hook.received[before]?.body ?? '{}') as WebhookPayload;
      };

      const { record } = await createRecordsIn(t.db, owner, table);
      await inScope(t.appDb, { userId: owner.id, workspaceId }, async (tx) => {
        await deleteRecords(ctx(tx), [record.id]);
        await restoreRecords(ctx(tx), [record.id]);
      });
      const restored = await deliver('record.restored', '01900000-0000-7000-8000-00000000c001');
      expect(restored).toMatchObject({
        type: 'record.restored',
        record: { id: record.id, before: null },
        actor: { id: owner.id },
      });
      expect(restored.record?.after).toBeTypeOf('object');

      const comment = await inScope(t.appDb, { userId: owner.id, workspaceId }, (tx) =>
        createComment(ctx(tx), record.id, { body: 'Looks **good**' })
      );
      expect(
        await deliver('comment.created', '01900000-0000-7000-8000-00000000c002')
      ).toMatchObject({
        type: 'comment.created',
        table: { id: table.id, name: 'Tasks' },
        comment: {
          id: comment.id,
          recordId: record.id,
          body: 'Looks **good**',
          authorId: owner.id,
          mentions: [],
        },
      });
      await inScope(t.appDb, { userId: owner.id, workspaceId }, (tx) =>
        deleteComment(ctx(tx), record.id, comment.id)
      );
      expect(
        await deliver('comment.deleted', '01900000-0000-7000-8000-00000000c003')
      ).toMatchObject({
        type: 'comment.deleted',
        comment: { id: comment.id, recordId: record.id, body: null },
      });
      await call(creator, 'DELETE', `${hooksOf(baseId)}/${created.id}`);
    });

    it('redelivers a failed event with the same event id and the next attempt (#126)', async () => {
      const created = await createHook({ url: url('/again'), events: ['record.updated'] });
      await editNotes(table, recordId, 'Redeliver me');
      const event = await latestOutbox('record.updated', table.id);
      const eventId = '01900000-0000-7000-8000-00000000d001';
      hook.respondWith(500);
      await expect(
        deliverWebhook(
          deliveryDeps(),
          { workspaceId, outboxId: event.id, subscriberId: created.id },
          eventId,
          1
        )
      ).rejects.toThrow(/500/);
      const ping = await call(creator, 'POST', `${hooksOf(baseId)}/${created.id}/ping`);
      const log = await call(creator, 'GET', `${hooksOf(baseId)}/${created.id}/deliveries`);
      const failed = log.body.deliveries.find((d: Json) => d.eventId === eventId);
      expect(failed).toMatchObject({ success: false, attempt: 1 });
      const path = (id: string, hookId = created.id, base = baseId) =>
        `${hooksOf(base)}/${hookId}/deliveries/${id}/redeliver`;

      // Creators only; another base's path is 404; a ping can't be redelivered.
      expect((await call(editor, 'POST', path(failed.id))).status).toBe(403);
      expect((await call(creator, 'POST', path(failed.id, created.id, otherBaseId))).status).toBe(
        404
      );
      expect((await call(creator, 'POST', path(ping.body.id))).status).toBe(409);

      const res = await call(creator, 'POST', path(failed.id));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual({ queued: true, eventId });
      const { rows } = await t.db.execute<{ data: Json }>(
        sql`SELECT data FROM pgboss.job WHERE name = 'webhooks.deliver' AND data->>'eventId' = ${eventId}`
      );
      expect(rows).toHaveLength(1);
      const data = rows[0]?.data;
      expect(data).toMatchObject({
        workspaceId,
        outboxId: event.id,
        subscriberId: created.id,
        eventId,
        priorAttempts: 1,
      });
      // A second click while it waits queues nothing more.
      expect((await call(creator, 'POST', path(failed.id))).status).toBe(200);
      const again = await t.db.execute(
        sql`SELECT 1 FROM pgboss.job WHERE name = 'webhooks.deliver' AND data->>'eventId' = ${eventId}`
      );
      expect(again.rows).toHaveLength(1);

      // The worker's run of it: the same event id, attempt 2, delivered.
      const before = hook.received.length;
      await deliverWebhook(deliveryDeps(), data, eventId, data.priorAttempts + 1);
      expect(hook.received[before]?.headers['x-openrows-event-id']).toBe(eventId);
      const after = await call(creator, 'GET', `${hooksOf(baseId)}/${created.id}/deliveries`);
      expect(
        after.body.deliveries
          .filter((d: Json) => d.eventId === eventId)
          .map((d: Json) => [d.attempt, d.success])
      ).toEqual([
        [2, true],
        [1, false],
      ]);

      // Off: refused, until it's turned on again.
      await call(creator, 'PATCH', `${hooksOf(baseId)}/${created.id}`, { enabled: false });
      expect((await call(creator, 'POST', path(failed.id))).status).toBe(409);
      await call(creator, 'DELETE', `${hooksOf(baseId)}/${created.id}`);
    });

    it('prunes the delivery log after 7 days', async () => {
      const created = await createHook({ url: url(), events: ['record.created'] });
      await t.db.insert(webhookDeliveries).values([
        {
          workspaceId,
          webhookId: created.id,
          eventId: 'old',
          eventType: 'record.created',
          attempt: 1,
          success: true,
          durationMs: 3,
          createdAt: new Date(Date.now() - 8 * 24 * 3600 * 1000),
        },
        {
          workspaceId,
          webhookId: created.id,
          eventId: 'new',
          eventType: 'record.created',
          attempt: 1,
          success: true,
          durationMs: 3,
        },
      ]);
      expect(await pruneWebhookDeliveries(t.appDb)).toBeGreaterThanOrEqual(1);
      const left = await t.db
        .select({ eventId: webhookDeliveries.eventId })
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.webhookId, created.id));
      expect(left).toEqual([{ eventId: 'new' }]);
      await call(creator, 'DELETE', `${hooksOf(baseId)}/${created.id}`);
    });
  });
});
