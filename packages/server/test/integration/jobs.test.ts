import { and, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { hashSessionToken } from '../../src/auth/session-token.js';
import { pruneOutbox } from '../../src/data/outbox.js';
import { baseSnapshots, bases, createDb, outbox, sessions } from '../../src/db/index.js';
import { startWorkerHttp } from '../../src/jobs/http.js';
import { ensureQueues } from '../../src/jobs/queues.js';
import {
  type OutboxSubscriber,
  type RelayJobData,
  relayJobId,
  relayLag,
  relayOutbox,
} from '../../src/jobs/relay.js';
import {
  builtinQueues,
  type QueueDefinition,
  type RunningWorker,
  startWorker,
} from '../../src/jobs/runtime.js';
import { createJobs, type Jobs } from '../../src/jobs/send.js';
import { tenantJob, tenantJobData, withTenant } from '../../src/jobs/tenant.js';
import { createLogger } from '../../src/lib/logger.js';
import { useTestDb } from '../helpers/db.js';
import { createBase, createSession, createWorkspace } from '../helpers/factories.js';
import { MemoryObjectStore } from '../helpers/object-store.js';
import { relayAll } from '../helpers/outbox.js';

/**
 * The worker on pg-boss (ADR-004): cron once across workers, tenant scope (RLS) in jobs,
 * jobs sent in the request transaction, the outbox relay's crash safety and ordering, and the
 * prunes and snapshots run as pg-boss jobs.
 */
const t = useTestDb();
const logger = createLogger({ level: 'silent' });

const running: RunningWorker[] = [];
afterAll(async () => {
  await Promise.all(running.map((w) => w.stop(2_000)));
});

async function worker(queues: Record<string, QueueDefinition>, name = 'test') {
  const w = await startWorker(
    { db: t.appDb, logger, revisionDays: 365 },
    {
      connectionString: t.appUrl,
      instanceName: name,
      queues,
      pollingIntervalSeconds: 0.5,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      maxConnections: 3,
    }
  );
  running.push(w);
  return w;
}

async function until<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 200));
  }
}

const jobsIn = async (queue: string) =>
  (
    await t.db.execute<{ id: string; state: string; singleton_key: string | null }>(
      sql`SELECT id, state, singleton_key FROM pgboss.job WHERE name = ${queue} ORDER BY created_on`
    )
  ).rows;

/**
 * Waits until `n` events are past the relay's horizon: it's cluster-wide, so a transaction open
 * in another test file's database holds it back for a moment.
 */
