import { describe, expect, it } from 'vitest';
import type { FieldRow, TableRow } from '../../fields/service.js';
import { unreadableFields } from './ask.js';

const A = '0190a000-0000-7000-8000-00000000000a';
const B = '0190a000-0000-7000-8000-00000000000b';
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

function row(n: number, tableId: string, type: string, config: Record<string, unknown> = {}) {
  return { id: id(n), tableId, type, config, isPrimary: false } as unknown as FieldRow;
}

const viewer = { userId: id(999), role: 'creator' as const };
const hiding = (hidden: string[]) => ({ hiddenFields: () => new Set(hidden) });

describe('unreadableFields', () => {
  it('follows a formula by its formula, even when the stored reference list is empty', () => {
    const secret = row(1, A, 'number');
    const formula = row(2, A, 'formula', { formula: `{${id(1)}} * 2`, referencedFieldIds: [] });
    const button = row(3, A, 'button', { formula: `{${id(2)}}`, referencedFieldIds: [] });
    const plain = row(4, A, 'number');
    const rows = new Map([secret, formula, button, plain].map((r) => [r.id, r]));
    const out = unreadableFields(viewer, hiding([id(1)]), [{ id: A } as TableRow], rows);
    expect([...out].sort()).toEqual([id(1), id(2), id(3)]);
  });

  it('checks every table of the base, not only the ones passed in', () => {
    // A lookup in A reads a hidden field of B; B is past the tables described.
    const secret = row(1, B, 'text');
    const link = row(2, A, 'link', { linkedTableId: B });
    const lookup = row(3, A, 'lookup', { recordLinkFieldId: id(2), fieldIdInLinkedTable: id(1) });
    const rows = new Map([secret, link, lookup].map((r) => [r.id, r]));
    const visibility = {
      hiddenFields: (_: unknown, tableId: string) => new Set(tableId === B ? [id(1)] : []),
    };
    const out = unreadableFields(viewer, visibility, [{ id: A } as TableRow], rows);
    expect(out.has(id(3))).toBe(true);
    expect(out.has(id(2))).toBe(false);
  });
});
