import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import type { users } from '../../src/db/index.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import {
  createBase,
  createRecordsIn,
  createSession,
  createTableWithFields,
  createUser,
  createWorkspace,
} from '../helpers/factories.js';

type User = typeof users.$inferSelect;
type Json = ReturnType<typeof JSON.parse>;

const REDIRECT = 'https://app.example.test/oauth/callback';

/** A PKCE verifier and its S256 challenge. */
function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/**
 * OAuth apps end to end as openrows_app: registration, the consent screen's checks, the
 * code exchange with PKCE, the access token as a narrowed bearer (scopes, grants, live role),
 * refresh rotation and replay detection, code replay, revocation from Settings and by the app
 * (RFC 7009), deleting the app, expiry, and no secret in the logs.
 */
describe('OAuth apps', () => {
  const t = useTestDb();
  let built: ReturnType<typeof testApp>;
  let developer: User;
  let person: User;
  let cookies: Map<string, string>;
  let workspaceId: string;
  let baseId: string;
  let tableId: string;
  let otherWorkspaceId: string;
  let otherBaseId: string;

  const call = async (
    auth: User | string | null,
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; body: Json; headers: Headers }> => {
    const headers = new Headers();
    if (typeof auth === 'string') headers.set('authorization', `Bearer ${auth}`);
    else if (auth) headers.set('cookie', `${SESSION_COOKIE}=${cookies.get(auth.id)}`);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const res = await built.app.request(path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: Json = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, headers: res.headers };
  };

  /** A form POST to the token or revocation endpoint, with the client's Basic credentials. */
  const form = async (
    path: string,
    params: Record<string, string>,
    client?: { clientId: string; clientSecret: string }
  ) => {
    const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' });
    if (client) {
      const basic = Buffer.from(
        `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`
      ).toString('base64');
      headers.set('authorization', `Basic ${basic}`);
    }
    const res = await built.app.request(path, {
      method: 'POST',
      headers,
      body: new URLSearchParams(params).toString(),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };

  interface App {
    id: string;
    clientId: string;
    clientSecret: string;
  }
  const register = async (name = 'Zap'): Promise<App> => {
    const res = await call(developer, 'POST', '/api/me/oauth-apps', {
      name,
      description: 'Moves rows around',
      homepageUrl: 'https://app.example.test',
      redirectUris: [REDIRECT, 'http://localhost:8765/cb'],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
  };

  const authorizeQuery = (app: App, challenge: string, extra: Record<string, string> = {}) =>
    new URLSearchParams({
      response_type: 'code',
      client_id: app.clientId,
      redirect_uri: REDIRECT,
      scope: 'schema.bases:read data.records:read',
      state: 'xyz',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...extra,
    }).toString();

  /** Consents as `person` and answers the code from the redirect. */
  const consent = async (app: App, challenge: string, grant = { workspaceIds: [workspaceId] }) => {
    const res = await call(person, 'POST', '/api/oauth/authorize', {
      clientId: app.clientId,
      redirectUri: REDIRECT,
      scope: 'schema.bases:read data.records:read',
      state: 'xyz',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      decision: 'allow',
      ...grant,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const url = new URL(res.body.redirectTo);
    expect(`${url.origin}${url.pathname}`).toBe(REDIRECT);
    expect(url.searchParams.get('state')).toBe('xyz');
    return url.searchParams.get('code') ?? '';
  };

  const exchange = (app: App, code: string, verifier: string) =>
    form(
      '/oauth/token',
      { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier },
      app
    );

  /** A full authorization: the token response. */
  const authorize = async (app: App) => {
    const { verifier, challenge } = pkce();
    const code = await consent(app, challenge);
    const res = await exchange(app, code, verifier);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { access_token: string; refresh_token: string };
  };

  beforeAll(async () => {
    built = testApp({ db: t.appDb, env: { AUTH_RATE_LIMIT: '100000' } });
    developer = await createUser(t.db);
    const w = await createWorkspace(t.db);
    person = w.owner;
    workspaceId = w.workspace.id;
    const base = await createBase(t.db, workspaceId);
    baseId = base.id;
    const { table } = await createTableWithFields(t.db, person, base);
    tableId = table.id;
    await createRecordsIn(t.db, person, table);
    const other = await createWorkspace(t.db);
    otherWorkspaceId = other.workspace.id;
    otherBaseId = (await createBase(t.db, otherWorkspaceId)).id;
    cookies = new Map();
    for (const u of [developer, person]) cookies.set(u.id, await createSession(t.db, u));
  });

  it('registers apps with a client secret shown once, and checks redirect URIs', async () => {
    const app = await register('Registered');
    expect(app.clientId).toMatch(/^or_app_[a-z2-7]{20}$/);
    expect(app.clientSecret).toMatch(/^or_secret_[A-Za-z0-9_-]{43}$/);
    const list = await call(developer, 'GET', '/api/me/oauth-apps');
    expect(list.body.apps.map((a: Json) => a.id)).toContain(app.id);
    expect(JSON.stringify(list.body)).not.toContain(app.clientSecret);
    // Nobody else sees or changes it.
    expect((await call(person, 'GET', '/api/me/oauth-apps')).body.apps).toEqual([]);
    expect(
      (await call(person, 'PATCH', `/api/me/oauth-apps/${app.id}`, { name: 'Mine' })).status
    ).toBe(404);
    expect((await call(person, 'DELETE', `/api/me/oauth-apps/${app.id}`)).status).toBe(404);

    for (const bad of [
      'http://app.example.test/cb',
      'https://user:pw@app.example.test/cb',
      'https://app.example.test/cb#frag',
      'javascript:alert(1)',
      'not a url',
    ]) {
      const res = await call(developer, 'POST', '/api/me/oauth-apps', {
        name: 'Bad',
        redirectUris: [bad],
      });
      expect(res.status, bad).toBe(422);
    }
    const none = await call(developer, 'POST', '/api/me/oauth-apps', {
      name: 'X',
      redirectUris: [],
    });
    expect(none.status).toBe(422);

    const rotated = await call(developer, 'PATCH', `/api/me/oauth-apps/${app.id}`, {
      rotateSecret: true,
    });
    expect(rotated.status).toBe(200);
    expect(rotated.body.clientSecret).toMatch(/^or_secret_/);
    expect(rotated.body.clientSecret).not.toBe(app.clientSecret);
    const renamed = await call(developer, 'PATCH', `/api/me/oauth-apps/${app.id}`, {
      name: 'Renamed',
    });
    expect(renamed.body).toMatchObject({ name: 'Renamed', clientSecret: null });
  });

  it("checks the consent screen's request before it shows anything", async () => {
    const app = await register('Checked');
    const { challenge } = pkce();
    const ok = await call(person, 'GET', `/api/oauth/authorize?${authorizeQuery(app, challenge)}`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({
      app: { name: 'Checked', homepageUrl: 'https://app.example.test' },
      redirectUri: REDIRECT,
      scopes: ['schema.bases:read', 'data.records:read'],
      current: null,
    });
    // No session: 401 (the page sends the person to sign in first).
    expect(
      (await call(null, 'GET', `/api/oauth/authorize?${authorizeQuery(app, challenge)}`)).status
    ).toBe(401);
    // An unknown app or redirect URI never sends the browser anywhere.
    for (const extra of [
      { client_id: 'or_app_nope' },
      { redirect_uri: 'https://evil.test/cb' },
      { redirect_uri: `${REDIRECT}/more` },
    ] as Record<string, string>[]) {
      const res = await call(
        person,
        'GET',
        `/api/oauth/authorize?${authorizeQuery(app, challenge, extra)}`
      );
      expect(res.status).toBe(422);
      expect(res.body.redirectTo).toBeUndefined();
    }
    // Other problems go back to the app with the OAuth error and the state.
    for (const [extra, error] of [
      [{ response_type: 'token' }, 'unsupported_response_type'],
      [{ scope: 'data.records:read admin:everything' }, 'invalid_scope'],
      [{ scope: '' }, 'invalid_scope'],
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ code_challenge: 'short' }, 'invalid_request'],
    ] as const) {
      const res = await call(
        person,
        'GET',
        `/api/oauth/authorize?${authorizeQuery(app, challenge, extra)}`
      );
      expect(res.status).toBe(422);
      const back = new URL(res.body.redirectTo);
      expect(back.searchParams.get('error')).toBe(error);
      expect(back.searchParams.get('state')).toBe('xyz');
    }

    // Declining sends access_denied back.
    const denied = await call(person, 'POST', '/api/oauth/authorize', {
      clientId: app.clientId,
      redirectUri: REDIRECT,
      scope: 'data.records:read',
      state: 's1',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      decision: 'deny',
    });
    expect(denied.status).toBe(200);
    expect(new URL(denied.body.redirectTo).searchParams.get('error')).toBe('access_denied');
    // Only what the person can reach can be granted.
    const elsewhere = await call(person, 'POST', '/api/oauth/authorize', {
      clientId: app.clientId,
      redirectUri: REDIRECT,
      scope: 'data.records:read',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      decision: 'allow',
      workspaceIds: [otherWorkspaceId],
    });
    expect(elsewhere.status).toBe(422);
    const nothing = await call(person, 'POST', '/api/oauth/authorize', {
      clientId: app.clientId,
      redirectUri: REDIRECT,
      scope: 'data.records:read',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      decision: 'allow',
    });
    expect(nothing.status).toBe(422);
  });

  it('exchanges a code with PKCE for tokens that act as the person, narrowed', async () => {
    const app = await register('Flow');
    const { verifier, challenge } = pkce();
    const code = await consent(app, challenge);
    // A wrong secret is invalid_client; the code isn't used up by it.
    const wrong = await exchange(
      { ...app, clientSecret: `or_secret_${'A'.repeat(43)}` },
      code,
      verifier
    );
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe('invalid_client');
    const res = await exchange(app, code, verifier);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body).toMatchObject({
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'schema.bases:read data.records:read',
      access_token: expect.stringMatching(/^or_oat_[a-z2-7]{12}_[A-Za-z0-9_-]{43}$/),
      refresh_token: expect.stringMatching(/^or_ort_[a-z2-7]{12}_[A-Za-z0-9_-]{43}$/),
    });
    const access = res.body.access_token as string;

    const bases = await call(access, 'GET', '/api/v1/meta/bases');
    expect(bases.status).toBe(200);
    expect(bases.body.bases.map((b: Json) => b.id)).toEqual([baseId]);
    expect((await call(access, 'GET', `/api/v1/${baseId}/${tableId}`)).status).toBe(200);
    // Its scopes: no writes, no comments.
    const write = await call(access, 'POST', `/api/v1/${baseId}/${tableId}`, { fields: {} });
    expect(write.status).toBe(403);
    // Its grants: nothing of the other tenant.
    expect((await call(access, 'GET', `/api/v1/meta/bases/${otherBaseId}/tables`)).status).toBe(
      404
    );
    // Session-only routes stay closed to it, as to personal access tokens.
    expect((await call(access, 'GET', '/api/me/tokens')).status).toBe(403);
    expect((await call(access, 'GET', '/api/me/authorizations')).status).toBe(403);
    expect(
      (await call(access, 'POST', '/api/me/oauth-apps', { name: 'x', redirectUris: [REDIRECT] }))
        .status
    ).toBe(403);

    // Settings → Integrations lists it, with what it reaches.
    const list = await call(person, 'GET', '/api/me/authorizations');
    const mine = (list.body.authorizations as Json[]).find((a) => a.app.id === app.id);
    expect(mine).toMatchObject({
      scopes: ['schema.bases:read', 'data.records:read'],
      workspaceIds: [workspaceId],
      baseIds: [],
    });
    expect(mine.lastUsedAt).not.toBeNull();
    // Consenting again shows what it has now.
    const again = await call(
      person,
      'GET',
      `/api/oauth/authorize?${authorizeQuery(app, pkce().challenge)}`
    );
    expect(again.body.current).toEqual({ workspaceIds: [workspaceId], baseIds: [] });

    // Expired, it's refused like any bad token.
    await t.db.execute(
      sql`UPDATE oauth_tokens SET expires_at = now() - interval '1 second' WHERE kind = 'access'`
    );
    const expired = await call(access, 'GET', '/api/v1/meta/bases');
    expect(expired.status).toBe(401);

    // No credential ever reaches the logs.
    const logs = JSON.stringify(built.logs);
    expect(logs).not.toContain(access);
    expect(logs).not.toContain(res.body.refresh_token);
    expect(logs).not.toContain(app.clientSecret);
    expect(logs).not.toContain(code);
  });

  it('refuses a code twice, with the wrong verifier or redirect URI, and revokes on replay', async () => {
    const app = await register('Replay');
    const first = pkce();
    const code = await consent(app, first.challenge);
    // The wrong verifier uses the code up.
    const bad = await exchange(app, code, pkce().verifier);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_grant');
    expect((await exchange(app, code, first.verifier)).body.error).toBe('invalid_grant');

    const second = pkce();
    const code2 = await consent(app, second.challenge);
    const wrongUri = await form(
      '/oauth/token',
      {
        grant_type: 'authorization_code',
        code: code2,
        redirect_uri: 'http://localhost:8765/cb',
        code_verifier: second.verifier,
      },
      app
    );
    expect(wrongUri.body.error).toBe('invalid_grant');

    const tokens = await authorize(app);
    expect((await call(tokens.access_token, 'GET', '/api/v1/meta/bases')).status).toBe(200);
    // Another app can't use this app's code.
    const third = pkce();
    const code3 = await consent(app, third.challenge);
    const other = await register('Other');
    expect((await exchange(other, code3, third.verifier)).body.error).toBe('invalid_grant');
    // A code used twice revokes the authorization: the tokens it gave stop working.
    const ok = await exchange(app, code3, third.verifier);
    expect(ok.status).toBe(200);
    expect((await exchange(app, code3, third.verifier)).body.error).toBe('invalid_grant');
    expect((await call(ok.body.access_token, 'GET', '/api/v1/meta/bases')).status).toBe(401);
    expect((await call(tokens.access_token, 'GET', '/api/v1/meta/bases')).status).toBe(401);
    // A code is good for ten minutes.
    const fourth = pkce();
    const code4 = await consent(app, fourth.challenge);
    await t.db.execute(
      sql`UPDATE oauth_codes SET expires_at = now() - interval '1 second' WHERE used_at IS NULL`
    );
    expect((await exchange(app, code4, fourth.verifier)).body.error).toBe('invalid_grant');
  });

  it('rotates refresh tokens, and a reused one revokes the authorization', async () => {
    const app = await register('Refresh');
    const tokens = await authorize(app);
    const refresh = (token: string, client: App = app) =>
      form('/oauth/token', { grant_type: 'refresh_token', refresh_token: token }, client);
    const next = await refresh(tokens.refresh_token);
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(next.body.refresh_token).not.toBe(tokens.refresh_token);
    expect((await call(next.body.access_token, 'GET', '/api/v1/meta/bases')).status).toBe(200);
    // Another app's credentials don't refresh it.
    expect((await refresh(next.body.refresh_token, await register('Thief'))).body.error).toBe(
      'invalid_grant'
    );
    // The old refresh token again: someone else holds it, so everything under it ends.
    const replay = await refresh(tokens.refresh_token);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
    expect((await call(next.body.access_token, 'GET', '/api/v1/meta/bases')).status).toBe(401);
    expect((await refresh(next.body.refresh_token)).body.error).toBe('invalid_grant');

    // Form errors in RFC 6749's shape.
    expect((await form('/oauth/token', { grant_type: 'password' }, app)).body.error).toBe(
      'unsupported_grant_type'
    );
    expect((await form('/oauth/token', { grant_type: 'refresh_token' }, app)).body.error).toBe(
      'invalid_request'
    );
    const anonymous = await form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: 'x',
    });
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error).toBe('invalid_client');
    // client_secret_post works too.
    const fresh = await authorize(app);
    const posted = await form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: fresh.refresh_token,
      client_id: app.clientId,
      client_secret: app.clientSecret,
    });
    expect(posted.status).toBe(200);
  });

  it('ends access when the person revokes it, the app revokes it or the app is deleted', async () => {
    const app = await register('Revoked');
    const live = async (access: string) => (await call(access, 'GET', '/api/v1/meta/bases')).status;

    // From Settings → Integrations.
    let tokens = await authorize(app);
    const list = await call(person, 'GET', '/api/me/authorizations');
    const mine = (list.body.authorizations as Json[]).find((a) => a.app.id === app.id);
    expect((await call(developer, 'DELETE', `/api/me/authorizations/${mine.id}`)).status).toBe(404);
    expect((await call(person, 'DELETE', `/api/me/authorizations/${mine.id}`)).status).toBe(204);
    expect(await live(tokens.access_token)).toBe(401);
    expect(
      (
        await form(
          '/oauth/token',
          { grant_type: 'refresh_token', refresh_token: tokens.refresh_token },
          app
        )
      ).body.error
    ).toBe('invalid_grant');
    expect(
      ((await call(person, 'GET', '/api/me/authorizations')).body.authorizations as Json[]).some(
        (a) => a.app.id === app.id
      )
    ).toBe(false);

    // By the app (RFC 7009): an access token alone, or a refresh token and all with it.
    tokens = await authorize(app);
    expect((await form('/oauth/revoke', { token: tokens.access_token }, app)).status).toBe(200);
    expect(await live(tokens.access_token)).toBe(401);
    const next = await form(
      '/oauth/token',
      { grant_type: 'refresh_token', refresh_token: tokens.refresh_token },
      app
    );
    expect(next.status).toBe(200);
    expect((await form('/oauth/revoke', { token: next.body.refresh_token }, app)).status).toBe(200);
    expect(await live(next.body.access_token)).toBe(401);
    // Unknown tokens are answered the same.
    expect((await form('/oauth/revoke', { token: 'or_ort_nope' }, app)).status).toBe(200);

    // Deleting the app ends everyone's access to it.
    tokens = await authorize(app);
    expect((await call(developer, 'DELETE', `/api/me/oauth-apps/${app.id}`)).status).toBe(204);
    expect(await live(tokens.access_token)).toBe(401);
    const gone = await call(
      person,
      'GET',
      `/api/oauth/authorize?${authorizeQuery(app, pkce().challenge)}`
    );
    expect(gone.status).toBe(422);
  });

  it('follows the person’s live role and suspension', async () => {
    const app = await register('Live');
    const tokens = await authorize(app);
    await t.db.execute(sql`UPDATE users SET suspended_at = now() WHERE id = ${person.id}`);
    expect((await call(tokens.access_token, 'GET', '/api/v1/meta/bases')).status).toBe(401);
    await t.db.execute(sql`UPDATE users SET suspended_at = NULL WHERE id = ${person.id}`);
    expect((await call(tokens.access_token, 'GET', '/api/v1/meta/bases')).status).toBe(200);
  });

  it('describes itself (RFC 8414)', async () => {
    const res = await call(null, 'GET', '/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      issuer: built.config.appUrl,
      authorization_endpoint: `${built.config.appUrl}/oauth/authorize`,
      token_endpoint: `${built.config.appUrl}/oauth/token`,
      code_challenge_methods_supported: ['S256'],
    });
  });
});
