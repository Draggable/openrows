import type { AccessToken, CreatedAccessToken } from '@openrows/shared';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { BEARER_FAILURE_LIMIT } from '../../src/app.js';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { inScope } from '../../src/authz/scope.js';
import { personalAccessTokens, type users, workspaceMembers } from '../../src/db/index.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import {
  addMember,
  createBase,
  createRecordsIn,
  createSession,
  createTableWithFields,
  createToken,
  createUser,
  createWorkspace,
} from '../helpers/factories.js';

type User = typeof users.$inferSelect;

/**
 * Personal access tokens: created, listed and revoked by their owner's session; bearer
 * auth with the user's role ∩ the token's scopes ∩ its grants; 401 alike for unknown, revoked,
 * expired and malformed tokens; no cookies, no CSRF check, failed attempts rate-limited; never
 * logged; and the access follows the user's live role.
 */
describe('personal access tokens', () => {
  const t = useTestDb();
  let app: ReturnType<typeof testApp>;
  let owner: User;
  let ownerCookie: string;
  let workspaceId: string;
  let baseId: string;
  let tableId: string;
  let otherWorkspaceId: string;
  let otherBaseId: string;
  let otherTableId: string;

  beforeAll(async () => {
    app = testApp({ db: t.appDb });
    const w = await createWorkspace(t.db);
    owner = w.owner;
    workspaceId = w.workspace.id;
    ownerCookie = await createSession(t.db, owner);
    const base = await createBase(t.db, workspaceId);
    baseId = base.id;
    const { table } = await createTableWithFields(t.db, owner, base);
    tableId = table.id;
    await createRecordsIn(t.db, owner, table);
    // Another tenant, with its own base and table.
    const other = await createWorkspace(t.db);
    otherWorkspaceId = other.workspace.id;
    const otherBase = await createBase(t.db, otherWorkspaceId);
    otherBaseId = otherBase.id;
    const { table: otherTable } = await createTableWithFields(t.db, other.owner, otherBase);
    otherTableId = otherTable.id;
  });

  const call = (
    method: string,
    path: string,
    auth: { bearer?: string; cookie?: string; origin?: boolean } = {},
    body?: unknown
  ) =>
    app.app.request(path, {
      method,
      headers: {
        ...(auth.bearer !== undefined ? { authorization: `Bearer ${auth.bearer}` } : {}),
        ...(auth.cookie ? { cookie: `${SESSION_COOKIE}=${auth.cookie}` } : {}),
        ...(auth.origin ? { origin: app.config.appUrl } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const asOwner = (method: string, path: string, body?: unknown) =>
    call(method, path, { cookie: ownerCookie, origin: true }, body);

  async function create(body: Record<string, unknown>): Promise<CreatedAccessToken> {
    const res = await asOwner('POST', '/api/me/tokens', body);
    if (res.status !== 201) throw new Error(`${res.status}: ${await res.text()}`);
    return (await res.json()) as CreatedAccessToken;
  }

  it('creates a token shown once, lists it without the secret, and stores only a hash', async () => {
    const created = await create({
      name: 'CI sync',
      scopes: ['schema.bases:read', 'data.records:read'],
      workspaceIds: [workspaceId],
    });
    expect(created.token).toMatch(/^or_pat_[a-z2-7]{12}_[A-Za-z0-9_-]{43}$/);
    expect(created.token.startsWith(created.prefix)).toBe(true);
    const days = (Date.parse(created.expiresAt) - Date.parse(created.createdAt)) / 86_400_000;
    expect(days).toBe(90);

    const list = (await (await asOwner('GET', '/api/me/tokens')).json()) as {
      tokens: AccessToken[];
    };
    const listed = list.tokens.find((k) => k.id === created.id);
    expect(listed).toMatchObject({ name: 'CI sync', prefix: created.prefix, lastUsedAt: null });
    expect(JSON.stringify(list)).not.toContain(created.token);

    const [row] = await t.db
      .select()
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.id, created.id));
    const secret = created.token.slice(created.prefix.length + 1);
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  it('validates the request: scopes, grants, expiry at most a year', async () => {
    const bad = [
      { name: 'x', scopes: [], workspaceIds: [workspaceId] },
      { name: 'x', scopes: ['data.records:delete'], workspaceIds: [workspaceId] },
      { name: 'x', scopes: ['data.records:read'] },
      { name: 'x', scopes: ['data.records:read'], workspaceIds: [workspaceId], expiresInDays: 366 },
      { name: '', scopes: ['data.records:read'], workspaceIds: [workspaceId] },
      // Another tenant's workspace or base can't be granted (cross-tenant).
      { name: 'x', scopes: ['data.records:read'], workspaceIds: [otherWorkspaceId] },
      { name: 'x', scopes: ['data.records:read'], baseIds: [otherBaseId] },
    ];
    for (const body of bad) {
      const res = await asOwner('POST', '/api/me/tokens', body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    const year = await create({
      name: 'yearly',
      scopes: ['data.records:read'],
      baseIds: [baseId],
      expiresInDays: 365,
    });
    expect(Date.parse(year.expiresAt) - Date.parse(year.createdAt)).toBe(365 * 86_400_000);
  });

  it('authenticates GET /api/workspaces, records and schema with the bearer token', async () => {
    const { token } = await create({
      name: 'reader',
      scopes: ['schema.bases:read', 'data.records:read'],
      workspaceIds: [workspaceId],
    });
    const ws = await call('GET', '/api/workspaces', { bearer: token });
    expect(ws.status).toBe(200);
    const { workspaces } = (await ws.json()) as { workspaces: { id: string }[] };
    expect(workspaces.map((w) => w.id)).toEqual([workspaceId]);
    expect((await call('GET', `/api/bases/${baseId}/tables`, { bearer: token })).status).toBe(200);
    expect((await call('GET', `/api/tables/${tableId}/records`, { bearer: token })).status).toBe(
      200
    );
    // last_used_at is recorded.
    const [row] = await t.db
      .select({ lastUsedAt: personalAccessTokens.lastUsedAt })
      .from(personalAccessTokens)
      .where(sql`${personalAccessTokens.publicId} = ${token.slice(7, 19)}`);
    expect(row?.lastUsedAt).toBeInstanceOf(Date);
  });

  it('allows only what its scopes name (403 otherwise)', async () => {
    const { token } = await create({
      name: 'schema only',
      scopes: ['schema.bases:read'],
      workspaceIds: [workspaceId],
    });
    expect((await call('GET', `/api/bases/${baseId}/tables`, { bearer: token })).status).toBe(200);
    expect((await call('GET', `/api/tables/${tableId}/records`, { bearer: token })).status).toBe(
      403
    );
    const write = await call(
      'POST',
      `/api/tables/${tableId}/records`,
      { bearer: token },
      {
        records: [{ fields: {} }],
      }
    );
    expect(write.status).toBe(403);
    // The realtime catch-up carries record data.
    expect(
      (await call('GET', `/api/bases/${baseId}/events?since=0`, { bearer: token })).status
    ).toBe(403);
    // GET /api/me needs user.email:read.
    expect((await call('GET', '/api/me', { bearer: token })).status).toBe(403);
    const { token: email } = await create({
      name: 'whoami',
      scopes: ['user.email:read'],
      workspaceIds: [workspaceId],
    });
    const me = await call('GET', '/api/me', { bearer: email });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { id: string } }).user.id).toBe(owner.id);
  });

  it("never exceeds its user's role", async () => {
    const reader = await addMember(t.db, workspaceId, 'read_only');
    const { token } = await createToken(t.db, reader, { workspaceIds: [workspaceId] });
    expect((await call('GET', `/api/tables/${tableId}/records`, { bearer: token })).status).toBe(
      200
    );
    const write = await call(
      'POST',
      `/api/tables/${tableId}/records`,
      { bearer: token },
      {
        records: [{ fields: {} }],
      }
    );
    expect(write.status).toBe(403);
    const rename = await call('PATCH', `/api/bases/${baseId}`, { bearer: token }, { name: 'x' });
    expect(rename.status).toBe(403);
  });

  it('writes with data.records:write, without a CSRF Origin, and sets no cookie', async () => {
    const { token } = await createToken(t.db, owner, {
      scopes: ['data.records:write'],
      workspaceIds: [workspaceId],
    });
    const res = await call(
      'POST',
      `/api/tables/${tableId}/records`,
      { bearer: token },
      {
        records: [{ fields: {} }],
      }
    );
    expect(res.status).toBe(201);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('answers 404 for a base outside its grants, and in another tenant (cross-tenant)', async () => {
    const secondBase = await createBase(t.db, workspaceId);
    const { table: secondTable } = await createTableWithFields(t.db, owner, secondBase, 'Second');
    const { token } = await createToken(t.db, owner, { baseIds: [baseId] });
    expect((await call('GET', `/api/bases/${baseId}`, { bearer: token })).status).toBe(200);
    expect((await call('GET', `/api/bases/${secondBase.id}`, { bearer: token })).status).toBe(404);
    expect(
      (await call('GET', `/api/tables/${secondTable.id}/records`, { bearer: token })).status
    ).toBe(404);
    // The workspace itself isn't granted, its base list shows only the granted base.
    expect((await call('GET', `/api/workspaces/${workspaceId}`, { bearer: token })).status).toBe(
      404
    );
    const listed = await call('GET', `/api/workspaces/${workspaceId}/bases`, { bearer: token });
    expect(listed.status).toBe(200);
    const { bases } = (await listed.json()) as { bases: { id: string }[] };
    expect(bases.map((b) => b.id)).toEqual([baseId]);
    const ws = (await (await call('GET', '/api/workspaces', { bearer: token })).json()) as {
      workspaces: { id: string }[];
    };
    expect(ws.workspaces.map((w) => w.id)).toEqual([workspaceId]);

    // Workspace A's token can't read workspace B, even if (wrongly) granted B.
    const { token: forged } = await createToken(t.db, owner, {
      workspaceIds: [workspaceId, otherWorkspaceId],
      baseIds: [otherBaseId],
    });
    for (const path of [
      `/api/workspaces/${otherWorkspaceId}`,
      `/api/workspaces/${otherWorkspaceId}/bases`,
      `/api/bases/${otherBaseId}`,
      `/api/tables/${otherTableId}/records`,
    ]) {
      expect((await call('GET', path, { bearer: forged })).status, path).toBe(404);
    }
    const all = (await (await call('GET', '/api/workspaces', { bearer: forged })).json()) as {
      workspaces: { id: string }[];
    };
    expect(all.workspaces.map((w) => w.id)).toEqual([workspaceId]);
  });

  it('keeps session-only routes to sessions (403 with a token)', async () => {
    const { token } = await createToken(t.db, owner, { workspaceIds: [workspaceId] });
    const refused: [string, string, unknown?][] = [
      ['GET', '/api/me/tokens'],
      ['POST', '/api/me/tokens', { name: 'x', scopes: ['data.records:read'], baseIds: [baseId] }],
      ['GET', '/api/me/export.zip'],
      ['GET', `/api/bases/${baseId}/export.zip`],
      ['GET', '/api/notifications'],
      ['PATCH', `/api/workspaces/${workspaceId}`, { name: 'Renamed' }],
      ['DELETE', `/api/workspaces/${workspaceId}`],
      ['DELETE', `/api/bases/${baseId}`],
      ['POST', `/api/workspaces/${workspaceId}/invitations`, { email: 'a@b.test', role: 'editor' }],
      ['POST', `/api/bases/${baseId}/shares`, {}],
      ['GET', `/api/bases/${baseId}/snapshots`],
      ['PATCH', `/api/tables/${tableId}`, { permissions: { addRecords: { level: 'creators' } } }],
    ];
    for (const [method, path, body] of refused) {
      const res = await call(method, path, { bearer: token }, body);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    // The same token renames the table (no permission change in the body).
    const rename = await call(
      'PATCH',
      `/api/tables/${tableId}`,
      { bearer: token },
      {
        name: 'Renamed by token',
      }
    );
    expect(rename.status).toBe(200);
  });

  it('rejects revoked, expired, unknown and malformed tokens with the same 401', async () => {
    const created = await create({
      name: 'to revoke',
      scopes: ['schema.bases:read'],
      workspaceIds: [workspaceId],
    });
    expect((await call('GET', '/api/workspaces', { bearer: created.token })).status).toBe(200);
    expect((await asOwner('DELETE', `/api/me/tokens/${created.id}`)).status).toBe(204);
    expect((await asOwner('DELETE', `/api/me/tokens/${created.id}`)).status).toBe(404);

    const { token: expired } = await createToken(t.db, owner, {
      workspaceIds: [workspaceId],
      expiresAt: new Date(Date.now() - 1000),
    });
    const { token: live } = await createToken(t.db, owner, { workspaceIds: [workspaceId] });
    const unknown = `${live.slice(0, 7)}aaaaaaaaaaaa${live.slice(19)}`;
    const wrongSecret = `${live.slice(0, -4)}AAAA`;
    const bodies = new Set<string>();
    for (const bearer of [created.token, expired, unknown, wrongSecret, 'or_pat_nope', 'x']) {
      const res = await call('GET', '/api/workspaces', { bearer });
      expect(res.status, bearer).toBe(401);
      const { detail, title, code } = (await res.json()) as Record<string, unknown>;
      bodies.add(JSON.stringify({ detail, title, code }));
    }
    expect(bodies.size).toBe(1);
    // A bad bearer token isn't rescued by a valid cookie: the token decides.
    const both = await call('GET', '/api/workspaces', { bearer: wrongSecret, cookie: ownerCookie });
    expect(both.status).toBe(401);
    expect(both.headers.get('set-cookie')).toBeNull();
  });

  it("lists, and revokes, only the caller's own tokens (RLS)", async () => {
    const stranger = await createUser(t.db);
    const { id } = await createToken(t.db, stranger, { workspaceIds: [workspaceId] });
    const mine = (await (await asOwner('GET', '/api/me/tokens')).json()) as {
      tokens: AccessToken[];
    };
    expect(mine.tokens.some((k) => k.id === id)).toBe(false);
    expect((await asOwner('DELETE', `/api/me/tokens/${id}`)).status).toBe(404);
    // Under RLS as the owner, the stranger's token isn't visible at all.
    const seen = await inScope(t.appDb, { userId: owner.id }, (tx) =>
      tx.select().from(personalAccessTokens).where(eq(personalAccessTokens.id, id))
    );
    expect(seen).toEqual([]);
    const theirs = await inScope(t.appDb, { userId: stranger.id }, (tx) =>
      tx.select().from(personalAccessTokens).where(eq(personalAccessTokens.id, id))
    );
    expect(theirs).toHaveLength(1);
  });

  it('loses access with its user: no stored role', async () => {
    const editor = await addMember(t.db, workspaceId, 'editor');
    const { token } = await createToken(t.db, editor, { workspaceIds: [workspaceId] });
    const path = `/api/tables/${tableId}/records`;
    expect((await call('GET', path, { bearer: token })).status).toBe(200);
    await t.db
      .update(workspaceMembers)
      .set({ role: 'read_only' })
      .where(eq(workspaceMembers.userId, editor.id));
    const write = await call('POST', path, { bearer: token }, { records: [{ fields: {} }] });
    expect(write.status).toBe(403);
    await t.db.delete(workspaceMembers).where(eq(workspaceMembers.userId, editor.id));
    expect((await call('GET', path, { bearer: token })).status).toBe(404);
    const ws = (await (await call('GET', '/api/workspaces', { bearer: token })).json()) as {
      workspaces: unknown[];
    };
    expect(ws.workspaces).toEqual([]);
  });

  it('never logs the token', async () => {
    const created = await create({
      name: 'logged?',
      scopes: ['schema.bases:read'],
      workspaceIds: [workspaceId],
    });
    await call('GET', '/api/workspaces', { bearer: created.token });
    await call('GET', '/api/workspaces', { bearer: `${created.token.slice(0, -1)}A` });
    await call('GET', '/api/me/tokens', { bearer: created.token });
    const secret = created.token.slice(created.prefix.length + 1);
    const logged = JSON.stringify(app.logs);
    expect(logged).toContain(created.id);
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain(created.prefix);
  });

  it('rate-limits failed bearer attempts per IP', async () => {
    const limited = testApp({ db: t.appDb });
    const { token } = await createToken(t.db, owner, { workspaceIds: [workspaceId] });
    const attempt = (bearer: string) =>
      limited.app.request('/api/workspaces', { headers: { authorization: `Bearer ${bearer}` } });
    expect((await attempt(token)).status).toBe(200);
    for (let i = 0; i < BEARER_FAILURE_LIMIT; i++) {
      expect((await attempt(`or_pat_bad${i}`)).status).toBe(401);
    }
    expect((await attempt('or_pat_bad')).status).toBe(429);
    // Past the limit even a valid token waits for the window.
    expect((await attempt(token)).status).toBe(429);
    // Sessions aren't affected.
    const viaCookie = await limited.app.request('/api/workspaces', {
      headers: { cookie: `${SESSION_COOKIE}=${ownerCookie}` },
    });
    expect(viaCookie.status).toBe(200);
  });
});
