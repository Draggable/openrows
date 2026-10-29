import { sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { type BucketPolicy, type RateLimiter, retryAfter } from '../ratelimit/limiter.js';

/**
 * Per-workspace limits on what the worker sends out: webhook deliveries, automations'
 * email, HTTP and Slack steps and run-script `fetch` calls. One tenant can't fill the worker's
 * slots or use the server to flood a third party; over the limits, work is delayed, never dropped.
 *
 * - The **rate**: a token bucket per workspace (`outbound:<workspace id>`) in the API's rate limit
 *   store, shared by every worker. Each outbound request takes one token.
 * - The **concurrency**: at most that many of a workspace's deliveries, and of its automation
 *   runs, at once across every worker. pg-boss's group concurrency on `webhooks.deliver` and
 *   `automations.run` (each job's group is its workspace) keeps the excess in the queue while
 *   other workspaces' jobs go ahead; its count is a snapshot, so a job also takes one of the
 *   workspace's `OutboundSlots`, and one that finds none is deferred for SLOT_RETRY_SECONDS.
 *
 * The limits come from the config (OUTBOUND_WORKSPACE_*) today; the hosted plans
 * plug in through `OutboundLimits.rateFor` (and pg-boss's group tiers for the concurrency).
 */
export interface OutboundLimits {
  /** A workspace's bucket: tokens per second and burst. */
  rateFor(workspaceId: string): BucketPolicy | Promise<BucketPolicy>;
  /** Active webhook deliveries, and automation runs, per workspace at once (each queue). */
  concurrency: number;
}

export interface OutboundLimitConfig {
  /** Requests per minute per workspace. */
  perMinute: number;
  /** Requests at once after a quiet period. */
  burst: number;
  concurrency: number;
}

export const DEFAULT_OUTBOUND_LIMITS: OutboundLimitConfig = {
  perMinute: 600,
  burst: 100,
  concurrency: 4,
};

/** The same limits for every workspace, from the config. */
export function configOutboundLimits(config: OutboundLimitConfig): OutboundLimits {
  const policy = { perSecond: config.perMinute / 60, burst: config.burst };
  return { rateFor: () => policy, concurrency: config.concurrency };
}

/** A workspace's outbound budget is spent for now: retry the work after `retryAfterSeconds`. */
export class OutboundDeferred extends Error {
  override name = 'OutboundDeferred';
  constructor(readonly retryAfterSeconds: number) {
    super(`outbound rate limit: retry in ${retryAfterSeconds}s`);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Takes one token from a workspace's outbound bucket before each request. A short wait (up to
 * `maxWaitMs`, the next token's arrival at most) is spent here; past that, `OutboundDeferred`
 * says when to try again, and the caller puts the whole job back in the queue for then.
 */
export class OutboundGate {
  constructor(
    private readonly limiter: RateLimiter,
    private readonly limits: Pick<OutboundLimits, 'rateFor'>,
    private readonly wait: (ms: number) => Promise<void> = sleep,
    private readonly now: () => number = Date.now
  ) {}

  /** Resolves once the request may go; throws OutboundDeferred when it must wait longer. */
  async acquire(workspaceId: string, maxWaitMs: number): Promise<void> {
    const policy = await this.limits.rateFor(workspaceId);
    if (!(policy.perSecond > 0) || !(policy.burst >= 1)) return;
    const deadline = this.now() + maxWaitMs;
    for (;;) {
      const decision = await this.limiter.take([
        { kind: 'outbound', key: `outbound:${workspaceId}`, policy },
      ]);
      if (decision.allowed) return;
      const bucket = decision.buckets[0];
      const seconds = bucket ? retryAfter(bucket) : 1;
      const waitMs = Math.max(
        50,
        Math.ceil((1 - (bucket?.level ?? 0)) * (1000 / policy.perSecond))
      );
      if (this.now() + waitMs > deadline) throw new OutboundDeferred(Math.max(1, seconds));
      await this.wait(waitMs);
    }
  }
}

/** How long a job waits before it tries again when its workspace's slots are all taken. */
export const SLOT_RETRY_SECONDS = 2;

/**
 * A workspace's concurrency slots for one kind of outbound work (`webhooks`,
 * `automations`), in Postgres (`outbound_lease_take`, drizzle/0067) so every worker shares them.
 */
export class OutboundSlots {
  constructor(private readonly db: Pick<Database, 'execute'>) {}

  /** Takes a free slot below `cap` for `holder` (a job id) for `seconds`; false when none is. */
  async take(kind: string, workspaceId: string, cap: number, holder: string, seconds: number) {
    const { rows } = await this.db.execute<{ ok: boolean }>(
      sql`SELECT outbound_lease_take(${slotKey(kind, workspaceId)}, ${cap}, ${holder}, ${Math.ceil(seconds)}) AS ok`
    );
    return rows[0]?.ok === true;
  }

  async release(kind: string, workspaceId: string, holder: string): Promise<void> {
    await this.db.execute(
      sql`SELECT outbound_lease_release(${slotKey(kind, workspaceId)}, ${holder})`
    );
  }

  /**
   * Runs `fn` holding one of the workspace's slots, released after; `{ busy: true }` without
   * running it when every slot is taken (the caller defers the job).
   */
  async run<T>(
    kind: string,
    workspaceId: string,
    cap: number,
    holder: string,
    seconds: number,
    fn: () => Promise<T>
  ): Promise<T | { busy: true }> {
    if (!(await this.take(kind, workspaceId, cap, holder, seconds))) return { busy: true };
    try {
      return await fn();
    } finally {
      await this.release(kind, workspaceId, holder).catch(() => {});
    }
  }
}

const slotKey = (kind: string, workspaceId: string) => `outbound:${kind}:${workspaceId}`;

/** Drops slots expired over an hour ago (crashed workers); the worker's hourly prune. */
export async function pruneOutboundLeases(db: Pick<Database, 'execute'>): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(sql`SELECT outbound_lease_prune() AS n`);
  return Number(rows[0]?.n ?? 0);
}
