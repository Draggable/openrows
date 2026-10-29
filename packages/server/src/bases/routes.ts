import { contracts } from '@openrows/shared';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Context } from 'hono';
import { audit } from '../audit/record.js';
import type { ResourceEnv } from '../authz/middleware.js';
import { effectiveRole } from '../authz/policy.js';
import type { RouteRegistry } from '../authz/routes.js';
import type { Config } from '../config.js';
import { emit, emitAccessChange } from '../data/outbox.js';
import { baseMembers, bases, type Database } from '../db/index.js';
import type { EmailTransport } from '../email/transport.js';
import type { Jobs } from '../jobs/send.js';
import { loadOwnJob } from '../jobs/status.js';
import { assertEditorRoom } from '../usage/quota.js';
import { directoryAccess } from '../workspaces/collaborators.js';
import {
  createInvitation,
  type InviteContext,
  listInvitations,
  resendInvitation,
  revokeInvitation,
} from '../workspaces/service.js';
import { listBaseCollaborators, removeBaseRole, setBaseRole } from './collaborators.js';
import { startDuplicate, toDuplicateJob } from './duplicate.js';
import { createBase, deleteBase, toBase } from './service.js';

export interface BaseDeps {
  db: Database;
  config: Pick<Config, 'appUrl'>;
  email: EmailTransport;
  jobs: Jobs;
}

/**
 * Bases: list and create them in a workspace (with their `b_<hex>` record schema, ADR-001), read,
 * update and delete (to the trash) one; their collaborators and invitations.
 */
