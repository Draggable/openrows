/**
 * Token buckets for the API. A bucket holds up to `burst` tokens and refills at
 * `perSecond`; each request takes one token from every bucket it counts against (the base, the
 * token or user), or from none when any of them is empty. The store is behind `RateLimiter`:
 * Postgres on self-host (`PostgresRateLimiter`, shared by every instance), memory for one process
 * and tests, and Valkey later for the hosted service.
 */

export interface BucketPolicy {
  /** Tokens added per second. */
  perSecond: number;
  /** The bucket's capacity: requests allowed at once after a quiet period. */
  burst: number;
}

/** A bucket a request counts against: `kind` names it in headers and errors. */
export interface BucketRequest {
  /** `outbound`: a workspace's outbound requests from the worker. */
  kind: 'base' | 'token' | 'user' | 'outbound';
  key: string;
  policy: BucketPolicy;
}

export interface BucketState {
  kind: BucketRequest['kind'];
  policy: BucketPolicy;
  /** Tokens left after this request (fractional). */
  level: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  buckets: BucketState[];
}

export interface RateLimiter {
  /** Takes one token from each bucket, or none when any is empty. At most 8 buckets. */
  take(requests: readonly BucketRequest[]): Promise<RateLimitDecision>;
}

/** The level of a bucket last at `level` after `elapsedMs`, capped at its burst. */
export function refill(level: number, elapsedMs: number, policy: BucketPolicy): number {
  return Math.min(policy.burst, level + (Math.max(0, elapsedMs) / 1000) * policy.perSecond);
}

/** What the response headers say: the bucket closest to empty, or the empty one on a refusal. */
export function headersFor(decision: RateLimitDecision): Record<string, string> {
  const tightest = tightestBucket(decision);
  if (!tightest) return {};
  const { policy, level } = tightest;
  const headers: Record<string, string> = {
    'RateLimit-Limit': String(policy.burst),
    'RateLimit-Remaining': String(Math.max(0, Math.floor(level))),
    // Seconds until the bucket is full again.
    'RateLimit-Reset': String(Math.ceil((policy.burst - level) / policy.perSecond)),
    'RateLimit-Policy': `${policy.burst};w=${round(policy.burst / policy.perSecond)}`,
  };
  if (!decision.allowed) headers['Retry-After'] = String(retryAfter(tightest));
  return headers;
}

/** Whole seconds until the bucket holds one token again (at least 1). */
export function retryAfter(bucket: BucketState): number {
  return Math.max(1, Math.ceil((1 - bucket.level) / bucket.policy.perSecond));
}

/** The empty bucket of a refusal, else the one with the fewest tokens left. */
export function tightestBucket(decision: RateLimitDecision): BucketState | undefined {
  const pool = decision.allowed ? decision.buckets : decision.buckets.filter((b) => b.level < 1);
  let tightest: BucketState | undefined;
  for (const b of pool) {
    const left = b.level / b.policy.burst;
    if (!tightest || left < tightest.level / tightest.policy.burst) tightest = b;
  }
  return tightest;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Buckets in this process's memory: one instance only (development, tests, a single replica).
 * Idle buckets are dropped once they would be full again.
 */
export class MemoryRateLimiter implements RateLimiter {
  readonly #buckets = new Map<string, { level: number; at: number; fullAt: number }>();
  #nextSweep = 0;

  constructor(private readonly now: () => number = Date.now) {}

  async take(requests: readonly BucketRequest[]): Promise<RateLimitDecision> {
    const t = this.now();
    if (t >= this.#nextSweep) {
      for (const [k, b] of this.#buckets) if (b.fullAt <= t) this.#buckets.delete(k);
      this.#nextSweep = t + 60_000;
    }
    const levels = requests.map((r) => {
      const b = this.#buckets.get(r.key);
      return b ? refill(b.level, t - b.at, r.policy) : r.policy.burst;
    });
    const allowed = levels.every((l) => l >= 1);
    const buckets = requests.map((r, i) => {
      const level = (levels[i] ?? 0) - (allowed ? 1 : 0);
      const fullAt = t + ((r.policy.burst - level) / r.policy.perSecond) * 1000;
      this.#buckets.set(r.key, { level, at: t, fullAt });
      return { kind: r.kind, policy: r.policy, level };
    });
    return { allowed, buckets };
  }
}
