import { MAX_AUTOMATION_HOOK_BYTES } from '@openrows/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { uuidv7 } from 'uuidv7';
import { clientIp } from '../auth/client-ip.js';
import { rateLimit } from '../auth/rate-limit.js';
import type { RouteRegistry } from '../authz/routes.js';
import { setScope } from '../authz/scope.js';
import type { Config } from '../config.js';
import { automations, type Database } from '../db/index.js';
import { workspaceGroup } from '../jobs/defer.js';
import type { Jobs } from '../jobs/send.js';
import { AppError } from '../lib/errors.js';
import {
  type BucketPolicy,
  headersFor,
  type RateLimiter,
  retryAfter,
  tightestBucket,
} from '../ratelimit/limiter.js';
import { HOOK_PATH_PREFIX, hashHookToken } from './secrets.js';
import { AUTOMATION_QUEUE } from './subscriber.js';

/** Requests per automation's URL: 5 a second, bursts of 20 (as Airtable's 5 per second). */
export const HOOK_RATE: BucketPolicy = { perSecond: 5, burst: 20 };
/** Requests per client IP and minute across every hook URL (before any lookup). */
export const HOOK_IP_LIMIT_PER_MINUTE = 600;

const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

const NO_SUCH_HOOK = () => new AppError('NOT_FOUND', { detail: 'No such webhook.' });

/**
 * Webhook-received triggers: `POST /hooks/a/<token>` with a JSON body (at most 100 KB)
 * runs the automation with the body as `{{trigger.body...}}`. No session: the URL's token is the
 * credential, looked up by its SHA-256 (`automation_hook_resolve`: enabled webhook automations
 * of live bases only), so a turned-off, deleted or rotated URL is a 404 at once. Rate-limited
 * per client IP (in memory, before the lookup) and per automation (the API's shared limiter).
 * The request's body is kept as the automation's sample, for mapping fields.
 */
export function hookRoutes(
  routes: RouteRegistry,
  deps: { db: Database; jobs: Jobs; limiter: RateLimiter; config: Config }
) {
  const { db, config } = deps;
  const ip = (c: Context) =>
    clientIp(c, { trustProxy: config.trustProxy, hops: config.trustProxyHops }) ?? 'unknown';
  const path = `${HOOK_PATH_PREFIX}*`;
  routes.use(
    path,
    rateLimit({ limit: HOOK_IP_LIMIT_PER_MINUTE, windowMs: 60_000, key: (c) => `hook-ip:${ip(c)}` })
  );
  routes.use(
    path,
    bodyLimit({
      maxSize: MAX_AUTOMATION_HOOK_BYTES,
      onError: () => {
        throw new AppError('PAYLOAD_TOO_LARGE', { detail: 'A webhook body is at most 100 KB.' });
      },
    })
  );

  routes.public('POST', `${HOOK_PATH_PREFIX}:hookToken`, async (c) => {
    const token = c.req.param('hookToken') ?? '';
    if (!TOKEN_RE.test(token)) throw NO_SUCH_HOOK();
    const hash = hashHookToken(token);
    const { rows } = await db.execute<{ id: string; workspace_id: string; token_hash: string }>(
      sql`SELECT * FROM automation_hook_resolve(${hash})`
    );
    const hook = rows[0];
    if (!hook || hook.token_hash !== hash) throw NO_SUCH_HOOK();

    const decision = await deps.limiter.take([
      { kind: 'token', key: `hook:${hook.id}`, policy: HOOK_RATE },
    ]);
    for (const [k, v] of Object.entries(headersFor(decision))) c.header(k, v);
    if (!decision.allowed) {
      const bucket = tightestBucket(decision);
      if (bucket) c.header('Retry-After', String(retryAfter(bucket)));
      throw new AppError('RATE_LIMITED', {
        detail: 'Too many requests to this webhook. Try again shortly.',
      });
    }

    const type = c.req.header('content-type') ?? '';
    if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(type)) {
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', { detail: 'Send the body as JSON.' });
    }
    let body: unknown;
    try {
      const text = await c.req.text();
      body = text.trim() === '' ? {} : JSON.parse(text);
    } catch {
      throw new AppError('BAD_REQUEST', { detail: 'The body is not valid JSON.' });
    }

    const requestId = uuidv7();
    const receivedAt = new Date();
    await db.transaction(async (tx) => {
      await setScope(tx, { userId: '', workspaceId: hook.workspace_id });
      // Still on, in this transaction (it may have been turned off since the lookup).
      const [row] = await tx
        .update(automations)
        .set({
          hookSample: body as Record<string, unknown>,
          hookSampleAt: receivedAt,
          updatedAt: sql`${automations.updatedAt}`,
        })
        .where(and(eq(automations.id, hook.id), eq(automations.hookTokenHash, hash)))
        .returning({ enabled: automations.enabled });
      if (!row?.enabled) throw NO_SUCH_HOOK();
      await deps.jobs.send(
        tx,
        AUTOMATION_QUEUE,
        {
          workspaceId: hook.workspace_id,
          subscriberId: hook.id,
          hook: { requestId, receivedAt: receivedAt.toISOString(), body },
        },
        { group: workspaceGroup(hook.workspace_id) }
      );
    });
    c.var.logger.info({ automationId: hook.id }, 'automation webhook received');
    return c.json({ success: true });
  });
}
