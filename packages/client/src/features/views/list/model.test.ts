import type { FieldMeta, RecordData } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import { listRows, rowFieldsOf, treeKey } from './model';

const field = (id: string, type: string, extra: Partial<FieldMeta> = {}): FieldMeta =>
  ({
    id,
    tableId: 't',
    name: id,
    type,
    options: {},
    isPrimary: false,
    deletedAt: null,
    ...extra,
  }) as unknown as FieldMeta;
const parent = field('parent', 'link');
const record = (id: string, parentId?: string): RecordData =>
  ({
    id,
    tableId: 't',
    version: 1,
    fields: { parent: parentId ? [{ id: parentId }] : null },
  }) as unknown as RecordData;
const shape = (rows: ReturnType<typeof listRows>) =>
  rows.map((r) => `${'  '.repeat(r.level - 1)}${r.record.id}`);

describe('list tree', () => {
  const records = [
    record('a'),
    record('a1', 'a'),
    record('b'),
    record('a2', 'a'),
    record('a11', 'a1'),
  ];

  it('nests records under their parent, in view order', () => {
    expect(shape(listRows(records, parent))).toEqual(['a', '  a1', '    a11', '  a2', 'b']);
    const [a] = listRows(records, parent);
    expect(a).toMatchObject({ level: 1, childCount: 2, posInSet: 1, setSize: 2 });
  });

  it('is flat without a parent field, and collapsed branches hide their subtree', () => {
    expect(shape(listRows(records, undefined))).toEqual(['a', 'a1', 'b', 'a2', 'a11']);
    expect(shape(listRows(records, parent, new Set(['a'])))).toEqual(['a', 'b']);
  });

  it('puts records whose parent is missing or loops at the top, each once', () => {
    const loop = [record('x', 'y'), record('y', 'x'), record('z', 'gone'), record('s', 's')];
    const rows = listRows(loop, parent);
    expect(rows.map((r) => r.record.id).sort()).toEqual(['s', 'x', 'y', 'z']);
    expect(rows.filter((r) => r.level === 1).length).toBeGreaterThanOrEqual(3);
  });

  it('follows the tree keys', () => {
    const rows = listRows(records, parent);
    const none = new Set<string>();
    expect(treeKey('ArrowLeft', rows, 0, none)).toEqual({ toggle: 'a' });
    expect(treeKey('ArrowRight', rows, 0, none)).toEqual({ focus: 1 });
    expect(treeKey('ArrowLeft', rows, 2, none)).toEqual({ focus: 1 });
    expect(treeKey('ArrowRight', rows, 0, new Set(['a']))).toEqual({ toggle: 'a' });
    expect(treeKey('ArrowDown', rows, 4, none)).toBeNull();
    expect(treeKey('End', rows, 0, none)).toEqual({ focus: 4 });
  });

  it('shows the saved row fields, else the first three', () => {
    const fields = [
      field('name', 'singleLineText', { isPrimary: true }),
      parent,
      field('n1', 'number'),
      field('n2', 'number'),
      field('n3', 'number'),
      field('n4', 'number'),
    ];
    expect(rowFieldsOf(fields, { parentFieldId: 'parent' }).map((f) => f.id)).toEqual([
      'n1',
      'n2',
      'n3',
    ]);
    expect(rowFieldsOf(fields, { rowFields: ['n4', 'gone'] }).map((f) => f.id)).toEqual(['n4']);
  });
});
