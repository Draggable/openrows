import { describe, expect, it } from 'vitest';
import { editRights, isLockedField, summary, withLevel } from './model';

const me = '0190a000-0000-7000-8000-000000000001';
const creatorsOnly = { permissions: { edit: { level: 'creators' as const } } };
const open = { permissions: { edit: { level: 'editors' as const } } };

describe('editRights', () => {
  it('follows the table and field permissions for the role', () => {
    const table = {
      permissions: {
        addRecords: { level: 'editors' as const },
        deleteRecords: { level: 'creators' as const },
        editRecords: { level: 'editors' as const },
      },
    };
    const editor = editRights(table, 'editor', me);
    expect(editor).toMatchObject({ canAdd: true, canDelete: false });
    expect(editor.canEditField(open)).toBe(true);
    expect(editor.canEditField(creatorsOnly)).toBe(false);
    expect(editRights(table, 'creator', me).canEditField(creatorsOnly)).toBe(true);
    expect(editRights(table, 'commenter', me).canEditField(open)).toBe(false);
  });

  it('applies the table edit permission to cells but not to new records', () => {
    const table = { permissions: { editRecords: { level: 'nobody' as const } } };
    const rights = editRights(table as Parameters<typeof editRights>[0], 'owner', me);
    expect(rights.canEditField(open)).toBe(false);
    expect(rights.canSetOnCreate(open)).toBe(true);
  });

  it('matches specific people by id, and nothing while the role is loading', () => {
    const listed = {
      permissions: { edit: { level: 'specific' as const, userIds: [me], roles: [] } },
    };
    expect(editRights(undefined, 'editor', me).canEditField(listed)).toBe(true);
    expect(editRights(undefined, 'editor', undefined).canEditField(listed)).toBe(false);
    expect(editRights(undefined, undefined, me).canEditField(open)).toBe(false);
  });
});

describe('locks and labels', () => {
  it('locks restricted fields and fields of a table with restricted editing', () => {
    expect(isLockedField({}, creatorsOnly)).toBe(true);
    expect(isLockedField({}, open)).toBe(false);
    expect(
      isLockedField(
        { permissions: { editRecords: { level: 'creators' } } } as Parameters<
          typeof isLockedField
        >[0],
        open
      )
    ).toBe(true);
  });

  it('keeps the lists while the level stays specific', () => {
    const specific = { level: 'specific' as const, userIds: [me], roles: ['owner' as const] };
    expect(withLevel(specific, 'specific')).toBe(specific);
    expect(withLevel(specific, 'nobody')).toEqual({ level: 'nobody' });
    expect(withLevel({ level: 'editors' }, 'specific')).toEqual({
      level: 'specific',
      userIds: [],
      roles: [],
    });
    expect(summary(specific)).toBe('1 person, Owners');
    expect(summary({ level: 'creators' })).toBe('Creators and up');
  });
});
