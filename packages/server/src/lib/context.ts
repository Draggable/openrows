import type { MiddlewareHandler } from 'hono';
import { uuidv7 } from 'uuidv7';
import type { Edition } from '../edition/types.js';
import type { Logger } from './logger.js';

/** Per-request variables every handler can read with `c.get(...)`. */
export interface AppEnv {
  Variables: {
    requestId: string;
    /** Child logger bound to the request id. */
    logger: Logger;
    /**
     * Origins that may frame this response, set by the embed page of a share link;
     * securityHeaders sends `frame-ancestors 'none'` and `X-Frame-Options: DENY` without it.
     */
    frameAncestors?: readonly string[];
    /** The edition's providers, set by createApp for every request. */
    edition: Edition;
    /** The client's IP as TRUST_PROXY reads it, for the audit log; null when unknown. */
    clientIp: string | null;
  };
}

export const REQUEST_ID_HEADER = 'X-Request-Id';

// Accept only short, log-safe ids from a proxy; anything else gets a fresh one.
const VALID_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

// Liveness/readiness probes run every few seconds; keep them out of the info log.
const QUIET_PATHS = new Set(['/health', '/ready']);

/**
 * Path segments that are credentials: share and embed links, public forms,
 * invitations and webhook-received triggers' URLs. `context.test.ts` checks every
 * registered route and client route with a token parameter against it.
 */
const SECRET_PATHS =
  /^(\/s|\/f|\/embed|\/invite|\/api\/shared|\/api\/forms|\/api\/invitations|\/hooks\/a)\/[^/]+/;

/** The path as it may be logged or echoed: link, invitation and hook tokens become `:token`. */
export function loggablePath(path: string): string {
  return path.replace(SECRET_PATHS, '$1/:token');
}

/**
 * Assigns a request id (UUIDv7, or the proxy's `X-Request-Id` when `trustProxy` is on), echoes
 * it in the response header, binds a child logger to it and logs one line per request. Only the
 * path is logged, never the query string (OAuth codes, unsubscribe tokens), headers or cookies,
 * and the tokens in it are redacted (`loggablePath`). Access logs are kept at most 90 days
 * (the operator prunes older log lines).
 */
export function requestContext(opts: {
  logger: Logger;
  trustProxy: boolean;
}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const incoming = opts.trustProxy ? c.req.header(REQUEST_ID_HEADER) : undefined;
    const requestId = incoming && VALID_REQUEST_ID.test(incoming) ? incoming : uuidv7();
    const log = opts.logger.child({ requestId });
    c.set('requestId', requestId);
    c.set('logger', log);
    c.header(REQUEST_ID_HEADER, requestId);

    const start = performance.now();
    await next();
    c.res.headers.set(REQUEST_ID_HEADER, requestId);

    const status = c.res.status;
    const level = status >= 500 ? 'error' : QUIET_PATHS.has(c.req.path) ? 'debug' : 'info';
    log[level](
      {
        method: c.req.method,
        path: loggablePath(c.req.path),
        status,
        durationMs: Math.round((performance.now() - start) * 10) / 10,
      },
      'request completed'
    );
  };
}
