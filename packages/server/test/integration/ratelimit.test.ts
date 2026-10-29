import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import type { users } from '../../src/db/index.js';
import { pruneRateLimits, pruneTokenUsage } from '../../src/ratelimit/postgres.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import {
  createBase,
  createSession,
  createTableWithFields,
  createToken,
  createWorkspace,
} from '../helpers/factories.js';

type User = typeof users.$inferSelect;
type App = ReturnType<typeof testApp>;

const limits = (base: [number, number], token: [number, number]) => ({
  API_RATE_LIMIT_BASE: String(base[0]),
  API_RATE_LIMIT_BASE_BURST: String(base[1]),
  API_RATE_LIMIT_TOKEN: String(token[0]),
  API_RATE_LIMIT_TOKEN_BURST: String(token[1]),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The API's rate limits: token buckets per base on /api/v1 and per personal access token
 * (any route) or signed-in user (/api/v1), kept in Postgres so every instance shares them.
 */
describe('API rate limits', () => {
  const t = useTestDb();
  let owner: User;
  let workspaceId: string;
  let outsider: User;

  beforeAll(async () => {
    const w = await createWorkspace(t.db);
    owner = w.owner;
    workspaceId = w.workspace.id;
    outsider = (await createWorkspace(t.db)).owner;
  });

  /** A new base with a "Tasks" table: every test gets buckets of its own. */
  async function newBase(): Promise<string> {
    const base = await createBase(t.db, workspaceId);
    await createTableWithFields(t.db, owner, base);
    return base.id;
  }

  const get = (app: App, path: string, auth: { bearer?: string; cookie?: string }) =>
    app.app.request(path, {
      headers: {
        ...(auth.bearer ? { authorization: `Bearer ${auth.bearer}` } : {}),
        ...(auth.cookie ? { cookie: `${SESSION_COOKIE}=${auth.cookie}` } : {}),
      },
    });
  const statuses = async (n: number, call: () => Response | Promise<Response>) => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push((await call()).status);
    return out;
  };

  it('allows a burst per base, then answers 429 with Retry-After and RateLimit headers', async () => {
    const app = testApp({ db: t.appDb, env: limits([0.1, 3], [100, 1000]) });
    const baseId = await newBase();
    const { token } = await createToken(t.db, owner, { workspaceIds: [workspaceId] });
    const path = `/api/v1/${baseId}/Tasks`;

    const remaining: (string | null)[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await get(app, path, { bearer: token });
      expect(res.status).toBe(200);
      expect(res.headers.get('RateLimit-Limit')).toBe('3');
      expect(res.headers.get('RateLimit-Policy')).toBe('3;w=30');
      remaining.push(res.headers.get('RateLimit-Remaining'));
    }
    expect(remaining).toEqual(['2', '1', '0']);

    const refused = await get(app, path, { bearer: token });
    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).toBe('10');
    expect(refused.headers.get('RateLimit-Limit')).toBe('3');
    expect(refused.headers.get('RateLimit-Remaining')).toBe('0');
    expect(Number(refused.headers.get('RateLimit-Reset'))).toBeGreaterThan(20);
    const requestId = refused.headers.get('X-Request-Id');
    expect(requestId).toBeTruthy();
    expect(await refused.json()).toEqual({
      error: {
        type: 'TOO_MANY_REQUESTS',
        code: 'RATE_LIMITED',
        message: expect.stringContaining('this base'),
        requestId,
        limit: 'base',
      },
    });
  });

  it('keeps bases apart: one base at its limit leaves the others alone', async () => {
    const app = testApp({ db: t.appDb, env: limits([0.1, 2], [100, 1000]) });
    const [b1, b2] = [await newBase(), await newBase()];
    const { token } = await createToken(t.db, owner, { workspaceIds: [workspaceId] });
    expect(await statuses(3, () => get(app, `/api/v1/${b1}/Tasks`, { bearer: token }))).toEqual([
      200, 200, 429,
    ]);
    expect(await statuses(2, () => get(app, `/api/v1/${b2}/Tasks`, { bearer: token }))).toEqual([
      200, 200,
    ]);
    // The meta routes of a base count against it too.
    expect((await get(app, `/api/v1/meta/bases/${b1}/tables`, { bearer: token })).status).toBe(429);
    // Every caller of the base shares its bucket: another token of another member, too.
    const { token: second } = await createToken(t.db, owner, { baseIds: [b1] });
    expect((await get(app, `/api/v1/${b1}/Tasks`, { bearer: second })).status).toBe(429);
  });

  it('refills over time', async () => {
    const app = testApp({ db: t.appDb, env: limits([20, 2], [100, 1000]) });
    const baseId = await newBase();
    const { token } = await createToken(t.db, owner, { workspaceIds: [workspaceId] });
    const call = () => get(app, `/api/v1/${baseId}/Tasks`, { bearer: token });
    // Two at once, then empty: at 20 per second a token is back within 50 ms.
    const first = await statuses(3, call);
    expect(first.slice(0, 2)).toEqual([200, 200]);
    await sleep(120);
    expect((await call()).status).toBe(200);
    await sleep(120);
    expect((await call()).status).toBe(200);
  });

  it('shares the limits between two API instances on one database', async () => {
    const env = limits([0.1, 4], [100, 1000]);
    const one = testApp({ db: t.appDb, env });
    const two = testApp({ db: t.appDb, env });
    const baseId = await newBase();
    const { token } = await createToken(t.db, owner, { workspaceIds: [workspaceId] });
    const path = `/api/v1/${baseId}/Tasks`;
    const seen: number[] = [];
    for (const app of [one, two, one, two, one, two]) {
      seen.push((await get(app, path, { bearer: token })).status);
    }
    expect(seen).toEqual([200, 200, 200, 200, 429, 429]);

    // Concurrent requests through both instances never pass more than the burst.
    const fresh = await newBase();
    const all = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        get(i % 2 ? one : two, `/api/v1/${fresh}/Tasks`, { bearer: token })
      )
    );
    expect(all.filter((r) => r.status === 200)).toHaveLength(4);
    expect(all.filter((r) => r.status === 429)).toHaveLength(6);
  });

  it('limits a token on every route and across bases, each token apart', async () => {
    const app = testApp({ db: t.appDb, env: limits([100, 1000], [0.1, 4]) });
    const [b1, b2] = [await newBase(), await newBase()];
    const { token } = await createToken(t.db, owner, { workspaceIds: [workspaceId] });
    const seen = [
      (await get(app, `/api/v1/${b1}/Tasks`, { bearer: token })).status,
      (await get(app, `/api/v1/${b2}/Tasks`, { bearer: token })).status,
      // Outside /api/v1 as well.
      (await get(app, '/api/me', { bearer: token })).status,
      (await get(app, '/api/v1/meta/bases', { bearer: token })).status,
    ];
    expect(seen).toEqual([200, 200, 200, 200]);
    const refused = await get(app, `/api/v1/${b2}/Tasks`, { bearer: token });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: { limit: 'token' } });
    const other = await get(app, '/api/me', { bearer: token });
    expect(other.status).toBe(429);
    expect(other.headers.get('content-type')).toContain('application/problem+json');
    expect(await other.json()).toMatchObject({ code: 'RATE_LIMITED', limit: 'token' });

    const { token: second } = await createToken(t.db, owner, { workspaceIds: [workspaceId] });
    expect((await get(app, `/api/v1/${b1}/Tasks`, { bearer: second })).status).toBe(200);
  });

  it("limits a signed-in user on /api/v1, never the app's own API", async () => {
    const app = testApp({ db: t.appDb, env: limits([100, 1000], [0.1, 2]) });
    const baseId = await newBase();
    const cookie = await createSession(t.db, owner);
    expect(await statuses(3, () => get(app, `/api/v1/${baseId}/Tasks`, { cookie }))).toEqual([
      200, 200, 429,
    ]);
    const inApp = await get(app, `/api/bases/${baseId}`, { cookie });
    expect(inApp.status).toBe(200);
    expect(inApp.headers.get('RateLimit-Limit')).toBeNull();
  });

  it("can't be used to drain another tenant's base", async () => {
    const app = testApp({ db: t.appDb, env: limits([0.1, 2], [100, 1000]) });
    const baseId = await newBase();
    const { token: theirs } = await createToken(t.db, outsider);
    const outsiderCookie = await createSession(t.db, outsider);
    for (let i = 0; i < 5; i++) {
      expect((await get(app, `/api/v1/${baseId}/Tasks`, { bearer: theirs })).status).toBe(404);
      expect((await get(app, `/api/v1/${baseId}/Tasks`, { cookie: outsiderCookie })).status).toBe(
        404
      );
    }
    const { token } = await createToken(t.db, owner, { workspaceIds: [workspaceId] });
    expect(await statuses(2, () => get(app, `/api/v1/${baseId}/Tasks`, { bearer: token }))).toEqual(
      [200, 200]
    );
  });

  it("counts each token's requests per UTC day for the token list", async () => {
    const app = testApp({ db: t.appDb });
    const baseId = await newBase();
    const { id, token } = await createToken(t.db, owner, { workspaceIds: [workspaceId] });
    const { id: idle } = await createToken(t.db, owner, { workspaceIds: [workspaceId] });
    for (let i = 0; i < 3; i++) await get(app, `/api/v1/${baseId}/Tasks`, { bearer: token });
    await get(app, '/api/me', { bearer: token });
    // An older day, as the counter left it.
    await t.db.execute(
      sql`INSERT INTO personal_access_token_usage (token_id, user_id, day, requests)
          VALUES (${id}, ${owner.id}, (now() AT TIME ZONE 'UTC')::date - 2, 7),
                 (${id}, ${owner.id}, (now() AT TIME ZONE 'UTC')::date - 30, 99)`
    );
    const cookie = await createSession(t.db, owner);
    const res = await get(app, '/api/me/tokens', { cookie });
    expect(res.status).toBe(200);
    const { tokens } = (await res.json()) as {
      tokens: { id: string; usage: { day: string; requests: number }[] }[];
    };
    const today = new Date().toISOString().slice(0, 10);
    const used = tokens.find((x) => x.id === id);
    expect(used?.usage).toHaveLength(7);
    expect(used?.usage.at(-1)).toEqual({ day: today, requests: 4 });
    expect(used?.usage.at(-3)?.requests).toBe(7);
    expect(used?.usage.reduce((n, d) => n + d.requests, 0)).toBe(11);
    // The worker drops counts past retention.
    expect(await pruneTokenUsage(t.appDb, 10)).toBe(1);
    expect(tokens.find((x) => x.id === idle)?.usage.every((d) => d.requests === 0)).toBe(true);
  });

  it('keeps the buckets out of reach of the app role and prunes idle ones', async () => {
    await expect(t.appDb.execute(sql`SELECT * FROM rate_limit_buckets`)).rejects.toMatchObject({
      cause: { code: '42501' },
    });
    await t.db.execute(
      sql`INSERT INTO rate_limit_buckets (key, tokens, updated_at)
          VALUES ('base:idle', 1, now() - interval '2 hours'), ('base:busy', 1, now())`
    );
    expect(await pruneRateLimits(t.appDb, 3600)).toBeGreaterThanOrEqual(1);
    const { rows } = await t.db.execute<{ key: string }>(
      sql`SELECT key FROM rate_limit_buckets WHERE key IN ('base:idle', 'base:busy')`
    );
    expect(rows.map((r) => r.key)).toEqual(['base:busy']);
    const { rows: kind } = await t.db.execute<{ relpersistence: string }>(
      sql`SELECT relpersistence FROM pg_class WHERE relname = 'rate_limit_buckets'`
    );
    expect(kind[0]?.relpersistence).toBe('u');
  });
});
