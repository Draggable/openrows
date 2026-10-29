import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../lib/context.js';
import { problem } from '../lib/errors.js';

export interface RateLimitOptions {
  /** Requests allowed per window and key. */
  limit: number;
  windowMs: number;
  /** The bucket a request counts against, usually the client IP. */
  key: (c: Parameters<MiddlewareHandler<AppEnv>>[0]) => string;
  now?: () => number;
}

/**
 * Fixed-window, in-memory rate limiter. One process per deployment is the plan for now; a shared
 * store (Redis or Postgres) is only needed once the server runs as several replicas.
 */
export function rateLimit(opts: RateLimitOptions): MiddlewareHandler<AppEnv> {
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, { count: number; resetAt: number }>();
  let nextSweep = now() + opts.windowMs;

  return async (c, next) => {
    const t = now();
    if (t >= nextSweep) {
      for (const [k, b] of buckets) if (b.resetAt <= t) buckets.delete(k);
      nextSweep = t + opts.windowMs;
    }
    const key = opts.key(c);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= t) {
      bucket = { count: 0, resetAt: t + opts.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    c.header('RateLimit-Limit', String(opts.limit));
    c.header('RateLimit-Remaining', String(Math.max(0, opts.limit - bucket.count)));
    if (bucket.count > opts.limit) {
      const res = problem(c, 'RATE_LIMITED', { detail: 'Too many attempts. Try again shortly.' });
      res.headers.set('Retry-After', String(Math.ceil((bucket.resetAt - t) / 1000)));
      return res;
    }
    await next();
  };
}
