import {
  type Collaborator,
  MAX_COLLABORATORS,
  type UserRole,
  userColor,
  userInitials,
} from '@openrows/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Principal } from '../auth/sessions.js';
import { assertAllowed, authorize } from '../authz/policy.js';
import { resolveResource } from '../authz/resolve.js';
import { setScope } from '../authz/scope.js';
import {
  baseMembers,
  bases,
  type Database,
  interfaceMembers,
  interfaces,
  type Transaction,
  users,
  workspaceMembers,
} from '../db/index.js';
import { AppError } from '../lib/errors.js';

/**
 * The collaborator directory: who a user cell (createdBy, lastModifiedBy, later the
 * collaborator field) can name, as the caller may see them. Workspace members see every member
 * and the base-only collaborators of every base, with emails (as on the members page);
 * a base-only collaborator sees the members and the collaborators of their own bases, without
 * emails. Nobody else is ever listed.
 */

/** What the caller may see of a workspace's people. */
export interface DirectoryAccess {
  workspaceId: string;
  /** Bases whose base-only collaborators are listed; `all` for workspace members. */
  bases: 'all' | string[];
  /** Workspace members see emails, as on the members page. */
  emails: boolean;
  /** The caller's workspace role (null for a base-only collaborator), when resolved here. */
  workspaceRole?: UserRole | null;
}

type UserRow = Pick<typeof users.$inferSelect, 'id' | 'name' | 'email'>;

/** The name a user is shown by: their name, else (for callers who see emails) their email. */
export function displayName(u: Pick<UserRow, 'name' | 'email'>, emails: boolean): string {
  const name = u.name?.trim();
  if (name) return name;
  return (emails ? u.email : null) ?? 'Collaborator';
}

export function toCollaborator(u: UserRow, emails: boolean): Collaborator {
  const name = displayName(u, emails);
  return {
    id: u.id,
    name,
    ...(emails && u.email ? { email: u.email } : {}),
    initials: userInitials(name),
    color: userColor(u.id),
  };
}

/**
 * Resolves the caller's directory access to a workspace and narrows `tx` to it. A workspace
 * role goes through `authorize(principal, 'workspace:read', …)`; without one, the caller needs a
 * base membership (read under the user-only scope, where RLS shows only the caller's own
 * `base_members` rows) on a base that `authorize(principal, 'base:read', …)` allows. Otherwise
 * 404, as for any other tenant.
 */
export async function directoryAccess(
  db: Database,
  tx: Transaction,
  principal: Principal,
  workspaceId: string
): Promise<DirectoryAccess> {
  const userId = principal.user.id;
  const resource = await resolveResource(db, 'workspace', workspaceId, userId);
  const decision = authorize(principal, 'workspace:read', resource);
  if (decision.allowed && resource) {
    await setScope(tx, { userId, workspaceId: resource.workspaceId });
    return {
      workspaceId: resource.workspaceId,
      bases: 'all',
      emails: true,
      workspaceRole: resource.workspaceRole,
    };
  }
  if (!resource || decision.allowed || decision.reason !== 'not_found') {
    assertAllowed(decision);
    throw new AppError('NOT_FOUND');
  }
  await setScope(tx, { userId });
  // A personal access token granted only some bases of the workspace reaches those.
  const own = principal.token
    ? principal.token.baseIds.map((baseId) => ({ baseId }))
    : await tx
        .select({ baseId: baseMembers.baseId })
        .from(baseMembers)
        .where(
          and(eq(baseMembers.userId, userId), eq(baseMembers.workspaceId, resource.workspaceId))
        )
        .limit(1000);
  // Each base goes through authorize() too (a base in the trash resolves to nothing; a granted
  // base of another workspace isn't in this one).
  const live: string[] = [];
  for (const { baseId } of own) {
    const base = await resolveResource(db, 'base', baseId, userId);
    if (base?.workspaceId !== resource.workspaceId) continue;
    if (authorize(principal, 'base:read', base).allowed) live.push(baseId);
  }
  if (live.length === 0) throw new AppError('NOT_FOUND');
  await setScope(tx, { userId, workspaceId: resource.workspaceId });
  // A token's workspace role still counts in the bases it was granted.
  const workspaceRole = principal.token ? resource.workspaceRole : null;
  return { workspaceId: resource.workspaceId, bases: live, emails: false, workspaceRole };
}

/** The directory, sorted by display name (case-insensitive). `tx` is scoped to the workspace. */
export async function listCollaborators(
  tx: Transaction,
  access: DirectoryAccess
): Promise<Collaborator[]> {
  const pick = { id: users.id, name: users.name, email: users.email };
  const members = await tx
    .select(pick)
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, access.workspaceId))
    .limit(MAX_COLLABORATORS);
  const guests =
    access.bases !== 'all' && access.bases.length === 0
      ? []
      : await tx
          .selectDistinct(pick)
          .from(baseMembers)
          .innerJoin(users, eq(users.id, baseMembers.userId))
          .innerJoin(
            bases,
            and(eq(bases.workspaceId, baseMembers.workspaceId), eq(bases.id, baseMembers.baseId))
          )
          .where(
            and(
              eq(baseMembers.workspaceId, access.workspaceId),
              isNull(bases.deletedAt),
              access.bases === 'all' ? undefined : inArray(baseMembers.baseId, access.bases)
            )
          )
          .limit(MAX_COLLABORATORS);
  // Interface-only collaborators of the bases' interfaces: assignable in user fields, so
  // a page can filter by "assigned to me" for them too.
  const interfaceGuests =
    access.bases !== 'all' && access.bases.length === 0
      ? []
      : await tx
          .selectDistinct(pick)
          .from(interfaceMembers)
          .innerJoin(users, eq(users.id, interfaceMembers.userId))
          .innerJoin(
            interfaces,
            and(
              eq(interfaces.workspaceId, interfaceMembers.workspaceId),
              eq(interfaces.id, interfaceMembers.interfaceId)
            )
          )
          .innerJoin(
            bases,
            and(eq(bases.workspaceId, interfaces.workspaceId), eq(bases.id, interfaces.baseId))
          )
          .where(
            and(
              eq(interfaceMembers.workspaceId, access.workspaceId),
              isNull(bases.deletedAt),
              access.bases === 'all' ? undefined : inArray(interfaces.baseId, access.bases)
            )
          )
          .limit(MAX_COLLABORATORS);
  const byId = new Map<string, Collaborator>();
  for (const u of [...members, ...guests, ...interfaceGuests]) {
    if (byId.size >= MAX_COLLABORATORS) break;
    if (!byId.has(u.id)) byId.set(u.id, toCollaborator(u, access.emails));
  }
  return [...byId.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id)
  );
}

/** Display names of a directory by user id (the CSV export's user cells). */
export async function collaboratorNames(
  tx: Transaction,
  access: DirectoryAccess
): Promise<Map<string, string>> {
  const list = await listCollaborators(tx, access);
  return new Map(list.map((c) => [c.id, c.name]));
}
