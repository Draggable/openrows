import type { FieldMeta, FieldTypeName } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import {
  copyPayload,
  type Fields,
  parseTsv,
  planFill,
  planPaste,
  readClipboard,
  toTsv,
} from './clipboard';

const NOW = '2026-10-25T10:00:00.000Z';
let n = 0;
const field = (type: FieldTypeName, options: unknown = {}): FieldMeta => ({
  id: `0190a000-0000-7000-8000-${String(++n).padStart(12, '0')}`,
  tableId: '0190a000-0000-7000-8000-000000000999',
  name: type,
  description: null,
  type,
  options,
  isPrimary: false,
  position: n,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
});

const name = field('singleLineText');
const estimate = field('number');
const done = field('checkbox');
const status = field('singleSelect', {
  choices: [
    { id: 'todo', name: 'Todo', color: 'blue' },
    { id: 'doing', name: 'In progress', color: 'amber' },
  ],
});
const created = field('createdTime');
const due = field('date', { dateFormat: 'us' });

describe('TSV', () => {
  it('parses Excel and Sheets output: CRLF, quoted tabs, newlines and quotes', () => {
    expect(parseTsv('a\tb\r\nc\td\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(parseTsv('"x\ty"\t"line 1\nline 2"\t"say ""hi"""\n')).toEqual([
      ['x\ty', 'line 1\nline 2', 'say "hi"'],
    ]);
    expect(parseTsv('a\t\tc')).toEqual([['a', '', 'c']]);
    expect(parseTsv('')).toEqual([]);
    expect(parseTsv('one')).toEqual([['one']]);
  });

  it('round-trips through toTsv', () => {
    const rows = [
      ['plain', 'with\ttab', 'with "quote"'],
      ['two\nlines', '', 'x'],
    ];
    expect(parseTsv(toTsv(rows))).toEqual(rows);
  });
});

describe('copy and read', () => {
  it('copies display text as TSV and exact values in the HTML', () => {
    const rows: Fields[] = [
      { [name.id]: 'Write <tests>', [estimate.id]: 3, [status.id]: 'doing' },
      { [name.id]: 'Ship', [estimate.id]: null, [status.id]: null },
    ];
    const payload = copyPayload([name, estimate, status], rows);
    expect(payload.text).toBe('Write <tests>\t3\tIn progress\nShip\t\t');
    expect(payload.html).toContain('<td>Write &lt;tests&gt;</td>');
    expect(readClipboard(payload.text, payload.html)).toEqual([
      [
        { text: 'Write <tests>', value: 'Write <tests>' },
        { text: '3', value: 3 },
        { text: 'In progress', value: 'In progress' },
      ],
      [
        { text: 'Ship', value: 'Ship' },
        { text: '', value: null },
        { text: '', value: null },
      ],
    ]);
  });

  it('reads plain text when the HTML is not ours or does not match', () => {
    expect(readClipboard('a\tb', '<table><tr><td>a</td></tr></table>')).toEqual([
      [{ text: 'a' }, { text: 'b' }],
    ]);
    expect(readClipboard('a', '<table data-openrows="[[1,2]]"></table>')).toEqual([
      [{ text: 'a' }],
    ]);
  });
});

