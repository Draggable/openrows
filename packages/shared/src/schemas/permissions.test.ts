import { describe, expect, it } from 'vitest';
import { USER_ROLES, type UserRole } from '../constants/index.js';
import {
  canEditField,
  type EditPermission,
  editPermissionSchema,
  fieldPermissionsOf,
  formsMayFill,
  MAX_PERMISSION_USERS,
  permissionAllows,
  tablePermissionsOf,
} from './permissions.js';

const me = '0190a000-0000-7000-8000-000000000001';
const other = '0190a000-0000-7000-8000-000000000002';

describe('permissionAllows', () => {
  // Rows: owner, creator, editor, commenter, read_only.
  const cases: [EditPermission, boolean[]][] = [
    [{ level: 'editors' }, [true, true, true, false, false]],
    [{ level: 'creators' }, [true, true, false, false, false]],
    [{ level: 'specific', userIds: [me], roles: [] }, [true, true, true, false, false]],
    [{ level: 'specific', userIds: [other], roles: [] }, [false, false, false, false, false]],
    [{ level: 'specific', userIds: [], roles: ['editor'] }, [false, false, true, false, false]],
    [{ level: 'specific', userIds: [], roles: [] }, [false, false, false, false, false]],
    [{ level: 'nobody' }, [false, false, false, false, false]],
  ];
  it.each(cases)('%j', (permission, allowed) => {
    expect(USER_ROLES.map((role) => permissionAllows(permission, { role, userId: me }))).toEqual(
      allowed
    );
  });

  it('needs both the table and the field to allow a cell edit', () => {
    const who = { role: 'editor' as UserRole, userId: me };
    const table = tablePermissionsOf({});
    const field = fieldPermissionsOf({});
    expect(canEditField(table, field, who)).toBe(true);
    expect(canEditField(table, { edit: { level: 'creators' } }, who)).toBe(false);
    expect(canEditField({ ...table, editRecords: { level: 'nobody' } }, field, who)).toBe(false);
  });
});

describe('formsMayFill (#121)', () => {
  it('lets forms fill fields editors may edit, or that allow forms', () => {
    expect(formsMayFill(fieldPermissionsOf({}))).toBe(true);
    expect(formsMayFill(fieldPermissionsOf({ edit: { level: 'creators' } }))).toBe(false);
    expect(formsMayFill(fieldPermissionsOf({ edit: { level: 'nobody' }, allowForms: true }))).toBe(
      true
    );
    expect(
      formsMayFill(fieldPermissionsOf({ edit: { level: 'specific', roles: ['editor'] } }))
    ).toBe(true);
    // Only the form: people are still bound by `edit`.
    const field = fieldPermissionsOf({ edit: { level: 'creators' }, allowForms: true });
    expect(permissionAllows(field.edit, { role: 'editor', userId: me })).toBe(false);
  });
});

describe('permission schemas', () => {
  it('defaults missing and unreadable values to "editors and up"', () => {
    expect(tablePermissionsOf({})).toEqual({
      addRecords: { level: 'editors' },
      deleteRecords: { level: 'editors' },
      editRecords: { level: 'editors' },
    });
    expect(tablePermissionsOf({ addRecords: { level: 'creators' } }).addRecords).toEqual({
      level: 'creators',
    });
    expect(fieldPermissionsOf(null)).toEqual({ edit: { level: 'editors' } });
    expect(fieldPermissionsOf({ edit: { level: 'bogus' } })).toEqual({
      edit: { level: 'editors' },
    });
  });

  it('caps the people a permission lists and refuses unknown levels and roles', () => {
    const ids = (n: number) =>
      Array.from({ length: n }, (_, i) => `0190a000-0000-7000-8000-${String(i).padStart(12, '0')}`);
    expect(
      editPermissionSchema.safeParse({ level: 'specific', userIds: ids(MAX_PERMISSION_USERS) })
        .success
    ).toBe(true);
    for (const bad of [
      { level: 'specific', userIds: ids(MAX_PERMISSION_USERS + 1) },
      { level: 'specific', userIds: ['not-a-uuid'] },
      { level: 'specific', roles: ['commenter'] },
      { level: 'everyone' },
      { level: 'nobody', userIds: [] },
    ]) {
      expect(editPermissionSchema.safeParse(bad).success).toBe(false);
    }
    expect(editPermissionSchema.parse({ level: 'specific' })).toEqual({
      level: 'specific',
      userIds: [],
      roles: [],
    });
  });
});
