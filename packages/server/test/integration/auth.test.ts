import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashSessionToken, SESSION_COOKIE } from '../../src/auth/session-token.js';
import { REFRESH_INTERVAL_MS, SESSION_IDLE_MS } from '../../src/auth/sessions.js';
import { sessions, users, workspaceMembers, workspaces } from '../../src/db/index.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { authedClient, createUser } from '../helpers/factories.js';
import { cookieFrom, signIn, useMockIssuer } from '../helpers/oidc.js';

const APP_URL = 'https://app.openrows.test';

describe('OIDC sign-in against a mock issuer', () => {
  const t = useTestDb();
  const issuer = useMockIssuer();

  function app(env: Record<string, string> = {}) {
    return testApp({
      db: t.appDb,
      env: {
        APP_URL,
        OIDC_ISSUER_URL: issuer.url,
        OIDC_CLIENT_ID: 'openrows-app',
        OIDC_CLIENT_SECRET: 'test-client-secret',
        AUTH_RATE_LIMIT: '1000',
        ...env,
      },
    }).app;
  }

  const me = (a: ReturnType<typeof app>, token: string | undefined) =>
    a.request('/api/me', { headers: { cookie: `${SESSION_COOKIE}=${token}` } });

  it('redirects to the issuer with PKCE S256, state and nonce', async () => {
    const res = await app().request('/auth/login');
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location') ?? '');
    expect(`${url.origin}${url.pathname}`).toBe(`${issuer.url}/authorize`);
    const p = url.searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe('openrows-app');
    expect(p.get('redirect_uri')).toBe(`${APP_URL}/auth/callback`);
    expect(p.get('scope')).toBe('openid email profile');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get('state')).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(p.get('nonce')).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(p.has('prompt')).toBe(false);

    // The verifier, state and nonce stay server-side in an encrypted, HttpOnly cookie.
    const cookie = res.headers.getSetCookie().join('\n');
    expect(cookie).toMatch(/openrows_login=[^;]+; Max-Age=1800; Path=\/auth\/callback;.*HttpOnly/);
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain(p.get('state') ?? '-');
  });

  it('?provider= passes kc_idp_hint for a configured provider only', async () => {
    const a = app({ AUTH_PROVIDERS: 'github, Google' });
    const hint = async (path: string) =>
      new URL((await a.request(path)).headers.get('location') ?? '').searchParams.get(
        'kc_idp_hint'
      );
    expect(await hint('/auth/login?provider=github')).toBe('github');
    expect(await hint('/auth/signup?provider=google')).toBe('google');
    expect(await hint('/auth/login?provider=evil')).toBeNull();
    expect(await hint('/auth/login')).toBeNull();
    const res = await a.request('/auth/providers');
    expect(await res.json()).toEqual({ providers: ['github', 'google'], statusPageUrl: null });
  });

  it('/auth/signup asks for the registration page', async () => {
    const res = await app().request('/auth/signup');
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('prompt')).toBe('create');
  });

  it('reauth asks for the credentials again and keeps their time on the session (#76)', async () => {
    const a = app();
    const res = await a.request('/auth/login?reauth=1&returnTo=/settings?delete-account=1');
    const params = new URL(res.headers.get('location') ?? '').searchParams;
    expect(params.get('prompt')).toBe('login');
    expect(params.get('max_age')).toBe('0');
    const authTime = Math.floor(Date.now() / 1000) - 5;
    issuer.setIdentity({
      sub: 'subject-reauth',
      email: 'reauth@example.test',
      email_verified: true,
      auth_time: authTime,
    });
    const { callback, sessionToken } = await signIn(a, {
      path: '/auth/login?reauth=1&returnTo=/settings?delete-account=1',
    });
    expect(callback.headers.get('location')).toBe(`${APP_URL}/settings?delete-account=1`);
    const body = (await (await me(a, sessionToken)).json()) as {
      session: { authenticatedAt: string | null };
    };
    expect(body.session.authenticatedAt).toBe(new Date(authTime * 1000).toISOString());
  });

  it('refuses to sign in a deleted account (#76)', async () => {
    issuer.setIdentity({ sub: 'subject-gone', email: 'gone@example.test', email_verified: true });
    await signIn(app());
    await t.db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(eq(users.oidcSubject, 'subject-gone'));
    const { callback, sessionToken } = await signIn(app());
    expect(callback.headers.get('location')).toBe(`${APP_URL}/login?error=account_deleted`);
    expect(sessionToken).toBeUndefined();
  });

  it('callback creates the user and a session; /api/me returns them; logout ends it', async () => {
    issuer.setIdentity({
      sub: 'subject-ada',
      email: 'Ada@Example.test',
      email_verified: true,
      name: 'Ada Lovelace',
      sid: 'kc-session-1',
    });
    const a = app();
    const { callback, sessionToken } = await signIn(a, { path: '/auth/login?returnTo=/bases/42' });

    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(`${APP_URL}/bases/42`);
    expect(sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const setCookie = callback.headers.getSetCookie().find((c) => c.startsWith(SESSION_COOKIE));
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Path=\//);

    const [user] = await t.db.select().from(users).where(eq(users.oidcSubject, 'subject-ada'));
    expect(user).toMatchObject({
      oidcIssuer: issuer.url,
      email: 'ada@example.test',
      emailVerified: true,
      name: 'Ada Lovelace',
    });
    const [session] = await t.db
      .select()
      .from(sessions)
      .where(eq(sessions.idHash, hashSessionToken(sessionToken ?? '')));
    expect(session).toMatchObject({ userId: user?.id, oidcSid: 'kc-session-1' });
    // Tokens are stored encrypted, never in the clear.
    expect(session?.refreshTokenEnc?.length).toBeGreaterThan(28);
    expect(session?.idTokenEnc?.toString('utf8')).not.toMatch(/^eyJ/);

    const res = await me(a, sessionToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      user: { id: user?.id, email: 'ada@example.test', name: 'Ada Lovelace', isSystemAdmin: false },
      session: { expiresAt: expect.any(String) },
    });

    // Signing in again updates the same user rather than creating another.
    issuer.setIdentity({
      sub: 'subject-ada',
      email: 'ada@example.test',
      email_verified: true,
      name: 'Ada K.',
    });
    await signIn(a);
    const again = await t.db.select().from(users).where(eq(users.oidcSubject, 'subject-ada'));
    expect(again).toHaveLength(1);
    expect(again[0]?.name).toBe('Ada K.');

    // The first sign-in created a personal workspace, owned by the user; later ones don't.
    const owned = await t.db
      .select({ workspace: workspaces, role: workspaceMembers.role })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, user?.id ?? ''));
    expect(owned.map((o) => [o.workspace.name, o.role])).toEqual([["Ada's workspace", 'owner']]);
    expect(again[0]?.personalWorkspaceId).toBe(owned[0]?.workspace.id);

    const logout = await a.request('/auth/logout', {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=${sessionToken}`, origin: APP_URL },
    });
    expect(logout.status).toBe(303);
    const end = new URL(logout.headers.get('location') ?? '');
    expect(`${end.origin}${end.pathname}`).toBe(`${issuer.url}/endsession`);
    expect(end.searchParams.get('post_logout_redirect_uri')).toBe(`${APP_URL}/`);
    expect(end.searchParams.get('id_token_hint')).toMatch(/^eyJ/);
    expect(cookieFrom(logout, SESSION_COOKIE)).toBe('');
    expect(
      await t.db
        .select()
        .from(sessions)
        .where(eq(sessions.idHash, hashSessionToken(sessionToken ?? '')))
    ).toHaveLength(0);
    expect((await me(a, sessionToken)).status).toBe(401);
  });

  it('refuses an unverified email and creates nothing', async () => {
    issuer.setIdentity({
      sub: 'subject-mallory',
      email: 'victim@example.test',
      email_verified: false,
    });
    const { callback, sessionToken } = await signIn(app());
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(`${APP_URL}/login?error=email_unverified`);
    expect(sessionToken).toBeUndefined();
    expect(await t.db.select().from(users).where(eq(users.oidcSubject, 'subject-mallory'))).toEqual(
      []
    );
  });

  it('refuses a missing email claim', async () => {
    issuer.setIdentity({ sub: 'subject-noemail' });
    const { callback } = await signIn(app());
    expect(callback.headers.get('location')).toBe(`${APP_URL}/login?error=email_unverified`);
  });

  it('sets is_system_admin from OPENROWS_SYSTEM_ADMINS at each sign-in (#91)', async () => {
    const a = app({ OPENROWS_SYSTEM_ADMINS: ' Root@Example.test , other@example.test' });
    const adminOf = async (sub: string) =>
      (await t.db.select().from(users).where(eq(users.oidcSubject, sub)))[0]?.isSystemAdmin;

    issuer.setIdentity({ sub: 'subject-root', email: 'root@example.TEST', email_verified: true });
    const { sessionToken } = await signIn(a);
    expect(await adminOf('subject-root')).toBe(true);
    const body = (await (await me(a, sessionToken)).json()) as { user: { isSystemAdmin: boolean } };
    expect(body.user.isSystemAdmin).toBe(true);

    issuer.setIdentity({ sub: 'subject-plain', email: 'plain@example.test', email_verified: true });
    await signIn(a);
    expect(await adminOf('subject-plain')).toBe(false);

    // Without OPENROWS_SYSTEM_ADMINS the flag is left as it is, so operators can set it by hand
    // in the database.
    issuer.setIdentity({ sub: 'subject-root', email: 'root@example.test', email_verified: true });
    await signIn(app());
    expect(await adminOf('subject-root')).toBe(true);

    // Taken off the list: the next sign-in clears the flag.
    await signIn(app({ OPENROWS_SYSTEM_ADMINS: 'other@example.test' }));
    expect(await adminOf('subject-root')).toBe(false);
  });

  it('rejects a tampered state', async () => {
    issuer.setIdentity({
      sub: 'subject-tamper',
      email: 'tamper@example.test',
      email_verified: true,
    });
    const { callback, sessionToken } = await signIn(app(), {
      tamper: (p) => p.set('state', `${p.get('state')}x`),
    });
    expect(callback.headers.get('location')).toBe(`${APP_URL}/login?error=state_mismatch`);
    expect(sessionToken).toBeUndefined();
    expect(await t.db.select().from(users).where(eq(users.oidcSubject, 'subject-tamper'))).toEqual(
      []
    );
  });

  it('rejects a callback without the login cookie, or with a forged one', async () => {
    const a = app();
    const login = await a.request('/auth/login');
    const authorize = await fetch(login.headers.get('location') ?? '', { redirect: 'manual' });
    const cb = new URL(authorize.headers.get('location') ?? '');
    const path = `${cb.pathname}${cb.search}`;
    const noCookie = await a.request(path);
    expect(noCookie.headers.get('location')).toBe(`${APP_URL}/login?error=login_expired`);
    const forged = await a.request(path, { headers: { cookie: 'openrows_login=AAAA' } });
    expect(forged.headers.get('location')).toBe(`${APP_URL}/login?error=login_expired`);
  });

  it('maps a provider error (user cancelled) to access_denied', async () => {
    const { callback } = await signIn(app(), {
      tamper: (p) => {
        p.delete('code');
        p.set('error', 'access_denied');
      },
    });
    expect(callback.headers.get('location')).toBe(`${APP_URL}/login?error=access_denied`);
  });

  it('ignores an open-redirect returnTo', async () => {
    issuer.setIdentity({ sub: 'subject-redirect', email: 'r@example.test', email_verified: true });
    const { callback } = await signIn(app(), { path: '/auth/login?returnTo=//evil.example/x' });
    expect(callback.headers.get('location')).toBe(`${APP_URL}/`);
  });

  it('authedClient (the test helper) is signed in as its user', async () => {
    const user = await createUser(t.db, { name: 'Helper' });
    const client = await authedClient(t, user);
    const res = await client.request('/api/me');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: { id: user.id, name: 'Helper' } });
  });

  describe('keeping the session alive', () => {
    async function signedIn(sub: string) {
      issuer.setIdentity({ sub, email: `${sub}@example.test`, email_verified: true });
      const a = app();
      const { sessionToken } = await signIn(a);
      const idHash = hashSessionToken(sessionToken ?? '');
      const row = async () =>
        (await t.db.select().from(sessions).where(eq(sessions.idHash, idHash)))[0];
      const age = (field: 'tokensRefreshedAt' | 'lastSeenAt', ms: number) =>
        t.db
          .update(sessions)
          .set({ [field]: new Date(Date.now() - ms) })
          .where(eq(sessions.idHash, idHash));
      return { a, sessionToken, row, age };
    }

    it('refreshes and rotates the stored refresh token after the interval', async () => {
      const s = await signedIn('subject-refresh');
      const before = await s.row();
      await s.age('tokensRefreshedAt', REFRESH_INTERVAL_MS + 1000);
      expect((await me(s.a, s.sessionToken)).status).toBe(200);
      const after = await s.row();
      expect(after?.refreshTokenEnc?.equals(before?.refreshTokenEnc ?? Buffer.alloc(0))).toBe(
        false
      );
      expect(after?.tokensRefreshedAt.getTime()).toBeGreaterThan(Date.now() - 10_000);
    });

    it('ends the session when the provider rejects the refresh token', async () => {
      const s = await signedIn('subject-revoked');
      await s.age('tokensRefreshedAt', REFRESH_INTERVAL_MS + 1000);
      issuer.server.service.once('beforeResponse', (response) => {
        response.statusCode = 400;
        response.body = { error: 'invalid_grant', error_description: 'Session not active' };
      });
      const res = await me(s.a, s.sessionToken);
      expect(res.status).toBe(401);
      expect(cookieFrom(res, SESSION_COOKIE)).toBe('');
      expect(await s.row()).toBeUndefined();
    });

    it('deleteExpired sweeps idle and past-expiry sessions only', async () => {
      const idle = await signedIn('subject-sweep-idle');
      await idle.age('lastSeenAt', SESSION_IDLE_MS + 1000);
      const live = await signedIn('subject-sweep-live');
      const { store } = testApp({ db: t.appDb });
      expect(await store.deleteExpired()).toBeGreaterThanOrEqual(1);
      expect(await idle.row()).toBeUndefined();
      expect(await live.row()).toBeDefined();
    });

    it('expires an idle session', async () => {
      const s = await signedIn('subject-idle');
      await s.age('lastSeenAt', SESSION_IDLE_MS + 1000);
      expect((await me(s.a, s.sessionToken)).status).toBe(401);
      expect(await s.row()).toBeUndefined();
    });
  });
});
