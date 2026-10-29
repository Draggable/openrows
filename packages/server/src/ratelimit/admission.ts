import { sql } from 'drizzle-orm';
import type { Context } from 'hono';
import type { Principal } from '../auth/sessions.js';
import { effectiveRole, tokenReaches } from '../authz/policy.js';
import { resolveResource } from '../authz/resolve.js';
import { inScope } from '../authz/scope.js';
import type { Database } from '../db/index.js';
import type { EntitlementsProvider } from '../edition/types.js';
import type { AppEnv } from '../lib/context.js';
import { AppError } from '../lib/errors.js';
import { apiCallRoom } from '../usage/quota.js';
import {
  type BucketPolicy,
  type BucketRequest,
  headersFor,
  type RateLimiter,
  tightestBucket,
} from './limiter.js';

export interface ApiRateLimits {
  /** Every caller of one base through /api/v1 together (Airtable: 5 per second). */
  base: BucketPolicy;
  /** One personal access token on any route, or one signed-in user on /api/v1. */
  token: BucketPolicy;
}

/** The base a v1 path names: `/api/v1/<baseId>/…`, `/api/v1/meta/bases/<baseId>/…` or `/api/v1/bases/<baseId>/…` (webhooks). */
const V1_BASE =
  /^\/api\/v1\/(?:meta\/bases\/|bases\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

/** The base id in a REST API v1 path, if it names one. */
export function v1BaseId(path: string): string | undefined {
  return V1_BASE.exec(path)?.[1]?.toLowerCase();
}

const KIND_NAMES = {
  base: 'this base',
  token: 'this token',
  user: 'your account',
  // The worker's outbound buckets; never an API request's.
  outbound: 'this workspace',
} as const;

/**
 * The API's rate limits, run by `requireSession` once the caller is known: a personal
 * access token's bucket on every route it calls, a signed-in user's on /api/v1 (the app's own
 * calls aren't limited), and on a v1 path naming a base the caller reaches, that base's bucket,
 * shared by everyone who calls it. A base the caller doesn't reach takes nothing from its bucket
 * (the route answers 404), so nobody can drain another tenant's limit. Every limited answer gets
 * `RateLimit-Limit`, `-Remaining`, `-Reset` and `-Policy` for the tightest bucket; a refusal is
 * 429 `RATE_LIMITED` with `Retry-After` and which limit it hit. If the store fails the request
 * goes through (logged): the limits protect fairness, not data.
 *
 * Before the buckets, a v1 request on a base the caller reaches is checked against its
 * workspace's plan's API calls per month: past it, 429 `QUOTA_EXCEEDED` with
 * `Retry-After` and `resetsAt` (the next UTC month), and nothing is counted.
 */
export function apiAdmission(deps: {
  db: Database;
  limiter: RateLimiter;
  limits: ApiRateLimits;
  /** The workspaces' plans; none: no monthly quota. */
  entitlements?: EntitlementsProvider | undefined;
}): (c: Context, principal: Principal) => Promise<void> {
  const { db, limiter, limits, entitlements } = deps;

  /** The base's workspace when the caller reaches the base, else null. */
  async function reachedWorkspace(principal: Principal, baseId: string): Promise<string | null> {
    const resolved = await resolveResource(db, 'base', baseId, principal.user.id);
    if (!resolved || effectiveRole(resolved) === null) return null;
    return !principal.token || tokenReaches(principal.token, resolved)
      ? resolved.workspaceId
      : null;
  }

  return async (c, principal) => {
    const path = c.req.path;
    const v1 = path.startsWith('/api/v1/');
    const requests: BucketRequest[] = [];
    if (principal.token) {
      requests.push({ kind: 'token', key: `token:${principal.token.id}`, policy: limits.token });
    } else if (v1) {
      requests.push({ kind: 'user', key: `user:${principal.user.id}`, policy: limits.token });
    } else {
      return;
    }
    const baseId = v1 ? v1BaseId(path) : undefined;
    const workspaceId = baseId ? await reachedWorkspace(principal, baseId) : null;
    if (baseId && workspaceId) {
      requests.push({ kind: 'base', key: `base:${baseId}`, policy: limits.base });
    }
    if (workspaceId && entitlements) {
      const over = await inScope(db, { userId: principal.user.id, workspaceId }, async (tx) =>
        apiCallRoom(tx, await entitlements.forWorkspace(workspaceId, tx), workspaceId)
      );
      if (over) {
        c.header('Retry-After', String(over.retryAfterSeconds));
        throw over.error;
      }
    }

    let decision: Awaited<ReturnType<RateLimiter['take']>>;
    try {
      decision = await limiter.take(requests);
    } catch (err) {
      (c as Context<AppEnv>).get('logger')?.warn({ err }, 'rate limiter unavailable');
      return;
    }
    for (const [name, value] of Object.entries(headersFor(decision))) c.header(name, value);
    if (decision.allowed) {
      // The workspace's monthly API calls: admitted v1 requests on a base it reaches.
      if (workspaceId) {
        await db.execute(sql`SELECT api_call_count(${workspaceId}::uuid)`).catch((err: unknown) => {
          (c as Context<AppEnv>).get('logger')?.warn({ err }, 'API call not counted');
        });
      }
      return;
    }
    const kind = tightestBucket(decision)?.kind ?? 'token';
    throw new AppError('RATE_LIMITED', {
      detail: `Rate limit exceeded for ${KIND_NAMES[kind]}. Wait for Retry-After seconds.`,
      extensions: { limit: kind },
    });
  };
}
