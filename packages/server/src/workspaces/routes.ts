import { contracts } from '@openrows/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Context } from 'hono';
import { uuidv7 } from 'uuidv7';
import { audit } from '../audit/record.js';
import type { ResourceEnv } from '../authz/middleware.js';
import { authorize } from '../authz/policy.js';
import { resolveResource } from '../authz/resolve.js';
import type { RouteRegistry } from '../authz/routes.js';
import { inScope } from '../authz/scope.js';
import type { Config } from '../config.js';
import { emitAccessChange } from '../data/outbox.js';
import { baseMembers, type Database, users, workspaceMembers, workspaces } from '../db/index.js';
import type { EmailTransport } from '../email/transport.js';
import type { Jobs } from '../jobs/send.js';
import { AppError } from '../lib/errors.js';
import { assertEditorRoom } from '../usage/quota.js';
import { directoryAccess, listCollaborators } from './collaborators.js';
import {
  acceptInvitation,
  createInvitation,
  type InviteContext,
  listInvitations,
  listMembers,
  previewInvitation,
  removeMember,
  resendInvitation,
  revokeInvitation,
  toWorkspace,
  updateMemberRole,
} from './service.js';

/** How many of a user's base roles `GET /api/workspaces` looks at. */
const MAX_BASE_MEMBERSHIPS_LISTED = 1000;

export interface WorkspaceDeps {
  db: Database;
  config: Pick<Config, 'appUrl'>;
  email: EmailTransport;
  /** Sends the purge of a deleted workspace. */
  jobs: Jobs;
}

/**
 * Workspaces: list and create your own, read, rename and delete (owners) one you belong to;
 * members and invitations.
 */
