import { AUDIT_USER_AGENT_MAX, type AuthErrorCode, contracts } from '@openrows/shared';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { auditForUser } from '../audit/record.js';
import type { RouteRegistry } from '../authz/routes.js';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import { problem } from '../lib/errors.js';
import { ensurePersonalWorkspace } from '../workspaces/service.js';
import { clientIp } from './client-ip.js';
import { createCipher } from './crypto.js';
import type { LoginTransaction, OidcClient } from './oidc.js';
import { rateLimit } from './rate-limit.js';
import { safeReturnTo } from './return-to.js';
import { SESSION_COOKIE } from './session-token.js';
import type { SessionStore } from './sessions.js';

/** Holds the PKCE verifier, state and nonce between /auth/login and /auth/callback. */
export const LOGIN_COOKIE = 'openrows_login';
/** Same as the Keycloak realm's login lifespan (accessCodeLifespanLogin). */
const LOGIN_TTL_S = 30 * 60;

export interface AuthDeps {
  db: Database;
  config: Config;
  store: SessionStore;
  oidc: OidcClient | undefined;
}

/**
 * The backend-for-frontend OIDC flow (ADR-006): `/auth/login`, `/auth/signup`, `/auth/callback`
 * and `/auth/logout`. Tokens stay on the server; the browser only gets an opaque session cookie.
 * Callback failures redirect to `/login?error=<AuthErrorCode>` so the client can explain them.
 */
export function authRoutes(routes: RouteRegistry, { db, config, store, oidc }: AuthDeps) {
  const txCipher = createCipher(config.encryptionKey, 'login-transaction');
  const secure = config.appUrl.startsWith('https:');
  const redirectUri = `${config.appUrl}/auth/callback`;
  const ip = (c: Context) =>
    clientIp(c, { trustProxy: config.trustProxy, hops: config.trustProxyHops });

  routes.use(
    '/auth/*',
    rateLimit({ limit: config.authRateLimit, windowMs: 60_000, key: (c) => ip(c) ?? 'unknown' })
  );

  const fail = (c: Context, code: AuthErrorCode) =>
    c.redirect(`${config.appUrl}/login?error=${code}`);

  const start = (signup: boolean) =>
    routes.public('GET', signup ? '/auth/signup' : '/auth/login', async (c) => {
      if (!oidc) {
        return problem(c, 'SERVICE_UNAVAILABLE', { detail: 'Sign-in is not configured.' });
      }
      // "Sign in with SSO": `email` finds its domain's workspace identity provider
      // (home-realm discovery), which Keycloak then goes straight to.
      let ssoHint: { alias: string; email: string } | undefined;
      const email = c.req.query('email');
      if (!signup && email !== undefined) {
        const parsed = z.email().max(320).safeParse(email.trim().toLowerCase());
        if (!parsed.success) return fail(c, 'sso_not_found');
        let alias: string | null;
        try {
          alias = await c.var.edition.sso.discover(db, parsed.data);
        } catch (err) {
          c.get('logger').error({ err }, 'single sign-on discovery failed');
          return fail(c, 'login_failed');
        }
        if (!alias) return fail(c, 'sso_not_found');
        ssoHint = { alias, email: parsed.data };
      }
      let started: Awaited<ReturnType<OidcClient['startLogin']>>;
      try {
        // Only configured providers: anything else falls back to the provider's own page.
        const provider = c.req.query('provider');
        started = await oidc.startLogin({
          returnTo: safeReturnTo(c.req.query('returnTo')),
          signup,
          reauth: !signup && c.req.query('reauth') === '1',
          idpHint:
            ssoHint?.alias ??
            (provider && config.oidc?.providers.includes(provider) ? provider : undefined),
          loginHint: ssoHint?.email,
        });
      } catch (err) {
        c.get('logger').error({ err }, 'OIDC discovery failed');
        return problem(c, 'SERVICE_UNAVAILABLE', {
          detail: 'The sign-in provider is unavailable.',
        });
      }
      const sealed = txCipher.encrypt(JSON.stringify({ ...started.tx, iat: Date.now() }));
      setCookie(c, LOGIN_COOKIE, sealed.toString('base64url'), {
        httpOnly: true,
        secure,
        sameSite: 'Lax',
        path: '/auth/callback',
        maxAge: LOGIN_TTL_S,
      });
      return c.redirect(started.url.href);
    });
  start(false);
  start(true);

  // What the sign-in page shows: the social sign-in buttons (AUTH_PROVIDERS) and the instance's
  // status page link (STATUS_PAGE_URL; the help menu shows it too). Public: it only names them.
  routes.public('GET', '/auth/providers', (c) =>
    c.json({
      providers: oidc ? (config.oidc?.providers ?? []) : [],
      statusPageUrl: config.statusPageUrl ?? null,
    })
  );

  routes.public('GET', '/auth/callback', async (c) => {
    if (!oidc) return fail(c, 'not_configured');
    const log = c.get('logger');

    const sealed = getCookie(c, LOGIN_COOKIE);
    deleteCookie(c, LOGIN_COOKIE, { path: '/auth/callback', secure, httpOnly: true });
    const tx = sealed
      ? readTransaction(txCipher.decrypt(Buffer.from(sealed, 'base64url')))
      : undefined;
    if (!tx) return fail(c, 'login_expired');

    const query = new URL(c.req.url).search;
    const params = new URLSearchParams(query);
    if (params.get('state') !== tx.state) {
      log.warn('OIDC callback with a state that does not match the login transaction');
      return fail(c, 'state_mismatch');
    }
    if (params.has('error')) {
      log.info({ error: params.get('error') }, 'the provider returned an error');
      return fail(c, params.get('error') === 'access_denied' ? 'access_denied' : 'login_failed');
    }

    let tokens: Awaited<ReturnType<OidcClient['finishLogin']>>;
    try {
      // The browser reached us through APP_URL (Vite or a proxy may sit in between), and the
      // redirect_uri sent to the token endpoint must be exactly the one we registered.
      tokens = await oidc.finishLogin(new URL(`${redirectUri}${query}`), tx);
    } catch (err) {
      log.warn({ err }, 'OIDC code exchange failed');
      return fail(c, 'login_failed');
    }

    // H6: an unverified address could be someone else's (invitations match by email).
    if (!tokens.claims.email || !tokens.claims.emailVerified) {
      log.info({ subject: tokens.claims.subject }, 'sign-in refused: email not verified');
      return fail(c, 'email_unverified');
    }

    const user = await store.upsertUser(tokens.claims, config.systemAdmins);
    // a deleted account stays signed out until the purge deletes it (and its provider user).
    if (user.deletedAt) {
      log.info({ userId: user.id }, 'sign-in refused: account deleted');
      return fail(c, 'account_deleted');
    }
    // a system admin suspended the account in the ops console.
    if (user.suspendedAt) {
      log.info({ userId: user.id }, 'sign-in refused: account suspended');
      return fail(c, 'account_suspended');
    }
    // "require SSO" for the address's domain, a workspace provider's verified domains,
    // and JIT membership through it.
    const userAgent = c.req.header('user-agent')?.slice(0, AUDIT_USER_AGENT_MAX) ?? null;
    let decision: Awaited<ReturnType<typeof c.var.edition.sso.signIn>>;
    try {
      decision = await c.var.edition.sso.signIn(db, {
        userId: user.id,
        email: tokens.claims.email,
        identityProvider: tokens.claims.identityProvider,
        ip: c.var.clientIp ?? null,
        userAgent,
      });
    } catch (err) {
      log.error({ err, userId: user.id }, 'the single sign-on check failed');
      return fail(c, 'login_failed');
    }
    if (!decision.allowed) {
      log.info({ userId: user.id, reason: decision.reason }, 'sign-in refused by single sign-on');
      return fail(c, decision.reason);
    }
    try {
      // A region provisioned from the home region gives nobody a personal workspace.
      if (c.var.edition.residency.selfServe) await ensurePersonalWorkspace(db, user);
    } catch (err) {
      // Not worth refusing the sign-in; the next sign-in tries again.
      log.error({ err, userId: user.id }, 'could not create the personal workspace');
    }
    const { token, expiresAt } = await store.create(user, tokens, {
      userAgent: c.req.header('user-agent'),
      ip: ip(c),
    });
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure,
      sameSite: 'Lax',
      path: '/',
      expires: expiresAt,
    });
    log.info({ userId: user.id }, 'signed in');
    // The audit log of each of the user's workspaces, with how they signed in.
    await auditForUser(db, c.var.edition.audit, user.id, {
      action: 'auth.sign_in',
      actor: {
        kind: 'user',
        userId: user.id,
        email: user.email ?? null,
        ip: c.var.clientIp,
        userAgent,
      },
      target: { type: 'user', id: user.id, name: user.email ?? null },
      summary: { after: { method: decision.method } },
    }).catch((err) => log.error({ err, userId: user.id }, 'could not audit the sign-in'));
    return c.redirect(`${config.appUrl}${tx.returnTo}`);
  });

  // POST only (sameOrigin applies): a cross-site page must not be able to sign users out.
  routes.public('POST', '/auth/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure, httpOnly: true });
    const ended = token ? await store.end(token) : undefined;
    let target = `${config.appUrl}/`;
    if (oidc && ended) {
      try {
        const url = await oidc.logoutUrl({ idToken: ended.idToken, postLogoutRedirectUri: target });
        if (url) target = url.href;
      } catch (err) {
        c.get('logger').warn({ err }, 'could not build the provider logout URL');
      }
    }
    return c.redirect(target, 303);
  });
}

