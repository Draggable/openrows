import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCipher } from '../../src/auth/crypto.js';
import { inScope } from '../../src/authz/scope.js';
import { type tables, type users, webhooks } from '../../src/db/index.js';
import { unlimitedEntitlements } from '../../src/edition/oss.js';
import { builtinQueues, type RunningWorker, startWorker } from '../../src/jobs/runtime.js';
import { createLogger } from '../../src/lib/logger.js';
import { createSafeFetch, outboundPolicy } from '../../src/lib/safe-fetch/index.js';
import { configOutboundLimits, OutboundGate, OutboundSlots } from '../../src/outbound/limits.js';
import { PostgresRateLimiter } from '../../src/ratelimit/postgres.js';
import { createRecords } from '../../src/records/service.js';
import { useTestDb } from '../helpers/db.js';
import { createBase, createTableWithFields, createWorkspace } from '../helpers/factories.js';
import { relayAll } from '../helpers/outbox.js';

type User = typeof users.$inferSelect;
type Table = typeof tables.$inferSelect;

interface Hit {
  path: string;
  at: number;
  eventId: string;
}

/**
 * A slow receiver: answers each request after `delayMs`, and counts how many requests of each
 * path are in flight at once (the most it saw).
 */
function slowReceiver(delayMs: number) {
  const hits: Hit[] = [];
  const inFlight = new Map<string, number>();
  const maxInFlight = new Map<string, number>();
  const server: Server = createServer((req, res) => {
    const path = req.url ?? '';
    const now = (inFlight.get(path) ?? 0) + 1;
    inFlight.set(path, now);
    maxInFlight.set(path, Math.max(maxInFlight.get(path) ?? 0, now));
    req.resume();
    req.on('end', () => {
      setTimeout(() => {
        inFlight.set(path, (inFlight.get(path) ?? 1) - 1);
        hits.push({ path, at: Date.now(), eventId: String(req.headers['x-openrows-event-id']) });
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      }, delayMs);
    });
  });
  return {
    hits,
    maxInFlight,
    start: () =>
      new Promise<number>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
      ),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function until<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const ENCRYPTION_KEY = 'outbound-test-encryption-key-0123456789abcdef';

/**
 * Per-workspace outbound limits with a real worker on pg-boss: a noisy workspace's
 * webhook deliveries are capped at its concurrency and rate, and another workspace's delivery
 * isn't stuck behind them; deliveries over the rate are put back in the queue (same event id),
 * never dropped or failed.
 */
describe('outbound limits per workspace', () => {
  const t = useTestDb();
  const logger = createLogger({ level: 'silent' });
  const cipher = createCipher(ENCRYPTION_KEY, 'webhook-secret');
  const hook = slowReceiver(300);
  let port: number;
  const running: RunningWorker[] = [];

  interface Tenant {
    owner: User;
    workspaceId: string;
    table: Table;
  }
  let noisy: Tenant;
  let quiet: Tenant;

  async function tenant(path: string): Promise<Tenant> {
    const { workspace, owner } = await createWorkspace(t.db);
    const base = await createBase(t.db, workspace.id);
    const { table } = await createTableWithFields(t.db, owner, base);
    await t.db.insert(webhooks).values({
      workspaceId: workspace.id,
      baseId: base.id,
      url: `http://127.0.0.1:${port}${path}`,
      events: ['record.created'],
      secretEncrypted: cipher.encrypt('whsec_outbound_test'),
      createdBy: owner.id,
    });
    return { owner, workspaceId: workspace.id, table };
  }

  const addRecords = (who: Tenant, n: number) =>
    inScope(t.appDb, { userId: who.owner.id, workspaceId: who.workspaceId }, (tx) =>
      createRecords(
        {
          tx,
          workspaceId: who.workspaceId,
          userId: who.owner.id,
          role: 'owner',
          entitlements: unlimitedEntitlements(),
          table: who.table,
        },
        Array.from({ length: n }, () => ({}))
      )
    );

  async function worker(limits: { perMinute: number; burst: number; concurrency: number }) {
    const outbound = configOutboundLimits(limits);
    const queues = builtinQueues({
      db: t.appDb,
      logger,
      revisionDays: 365,
      webhooks: {
        cipher,
        http: createSafeFetch(
          outboundPolicy({ allowHttp: true, extraPorts: [port], allow: ['127.0.0.1'], deny: [] })
        ),
        appUrl: 'http://localhost:5173',
      },
      outbound: {
        limits: outbound,
        gate: new OutboundGate(new PostgresRateLimiter(t.appDb), outbound),
        waitMs: 200,
      },
    });
    const deliver = queues['webhooks.deliver'];
    const relay = queues['outbox.relay'];
    if (!deliver || !relay) throw new Error('no webhook queues');
    const w = await startWorker(
      { db: t.appDb, logger, revisionDays: 365 },
      {
        connectionString: t.appUrl,
        instanceName: 'outbound',
        queues: { 'outbox.relay': relay, 'webhooks.deliver': deliver },
        pollingIntervalSeconds: 0.5,
        cronMonitorIntervalSeconds: 1,
        cronWorkerIntervalSeconds: 1,
        maxConnections: 6,
      }
    );
    running.push(w);
    return w;
  }

  beforeAll(async () => {
    port = await hook.start();
    noisy = await tenant('/noisy');
    quiet = await tenant('/quiet');
  });

  afterAll(async () => {
    await Promise.all(running.map((w) => w.stop(2_000).catch(() => {})));
    await hook.stop();
  });

  it('hands out at most the cap of slots per workspace and kind, reachable only by function', async () => {
    const slots = new OutboundSlots(t.appDb);
    const ws = noisy.workspaceId;
    expect(await slots.take('webhooks', ws, 2, 'job-1', 60)).toBe(true);
    expect(await slots.take('webhooks', ws, 2, 'job-2', 60)).toBe(true);
    expect(await slots.take('webhooks', ws, 2, 'job-3', 60)).toBe(false);
    // A retried handler keeps its slot; another kind and another workspace have their own.
    expect(await slots.take('webhooks', ws, 2, 'job-1', 60)).toBe(true);
    expect(await slots.take('automations', ws, 2, 'job-3', 60)).toBe(true);
    expect(await slots.take('webhooks', quiet.workspaceId, 2, 'job-3', 60)).toBe(true);
    await slots.release('webhooks', ws, 'job-2');
    expect(await slots.take('webhooks', ws, 2, 'job-3', 60)).toBe(true);
    // A crashed worker's slot expires.
    await t.db.execute(sql`UPDATE outbound_leases SET expires_at = now() - interval '1 second'
                            WHERE holder = 'job-1'`);
    expect(await slots.take('webhooks', ws, 2, 'job-4', 60)).toBe(true);
    await expect(t.appDb.execute(sql`SELECT * FROM outbound_leases`)).rejects.toThrow();
    await expect(t.appDb.execute(sql`DELETE FROM outbound_leases`)).rejects.toThrow();
    await t.db.execute(sql`DELETE FROM outbound_leases`);
  });

  it("caps a noisy workspace's concurrent deliveries; another workspace's goes ahead", async () => {
    await relayAll(t.appDb);
    const w = await worker({ perMinute: 6000, burst: 1000, concurrency: 2 });
    try {
      // 24 deliveries for the noisy workspace, then one for the quiet one, in one relay batch.
      await addRecords(noisy, 24);
      await addRecords(quiet, 1);
      await w.boss.send('outbox.relay', null);
      const quietHit = await until(async () => hook.hits.find((h) => h.path === '/quiet'));
      const noisyBefore = hook.hits.filter((h) => h.path === '/noisy' && h.at <= quietHit.at);
      // The quiet delivery didn't wait for the noisy backlog (24 × 300 ms / 2 ≈ 3.6 s).
      expect(noisyBefore.length).toBeLessThan(24);
      await until(async () => hook.hits.filter((h) => h.path === '/noisy').length === 24);
      // Never more than the cap of the noisy workspace's requests at once.
      expect(hook.maxInFlight.get('/noisy')).toBeLessThanOrEqual(2);
      expect(hook.maxInFlight.get('/noisy')).toBeGreaterThanOrEqual(1);
    } finally {
      await w.stop(2_000);
    }
  }, 90_000);

  it('delays deliveries over the rate, keeping their event ids, and never fails them', async () => {
    await relayAll(t.appDb);
    hook.hits.length = 0;
    // One token every 2 s after a burst of 2; the gate waits 200 ms at most, then defers.
    const w = await worker({ perMinute: 30, burst: 2, concurrency: 4 });
    try {
      await addRecords(noisy, 5);
      await addRecords(quiet, 1);
      await w.boss.send('outbox.relay', null);
      // All five arrive in the end, each event once.
      const all = await until(async () => {
        const got = hook.hits.filter((h) => h.path === '/noisy');
        return got.length >= 5 && got;
      }, 90_000);
      expect(new Set(all.map((h) => h.eventId)).size).toBe(5);
      // Two at once, then one token every 2 s: the last came seconds after the first.
      const times = all.map((h) => h.at).sort((a, b) => a - b);
      expect((times[4] ?? 0) - (times[0] ?? 0)).toBeGreaterThan(3_000);
      // The quiet workspace's bucket is its own: it didn't wait for the noisy one's.
      const quietHit = hook.hits.find((h) => h.path === '/quiet');
      expect(quietHit?.at).toBeLessThan(times[4] ?? 0);
      // The others were put back in the queue (copies carry the event id), not failed.
      const copies = await t.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM pgboss.job
             WHERE name = 'webhooks.deliver' AND data->>'workspaceId' = ${noisy.workspaceId}
               AND data ? 'eventId'`
      );
      expect(copies.rows[0]?.n).toBeGreaterThan(0);
      const failed = await t.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM pgboss.job
             WHERE name LIKE 'webhooks.deliver%' AND state IN ('failed', 'retry')`
      );
      expect(failed.rows[0]?.n).toBe(0);
      const attempts = await t.db.execute<{ attempt: number }>(
        sql`SELECT attempt FROM webhook_deliveries WHERE workspace_id = ${noisy.workspaceId}`
      );
      expect(attempts.rows.every((r) => r.attempt === 1)).toBe(true);
    } finally {
      await w.stop(2_000);
    }
  }, 120_000);
});
