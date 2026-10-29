import { randomUUID } from 'node:crypto';
import { PresencePeerSchema } from '@openrows/shared';
import { sql } from 'drizzle-orm';
import { Client } from 'pg';
import { z } from 'zod';
import {
  ACCESS_CHANNEL,
  baseHead,
  lockBaseStream,
  OUTBOX_CHANNEL,
  type OutboxRow,
  readBaseEvents,
} from '../data/outbox.js';
import type { Database, Transaction } from '../db/index.js';
import { PLAN_CHANNEL } from '../edition/plan.js';
import type { Logger } from '../lib/logger.js';
import { NOTIFICATIONS_CHANNEL } from '../notifications/repo.js';

/** Receives a base's committed events, in seq order, each exactly once. */
export type BaseListener = (rows: readonly OutboxRow[]) => void;
/** Called when access may have changed in a workspace (membership, workspace deleted). */
export type AccessListener = (workspaceId: string) => Promise<void> | void;

/**
 * A presence change on the bus (ADR-003 §8): never stored. The gateway that owns the
 * socket publishes it; every other process hands it to its sockets on the view.
 */
export const presenceBusMessageSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('upsert'),
    workspaceId: z.uuid(),
    viewId: z.uuid(),
    peer: PresencePeerSchema,
  }),
  z.object({
    op: z.literal('leave'),
    workspaceId: z.uuid(),
    viewId: z.uuid(),
    connectionId: z.uuid(),
  }),
]);
export type PresenceBusMessage = z.infer<typeof presenceBusMessageSchema>;
/** Called with a user whose notifications changed. */
export type NotificationListener = (userId: string) => void;

export type PlanListener = (workspaceId: string) => void;
/** Receives the presence changes published by other processes. */
export type PresenceListener = (messages: readonly PresenceBusMessage[]) => void;

/** One NOTIFY on `presence`: the publishing process and its batch of changes. */
const presenceFrameSchema = z.object({
  origin: z.uuid(),
  messages: z.array(presenceBusMessageSchema).max(500),
});

export const PRESENCE_CHANNEL = 'presence';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** NOTIFY payloads are capped at 8000 bytes; batches are split below that. */
const PRESENCE_FRAME_BYTES = 7500;
/** Presence changes within this window go out in one NOTIFY (latest per socket and view). */
const PRESENCE_FLUSH_MS = 20;

export interface BaseWatch {
  /** Events after this seq go to the listener; earlier ones are the client's catch-up. */
  seq: number;
  stop(): void;
}

/**
 * Fan-out of outbox events to this process's sockets (ADR-003 §4). `postgres` (self-host, the
 * default) listens on the database; `redis` (hosted, several replicas, M5) is a stub.
 */
export interface EventBus {
  start(): Promise<void>;
  /** Delivers `base`'s events committed after the returned seq to `listener`. */
  watch(base: { baseId: string; workspaceId: string }, listener: BaseListener): Promise<BaseWatch>;
  /** The seq up to which `baseId`'s events were delivered, while it is watched. */
  position(baseId: string): number | undefined;
  onAccessChange(listener: AccessListener): () => void;
  /** Shares a presence change with the other processes (best effort: presence is ephemeral). */
  publishPresence(message: PresenceBusMessage): void;
  /** Presence changes from the other processes (never this one's own). */
  onPresence(listener: PresenceListener): () => void;
  /** Users whose notifications changed, from any process. */
  onNotification(listener: NotificationListener): () => void;
  /** Workspaces whose plan changed (`workspace_plan_set`), from any process. */
  onPlanChange(listener: PlanListener): () => void;
  close(): Promise<void>;
}

/** Splits presence changes into NOTIFY payloads under the size cap. */
export function presenceFrames(origin: string, messages: readonly PresenceBusMessage[]): string[] {
  const frames: string[] = [];
  let batch: PresenceBusMessage[] = [];
  let bytes = 0;
  const overhead = Buffer.byteLength(JSON.stringify({ origin, messages: [] }));
  for (const message of messages) {
    const size = Buffer.byteLength(JSON.stringify(message)) + 1;
    if (
      batch.length > 0 &&
      (overhead + bytes + size > PRESENCE_FRAME_BYTES || batch.length >= 500)
    ) {
      frames.push(JSON.stringify({ origin, messages: batch }));
      batch = [];
      bytes = 0;
    }
    batch.push(message);
    bytes += size;
  }
  if (batch.length > 0) frames.push(JSON.stringify({ origin, messages: batch }));
  return frames;
}

