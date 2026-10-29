import {
  canEditField,
  type EditPermission,
  type FieldMeta,
  fieldPermissionsOf,
  isRestricted,
  type PermissionSubject,
  permissionAllows,
  type TableMeta,
  tablePermissionsOf,
  type UserRole,
} from '@openrows/shared';
import { useDirectory } from '../collaborators/context';

/**
 * What the signed-in user may do to a table's records under its edit permissions. The
 * server enforces them; the client only disables editors, hides actions and shows locks.
 */
export interface EditRights {
  canAdd: boolean;
  canDelete: boolean;
  /** Whether the user may write the field's cells (the table's `editRecords` and its own). */
  canEditField: (field: Pick<FieldMeta, 'permissions' | 'synced'>) => boolean;
  /** Whether the user may fill the field in a new record (its own permission only). */
  canSetOnCreate: (field: Pick<FieldMeta, 'permissions' | 'synced'>) => boolean;
}

/**
 * `role` undefined (still loading): nothing is editable. Without the user's id (outside the
 * collaborator directory) only "specific people" lists can't match.
 */
export function editRights(
  table: Pick<TableMeta, 'permissions' | 'synced'> | undefined,
  role: UserRole | undefined,
  meId: string | undefined
): EditRights {
  const tablePerms = tablePermissionsOf(table?.permissions);
  if (!role) {
    return {
      canAdd: false,
      canDelete: false,
      canEditField: () => false,
      canSetOnCreate: () => false,
    };
  }
  const who: PermissionSubject = { role, userId: meId ?? '' };
  // A synced table's records and synced fields come from its source: only the sync writes.
  const synced = table?.synced === true;
  return {
    canAdd: !synced && permissionAllows(tablePerms.addRecords, who),
    canDelete: !synced && permissionAllows(tablePerms.deleteRecords, who),
    canEditField: (field) =>
      !field.synced && canEditField(tablePerms, fieldPermissionsOf(field.permissions), who),
    canSetOnCreate: (field) =>
      !field.synced && permissionAllows(fieldPermissionsOf(field.permissions).edit, who),
  };
}

export function useEditRights(
  table: Pick<TableMeta, 'permissions' | 'synced'> | undefined,
  role: UserRole | undefined
): EditRights {
  return editRights(table, role, useDirectory().meId);
}

/** Whether a field's header shows the lock: its own or the table's edit is restricted. */
export function isLockedField(
  table: Pick<TableMeta, 'permissions'>,
  field: Pick<FieldMeta, 'permissions'>
): boolean {
  return (
    isRestricted(fieldPermissionsOf(field.permissions).edit) ||
    isRestricted(tablePermissionsOf(table.permissions).editRecords)
  );
}

export const LEVEL_LABELS: Record<EditPermission['level'], string> = {
  editors: 'Editors and up',
  creators: 'Creators and up',
  specific: 'Specific people',
  nobody: 'Nobody (read-only)',
};

/** The permission for a picked level, keeping the lists when it stays `specific`. */
export function withLevel(current: EditPermission, level: EditPermission['level']): EditPermission {
  if (level !== 'specific') return { level };
  return current.level === 'specific' ? current : { level, userIds: [], roles: [] };
}

/** One line for a permission ("Creators and up", "2 people, Owners"). */
export function summary(permission: EditPermission): string {
  if (permission.level !== 'specific') return LEVEL_LABELS[permission.level];
  const parts = [
    ...(permission.userIds.length
      ? [`${permission.userIds.length} ${permission.userIds.length === 1 ? 'person' : 'people'}`]
      : []),
    ...permission.roles.map((r) => `${r[0]?.toUpperCase()}${r.slice(1)}s`),
  ];
  return parts.length ? parts.join(', ') : 'Nobody yet';
}