export function workspaceRoutes(routes: RouteRegistry, { db, config, email, jobs }: WorkspaceDeps) {
  const w = contracts.workspaces;
  const m = contracts.members;
  const inv = contracts.invitations;

  // A personal access token lists the workspaces its grants reach: granted ones, and
  // those of granted bases the user can still read.
  routes.endpoint(
    w.list,
    'session',
    async (c) => {
      const { token } = c.var.principal;
      const userId = c.var.principal.user.id;
      // No workspace in scope: RLS shows only this user's memberships, base roles and their
      // workspaces (member_read, base_member_read).
      const { rows, guestOf, reached } = await inScope(db, { userId }, async (tx) => {
        const rows = await tx
          .select({ workspace: workspaces, role: workspaceMembers.role })
          .from(workspaces)
          .leftJoin(
            workspaceMembers,
            and(
              eq(workspaceMembers.workspaceId, workspaces.id),
              eq(workspaceMembers.userId, userId)
            )
          )
          .where(isNull(workspaces.deletedAt))
          .orderBy(asc(workspaces.createdAt));
        // A base-only collaborator sees a workspace while one of their bases is live.
        const own = await tx
          .select({ baseId: baseMembers.baseId, workspaceId: baseMembers.workspaceId })
          .from(baseMembers)
          .where(eq(baseMembers.userId, userId))
          .limit(MAX_BASE_MEMBERSHIPS_LISTED);
        const guestOf = new Set<string>();
        for (const { baseId, workspaceId } of own) {
          if (
            guestOf.has(workspaceId) ||
            rows.some((r) => r.role && r.workspace.id === workspaceId)
          )
            continue;
          if (await resolveResource(tx, 'base', baseId, userId)) guestOf.add(workspaceId);
        }
        // A token's workspaces, unless their policy turned tokens off.
        const reached = new Set<string>();
        for (const workspaceId of token?.workspaceIds ?? []) {
          const ws = await resolveResource(tx, 'workspace', workspaceId, userId);
          if (ws && authorize(c.var.principal, 'workspace:read', ws).allowed) {
            reached.add(workspaceId);
          }
        }
        for (const baseId of token?.baseIds ?? []) {
          const base = await resolveResource(tx, 'base', baseId, userId);
          if (base && authorize(c.var.principal, 'base:read', base).allowed) {
            reached.add(base.workspaceId);
          }
        }
        return { rows, guestOf, reached };
      });
      return {
        workspaces: rows
          .filter((r) => r.role !== null || guestOf.has(r.workspace.id))
          .filter((r) => !token || reached.has(r.workspace.id))
          .map((r) => toWorkspace(r.workspace, r.role)),
      };
    },
    { token: 'schema.bases:read' }
  );

  routes.endpoint(w.create, 'session', async (c, { body: input }) => {
    // A region provisioned from the home region: its workspaces are made there.
    if (!c.var.edition.residency.selfServe) {
      throw new AppError('WORKSPACE_CREATION_ELSEWHERE', {
        detail: "New workspaces in this region are created from the home region's app.",
      });
    }
    const userId = c.var.principal.user.id;
    const workspaceId = uuidv7();
    const workspace = await inScope(db, { userId, workspaceId }, async (tx) => {
      const [row] = await tx
        .insert(workspaces)
        .values({ id: workspaceId, name: input.name })
        .returning();
      await tx.insert(workspaceMembers).values({ workspaceId, userId, role: 'owner' });
      return row;
    });
    if (!workspace) throw new Error('create workspace: no row returned');
    return toWorkspace(workspace, 'owner');
  });

  routes.endpoint(w.get, { resource: 'workspace', action: 'workspace:read' }, async (c) => {
    const { tx, resource } = c.var;
    const [row] = await tx.select().from(workspaces).where(eq(workspaces.id, resource.id));
    if (!row) throw new Error('authorized workspace not visible under RLS');
    return toWorkspace(row, resource.role);
  });

  routes.endpoint(
    w.update,
    { resource: 'workspace', action: 'workspace:update' },
    async (c, { body: input }) => {
      const { tx, resource } = c.var;
      const [before] = await tx
        .select({ name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, resource.id));
      const [row] = await tx
        .update(workspaces)
        .set({ ...(input.name !== undefined ? { name: input.name } : {}), updatedAt: new Date() })
        .where(eq(workspaces.id, resource.id))
        .returning();
      if (!row) throw new Error('authorized workspace not visible under RLS');
      await emitAccessChange(tx, {
        workspaceId: resource.id,
        kind: 'workspace.updated',
        payload: { workspaceId: resource.id, name: row.name },
        actorId: c.var.principal.user.id,
      });
      await audit(c, tx, {
        workspaceId: resource.id,
        action: 'workspace.update',
        target: { type: 'workspace', id: resource.id, name: row.name },
        summary: { before: { name: before?.name ?? null }, after: { name: row.name } },
      });
      return toWorkspace(row, resource.role);
    }
  );

  routes.endpoint(w.delete, { resource: 'workspace', action: 'workspace:delete' }, async (c) => {
    const { tx, resource } = c.var;
    const [deleted] = await tx
      .update(workspaces)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(workspaces.id, resource.id))
      .returning({ name: workspaces.name });
    await audit(c, tx, {
      workspaceId: resource.id,
      action: 'workspace.delete',
      target: { type: 'workspace', id: resource.id, name: deleted?.name ?? null },
    });
    await emitAccessChange(tx, {
      workspaceId: resource.id,
      kind: 'workspace.deleted',
      payload: { workspaceId: resource.id },
      actorId: c.var.principal.user.id,
    });
    // Hard-deleted by the worker's purge within minutes: files, record schemas, rows.
    await jobs.send(tx, 'purge.deleted', null);
    c.var.logger.info({ workspaceId: resource.id }, 'workspace deleted');
    return null;
  });

  routes.endpoint(m.list, { resource: 'workspace', action: 'workspace:read' }, async (c) => ({
    members: await listMembers(c.var.tx, c.var.resource.id),
  }));

  // The collaborator directory. Base-only collaborators have no workspace role, so
  // `directoryAccess` runs authorize() itself: workspace:read, else base:read on their bases.
  routes.endpoint(contracts.collaborators.list, 'session', (c, { params }) =>
    db.transaction(async (tx) => {
      const access = await directoryAccess(db, tx, c.var.principal, params.workspaceId);
      return { collaborators: await listCollaborators(tx, access) };
    })
  );

  const manage = { resource: 'workspace', action: 'workspace:manage_members' } as const;

  // Membership changes notify the realtime gateway, which re-checks live subscriptions.
  routes.endpoint(m.update, manage, async (c, { params, body }) => {
    const { tx, resource, principal } = c.var;
    // A new editor seat needs room on the plan.
    const plan = await c.var.edition.entitlements.forWorkspace(resource.id, tx);
    await assertEditorRoom(tx, plan, resource.id, { userId: params.userId }, body.role);
    const [previous] = await tx
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, resource.id),
          eq(workspaceMembers.userId, params.userId)
        )
      );
    const member = await updateMemberRole(tx, resource.id, resource.role, params.userId, body.role);
    await audit(c, tx, {
      workspaceId: resource.id,
      action: 'member.role_change',
      target: { type: 'user', id: params.userId, name: member.email },
      summary: { before: { role: previous?.role ?? null }, after: { role: member.role } },
    });
    await emitAccessChange(tx, {
      workspaceId: resource.id,
      kind: 'member.updated',
      payload: { userId: params.userId, role: body.role },
      actorId: principal.user.id,
    });
    return member;
  });

  routes.endpoint(m.remove, manage, async (c, { params }) => {
    const [removed] = await c.var.tx
      .select({ role: workspaceMembers.role, email: users.email })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(
        and(
          eq(workspaceMembers.workspaceId, c.var.resource.id),
          eq(workspaceMembers.userId, params.userId)
        )
      );
    await removeMember(c.var.tx, c.var.resource.id, c.var.resource.role, params.userId);
    await audit(c, c.var.tx, {
      workspaceId: c.var.resource.id,
      action: 'member.remove',
      target: { type: 'user', id: params.userId, name: removed?.email ?? null },
      summary: { before: { role: removed?.role ?? null } },
    });
    await emitAccessChange(c.var.tx, {
      workspaceId: c.var.resource.id,
      kind: 'member.removed',
      payload: { userId: params.userId },
      actorId: c.var.principal.user.id,
    });
    c.var.logger.info({ workspaceId: c.var.resource.id, userId: params.userId }, 'member removed');
    return null;
  });

  const inviteContext = (c: Context<ResourceEnv<'workspace'>>): InviteContext => ({
    tx: c.var.tx,
    workspaceId: c.var.resource.id,
    baseId: null,
    actor: c.var.principal.user,
    actorRole: c.var.resource.role,
    appUrl: config.appUrl,
    email,
    logger: c.var.logger,
  });

  routes.endpoint(inv.list, manage, async (c) => ({
    invitations: await listInvitations(c.var.tx, c.var.resource.id),
  }));

  routes.endpoint(inv.create, manage, async (c, { body }) => {
    const { tx, resource } = c.var;
    const plan = await c.var.edition.entitlements.forWorkspace(resource.id, tx);
    await assertEditorRoom(tx, plan, resource.id, { email: body.email }, body.role);
    const invitation = await createInvitation(inviteContext(c), body);
    await audit(c, tx, {
      workspaceId: resource.id,
      action: 'invitation.create',
      target: { type: 'invitation', id: invitation.id, name: invitation.email },
      summary: { after: { role: invitation.role } },
    });
    return invitation;
  });

  routes.endpoint(inv.resend, manage, (c, { params }) =>
    resendInvitation(inviteContext(c), params.invitationId)
  );

  routes.endpoint(inv.revoke, manage, async (c, { params }) => {
    await revokeInvitation(c.var.tx, c.var.resource.id, c.var.resource.role, params.invitationId);
    await audit(c, c.var.tx, {
      workspaceId: c.var.resource.id,
      action: 'invitation.revoke',
      target: { type: 'invitation', id: params.invitationId },
    });
    return null;
  });

  // The token is the credential here; the invitee isn't a member until they accept.
  routes.endpoint(inv.preview, 'session', (c, { params }) =>
    previewInvitation(db, c.var.principal.user, params.token)
  );

  routes.endpoint(inv.accept, 'session', async (c, { params }) => {
    const user = c.var.principal.user;
    const workspace = await acceptInvitation(db, user, params.token, (tx, joined) =>
      audit(c, tx, {
        workspaceId: joined.workspaceId,
        action: joined.baseId || joined.interfaceId ? 'base_collaborator.add' : 'member.join',
        target: joined.interfaceId
          ? { type: 'interface', id: joined.interfaceId }
          : joined.baseId
            ? { type: 'base', id: joined.baseId }
            : { type: 'user', id: user.id, name: user.email },
        summary: { after: { role: joined.role, userId: user.id, via: 'invitation' } },
      })
    );
    c.var.logger.info({ workspaceId: workspace.id }, 'invitation accepted');
    return workspace;
  });
}