interface Watched {
  workspaceId: string;
  lastSeen: number;
  listeners: Set<BaseListener>;
  /** A fetch is queued: more notifications for the base needn't queue another. */
  queued: boolean;
  /** A fetch found the stream locked by an in-flight writer: retry after this many ms. */
  retryMs: number;
  retry: NodeJS.Timeout | undefined;
}

const PAGE = 1000;
const RETRY_FIRST_MS = 20;
const RETRY_MAX_MS = 1000;
const RECONNECT_MS = 1000;
const HEAD_ATTEMPTS = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The self-hosted bus: one dedicated (unpooled) `LISTEN` connection per process. A NOTIFY on
 * `outbox` carries a base id; if a socket here watches that base, the bus reads
 * `outbox WHERE base_id = $1 AND id > last_seen` (scoped to the base's workspace, under RLS) and
 * hands the rows to the listeners. Everything runs on one queue, so deliveries are in order and
 * an access change is handled before any event committed after it.
 */
export class PostgresEventBus implements EventBus {
  readonly #bases = new Map<string, Watched>();
  readonly #access = new Set<AccessListener>();
  readonly #presence = new Set<PresenceListener>();
  readonly #notifications = new Set<NotificationListener>();
  readonly #plans = new Set<PlanListener>();
  /** This process on the presence channel, to skip its own notifications. */
  readonly #origin = randomUUID();
  /** Presence changes waiting for the next flush, latest per socket and view. */
  readonly #outgoing = new Map<string, PresenceBusMessage>();
  #flush: NodeJS.Timeout | undefined;
  #client: Client | undefined;
  #queue: Promise<void> = Promise.resolve();
  #closed = false;
  #reconnect: NodeJS.Timeout | undefined;

  constructor(
    private readonly db: Database,
    private readonly opts: { connectionString: string; logger: Logger }
  ) {}

  /** Connects; if the database is down, keeps retrying in the background (/ready reports it). */
  async start(): Promise<void> {
    try {
      await this.#connect();
    } catch (err) {
      this.opts.logger.warn({ err }, 'realtime: LISTEN connection failed, retrying');
      this.#scheduleReconnect();
    }
  }

  async #connect(): Promise<void> {
    const client = new Client({ connectionString: this.opts.connectionString });
    client.on('notification', (msg) => {
      if (!msg.payload) return;
      if (msg.channel === OUTBOX_CHANNEL) this.#notified(msg.payload);
      else if (msg.channel === ACCESS_CHANNEL) this.#accessChanged(msg.payload);
      else if (msg.channel === PRESENCE_CHANNEL) this.#presenceNotified(msg.payload);
      else if (msg.channel === NOTIFICATIONS_CHANNEL) this.#notificationNotified(msg.payload);
      else if (msg.channel === PLAN_CHANNEL) this.#planNotified(msg.payload);
    });
    client.on('error', (err) => {
      this.opts.logger.warn({ err }, 'realtime: LISTEN connection error');
      this.#lost(client);
    });
    client.on('end', () => this.#lost(client));
    try {
      await client.connect();
      await client.query(`LISTEN ${OUTBOX_CHANNEL}`);
      await client.query(`LISTEN ${ACCESS_CHANNEL}`);
      await client.query(`LISTEN ${PRESENCE_CHANNEL}`);
      await client.query(`LISTEN ${NOTIFICATIONS_CHANNEL}`);
      await client.query(`LISTEN ${PLAN_CHANNEL}`);
    } catch (err) {
      client.end().catch(() => {});
      throw err;
    }
    this.#client = client;
  }

  /** Reconnects with a pause; notifications sent meanwhile are lost, so every base is re-read. */
  #lost(client: Client) {
    if (this.#client !== client || this.#closed) return;
    this.#client = undefined;
    client.removeAllListeners('notification');
    client.end().catch(() => {});
    this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    if (this.#closed || this.#reconnect) return;
    this.#reconnect = setTimeout(() => {
      this.#reconnect = undefined;
      if (this.#closed) return;
      this.#connect().then(
        () => {
          this.opts.logger.info('realtime: LISTEN connection established');
          for (const baseId of this.#bases.keys()) this.#notified(baseId);
        },
        (err: unknown) => {
          this.opts.logger.warn({ err }, 'realtime: LISTEN reconnect failed');
          this.#scheduleReconnect();
        }
      );
    }, RECONNECT_MS);
    this.#reconnect.unref();
  }

  #enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(job);
    this.#queue = run.then(
      () => {},
      (err: unknown) => this.opts.logger.error({ err }, 'realtime: bus job failed')
    );
    return run;
  }

  #notified(baseId: string) {
    const base = this.#bases.get(baseId);
    if (!base || base.queued) return;
    base.queued = true;
    void this.#enqueue(() => this.#fetch(baseId));
  }

  #planNotified(workspaceId: string) {
    for (const listener of this.#plans) {
      try {
        listener(workspaceId);
      } catch (err) {
        this.opts.logger.warn({ err }, 'realtime: plan listener failed');
      }
    }
  }

  #accessChanged(workspaceId: string) {
    void this.#enqueue(async () => {
      for (const listener of this.#access) await listener(workspaceId);
    });
  }

  /** Runs `fn` in a transaction scoped to the workspace, holding the base's stream lock. */
  async #locked<T>(
    workspaceId: string,
    baseId: string,
    fn: (tx: Transaction) => Promise<T>
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.workspace_id', ${workspaceId}, true)`);
      if (!(await lockBaseStream(tx, baseId))) return { ok: false as const };
      return { ok: true as const, value: await fn(tx) };
    });
  }

  async #fetch(baseId: string): Promise<void> {
    const base = this.#bases.get(baseId);
    if (!base) return;
    base.queued = false;
    const result = await this.#locked(base.workspaceId, baseId, async (tx) => {
      const rows: OutboxRow[] = [];
      for (;;) {
        const page = await readBaseEvents(tx, baseId, rows.at(-1)?.id ?? base.lastSeen, PAGE);
        rows.push(...page);
        if (page.length < PAGE) return rows;
      }
    });
    if (!result.ok) {
      // A writer of this base hasn't committed: its commit notifies, but a rollback doesn't.
      if (!base.retry) {
        base.retry = setTimeout(() => {
          base.retry = undefined;
          this.#notified(baseId);
        }, base.retryMs);
        base.retryMs = Math.min(base.retryMs * 2, RETRY_MAX_MS);
      }
      return;
    }
    base.retryMs = RETRY_FIRST_MS;
    const rows = result.value;
    const last = rows.at(-1);
    if (!last) return;
    base.lastSeen = last.id;
    for (const listener of base.listeners) {
      try {
        listener(rows);
      } catch (err) {
        this.opts.logger.error({ err }, 'realtime: listener failed');
      }
    }
  }

  async #head(workspaceId: string, baseId: string): Promise<number> {
    for (let attempt = 0, wait = RETRY_FIRST_MS; attempt < HEAD_ATTEMPTS; attempt++) {
      const result = await this.#locked(workspaceId, baseId, (tx) => baseHead(tx, baseId));
      if (result.ok) return result.value;
      await sleep(wait);
      wait = Math.min(wait * 2, RETRY_MAX_MS / 4);
    }
    throw new Error('realtime: the base event stream stayed locked');
  }

  watch(
    { baseId, workspaceId }: { baseId: string; workspaceId: string },
    listener: BaseListener
  ): Promise<BaseWatch> {
    return this.#enqueue(async () => {
      let base = this.#bases.get(baseId);
      if (!base) {
        const lastSeen = await this.#head(workspaceId, baseId);
        base = {
          workspaceId,
          lastSeen,
          listeners: new Set(),
          queued: false,
          retryMs: RETRY_FIRST_MS,
          retry: undefined,
        };
        this.#bases.set(baseId, base);
      }
      const watched = base;
      watched.listeners.add(listener);
      return {
        seq: watched.lastSeen,
        stop: () => {
          watched.listeners.delete(listener);
          if (watched.listeners.size === 0 && this.#bases.get(baseId) === watched) {
            clearTimeout(watched.retry);
            this.#bases.delete(baseId);
          }
        },
      };
    });
  }

  position(baseId: string): number | undefined {
    return this.#bases.get(baseId)?.lastSeen;
  }

  onAccessChange(listener: AccessListener): () => void {
    this.#access.add(listener);
    return () => this.#access.delete(listener);
  }

  onPlanChange(listener: PlanListener): () => void {
    this.#plans.add(listener);
    return () => this.#plans.delete(listener);
  }

  publishPresence(message: PresenceBusMessage): void {
    if (this.#closed) return;
    const id = message.op === 'upsert' ? message.peer.connectionId : message.connectionId;
    const key = `${message.viewId}:${id}`;
    // Re-inserted so that a socket's changes keep their order relative to its other views.
    this.#outgoing.delete(key);
    this.#outgoing.set(key, message);
    if (this.#flush) return;
    this.#flush = setTimeout(() => this.#flushPresence(), PRESENCE_FLUSH_MS);
    this.#flush.unref();
  }

  /** NOTIFY on the LISTEN connection itself; while it is down, changes are dropped (the
   * gateway's periodic refresh sends them again). */
  #flushPresence() {
    this.#flush = undefined;
    const messages = [...this.#outgoing.values()];
    this.#outgoing.clear();
    const client = this.#client;
    if (!client || messages.length === 0) return;
    for (const frame of presenceFrames(this.#origin, messages)) {
      client.query('SELECT pg_notify($1, $2)', [PRESENCE_CHANNEL, frame]).catch((err: unknown) => {
        this.opts.logger.warn({ err }, 'realtime: presence NOTIFY failed');
      });
    }
  }

  #presenceNotified(payload: string) {
    let frame: z.infer<typeof presenceFrameSchema>;
    try {
      frame = presenceFrameSchema.parse(JSON.parse(payload));
    } catch (err) {
      this.opts.logger.warn({ err }, 'realtime: malformed presence notification');
      return;
    }
    if (frame.origin === this.#origin) return;
    for (const listener of this.#presence) {
      try {
        listener(frame.messages);
      } catch (err) {
        this.opts.logger.error({ err }, 'realtime: presence listener failed');
      }
    }
  }

  onPresence(listener: PresenceListener): () => void {
    this.#presence.add(listener);
    return () => this.#presence.delete(listener);
  }

  #notificationNotified(payload: string) {
    if (!UUID_RE.test(payload)) return;
    for (const listener of this.#notifications) {
      try {
        listener(payload);
      } catch (err) {
        this.opts.logger.error({ err }, 'realtime: notification listener failed');
      }
    }
  }

  onNotification(listener: NotificationListener): () => void {
    this.#notifications.add(listener);
    return () => this.#notifications.delete(listener);
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#flush);
    this.#outgoing.clear();
    clearTimeout(this.#reconnect);
    for (const base of this.#bases.values()) clearTimeout(base.retry);
    this.#bases.clear();
    const client = this.#client;
    this.#client = undefined;
    await this.#queue;
    await client?.end().catch(() => {});
  }
}

/**
 * The hosted bus (ADR-003 §4): a relay in the worker publishes per-base channels to Redis
 * (Valkey) and every API replica subscribes. Not built yet (M5); selecting it fails at startup
 * so a multi-replica deployment can't silently run without fan-out.
 */
export class RedisEventBus implements EventBus {
  async start(): Promise<void> {
    throw new Error('EVENT_BUS=redis is not implemented yet (M5); use EVENT_BUS=postgres');
  }
  watch(): Promise<BaseWatch> {
    return Promise.reject(new Error('EVENT_BUS=redis is not implemented yet'));
  }
  position(): number | undefined {
    return undefined;
  }
  onAccessChange(): () => void {
    return () => {};
  }
  publishPresence(): void {}
  onPresence(): () => void {
    return () => {};
  }
  onNotification(): () => void {
    return () => {};
  }
  onPlanChange(): () => void {
    return () => {};
  }
  async close(): Promise<void> {}
}

export type EventBusKind = 'postgres' | 'redis';

export function createEventBus(
  kind: EventBusKind,
  deps: { db: Database; databaseUrl: string; logger: Logger }
): EventBus {
  if (kind === 'redis') return new RedisEventBus();
  return new PostgresEventBus(deps.db, {
    connectionString: deps.databaseUrl,
    logger: deps.logger,
  });
}