export function baseRoutes(routes: RouteRegistry, { db, config, email, jobs }: BaseDeps) {
  const b = contracts.bases;

  // Base-only collaborators have no workspace role, so `directoryAccess` runs authorize()
  // itself: workspace:read lists every base, else base:read on each of the caller's own bases.
  // A personal access token sees the bases its grants reach (directoryAccess).
  routes.endpoint(
    b.list,
    'session',
    (c, { params }) =>
      db.transaction(async (tx) => {
        const { principal } = c.var;
        const access = await directoryAccess(db, tx, principal, params.workspaceId);
        const rows = await tx
          .select({ base: bases, baseRole: baseMembers.role })
          .from(bases)
          .leftJoin(
            baseMembers,
            and(eq(baseMembers.baseId, bases.id), eq(baseMembers.userId, principal.user.id))
          )
          .where(
            and(
              eq(bases.workspaceId, access.workspaceId),
              isNull(bases.deletedAt),
              access.bases === 'all' ? undefined : inArray(bases.id, access.bases)
            )
          )
          .orderBy(asc(bases.createdAt));
        const list = rows.flatMap(({ base, baseRole }) => {
          const role = effectiveRole({
            kind: 'base',
            id: base.id,
            workspaceId: base.workspaceId,
            baseId: base.id,
            workspaceRole: access.workspaceRole ?? null,
            baseRole,
          });
          return role ? [toBase(base, role)] : [];
        });
        return { bases: list };
      }),
    { token: 'schema.bases:read' }
  );

  routes.endpoint(
    b.create,
    { resource: 'workspace', action: 'base:create' },
    async (c, { body: input }) => {
      const { tx, resource, principal } = c.var;
      return createBase(
        { tx, workspaceId: resource.workspaceId, userId: principal.user.id },
        input,
        resource.role
      );
    }
  );

  routes.endpoint(b.get, { resource: 'base', action: 'base:read' }, async (c) => {
    const { tx, resource } = c.var;
    const [row] = await tx.select().from(bases).where(eq(bases.id, resource.id));
    if (!row) throw new Error('authorized base not visible under RLS');
    return toBase(row, resource.role);
  });

  routes.endpoint(
    b.update,
    { resource: 'base', action: 'base:update' },
    async (c, { body: input }) => {
      const { tx, resource, principal } = c.var;
      const [row] = await tx
        .update(bases)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(bases.id, resource.id))
        .returning();
      if (!row) throw new Error('authorized base not visible under RLS');
      const base = toBase(row, resource.role);
      await emit(tx, {
        workspaceId: resource.workspaceId,
        baseId: row.id,
        kind: 'base.updated',
        payload: { base },
        actorId: principal.user.id,
      });
      return base;
    }
  );

  routes.endpoint(b.delete, { resource: 'base', action: 'base:delete' }, async (c) => {
    const { tx, resource, principal } = c.var;
    const [base] = await tx
      .select({ name: bases.name })
      .from(bases)
      .where(eq(bases.id, resource.id));
    await deleteBase(
      { tx, workspaceId: resource.workspaceId, userId: principal.user.id },
      resource.id
    );
    await audit(c, tx, {
      workspaceId: resource.workspaceId,
      action: 'base.delete',
      target: { type: 'base', id: resource.id, name: base?.name ?? null },
    });
    return null;
  });

  // Duplicate a base: creators of the base, and of the target workspace (checked in
  // startDuplicate); the copy runs in the worker and its starter polls it.
  routes.endpoint(
    b.duplicate,
    { resource: 'base', action: 'base:duplicate' },
    async (c, { body }) => {
      const { tx, resource, principal } = c.var;
      const [row] = await tx.select().from(bases).where(eq(bases.id, resource.id));
      if (!row) throw new Error('authorized base not visible under RLS');
      return startDuplicate(
        {
          db,
          jobs,
          entitlements: c.var.edition.entitlements,
          tx,
          principal,
          source: { id: row.id, workspaceId: row.workspaceId, name: row.name },
        },
        body
      );
    }
  );

  routes.endpoint(
    b.duplicateStatus,
    { resource: 'base', action: 'base:duplicate' },
    async (c, { params }) => {
      const { tx, resource, principal } = c.var;
      const job = await loadOwnJob(
        tx,
        {
          id: params.duplicateId,
          kind: 'duplicate',
          userId: principal.user.id,
          baseId: resource.id,
        },
        'No such duplicate.'
      );
      return toDuplicateJob(job);
    }
  );

  const bc = contracts.baseCollaborators;
  const bi = contracts.baseInvitations;
  const manage = { resource: 'base', action: 'base:manage_members' } as const;
  const scopeOf = (c: Context<ResourceEnv<'base'>>) => ({
    tx: c.var.tx,
    workspaceId: c.var.resource.workspaceId,
    baseId: c.var.resource.id,
  });

  routes.endpoint(bc.list, manage, async (c) => ({
    collaborators: await listBaseCollaborators(scopeOf(c)),
  }));

  // Base role changes notify the realtime gateway, which re-checks live subscriptions.
  routes.endpoint(bc.update, manage, async (c, { params, body }) => {
    const scope = scopeOf(c);
    // A new editor seat needs room on the plan.
    const plan = await c.var.edition.entitlements.forWorkspace(scope.workspaceId, scope.tx);
    await assertEditorRoom(scope.tx, plan, scope.workspaceId, { userId: params.userId }, body.role);
    const [previous] = await scope.tx
      .select({ role: baseMembers.role })
      .from(baseMembers)
      .where(and(eq(baseMembers.baseId, scope.baseId), eq(baseMembers.userId, params.userId)));
    const collaborator = await setBaseRole(scope, params.userId, body.role);
    await audit(c, scope.tx, {
      workspaceId: scope.workspaceId,
      action: previous ? 'base_collaborator.role_change' : 'base_collaborator.add',
      target: { type: 'base', id: scope.baseId },
      summary: {
        before: previous ? { role: previous.role } : undefined,
        after: { userId: params.userId, role: body.role },
      },
    });
    await emitAccessChange(scope.tx, {
      workspaceId: scope.workspaceId,
      kind: 'baseMember.updated',
      payload: { userId: params.userId, baseId: scope.baseId, role: body.role },
      actorId: c.var.principal.user.id,
    });
    return collaborator;
  });

  routes.endpoint(bc.remove, manage, async (c, { params }) => {
    const scope = scopeOf(c);
    await removeBaseRole(scope, params.userId);
    await audit(c, scope.tx, {
      workspaceId: scope.workspaceId,
      action: 'base_collaborator.remove',
      target: { type: 'base', id: scope.baseId },
      summary: { before: { userId: params.userId } },
    });
    await emitAccessChange(scope.tx, {
      workspaceId: scope.workspaceId,
      kind: 'baseMember.removed',
      payload: { userId: params.userId, baseId: scope.baseId },
      actorId: c.var.principal.user.id,
    });
    c.var.logger.info({ baseId: scope.baseId, userId: params.userId }, 'base collaborator removed');
    return null;
  });

  // Base invitations reuse the workspace invitation flow: hashed single-use tokens, 7 days.
  const inviteContext = (c: Context<ResourceEnv<'base'>>): InviteContext => ({
    tx: c.var.tx,
    workspaceId: c.var.resource.workspaceId,
    baseId: c.var.resource.id,
    actor: c.var.principal.user,
    actorRole: c.var.resource.role,
    appUrl: config.appUrl,
    email,
    logger: c.var.logger,
  });

  routes.endpoint(bi.list, manage, async (c) => ({
    invitations: await listInvitations(c.var.tx, c.var.resource.workspaceId, c.var.resource.id),
  }));

  routes.endpoint(bi.create, manage, async (c, { body }) => {
    const { tx, resource } = c.var;
    const plan = await c.var.edition.entitlements.forWorkspace(resource.workspaceId, tx);
    await assertEditorRoom(tx, plan, resource.workspaceId, { email: body.email }, body.role);
    const invitation = await createInvitation(inviteContext(c), body);
    await audit(c, tx, {
      workspaceId: resource.workspaceId,
      action: 'invitation.create',
      target: { type: 'invitation', id: invitation.id, name: invitation.email },
      summary: { after: { role: invitation.role, baseId: resource.id } },
    });
    return invitation;
  });

  routes.endpoint(bi.resend, manage, (c, { params }) =>
    resendInvitation(inviteContext(c), params.invitationId)
  );

  routes.endpoint(bi.revoke, manage, async (c, { params }) => {
    const { tx, resource } = c.var;
    await revokeInvitation(
      tx,
      resource.workspaceId,
      resource.role,
      params.invitationId,
      resource.id
    );
    await audit(c, tx, {
      workspaceId: resource.workspaceId,
      action: 'invitation.revoke',
      target: { type: 'invitation', id: params.invitationId },
      summary: { before: { baseId: resource.id } },
    });
    return null;
  });
}
