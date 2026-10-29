import { sql } from 'drizzle-orm';
import type { JobInsert } from 'pg-boss';
import { aiFieldSubscriber } from '../ai/fields/generate.js';
import { automationSubscriber } from '../automations/subscriber.js';
import { seatSubscriber } from '../billing/seats.js';
import type { Database } from '../db/index.js';
import { webhookSubscriber } from '../webhooks/subscriber.js';
import { computedSubscriber } from './computed.js';
import { workspaceGroup } from './defer.js';
import { namedJobId } from './ids.js';

/** One outbox row as the relay sees it: metadata only, never the payload. */
export interface RelayEvent {
  id: number;
  /** The writing transaction (xid8, as text). */
  txid: string;
  workspaceId: string;
  baseId: string | null;
  tableId: string | null;
  kind: string;
  actorId: string | null;
  createdAt: Date;
}

/** What a relayed job carries: its handler reads the event under the tenant's scope. */
export interface RelayJobData {
  workspaceId: string;
  outboxId: number;
  subscriberId: string;
}

/**
 * Something that wants jobs for outbox events: webhooks and automations. `match` gets a
 * batch of events and answers which subscriber, by a stable id (a webhook's id), wants each.
 * Its `db` is openrows_app without a scope: read tenant rows through `withTenant`.
 */
export interface OutboxSubscriber {
  /** The queue its jobs go to; it must be one the worker creates. */
  queue: string;
  match(
    events: readonly RelayEvent[],
    db: Database
  ): Promise<
    {
      event: RelayEvent;
      subscriberId: string;
      singletonKey?: string;
      /** Seconds to wait before the job runs (debounces with a stately singletonKey). */
      startAfter?: number;
    }[]
  >;
}

/**
 * The subscriber registry: webhooks, background recomputes, automations,
 * the seat sync (only run with per-seat billing) and AI field answers. The worker relays to those whose queue
 * it runs.
 */
export const OUTBOX_SUBSCRIBERS: readonly OutboxSubscriber[] = [
  webhookSubscriber,
  computedSubscriber,
  automationSubscriber,
  seatSubscriber,
  aiFieldSubscriber,
];

/** Sends a batch of jobs to one queue; pg-boss's `insert` skips ids that already exist. */
export type JobInserter = (queue: string, jobs: JobInsert<RelayJobData>[]) => Promise<unknown>;

const RELAY_NAMESPACE = 'openrows:outbox-relay:';

/**
 * The job id of (outbox row, subscriber): a name-based UUID (version 5 layout, SHA-1), so the
 * same match always gets the same id. pg-boss inserts with ON CONFLICT DO NOTHING on (queue, id),
 * which is what makes a replayed batch enqueue nothing new, even after the first job completed.
 */
export function relayJobId(outboxId: number, subscriberId: string): string {
  return namedJobId(`${RELAY_NAMESPACE}${outboxId}:${subscriberId}`);
}

export const RELAY_BATCH = 500;
/** Batches per run; the relay runs again on the next minute or notify. */
export const RELAY_MAX_BATCHES = 20;

export interface RelayOptions {
  batch?: number;
  maxBatches?: number;
  /** Test hook: runs after a batch's jobs are sent, before the cursor moves (a crash point). */
  afterEnqueue?: () => Promise<void>;
}

/**
 * The outbox relay (ADR-004): reads outbox rows past the stored cursor (outbox_relay_next,
 * in (txid, id) order, only rows of finished transactions), asks every subscriber which of them
 * it wants, sends one job per match (id from `relayJobId`, singletonKey the subscriber's or `<outbox id>:<subscriber
 * id>`), then moves the cursor. A crash between the two replays the batch next time, and the
 * fixed job ids make the replay a no-op. Returns how many events it read and jobs it sent.
 */
export async function relayOutbox(
  db: Database,
  insert: JobInserter,
  subscribers: readonly OutboxSubscriber[],
  opts: RelayOptions = {}
): Promise<{ events: number; matches: number }> {
  const batch = opts.batch ?? RELAY_BATCH;
  let events = 0;
  let matches = 0;
  for (let i = 0; i < (opts.maxBatches ?? RELAY_MAX_BATCHES); i++) {
    const { rows } = await db.execute<{
      id: string;
      txid: string;
      workspace_id: string;
      base_id: string | null;
      table_id: string | null;
      kind: string;
      actor_id: string | null;
      created_at: string;
    }>(sql`SELECT * FROM outbox_relay_next(${batch})`);
    const last = rows.at(-1);
    if (!last) break;
    const read: RelayEvent[] = rows.map((r) => ({
      id: Number(r.id),
      txid: r.txid,
      workspaceId: r.workspace_id,
      baseId: r.base_id,
      tableId: r.table_id,
      kind: r.kind,
      actorId: r.actor_id,
      createdAt: new Date(r.created_at),
    }));
    const byQueue = new Map<string, JobInsert<RelayJobData>[]>();
    for (const subscriber of subscribers) {
      for (const match of await subscriber.match(read, db)) {
        const { event, subscriberId, singletonKey, startAfter } = match;
        const jobs = byQueue.get(subscriber.queue) ?? [];
        jobs.push({
          id: relayJobId(event.id, subscriberId),
          singletonKey: singletonKey ?? `${event.id}:${subscriberId}`,
          ...(startAfter ? { startAfter } : {}),
          // Per-workspace concurrency on the queues that cap it.
          group: workspaceGroup(event.workspaceId),
          data: { workspaceId: event.workspaceId, outboxId: event.id, subscriberId },
        });
        byQueue.set(subscriber.queue, jobs);
      }
    }
    for (const [queue, jobs] of byQueue) {
      await insert(queue, jobs);
      matches += jobs.length;
    }
    await opts.afterEnqueue?.();
    await db.execute(sql`SELECT outbox_relay_advance(${last.txid}::xid8, ${last.id}::bigint)`);
    events += rows.length;
    if (rows.length < batch) break;
  }
  return { events, matches };
}

/** Where the relay stands: global numbers, no tenant data. */
export interface RelayLag {
  /** Outbox events past the relay cursor. */
  pending: number;
  /** Seconds since the cursor last moved. */
  cursorAgeSeconds: number;
  /** Seconds since the oldest event past the cursor was written; 0 when none is. */
  oldestPendingAgeSeconds: number;
}

/** The relay's lag (`outbox_relay_lag`, drizzle/0065), for the metrics and /ready. */
export async function relayLag(db: Pick<Database, 'execute'>): Promise<RelayLag | undefined> {
  const { rows } = await db.execute<{
    pending: string;
    cursor_age_seconds: number;
    oldest_pending_age_seconds: number;
  }>(sql`SELECT * FROM outbox_relay_lag()`);
  const row = rows[0];
  if (!row) return undefined;
  return {
    pending: Number(row.pending),
    cursorAgeSeconds: Math.round(Number(row.cursor_age_seconds)),
    oldestPendingAgeSeconds: Math.round(Number(row.oldest_pending_age_seconds)),
  };
}
