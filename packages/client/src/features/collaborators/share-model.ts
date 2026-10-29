import { BASE_ROLES, type BaseCollaborator, type BaseRole, USER_ROLES } from '@openrows/shared';
import { ROLE_LABELS } from '../../app/names';

/**
 * The Share dialog's rules. The effective role on a base is the higher of the workspace
 * role and the base role, so a base role can only raise a workspace member's access.
 */

const rank = (role: string) => USER_ROLES.indexOf(role as (typeof USER_ROLES)[number]);

/**
 * The base roles a collaborator can be given that mean something: all of them for a base-only
 * collaborator, the workspace role and higher for a member, none for a workspace owner.
 */
export function baseRoleChoices(c: Pick<BaseCollaborator, 'workspaceRole'>): BaseRole[] {
  if (c.workspaceRole === 'owner') return [];
  const floor = c.workspaceRole;
  return BASE_ROLES.filter((r) => floor === null || rank(r) <= rank(floor));
}

/** Where someone's access comes from, under their name. */
export function accessSource(c: Pick<BaseCollaborator, 'workspaceRole' | 'baseRole'>): string {
  if (c.workspaceRole === null) return 'Base only';
  const ws = `Workspace ${ROLE_LABELS[c.workspaceRole].toLowerCase()}`;
  if (c.baseRole === null || rank(c.baseRole) >= rank(c.workspaceRole)) return ws;
  return `${ws}, raised on this base`;
}

/** What removing the base role does: drops the base, or falls back to the workspace role. */
export function removeLabel(c: Pick<BaseCollaborator, 'workspaceRole'>): string {
  return c.workspaceRole === null ? 'Remove from base' : 'Reset to workspace role';
}
