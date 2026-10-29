import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { users } from '../../src/db/schema.js';
import { ossEdition } from '../../src/edition/oss.js';
import type { Edition } from '../../src/edition/types.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { createSession, createUser } from '../helpers/factories.js';
import { signIn, useMockIssuer } from '../helpers/oidc.js';

const APP_URL = 'http://localhost:5173';

/**
 * Data residency in the core: the OSS edition is one self-serve region; a stack whose
 * edition says it isn't self-serve (a region provisioned from the home one) creates no workspace
 * on request or at a first sign-in. Two regional stacks are the hosted edition's tests.
 */
describe('regions', () => {
  const t = useTestDb();
  const issuer = useMockIssuer();

  function app(edition?: Edition) {
    return testApp({
      db: t.appDb,
      ...(edition ? { edition } : {}),
      env: {
        APP_URL,
        OIDC_ISSUER_URL: issuer.url,
        OIDC_CLIENT_ID: 'openrows-app',
        OIDC_CLIENT_SECRET: 'test-client-secret',
        AUTH_RATE_LIMIT: '1000',
      },
    }).app;
  }

  const provisioned = (): Edition => ({
    ...ossEdition(),
    residency: {
      id: 'test',
      current: { id: 'us', name: 'United States', appUrl: 'https://us.example.test' },
      regions: [
        { id: 'eu', name: 'European Union', appUrl: 'https://eu.example.test' },
        { id: 'us', name: 'United States', appUrl: 'https://us.example.test' },
      ],
      selfServe: false,
    },
  });

  async function request(a: ReturnType<typeof app>, path: string, body?: unknown) {
    const user = await createUser(t.db);
    return a.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        cookie: `${SESSION_COOKIE}=${await createSession(t.db, user)}`,
        origin: APP_URL,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  it('the OSS edition lists its one region at APP_URL and creates nothing elsewhere', async () => {
    const a = app();
    const res = await request(a, '/api/regions');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      current: 'default',
      regions: [{ id: 'default', name: 'This server', appUrl: APP_URL }],
      createElsewhere: false,
    });
    expect((await request(a, '/api/regions/default/workspaces', { name: 'x' })).status).toBe(404);
    expect((await request(a, '/api/regions/us/workspaces', { name: 'x' })).status).toBe(404);
  });

  it('a provisioned region refuses POST /api/workspaces', async () => {
    const res = await request(app(provisioned()), '/api/workspaces', { name: 'Mine' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'WORKSPACE_CREATION_ELSEWHERE' });
    const regions = await request(app(provisioned()), '/api/regions');
    expect(await regions.json()).toMatchObject({ current: 'us', createElsewhere: false });
  });

  it('a provisioned region gives a first sign-in no personal workspace', async () => {
    issuer.setIdentity({ sub: 'subject-us', email: 'us@example.test', email_verified: true });
    const { sessionToken } = await signIn(app(provisioned()));
    expect(sessionToken).toBeTruthy();
    const [user] = await t.db.select().from(users).where(eq(users.oidcSubject, 'subject-us'));
    expect(user?.personalWorkspaceId).toBeNull();

    issuer.setIdentity({ sub: 'subject-eu', email: 'eu@example.test', email_verified: true });
    await signIn(app());
    const [home] = await t.db.select().from(users).where(eq(users.oidcSubject, 'subject-eu'));
    expect(home?.personalWorkspaceId).toBeTruthy();
  });
});
