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

  it("opens a two-way source's own records: its written-back fields, and deleting them", () => {
    const key = '0190a000-0000-7000-8000-00000000000a';
    const ownerField = '0190a000-0000-7000-8000-00000000000b';
    const points = '0190a000-0000-7000-8000-00000000000c';
    const source = (id: string, over: { twoWay: boolean; ownsUnattributed?: boolean }) => ({
      id,
      sourceFieldId: key,
      ownerFieldId: ownerField,
      ownsUnattributed: over.ownsUnattributed ?? false,
      twoWay: over.twoWay,
      writeBackFieldIds: over.twoWay ? [points] : [],
    });
    const sources = [
      source('s1', { twoWay: false, ownsUnattributed: true }),
      source('s2', { twoWay: true }),
    ];
    const table = { synced: true as const };
    const rights = editRights(table, 'editor', me, sources);
    const field = { id: points, synced: true as const };
    const mine = { fields: { [key]: 'k1', [ownerField]: 's2' } };
    const oneWay = { fields: { [key]: 'k2', [ownerField]: 's1' } };
    const first = { fields: { [key]: 'k3', [ownerField]: null } };
    const unowned = { fields: { [key]: 'k4', [ownerField]: 'gone' } };
    expect(rights.canEditCell(field, mine)).toBe(true);
    expect(rights.canEditCell({ ...field, id: key }, mine)).toBe(false);
    for (const record of [oneWay, first, unowned]) {
      expect(rights.canEditCell(field, record)).toBe(false);
      expect(rights.canDeleteRecord(record)).toBe(false);
    }
    expect(rights.canDeleteRecord(mine)).toBe(true);
    expect(rights).toMatchObject({ canAdd: false, canDelete: true });
    // Column-level: synced fields stay read-only; one-way tables are as before.
    expect(rights.canEditField(field)).toBe(false);
    const plain = editRights(table, 'editor', me, [sources[0] as (typeof sources)[number]]);
    expect(plain.canEditCell(field, oneWay)).toBe(false);
    expect(plain).toMatchObject({ canAdd: false, canDelete: false });
    // Readers can't, whatever the source.
    expect(editRights(table, 'read_only', me, sources).canDeleteRecord(mine)).toBe(false);
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
