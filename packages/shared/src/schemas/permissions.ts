import { z } from 'zod';
import { USER_ROLES, type UserRole } from '../constants/index.js';

/**
 * Edit permissions (Airtable Business): who may add, delete and edit the records of a
 * table, and who may edit one field's cells. They narrow the base role (`record:*` needs an
 * editor first) and restrict **editing** only; everyone who can read the table still reads
 * every field. The server enforces them in the RecordService; the client only disables and
 * locks what it can't do.
 */

/** Most users one `specific` permission lists. */
export const MAX_PERMISSION_USERS = 100;

/** The roles a `specific` permission may list: those that can edit at all. */
export const PERMISSION_ROLES = ['owner', 'creator', 'editor'] as const;

export const editPermissionSchema = z.discriminatedUnion('level', [
  /** The default: everyone whose role can edit records (editor and up). */
  z.object({ level: z.literal('editors') }).strict(),
  z.object({ level: z.literal('creators') }).strict(),
  /** Only the listed users and the listed roles (both may be empty: then nobody). */
  z
    .object({
      level: z.literal('specific'),
      userIds: z.array(z.uuid()).max(MAX_PERMISSION_USERS).default([]),
      roles: z.array(z.enum(PERMISSION_ROLES)).max(PERMISSION_ROLES.length).default([]),
    })
    .strict(),
  z.object({ level: z.literal('nobody') }).strict(),
]);

export type EditPermission = z.infer<typeof editPermissionSchema>;
export type EditPermissionLevel = EditPermission['level'];

const editors: EditPermission = { level: 'editors' };

/** A table's record permissions; a missing entry is `editors`. */
export const tablePermissionsSchema = z
  .object({
    addRecords: editPermissionSchema.default(editors),
    deleteRecords: editPermissionSchema.default(editors),
    editRecords: editPermissionSchema.default(editors),
  })
  .strict();

/**
 * A field's permission: who may edit its cells (`nobody`: a read-only field). `allowForms`
 * (Airtable's "allow editing via forms") lets public forms fill the field in although
 * `edit` keeps editors from it; it changes nothing for people.
 */
export const fieldPermissionsSchema = z
  .object({
    edit: editPermissionSchema.default(editors),
    allowForms: z.boolean().optional(),
  })
  .strict();

export type TablePermissions = z.infer<typeof tablePermissionsSchema>;
export type FieldPermissions = z.infer<typeof fieldPermissionsSchema>;

/** The permissions of a stored value (`{}` and anything unreadable are the defaults). */
export function tablePermissionsOf(stored: unknown): TablePermissions {
  const parsed = tablePermissionsSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : tablePermissionsSchema.parse({});
}

export function fieldPermissionsOf(stored: unknown): FieldPermissions {
  const parsed = fieldPermissionsSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : fieldPermissionsSchema.parse({});
}

/** Who is writing: their role on the table and their id. */
export interface PermissionSubject {
  role: UserRole;
  userId: string;
}

/**
 * Whom the edit permissions see when a public form writes: an editor who is no particular
 * user. A table or field that only creators or named people may edit can't be filled in by a
 * form, unless the field allows forms (`allowForms`).
 */
export const FORM_SUBJECT: PermissionSubject = {
  role: 'editor',
  userId: '00000000-0000-0000-0000-000000000000',
};

const rank = (role: UserRole) => USER_ROLES.indexOf(role);

/**
 * Whether `who` passes `permission`. Every level needs a role that can edit records (editor and
 * up): a commenter or read-only user named in a `specific` list still can't edit. As in
 * Airtable, owners and creators are bound too (they can change the permission instead).
 */
export function permissionAllows(permission: EditPermission, who: PermissionSubject): boolean {
  if (rank(who.role) > rank('editor')) return false;
  switch (permission.level) {
    case 'editors':
      return true;
    case 'creators':
      return rank(who.role) <= rank('creator');
    case 'specific':
      return (
        permission.userIds.includes(who.userId) ||
        (permission.roles as readonly UserRole[]).includes(who.role)
      );
    case 'nobody':
      return false;
  }
}

/** Whether `who` may edit the cells of a field: the table's `editRecords` and the field's own. */
export function canEditField(
  table: TablePermissions,
  field: FieldPermissions,
  who: PermissionSubject
): boolean {
  return permissionAllows(table.editRecords, who) && permissionAllows(field.edit, who);
}

/** Whether a public form may fill in a field's cells: editors may, or the field allows forms. */
export function formsMayFill(field: FieldPermissions): boolean {
  return permissionAllows(field.edit, FORM_SUBJECT) || field.allowForms === true;
}

/** Whether a permission differs from the default (the client's lock icon). */
export function isRestricted(permission: EditPermission): boolean {
  return permission.level !== 'editors';
}

/** A permission in words, for messages ("Only creators and up can edit "Budget"."). */
export function describePermission(permission: EditPermission): string {
  switch (permission.level) {
    case 'editors':
      return 'Editors and up';
    case 'creators':
      return 'Creators and up';
    case 'specific':
      return 'Specific people';
    case 'nobody':
      return 'Nobody';
  }
}
