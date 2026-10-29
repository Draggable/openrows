import type { MeResponse } from '@openrows/shared';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { beforeAll, describe, expect, it } from 'vitest';
import { hashSessionToken, SESSION_COOKIE } from '../../src/auth/session-token.js';
import { inScope } from '../../src/authz/scope.js';
import { adminAuditLog, sessions, shares, users, workspaces } from '../../src/db/schema.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import {
  addMember,
  createBase,
  createSession,
  createToken,
  createUser,
  createWorkspace,
} from '../helpers/factories.js';

// What the core enforces for the hosted ops console (whose routes are in the hosted edition):
// workspace and user suspensions, read-only impersonation and the append-only audit log.
describe('ops console enforcement', () => {
  const t = useTestDb();
  let app: ReturnType<typeof testApp>['app'];

  beforeAll(() => {
    app = testApp({ db: t.appDb }).app;
  });

  const as = (token: string, path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', `${SESSION_COOKIE}=${token}`);
    if (init.method && init.method !== 'GET') headers.set('origin', 'http://localhost:5173');
    return app.request(path, { ...init, headers });
  };
  const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  describe('a suspended workspace', () => {
    it('stays readable, refuses changes with 403 WORKSPACE_SUSPENDED and stops share links', async () => {
      const { workspace, owner } = await createWorkspace(t.db, { name: 'Before' });
      const base = await createBase(t.db, workspace.id);
      const reader = await addMember(t.db, workspace.id, 'read_only');
      const ownerSession = await createSession(t.db, owner);
      const readerSession = await createSession(t.db, reader);
      const tokenHash = 'a'.repeat(64);
      await t.db.insert(shares).values({
        id: uuidv7(),
        workspaceId: workspace.id,
        baseId: base.id,
        kind: 'base',
        tokenHash,
        createdBy: owner.id,
      });
      const resolves = async () =>
        (await t.appDb.execute(sql`SELECT * FROM share_resolve(${tokenHash})`)).rows.length;
      expect(await resolves()).toBe(1);

      await t.db
        .update(workspaces)
        .set({ suspendedAt: new Date(), suspendedReason: 'abuse' })
        .where(eq(workspaces.id, workspace.id));

      expect((await as(ownerSession, `/api/workspaces/${workspace.id}`)).status).toBe(200);
      expect((await as(readerSession, `/api/bases/${base.id}`)).status).toBe(200);
      const rename = await as(
        ownerSession,
        `/api/workspaces/${workspace.id}`,
        json('PATCH', { name: 'After' })
      );
      expect(rename.status).toBe(403);
      expect(await rename.json()).toMatchObject({ code: 'WORKSPACE_SUSPENDED' });
      const table = await as(
        ownerSession,
        `/api/bases/${base.id}/tables`,
        json('POST', { name: 'T' })
      );
      expect(table.status).toBe(403);
      expect(await resolves()).toBe(0);

      // Lifted: changes work again.
      await t.db
        .update(workspaces)
        .set({ suspendedAt: null })
        .where(eq(workspaces.id, workspace.id));
      expect(await resolves()).toBe(1);
      const again = await as(
        ownerSession,
        `/api/workspaces/${workspace.id}`,
        json('PATCH', { name: 'After' })
      );
      expect(again.status).toBe(200);
    });

    it("the app role can't set the suspension columns itself", async () => {
      const { workspace, owner } = await createWorkspace(t.db);
      await expect(
        inScope(t.appDb, { userId: owner.id, workspaceId: workspace.id }, (tx) =>
          tx.update(workspaces).set({ suspendedAt: null }).where(eq(workspaces.id, workspace.id))
        )
      ).rejects.toThrow();
      // Nor through the function without being a system admin.
      const err = await inScope(t.appDb, { userId: owner.id }, (tx) =>
        tx.execute(sql`SELECT workspace_suspend_set(${workspace.id}::uuid, true, 'x')`)
      ).catch((e: Error) => e);
      expect(String((err as Error & { cause?: Error }).cause?.message)).toMatch(
        /not a system admin/
      );
    });
  });

  describe('a suspended user', () => {
    it('loses their sessions and tokens', async () => {
      const { workspace, owner } = await createWorkspace(t.db);
      const session = await createSession(t.db, owner);
      const { token } = await createToken(t.db, owner, { workspaceIds: [workspace.id] });
      expect((await as(session, '/api/me')).status).toBe(200);
      await t.db.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, owner.id));
      expect((await as(session, '/api/me')).status).toBe(401);
      const bearer = await app.request('/api/me', {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(bearer.status).toBe(401);
      const left = await t.db.select().from(sessions).where(eq(sessions.userId, owner.id));
      expect(left).toHaveLength(0);
    });
  });

  describe('impersonation', () => {
    async function impersonating(minutes = 15) {
      const admin = await createUser(t.db, { isSystemAdmin: true });
      const { workspace, owner: target } = await createWorkspace(t.db);
      const token = await createSession(t.db, admin);
      await t.db
        .update(sessions)
        .set({
          impersonatedUserId: target.id,
          impersonationExpiresAt: new Date(Date.now() + minutes * 60_000),
        })
        .where(eq(sessions.idHash, hashSessionToken(token)));
      return { admin, target, workspace, token };
    }

    it('is the target user, read-only, until it ends', async () => {
      const { admin, target, workspace, token } = await impersonating();
      const me = (await (await as(token, '/api/me')).json()) as MeResponse;
      expect(me.user.id).toBe(target.id);
      expect(me.impersonation).toMatchObject({ adminEmail: admin.email });
      expect((await as(token, `/api/workspaces/${workspace.id}`)).status).toBe(200);
      const change = await as(
        token,
        `/api/workspaces/${workspace.id}`,
        json('PATCH', { name: 'X' })
      );
      expect(change.status).toBe(403);
      expect(await change.json()).toMatchObject({ code: 'IMPERSONATION_READ_ONLY' });

      const end = await as(token, '/api/me/impersonation', { method: 'DELETE' });
      expect(end.status).toBe(204);
      const after = (await (await as(token, '/api/me')).json()) as MeResponse;
      expect(after.user.id).toBe(admin.id);
      expect(after.impersonation).toBeNull();
      const [entry] = await t.db
        .select()
        .from(adminAuditLog)
        .where(eq(adminAuditLog.targetUserId, target.id));
      expect(entry).toMatchObject({ adminId: admin.id, action: 'impersonation.end' });
    });

    it('ends by itself when it expires or the admin is no admin any more', async () => {
      const expired = await impersonating(-1);
      expect(((await (await as(expired.token, '/api/me')).json()) as MeResponse).user.id).toBe(
        expired.admin.id
      );

      const demoted = await impersonating();
      await t.db.update(users).set({ isSystemAdmin: false }).where(eq(users.id, demoted.admin.id));
      expect(((await (await as(demoted.token, '/api/me')).json()) as MeResponse).user.id).toBe(
        demoted.admin.id
      );
    });

    it("lists in the user's support access", async () => {
      const admin = await createUser(t.db, { isSystemAdmin: true });
      const target = await createUser(t.db);
      const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      await inScope(t.appDb, { userId: admin.id }, (tx) =>
        tx.insert(adminAuditLog).values({
          id: uuidv7(),
          adminId: admin.id,
          action: 'impersonation.start',
          targetUserId: target.id,
          detail: { reason: 'Ticket 42', expiresAt },
        })
      );
      const session = await createSession(t.db, target);
      const res = await as(session, '/api/me/support-access');
      expect(await res.json()).toEqual({
        entries: [{ startedAt: expect.any(String), expiresAt, reason: 'Ticket 42' }],
      });
      // Someone else sees nothing of it.
      const other = await createSession(t.db, await createUser(t.db));
      expect(await (await as(other, '/api/me/support-access')).json()).toEqual({ entries: [] });
    });
  });

  describe('admin_audit_log', () => {
    it('only system admins write it, under their own id', async () => {
      const admin = await createUser(t.db, { isSystemAdmin: true });
      const user = await createUser(t.db);
      const insert = (as: string, adminId: string) =>
        inScope(t.appDb, { userId: as }, (tx) =>
          tx.insert(adminAuditLog).values({ id: uuidv7(), adminId, action: 'users.list' })
        );
      await expect(insert(user.id, user.id)).rejects.toThrow();
      await expect(insert(admin.id, user.id)).rejects.toThrow();
      await insert(admin.id, admin.id);
      // Non-admins read nothing that doesn't name them.
      const seen = await inScope(t.appDb, { userId: user.id }, (tx) =>
        tx.select().from(adminAuditLog)
      );
      expect(seen).toHaveLength(0);
    });

    it('is append-only, for the app role and the owner alike', async () => {
      const admin = await createUser(t.db, { isSystemAdmin: true });
      const id = uuidv7();
      await inScope(t.appDb, { userId: admin.id }, (tx) =>
        tx.insert(adminAuditLog).values({ id, adminId: admin.id, action: 'users.list' })
      );
      for (const db of [t.appDb, t.db]) {
        await expect(
          inScope(db, { userId: admin.id }, (tx) =>
            tx.update(adminAuditLog).set({ action: 'x' }).where(eq(adminAuditLog.id, id))
          )
        ).rejects.toThrow();
        await expect(
          inScope(db, { userId: admin.id }, (tx) =>
            tx.delete(adminAuditLog).where(eq(adminAuditLog.id, id))
          )
        ).rejects.toThrow();
      }
      await expect(t.db.execute(sql`TRUNCATE admin_audit_log`)).rejects.toThrow();
    });
  });
});