async function relayable(n: number) {
  await until(async () => {
    const { rows } = await t.appDb.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM outbox_relay_next(1000)`
    );
    return (rows[0]?.n ?? 0) >= n;
  });
}

async function event(workspaceId: string, baseId: string, kind = 'record.updated') {
  const [row] = await t.db
    .insert(outbox)
    .values({ workspaceId, baseId, kind, payload: {} })
    .returning({ id: outbox.id });
  return row?.id ?? 0;
}

describe('worker on pg-boss', () => {
  it('runs a cron occurrence once with two worker instances', async () => {
    const runs: string[] = [];
    const queues = (): Record<string, QueueDefinition> => ({
      'test.cron': {
        spec: { policy: 'stately', retryLimit: 0, cron: '* * * * *' },
        handler: async (_data, { job }) => {
          runs.push(job.id);
        },
      },
    });
    await Promise.all([worker(queues(), 'one'), worker(queues(), 'two')]);
    // pg-boss sends an occurrence while it is less than a minute old, so the one that just passed
    // runs at once; one more follows if the wait crosses a minute boundary.
    await until(async () => runs.length > 0, 75_000);
    await new Promise((r) => setTimeout(r, 3_000));
    // Both workers' cron passes forward each occurrence through pg-boss's send-it queue, filed
    // under the schedule and the occurrence's minute: the second instance's copy is dropped there.
    const { forwarded, jobs } = await until(async () => {
      const { rows: forwarded } = await t.db.execute<{ slot: string; state: string }>(
        sql`SELECT singleton_on::text AS slot, state FROM pgboss.job
            WHERE name = '__pgboss__send-it' AND data->>'name' = 'test.cron'`
      );
      const jobs = await jobsIn('test.cron');
      const settled = [...forwarded, ...jobs].every((j) => j.state === 'completed');
      return settled && runs.length >= jobs.length && { forwarded, jobs };
    });
    // One forward and one job per occurrence, each run once, by one of the two workers.
    expect(forwarded.length).toBeGreaterThan(0);
    expect(new Set(forwarded.map((f) => f.slot)).size).toBe(forwarded.length);
    expect(jobs).toHaveLength(forwarded.length);
    expect(runs.sort()).toEqual(jobs.map((j) => j.id).sort());
    expect(new Set(runs).size).toBe(runs.length);
  }, 120_000);

  it("runs a tenant job in its workspace's scope: it sees only that tenant's rows", async () => {
    const a = await createWorkspace(t.db);
    const b = await createWorkspace(t.db);
    const mine = await createBase(t.db, a.workspace.id, { name: 'A base' });
    await createBase(t.db, b.workspace.id, { name: 'B base' });
    const seen: { workspaceId: string; bases: string[] }[] = [];
    await worker({
      'test.tenant': {
        spec: { retryLimit: 0 },
        handler: tenantJob(t.appDb, tenantJobData, async (tx, data) => {
          const rows = await tx.select({ id: bases.id }).from(bases);
          seen.push({ workspaceId: data.workspaceId, bases: rows.map((r) => r.id) });
        }),
      },
    });

    // The API's Jobs: a rolled-back transaction sends nothing, a committed one sends the job.
    const api = createDb(t.appUrl);
    const jobs: Jobs = createJobs(api.db);
    try {
      await expect(
        withTenant(api.db, a.workspace.id, async (tx) => {
          await jobs.send(tx, 'test.tenant', { workspaceId: a.workspace.id });
          throw new Error('rolled back');
        })
      ).rejects.toThrow('rolled back');
      expect(await jobsIn('test.tenant')).toHaveLength(0);
      const id = await withTenant(api.db, a.workspace.id, (tx) =>
        jobs.send(tx, 'test.tenant', { workspaceId: a.workspace.id })
      );
      expect(id).toEqual(expect.any(String));
    } finally {
      await jobs.stop();
      await api.close();
    }
    await until(async () => seen.length > 0);
    expect(seen).toEqual([{ workspaceId: a.workspace.id, bases: [mine.id] }]);

    // Without a scope, openrows_app sees no tenant rows at all.
    expect(await t.appDb.select().from(bases)).toEqual([]);
  });

  it('fails a tenant job with bad data into its dead-letter queue', async () => {
    await worker({
      'test.bad': {
        spec: { retryLimit: 0 },
        handler: tenantJob(t.appDb, tenantJobData.extend({ n: z.number() }), async () => {}),
      },
    });
    const w = running.at(-1);
    await w?.boss.send('test.bad', { workspaceId: 'not-a-uuid' });
    const dead = await until(async () => {
      const rows = await jobsIn('test.bad.dead');
      return rows.length > 0 && rows;
    });
    expect(dead).toHaveLength(1);
    expect((await jobsIn('test.bad'))[0]?.state).toBe('failed');
  });

  describe('outbox relay', () => {
    const delivered: RelayJobData[] = [];
    const subscriber = (ids: string[]): OutboxSubscriber => ({
      queue: 'test.relay',
      match: async (events) =>
        events.flatMap((event) => ids.map((subscriberId) => ({ event, subscriberId }))),
    });
    let w: RunningWorker;
    let workspaceId: string;
    let baseId: string;
    const insert = (queue: string, jobs: Parameters<RunningWorker['boss']['insert']>[1]) =>
      w.boss.insert(queue, jobs);

    beforeAll(async () => {
      const { workspace } = await createWorkspace(t.db);
      workspaceId = workspace.id;
      baseId = (await createBase(t.db, workspaceId)).id;
      w = await worker({
        'test.relay': {
          spec: { retryLimit: 0 },
          handler: async (data) => {
            delivered.push(data as RelayJobData);
          },
        },
      });
      // Start from the end of what's already there.
      await relayOutbox(t.appDb, insert, []);
    });

    it('creates no duplicates when it crashes between enqueue and cursor update', async () => {
      const ids = [await event(workspaceId, baseId), await event(workspaceId, baseId)];
      await relayable(2);
      const subs = [subscriber(['s1', 's2'])];
      await expect(
        relayOutbox(t.appDb, insert, subs, {
          afterEnqueue: async () => {
            throw new Error('crash');
          },
        })
      ).rejects.toThrow('crash');
      // The jobs were sent and even run; the cursor didn't move.
      await until(async () => delivered.length === 4);
      const replay = await relayOutbox(t.appDb, insert, subs);
      expect(replay).toEqual({ events: 2, matches: 4 });
      expect(await relayOutbox(t.appDb, insert, subs)).toEqual({ events: 0, matches: 0 });
      await new Promise((r) => setTimeout(r, 1_500));

      const jobs = await jobsIn('test.relay');
      expect(jobs).toHaveLength(4);
      expect(jobs.map((j) => j.singleton_key).sort()).toEqual(
        ids.flatMap((id) => [`${id}:s1`, `${id}:s2`]).sort()
      );
      expect(jobs.map((j) => j.id).sort()).toEqual(
        ids.flatMap((id) => [relayJobId(id, 's1'), relayJobId(id, 's2')]).sort()
      );
      expect(delivered).toHaveLength(4);
      expect(delivered).toContainEqual({ workspaceId, outboxId: ids[0], subscriberId: 's1' });
    });

    it('never skips a row whose transaction commits after a later id', async () => {
      const subs = [subscriber(['late'])];
      const client = new pg.Client({ connectionString: t.url });
      await client.connect();
      try {
        await client.query('BEGIN');
        const early = await client.query<{ id: string }>(
          `INSERT INTO outbox (workspace_id, base_id, kind) VALUES ($1, $2, 'record.created')
           RETURNING id`,
          [workspaceId, baseId]
        );
        const later = await event(workspaceId, baseId);
        expect(later).toBeGreaterThan(Number(early.rows[0]?.id));
        // The later id is committed, but an older transaction is still open: wait for it.
        expect(await relayOutbox(t.appDb, insert, subs)).toEqual({ events: 0, matches: 0 });
        await client.query('COMMIT');
        await relayable(2);
        expect(await relayOutbox(t.appDb, insert, subs)).toEqual({ events: 2, matches: 2 });
        const keys = (await jobsIn('test.relay')).map((j) => j.singleton_key);
        expect(keys).toEqual(
          expect.arrayContaining([`${early.rows[0]?.id}:late`, `${later}:late`])
        );
      } finally {
        await client.end();
      }
    });

    it('never prunes an event the relay has not read, and reports its age (#124)', async () => {
      await relayAll(t.appDb);
      const ids = [
        await event(workspaceId, baseId),
        await event(workspaceId, baseId),
        await event(workspaceId, baseId),
      ];
      await relayable(3);
      // The worker was down for a month: every event is past the 7-day retention.
      await t.db.execute(sql`UPDATE outbox SET created_at = now() - interval '30 days'`);
      // It comes back and reads only the first event before the prune runs.
      expect(await relayOutbox(t.appDb, insert, [], { batch: 1, maxBatches: 1 })).toEqual({
        events: 1,
        matches: 0,
      });
      const lag = await relayLag(t.appDb);
      expect(lag?.pending).toBeGreaterThanOrEqual(2);
      expect(lag?.oldestPendingAgeSeconds).toBeGreaterThan(29 * 24 * 3600);
      await pruneOutbox(t.appDb, 7);
      const left = async () =>
        (
          await t.db
            .select({ id: outbox.id })
            .from(outbox)
            .where(sql`${outbox.id} IN (${sql.join(ids, sql`, `)})`)
        )
          .map((r) => r.id)
          .sort((a, b) => a - b);
      expect(await left()).toEqual(ids.slice(1));
      // The floor stays below every remaining event, so catch-up reads them all.
      const { rows } = await t.appDb.execute<{ floor: string }>(
        sql`SELECT outbox_floor() AS floor`
      );
      expect(Number(rows[0]?.floor)).toBeLessThan(ids[1] ?? 0);
      // Relayed, they go.
      await relayAll(t.appDb);
      expect((await relayLag(t.appDb))?.oldestPendingAgeSeconds).toBe(0);
      await pruneOutbox(t.appDb, 7);
      expect(await left()).toEqual([]);
    });

    it('is reachable only through its functions', async () => {
      await expect(t.appDb.execute(sql`SELECT * FROM outbox_relay_cursor`)).rejects.toThrow();
      await expect(
        t.appDb.execute(sql`UPDATE outbox_relay_cursor SET outbox_id = 0`)
      ).rejects.toThrow();
      // The cursor only moves forward.
      const { rows } = await t.appDb.execute<{ moved: boolean }>(
        sql`SELECT outbox_relay_advance('1'::xid8, 1) AS moved`
      );
      expect(rows[0]?.moved).toBe(false);
    });
  });

  it('runs the prunes and snapshots as pg-boss jobs, once at start', async () => {
    const { workspace, owner } = await createWorkspace(t.db);
    const base = await createBase(t.db, workspace.id);
    // The prune walks ids in order (they follow time): age everything there so far.
    await t.db.execute(sql`UPDATE outbox SET created_at = now() - interval '30 days'`);
    // The prune only takes events the relay has read.
    await relayAll(t.appDb);
    // An expired session, for the sweep that moved here from the API's timer.
    const expired = await createSession(t.db, owner);
    await t.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.idHash, hashSessionToken(expired)));
    const live = await createSession(t.db, owner);
    // A recent change, so the base is due an automatic snapshot.
    await event(workspace.id, base.id);
    const store = new MemoryObjectStore();
    const w = await worker(
      builtinQueues({ db: t.appDb, logger, store, revisionDays: 365 }),
      'builtin'
    );
    expect(w.queues.sort()).toEqual([
      'ai.generate',
      'attachments.gc',
      'automations.prune',
      'automations.run',
      'automations.schedule',
      'bases.duplicate',
      'computed.refresh',
      'computed.volatile',
      'imports.run',
      'jobs.sweep',
      'notifications.prune',
      'outbox.prune',
      'outbox.relay',
      'purge.deleted',
      'purge.trash',
      'ratelimit.prune',
      'revisions.prune',
      'sessions.sweep',
      'snapshots.auto',
      'snapshots.prune',
      'snapshots.restore',
      'syncs.run',
      'syncs.schedule',
      'usage.reconcile',
      'webhooks.prune',
    ]);
    await until(async () => {
      const { rows } = await t.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM outbox WHERE created_at < now() - interval '7 days'`
      );
      return rows[0]?.n === 0;
    });
    await until(async () => {
      const rows = await t.db.select({ idHash: sessions.idHash }).from(sessions);
      const hashes = rows.map((r) => r.idHash);
      return !hashes.includes(hashSessionToken(expired)) && hashes;
    }).then((hashes) => expect(hashes).toContain(hashSessionToken(live)));
    const snaps = await until(async () => {
      const rows = await t.db
        .select()
        .from(baseSnapshots)
        .where(and(eq(baseSnapshots.baseId, base.id), eq(baseSnapshots.kind, 'auto')));
      return rows.length > 0 && rows;
    });
    expect(snaps).toHaveLength(1);
    expect(await store.head(snaps[0]?.storageKey ?? '')).not.toBeNull();

    const schedules = await t.db.execute<{ name: string; cron: string }>(
      sql`SELECT name, cron FROM pgboss.schedule ORDER BY name`
    );
    expect(schedules.rows).toEqual(
      expect.arrayContaining([
        { name: 'automations.schedule', cron: '* * * * *' },
        { name: 'outbox.prune', cron: '0 * * * *' },
        { name: 'outbox.relay', cron: '* * * * *' },
        { name: 'snapshots.auto', cron: '10 * * * *' },
      ])
    );

    // Health and metrics for the Compose healthcheck and Prometheus.
    const http = await startWorkerHttp(() => w, { port: 0, host: '127.0.0.1', logger });
    try {
      const health = await fetch(`http://127.0.0.1:${http.port}/health`);
      expect(health.status).toBe(200);
      const metrics = await (await fetch(`http://127.0.0.1:${http.port}/metrics`)).text();
      expect(metrics).toContain('openrows_jobs_queued{queue="outbox.prune"}');
      expect(metrics).toContain('openrows_job_failures_total{queue="snapshots.auto"} 0');
      expect(metrics).toMatch(/openrows_outbox_relay_pending \d+/);
      expect((await fetch(`http://127.0.0.1:${http.port}/other`)).status).toBe(404);
      await w.stop(2_000);
      expect((await fetch(`http://127.0.0.1:${http.port}/health`)).status).toBe(503);
    } finally {
      await http.close();
    }
  });

  it('creates queues idempotently, with a dead-letter queue each', async () => {
    const w = running[0];
    if (!w) throw new Error('no worker');
    await ensureQueues(w.boss, { 'test.idem': { retryLimit: 1 } });
    await ensureQueues(w.boss, { 'test.idem': { retryLimit: 4 } });
    const queue = await w.boss.getQueue('test.idem');
    expect(queue).toMatchObject({ retryLimit: 4, deadLetter: 'test.idem.dead' });
  });
});
