import { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, beforeAll } from 'vitest';
import { LOGIN_COOKIE } from '../../src/auth/routes.js';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';

export interface MockIdentity {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  sid?: string;
  /** Seconds since the epoch: when the user last entered their credentials. */
  auth_time?: number;
  /** The Keycloak identity provider the user came through (workspace single sign-on). */
  identity_provider?: string;
}

/**
 * A mock OIDC issuer (oauth2-mock-server) for integration tests, so they don't need Keycloak. It
 * checks PKCE and echoes the nonce; `identity` sets the claims of the next tokens it issues.
 */
export function useMockIssuer() {
  const server = new OAuth2Server();
  const state = { identity: { sub: 'user-1' } as MockIdentity };

  beforeAll(async () => {
    await server.issuer.keys.generate('RS256');
    await server.start(0, '127.0.0.1');
    server.service.on('beforeTokenSigning', (token) => {
      Object.assign(token.payload, state.identity);
    });
  });
  afterAll(async () => {
    await server.stop();
  });

  return {
    server,
    get url() {
      const url = server.issuer.url;
      if (!url) throw new Error('mock issuer not started');
      return url;
    },
    setIdentity(identity: MockIdentity) {
      state.identity = identity;
    },
  };
}

type Requester = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

/** The value of cookie `name` from a response's Set-Cookie headers. */
export function cookieFrom(res: Response, name: string): string | undefined {
  for (const header of res.headers.getSetCookie()) {
    const [pair] = header.split(';');
    const [k, ...v] = (pair ?? '').split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

/**
 * Runs the browser's side of a sign-in: /auth/login, the issuer's authorize endpoint (which
 * redirects straight back), then /auth/callback. `tamper` can rewrite the callback query.
 */
export async function signIn(
  app: Requester,
  opts: { path?: string; tamper?: (params: URLSearchParams) => void } = {}
) {
  const login = await app.request(opts.path ?? '/auth/login');
  const loginCookie = cookieFrom(login, LOGIN_COOKIE);
  const authorizeUrl = new URL(login.headers.get('location') ?? '');

  const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
  const callbackUrl = new URL(authorize.headers.get('location') ?? '');
  opts.tamper?.(callbackUrl.searchParams);

  const callback = await app.request(`${callbackUrl.pathname}${callbackUrl.search}`, {
    headers: loginCookie ? { cookie: `${LOGIN_COOKIE}=${loginCookie}` } : {},
  });
  return {
    login,
    authorizeUrl,
    callback,
    sessionToken: cookieFrom(callback, SESSION_COOKIE) || undefined,
  };
}
