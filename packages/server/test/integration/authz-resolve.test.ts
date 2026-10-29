import { eq, sql } from 'drizzle-orm';
import { type ErrorHandler, type Handler, Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Principal } from '../../src/auth/sessions.js';
import { type ResourceEnv, withResource } from '../../src/authz/middleware.js';
import { resolveResource } from '../../src/authz/resolve.js';
import { bases, fields, workspaces } from '../../src/db/index.js';
import { onError } from '../../src/lib/errors.js';
import { createLogger } from '../../src/lib/logger.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, createTenant, createUser } from '../helpers/factories.js';

describe('resolveResource (authz_resolve, as openrows_app)', () => {
  const t = useTestDb();

  it('resolves every kind to its workspace, base and the user’s roles in one call', async () => {
    const a = await createTenant(t.db);
    const ids = {
      workspace: a.workspace.id,
      base: a.base.id,
      table: a.table.id,
      field: a.field.id,
      view: a.view.id,
    };
    for (const [kind, id] of Object.entries(ids) as [keyof typeof ids, string][]) {
      expect(await resolveResource(t.appDb, kind, id, a.owner.id), kind).toEqual({
        kind,
        id,
        workspaceId: a.workspace.id,
        baseId: kind === 'workspace' ? null : a.base.id,
        workspaceRole: 'owner',
        baseRole: null,
        suspended: false,
        // The workspace's token policy and the owner's last activity (createTenant's).
        tokensAllowed: true,
        lastActiveAt: expect.any(Date),
      });
    }
    // A workspace that turned tokens off; someone never active there.
    await t.db.execute(
      sql`UPDATE workspace_policies SET personal_access_tokens = false
           WHERE workspace_id = ${a.workspace.id}::uuid`
    );
    expect(await resolveResource(t.appDb, 'base', a.base.id, a.collaborator.id)).toMatchObject({
      tokensAllowed: false,
      lastActiveAt: null,
    });
  });

  it('returns base overrides inside the base only', async () => {
    const a = await createTenant(t.db);
    for (const [kind, id] of [
      ['base', a.base.id],
      ['table', a.table.id],
      ['field', a.field.id],
      ['view', a.view.id],
    ] as const) {
      expect(await resolveResource(t.appDb, kind, id, a.collaborator.id)).toMatchObject({
        workspaceRole: null,
        baseRole: 'editor',
      });
    }
    expect(
      await resolveResource(t.appDb, 'workspace', a.workspace.id, a.collaborator.id)
    ).toMatchObject({
      workspaceRole: null,
      baseRole: null,
    });
  });

  it('gives no role in another tenant (the resource exists, the user has nothing there)', async () => {
    const a = await createTenant(t.db);
    const b = await createTenant(t.db);
    expect(await resolveResource(t.appDb, 'table', b.table.id, a.owner.id)).toMatchObject({
      workspaceId: b.workspace.id,
      workspaceRole: null,
      baseRole: null,
    });
  });

  it('finds nothing for unknown ids, non-UUIDs, the wrong kind and trashed resources', async () => {
    const a = await createTenant(t.db);
    const user = a.owner.id;
    expect(await resolveResource(t.appDb, 'base', crypto.randomUUID(), user)).toBeNull();
    expect(await resolveResource(t.appDb, 'base', 'not-a-uuid', user)).toBeNull();
    expect(await resolveResource(t.appDb, 'base', undefined, user)).toBeNull();
    expect(await resolveResource(t.appDb, 'table', a.base.id, user)).toBeNull();

    await t.db.update(fields).set({ deletedAt: new Date() }).where(eq(fields.id, a.field.id));
    expect(await resolveResource(t.appDb, 'field', a.field.id, user)).toBeNull();

    await t.db.update(bases).set({ deletedAt: new Date() }).where(eq(bases.id, a.base.id));
    for (const [kind, id] of [
      ['base', a.base.id],
      ['table', a.table.id],
      ['view', a.view.id],
    ] as const) {
      expect(await resolveResource(t.appDb, kind, id, user), kind).toBeNull();
    }

    await t.db
      .update(workspaces)
      .set({ deletedAt: new Date() })
      .where(eq(workspaces.id, a.workspace.id));
    expect(await resolveResource(t.appDb, 'workspace', a.workspace.id, user)).toBeNull();
  });
});

describe('withResource', () => {
  const t = useTestDb();

  function appFor(principal: Principal, handler: Handler<ResourceEnv<'workspace'>>) {
    const app = new Hono<ResourceEnv<'workspace'>>();
    app.use('*', async (c, next) => {
      c.set('logger', createLogger({ level: 'silent' }));
      c.set('principal', principal);
      await next();
    });
    app.patch('/w/:workspaceId', withResource(t.appDb, 'workspace', 'workspace:update'), handler);
    // onError only reads AppEnv's variables, which ResourceEnv extends.
    app.onError(onError as unknown as ErrorHandler<ResourceEnv<'workspace'>>);
    return app;
  }

  it('rolls the request transaction back when the handler throws', async () => {
    const a = await createTenant(t.db);
    const app = appFor({ user: a.owner } as Principal, async (c) => {
      const { tx, resource } = (
        c as never as { var: { tx: typeof t.appDb; resource: { id: string } } }
      ).var;
      await tx.update(workspaces).set({ name: 'half-done' }).where(eq(workspaces.id, resource.id));
      throw new Error('boom');
    });
    const res = await app.request(`/w/${a.workspace.id}`, { method: 'PATCH' });
    expect(res.status).toBe(500);
    const [row] = await t.db.select().from(workspaces).where(eq(workspaces.id, a.workspace.id));
    expect(row?.name).toBe(a.workspace.name);
  });

  it('commits and scopes the transaction to the resource’s workspace', async () => {
    const a = await createTenant(t.db);
    await createTenant(t.db);
    const coOwner = await addMember(t.db, a.workspace.id, 'owner', await createUser(t.db));
    const app = appFor({ user: coOwner } as Principal, async (c) => {
      const { tx } = c.var;
      // No WHERE: RLS alone keeps the other tenant out.
      const all = await tx.update(workspaces).set({ name: 'renamed' }).returning();
      return c.json({ updated: all.map((w) => w.id) });
    });
    const res = await app.request(`/w/${a.workspace.id}`, { method: 'PATCH' });
    expect(await res.json()).toEqual({ updated: [a.workspace.id] });
  });
});
