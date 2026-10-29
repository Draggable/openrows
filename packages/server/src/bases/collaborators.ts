import {
  type BaseCollaborator,
  type BaseRole,
  MAX_BASE_COLLABORATORS,
  type UserRole,
} from '@openrows/shared';
import { and, eq, sql } from 'drizzle-orm';
import { higherRole } from '../authz/policy.js';
import { baseMembers, type Transaction, users, workspaceMembers } from '../db/index.js';
import { AppError } from '../lib/errors.js';

/**
 * Base collaborators: everyone with access to a base, and the base roles
 * (`base_members`) that raise a workspace member's access there or give someone the base alone
 * (a base-only collaborator). The effective role is the higher of the two (`effectiveRole`).
 * Adding someone new goes through a base invitation (`createInvitation` with a `baseId`); these
 * functions only change the roles of people who already have access.
 */

export interface BaseScope {
  tx: Transaction;
  workspaceId: string;
  baseId: string;
}

interface Row {
  userId: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  workspaceRole: UserRole | null;
  baseRole: BaseRole | null;
}

function toCollaborator(r: Row): BaseCollaborator {
  const role = higherRole(r.workspaceRole, r.baseRole);
  if (!role) throw new Error('base collaborator without a role');
  return { ...r, role };
}

/** Workspace members and the base's collaborators, by user, ordered by name then email. */
async function collaboratorRows(scope: BaseScope, userId?: string): Promise<Row[]> {
  const { rows } = await scope.tx.execute<{
    user_id: string;
    email: string | null;
    name: string | null;
    avatar_url: string | null;
    workspace_role: UserRole | null;
    base_role: BaseRole | null;
  }>(sql`
    SELECT u.id AS user_id, u.email, u.name, u.avatar_url,
           wm.role AS workspace_role, bm.role AS base_role
      FROM ${users} u
      LEFT JOIN ${workspaceMembers} wm
        ON wm.user_id = u.id AND wm.workspace_id = ${scope.workspaceId}
      LEFT JOIN ${baseMembers} bm ON bm.user_id = u.id AND bm.base_id = ${scope.baseId}
     WHERE (wm.user_id IS NOT NULL OR bm.user_id IS NOT NULL)
       ${userId ? sql`AND u.id = ${userId}` : sql``}
     ORDER BY lower(coalesce(u.name, u.email, '')), u.email, u.id`);
  return rows.map((r) => ({
    userId: r.user_id,
    email: r.email,
    name: r.name,
    avatarUrl: r.avatar_url,
    workspaceRole: r.workspace_role,
    baseRole: r.base_role,
  }));
}

export async function listBaseCollaborators(scope: BaseScope): Promise<BaseCollaborator[]> {
  return (await collaboratorRows(scope)).map(toCollaborator);
}

/** 404 when the user has no access to the base at all (new people are invited instead). */
async function collaborator(scope: BaseScope, userId: string): Promise<Row> {
  const [row] = await collaboratorRows(scope, userId);
  if (!row) throw new AppError('NOT_FOUND', { detail: 'No such collaborator on this base.' });
  return row;
}

/**
 * Sets `userId`'s base role. They must already have access (a workspace member or a base
 * collaborator). Workspace owners are owners of every base, so they get no base role (409).
 * Only creators and up get here (`base:manage_members`), and a base role is at most creator.
 */
export async function setBaseRole(
  scope: BaseScope,
  userId: string,
  role: BaseRole
): Promise<BaseCollaborator> {
  const { tx, workspaceId, baseId } = scope;
  const current = await collaborator(scope, userId);
  if (current.workspaceRole === 'owner') {
    throw new AppError('CONFLICT', {
      detail: 'Workspace owners are owners of every base; change their workspace role instead.',
    });
  }
  if (current.baseRole === null) {
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(baseMembers)
      .where(eq(baseMembers.baseId, baseId));
    if ((count?.n ?? 0) >= MAX_BASE_COLLABORATORS) {
      throw new AppError('CONFLICT', {
        detail: `A base can have at most ${MAX_BASE_COLLABORATORS} base collaborators.`,
      });
    }
  }
  await tx
    .insert(baseMembers)
    .values({ workspaceId, baseId, userId, role })
    .onConflictDoUpdate({
      target: [baseMembers.baseId, baseMembers.userId],
      set: { role, updatedAt: new Date() },
    });
  return toCollaborator({ ...current, baseRole: role });
}

/**
 * Removes `userId`'s base role: a base-only collaborator loses the base on their next request
 * (every request resolves roles afresh), a workspace member falls back to their workspace role.
 * 404 when they have no base role.
 */
export async function removeBaseRole(scope: BaseScope, userId: string): Promise<void> {
  const deleted = await scope.tx
    .delete(baseMembers)
    .where(and(eq(baseMembers.baseId, scope.baseId), eq(baseMembers.userId, userId)))
    .returning({ userId: baseMembers.userId });
  if (deleted.length === 0) {
    throw new AppError('NOT_FOUND', { detail: 'That person has no role on this base.' });
  }
}