describe('planPaste', () => {
  const columns = [name, estimate, done, status, created];
  const current: Fields[] = [
    { [name.id]: 'A', [estimate.id]: 1, [done.id]: false, [status.id]: null },
    { [name.id]: 'B', [estimate.id]: 2, [done.id]: true, [status.id]: 'todo' },
  ];
  const getRow = (row: number) => current[row];
  const cells = (text: string) => readClipboard(text);

  it('coerces each cell through the target field and skips unchanged ones', () => {
    const plan = planPaste(
      cells('A\t42\tx\tIn progress'),
      { top: 0, left: 0, bottom: 0, right: 0 },
      columns,
      2,
      getRow
    );
    expect(plan.updates).toEqual([
      { row: 0, fields: { [estimate.id]: 42, [done.id]: true, [status.id]: 'doing' } },
    ]);
    expect(plan.creates).toEqual([]);
    expect(plan).toMatchObject({ rows: 1, cols: 4, unreadable: 0 });
  });

  it('skips unreadable values and read-only columns, and drops columns past the last', () => {
    const plan = planPaste(
      cells('abc\t2026-01-01\textra'),
      { top: 1, left: 3, bottom: 1, right: 3 },
      columns,
      2,
      getRow
    );
    expect(plan.updates).toEqual([]);
    expect(plan.unreadable).toBe(1);
    expect(plan.cols).toBe(2);
  });

  it('keeps unknown select names for a typecast write only for schema roles (#70)', () => {
    const target = { top: 0, left: 3, bottom: 1, right: 3 };
    const plain = planPaste(cells('Blocked\nTodo'), target, columns, 2, getRow);
    expect(plain).toMatchObject({ unreadable: 1, typecast: false });
    const typecast = planPaste(cells(' Blocked \nTodo'), target, columns, 2, getRow, {
      typecast: true,
    });
    expect(typecast.updates).toEqual([{ row: 0, fields: { [status.id]: 'Blocked' } }]);
    expect(typecast).toMatchObject({ unreadable: 0, typecast: true });
    // Known names alone need no typecast.
    expect(planPaste(cells('Todo'), target, columns, 2, getRow, { typecast: true }).typecast).toBe(
      false
    );
  });

  it('empties cells for empty text and creates records past the last row', () => {
    const plan = planPaste(
      cells('\t5\nC\t3\nD\t'),
      { top: 1, left: 0, bottom: 1, right: 0 },
      columns,
      2,
      getRow
    );
    expect(plan.updates).toEqual([{ row: 1, fields: { [name.id]: null, [estimate.id]: 5 } }]);
    expect(plan.creates).toEqual([{ [name.id]: 'C', [estimate.id]: 3 }, { [name.id]: 'D' }]);
  });

  it('repeats the clipboard over a selection that is a multiple of it', () => {
    const plan = planPaste(
      cells('7'),
      { top: 0, left: 1, bottom: 1, right: 1 },
      columns,
      2,
      getRow
    );
    expect(plan.updates).toEqual([
      { row: 0, fields: { [estimate.id]: 7 } },
      { row: 1, fields: { [estimate.id]: 7 } },
    ]);
  });

  it('pastes exact values copied from OpenRows across types', () => {
    const payload = copyPayload([due], [{ [due.id]: '2026-03-04' }]);
    expect(payload.text).toBe('3/4/2026');
    const plan = planPaste(
      readClipboard(payload.text, payload.html),
      { top: 0, left: 0, bottom: 0, right: 0 },
      [due],
      1,
      () => ({ [due.id]: null })
    );
    expect(plan.updates).toEqual([{ row: 0, fields: { [due.id]: '2026-03-04' } }]);
  });

  it('plans a 500 × 10 paste', () => {
    const wide = Array.from({ length: 10 }, () => field('singleLineText'));
    const text = Array.from({ length: 500 }, (_, r) =>
      Array.from({ length: 10 }, (_, c) => `r${r}c${c}`).join('\t')
    ).join('\n');
    const plan = planPaste(
      readClipboard(text),
      { top: 0, left: 0, bottom: 0, right: 0 },
      wide,
      400,
      () => ({})
    );
    expect(plan.updates).toHaveLength(400);
    expect(plan.creates).toHaveLength(100);
    expect(plan.updates[399]?.fields[wide[9]?.id ?? '']).toBe('r399c9');
  });
});

describe('planFill', () => {
  it('repeats the source rows down, skipping computed and unchanged cells', () => {
    const rows: Fields[] = [
      { [name.id]: 'A', [estimate.id]: 1, [created.id]: NOW },
      { [name.id]: 'B', [estimate.id]: 2, [created.id]: NOW },
      { [name.id]: 'x', [estimate.id]: 9 },
      { [name.id]: 'B', [estimate.id]: null },
      { [name.id]: null, [estimate.id]: null },
    ];
    const writes = planFill(
      { top: 0, bottom: 1, left: 0, right: 2 },
      4,
      [name, estimate, created],
      (r) => rows[r]
    );
    expect(writes).toEqual([
      { row: 2, fields: { [name.id]: 'A', [estimate.id]: 1 } },
      { row: 3, fields: { [estimate.id]: 2 } },
      { row: 4, fields: { [name.id]: 'A', [estimate.id]: 1 } },
    ]);
  });
});