/** `GET /api/me`: the signed-in user, or 401. */
export function meRoutes(routes: RouteRegistry) {
  // With a personal access token: its owner's profile, with `user.email:read`.
  routes.endpoint(
    contracts.me.get,
    'session',
    (c) => {
      const { user, session: s, impersonation } = c.var.principal;
      return {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          avatarUrl: user.avatarUrl,
          isSystemAdmin: user.isSystemAdmin,
        },
        session: {
          expiresAt: s.expiresAt.toISOString(),
          createdAt: s.createdAt.toISOString(),
          authenticatedAt: s.authenticatedAt?.toISOString() ?? null,
        },
        impersonation: impersonation
          ? {
              adminEmail: impersonation.adminEmail,
              expiresAt: impersonation.expiresAt.toISOString(),
            }
          : null,
      };
    },
    { token: 'user.email:read' }
  );
}

function readTransaction(json: string | undefined): LoginTransaction | undefined {
  if (!json) return undefined;
  try {
    const v = JSON.parse(json) as Partial<LoginTransaction> & { iat?: number };
    if (typeof v.iat !== 'number' || Date.now() - v.iat > LOGIN_TTL_S * 1000) return undefined;
    if (!v.state || !v.nonce || !v.codeVerifier || typeof v.returnTo !== 'string') return undefined;
    return { state: v.state, nonce: v.nonce, codeVerifier: v.codeVerifier, returnTo: v.returnTo };
  } catch {
    return undefined;
  }
}
