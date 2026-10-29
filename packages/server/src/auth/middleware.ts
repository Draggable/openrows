import { contracts } from '@openrows/shared';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../lib/context.js';
import { AppError } from '../lib/errors.js';
import { SESSION_COOKIE } from './session-token.js';
import type { Principal, SessionStore } from './sessions.js';
import { bearerOf } from './tokens.js';

/** Context of routes behind `requireSession`: `c.var.principal` is always set. */
export interface SessionEnv {
  Variables: AppEnv['Variables'] & { principal: Principal };
}

/** Context of routes behind `optionalSession`: `c.var.principal` is null when signed out. */
export interface OptionalSessionEnv {
  Variables: AppEnv['Variables'] & { principal: Principal | null };
}

export interface SessionMiddleware {
  requireSession: MiddlewareHandler<SessionEnv>;
  optionalSession: MiddlewareHandler<OptionalSessionEnv>;
}

/** Options of `sessionMiddleware` for bearer tokens. */
export interface BearerOptions {
  /** Resolves `Authorization: Bearer or_pat_…` to its principal, or null. */
  resolve: (token: string) => Promise<Principal | null>;
  /** The client's IP, the key failed attempts count against. */
  ip: (c: Context) => string | undefined;
  /** Failed bearer attempts allowed per IP and window before every attempt answers 429. */
  failureLimit: number;
  windowMs: number;
  now?: () => number;
}

/** Whether a request carries `Authorization: Bearer …`, which then replaces the cookie. */
export function hasBearer(c: Context): boolean {
  return bearerOf(c.req.header('authorization')) !== null;
}

/**
 * The only way routes read the session cookie or a bearer token. Build once in createApp and
 * pass to routers. A request with `Authorization: Bearer …` is judged by the token alone: the
 * cookie is ignored and never cleared (bearer requests don't set cookies), and an unknown,
 * expired or revoked token is 401 with the same answer for each. Failed attempts are counted per
 * IP; past `failureLimit` in a window every bearer attempt from it answers 429.
 */
export function sessionMiddleware(
  store: SessionStore,
  bearer?: BearerOptions,
  /** Runs once the caller is known, before the route: the API's rate limits. */
  admit?: (c: Context, principal: Principal) => Promise<void>
): SessionMiddleware {
  const now = bearer?.now ?? Date.now;
  const failures = new Map<string, { count: number; resetAt: number }>();
  let nextSweep = 0;

  async function principalOfBearer(c: Context, raw: string): Promise<Principal> {
    if (!bearer) throw new AppError('UNAUTHENTICATED');
    const t = now();
    if (t >= nextSweep) {
      for (const [k, b] of failures) if (b.resetAt <= t) failures.delete(k);
      nextSweep = t + bearer.windowMs;
    }
    const key = bearer.ip(c) ?? 'unknown';
    const seen = failures.get(key);
    if (seen && seen.resetAt > t && seen.count >= bearer.failureLimit) {
      throw new AppError('RATE_LIMITED', { detail: 'Too many attempts. Try again shortly.' });
    }
    const principal = await bearer.resolve(raw);
    if (principal) return principal;
    const bucket = seen && seen.resetAt > t ? seen : { count: 0, resetAt: t + bearer.windowMs };
    bucket.count += 1;
    failures.set(key, bucket);
    throw new AppError('UNAUTHENTICATED');
  }

  async function principalOf(c: Context): Promise<Principal | null> {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return null;
    const principal = await store.resolve(token, (c as Context<AppEnv>).get('logger'));
    // A stale cookie is dropped so the browser stops sending it.
    if (!principal) deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return principal;
  }

  return {
    requireSession: createMiddleware<SessionEnv>(async (c, next) => {
      const raw = bearerOf(c.req.header('authorization'));
      const principal = raw !== null ? await principalOfBearer(c, raw) : await principalOf(c);
      if (!principal) throw new AppError('UNAUTHENTICATED');
      if (principal.impersonation) assertImpersonationAllows(c);
      c.set('principal', principal);
      if (admit) await admit(c, principal);
      await next();
    }),
    // Only a session proves who is looking at a public page (share links' email domains); a
    // bearer request is anonymous there.
    optionalSession: createMiddleware<OptionalSessionEnv>(async (c, next) => {
      c.set('principal', hasBearer(c) ? null : await principalOf(c));
      await next();
    }),
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The one change an impersonating admin may make: ending the impersonation. */
const IMPERSONATION_EXIT = contracts.me.endImpersonation;

/**
 * Impersonation is read-only: an impersonated principal may only read, apart from ending
 * the impersonation (and signing out, which isn't behind requireSession).
 */
function assertImpersonationAllows(c: Context): void {
  if (SAFE_METHODS.has(c.req.method)) return;
  if (c.req.method === IMPERSONATION_EXIT.method && c.req.path === IMPERSONATION_EXIT.path) return;
  throw new AppError('IMPERSONATION_READ_ONLY', {
    detail: 'You are viewing the app as someone else: nothing can be changed.',
  });
}

/**
 * CSRF defence for cookie sessions (ADR-006): a state-changing request from a browser must come
 * from the app's own origin. Browsers always send `Origin` on cross-site POSTs; requests with
 * neither `Origin` nor `Sec-Fetch-Site` aren't from a browser and can't ride on its cookie.
 * Bearer API requests are exempt: they carry their credential themselves.
 */
export function sameOrigin(appUrl: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // A bearer API request never rides on the cookie (requireSession ignores it then),
    // and a browser can't add the header cross-site without a CORS preflight we refuse.
    // The MCP endpoint and SCIM provisioning take nothing but a bearer token.
    const api =
      (c.req.path.startsWith('/api/') ||
        c.req.path === '/mcp' ||
        c.req.path.startsWith('/scim/')) &&
      hasBearer(c);
    if (!SAFE_METHODS.has(c.req.method) && !api) {
      const origin = c.req.header('origin');
      const site = c.req.header('sec-fetch-site');
      const ok = origin ? origin === appUrl : !site || site === 'same-origin' || site === 'none';
      if (!ok) throw new AppError('FORBIDDEN', { detail: 'Cross-origin request refused.' });
    }
    await next();
  };
}
