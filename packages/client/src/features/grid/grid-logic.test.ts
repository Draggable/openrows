import type { FieldMeta } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import {
  clampWidth,
  GUTTER_WIDTH,
  gridColumns,
  mergeOrder,
  moveField,
  orderedFields,
  PHONE_PRIMARY_WIDTH,
  phoneLayout,
} from './layout';
import {
  cellSelection,
  type GridSize,
  inRange,
  navigate,
  type Selection,
  selectionRange,
  selectRows,
} from './selection';
import { pagesFor } from './windowing';

const field = (id: string, type: string, isPrimary = false): FieldMeta =>
  ({
    id,
    tableId: 't',
    name: id,
    description: null,
    type,
    options: {},
    isPrimary,
    position: 0,
  }) as unknown as FieldMeta;

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const fields = [field(A, 'singleLineText', true), field(B, 'number'), field(C, 'checkbox')];

describe('layout', () => {
  it('keeps the primary field first, then the saved order, then new fields', () => {
    expect(orderedFields(fields, { fieldOrder: [C, A] }).map((f) => f.id)).toEqual([A, C, B]);
    expect(orderedFields(fields, { fieldOrder: ['gone', B] }).map((f) => f.id)).toEqual([A, B, C]);
  });

  it('computes widths, frozen panes and offsets', () => {
    const cols = gridColumns(fields, { frozenCount: 1, columnWidths: { [C]: 100 } });
    expect(cols.map((c) => [c.width, c.frozen, c.left])).toEqual([
      [240, true, GUTTER_WIDTH],
      [110, true, GUTTER_WIDTH + 240],
      [100, false, 0],
    ]);
    expect(cols[1]?.align).toBe('right');
    expect(clampWidth(5)).toBe(60);
  });

  it('moves fields but never before the primary field', () => {
    const cols = gridColumns(fields, {});
    expect(moveField(cols, C, 1)).toEqual([A, C, B]);
    expect(moveField(cols, C, 0)).toEqual([A, C, B]);
    expect(moveField(cols, A, 2)).toEqual([A, B, C]);
  });

  it('keeps hidden fields in their slots when the visible ones move', () => {
    expect(mergeOrder(['a', 'h', 'b', 'c'], ['a', 'c', 'b'])).toEqual(['a', 'h', 'c', 'b']);
    expect(mergeOrder(['a', 'h'], ['a', 'n'])).toEqual(['a', 'h', 'n']);
  });
});

describe('selection', () => {
  const size: GridSize = { rows: 100, cols: 5, pageRows: 10 };
  const at = (row: number, col: number) => cellSelection({ row, col });
  const go = (sel: Selection, key: string, mods: object = {}) =>
    navigate(sel, { key, ...mods }, size)?.focus;

  it('moves with arrows and clamps at the edges', () => {
    expect(go(at(0, 0), 'ArrowDown')).toEqual({ row: 1, col: 0 });
    expect(go(at(0, 0), 'ArrowUp')).toEqual({ row: 0, col: 0 });
    expect(go(at(3, 4), 'ArrowRight')).toEqual({ row: 3, col: 4 });
    expect(go(at(3, 2), 'ArrowDown', { ctrlKey: true })).toEqual({ row: 99, col: 2 });
  });

  it('handles Home/End, Page Up/Down and Tab wrapping', () => {
    expect(go(at(5, 2), 'Home')).toEqual({ row: 5, col: 0 });
    expect(go(at(5, 2), 'End')).toEqual({ row: 5, col: 4 });
    expect(go(at(5, 2), 'End', { metaKey: true })).toEqual({ row: 99, col: 4 });
    expect(go(at(5, 2), 'PageDown')).toEqual({ row: 15, col: 2 });
    expect(go(at(5, 2), 'PageUp')).toEqual({ row: 0, col: 2 });
    expect(go(at(5, 4), 'Tab')).toEqual({ row: 6, col: 0 });
    expect(go(at(6, 0), 'Tab', { shiftKey: true })).toEqual({ row: 5, col: 4 });
    expect(navigate(at(99, 4), { key: 'Tab' }, size)).toBeNull();
    expect(navigate(at(0, 0), { key: 'x' }, size)).toBeNull();
  });

  it('extends a range with Shift and covers whole rows', () => {
    const sel = navigate(at(2, 1), { key: 'ArrowDown', shiftKey: true }, size);
    if (!sel) throw new Error('no selection');
    const wider = navigate(sel, { key: 'ArrowRight', shiftKey: true }, size);
    if (!wider) throw new Error('no selection');
    expect(selectionRange(wider, size)).toEqual({ top: 2, bottom: 3, left: 1, right: 2 });
    const rows = selectRows(selectRows(null, 4, false), 6, true);
    const range = selectionRange(rows, size);
    expect(range).toEqual({ top: 4, bottom: 6, left: 0, right: 4 });
    expect(inRange(range, 5, 3)).toBe(true);
    expect(inRange(range, 7, 3)).toBe(false);
  });
});

describe('windowing', () => {
  it('covers the visible rows plus a page of overscan on each side', () => {
    expect(pagesFor(0, 30, 100_000)).toEqual([0, 100]);
    expect(pagesFor(450, 480, 100_000)).toEqual([300, 400, 500]);
    expect(pagesFor(99_990, 99_999, 100_000)).toEqual([99_800, 99_900]);
    expect(pagesFor(0, 0, 0)).toEqual([0]);
  });
});

describe('phone layout (#81)', () => {
  const fields = [field('p', 'singleLineText', true), field('a', 'number'), field('b', 'checkbox')];

  it('keeps only the primary field frozen, at most PHONE_PRIMARY_WIDTH wide', () => {
    const cols = gridColumns(fields, phoneLayout(fields, { frozenCount: 2 }));
    expect(cols.map((c) => c.frozen)).toEqual([true, false, false]);
    expect(cols[0]?.width).toBe(PHONE_PRIMARY_WIDTH);
    expect(cols[1]?.left).toBe(0);
  });

  it('keeps a narrower saved primary width and leaves the other widths alone', () => {
    const layout = { columnWidths: { p: 100, a: 300 } };
    const cols = gridColumns(fields, phoneLayout(fields, layout));
    expect(cols.map((c) => c.width).slice(0, 2)).toEqual([100, 300]);
    expect(layout.columnWidths).toEqual({ p: 100, a: 300 });
  });
});
