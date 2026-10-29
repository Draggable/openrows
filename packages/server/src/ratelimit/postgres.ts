import { sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import type { BucketRequest, RateLimitDecision, RateLimiter } from './limiter.js';

interface TakeRow extends Record<string, unknown> {
  allowed: boolean;
  remaining: number[];
}

/**
 * Token buckets in Postgres: the UNLOGGED `rate_limit_buckets`, through the SECURITY
 * DEFINER `rate_limit_take` (drizzle/0042_api_rate_limits_rls.sql), which locks the request's
 * buckets in key order, refills them from the database clock and takes a token from each or from
 * none, in one statement. Every server instance on the database shares the limits.
 */
export class PostgresRateLimiter implements RateLimiter {
  constructor(private readonly db: Database) {}

  async take(requests: readonly BucketRequest[]): Promise<RateLimitDecision> {
    if (requests.length === 0) return { allowed: true, buckets: [] };
    const keys = requests.map((r) => r.key);
    const capacities = requests.map((r) => r.policy.burst);
    const rates = requests.map((r) => r.policy.perSecond);
    const { rows } = await this.db.execute<TakeRow>(
      // sql.param: one array parameter each (node-postgres writes the array literal).
      sql`SELECT * FROM rate_limit_take(${sql.param(keys)}::text[],
        ${sql.param(capacities)}::float8[], ${sql.param(rates)}::float8[])`
    );
    const row = rows[0];
    if (!row) throw new Error('rate_limit_take returned nothing');
    return {
      allowed: row.allowed,
      buckets: requests.map((r, i) => ({
        kind: r.kind,
        policy: r.policy,
        level: Number(row.remaining[i] ?? 0),
      })),
    };
  }
}

/** Drops buckets idle for `idleSeconds` (full again by then); the worker's hourly job. */
export async function pruneRateLimits(db: Database, idleSeconds: number): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(
    sql`SELECT rate_limit_prune(${idleSeconds}) AS n`
  );
  return Number(rows[0]?.n ?? 0);
}

/** Days of per-token request counts kept. */
export const TOKEN_USAGE_RETENTION_DAYS = 90;

/** Drops per-token request counts older than `days`; the worker's hourly job. */
export async function pruneTokenUsage(db: Database, days: number): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(sql`SELECT pat_usage_prune(${days}) AS n`);
  return Number(rows[0]?.n ?? 0);
}
