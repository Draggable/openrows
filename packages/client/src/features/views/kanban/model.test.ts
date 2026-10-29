import type { Collaborator, FieldMeta } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import {
  afterIdFor,
  cardFieldsOf,
  coverOf,
  dropIndex,
  keyboardMove,
  stackableFields,
  stackCounts,
  stackKeyOf,
  stackRows,
  stacksOf,
} from './model';

const field = (id: string, type: string, options: unknown = {}, extra = {}): FieldMeta =>
  ({
    id,
    tableId: 't',
    name: id,
    type,
    options,
    description: null,
    isPrimary: false,
    position: 1,
    deletedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...extra,
  }) as unknown as FieldMeta;

const status = field('status', 'singleSelect', {
  choices: [
    { id: 'todo', name: 'To do', color: 'blue' },
    { id: 'done', name: 'Done', color: 'green' },
  ],
});
const owner = field('owner', 'user', { multiple: false, notify: false });
const ada = { id: 'u1', name: 'Ada' } as Collaborator;

describe('kanban stacks (#39)', () => {
  it('stacks by single selects and one-person user fields', () => {
    const team = field('team', 'user', { multiple: true, notify: false });
    const name = field('name', 'singleLineText', {}, { isPrimary: true });
    expect(stackableFields([name, status, owner, team]).map((f) => f.id)).toEqual([
      'status',
      'owner',
    ]);
  });

  it('has the empty stack first, then choices in order', () => {
    const stacks = stacksOf(status, []);
    expect(stacks.map((s) => [s.key, s.label])).toEqual([
      [null, 'Uncategorized'],
      ['todo', 'To do'],
      ['done', 'Done'],
    ]);
    expect(stacks[1]?.within).toEqual({ fieldId: 'status', operator: 'is', value: 'todo' });
    expect(stacks[0]?.within).toEqual({ fieldId: 'status', operator: 'isEmpty' });
    expect(stacks[2]?.value).toBe('done');
  });

  it('stacks people from the directory, then former members the counts name', () => {
    const stacks = stacksOf(
      owner,
      [ada],
      [
        { key: [null], count: 2 },
        { key: [['u1']], count: 1 },
        { key: [['gone']], count: 4 },
      ]
    );
    expect(stacks.map((s) => [s.key, s.label])).toEqual([
      [null, 'No owner'],
      ['u1', 'Ada'],
      ['gone', 'Former member'],
    ]);
    expect(stacks[1]?.within).toEqual({ fieldId: 'owner', operator: 'hasAnyOf', value: ['u1'] });
    expect(stacks[1]?.value).toEqual(['u1']);
  });

  it('reads stack keys and counts, unknown choices as empty', () => {
    expect(stackKeyOf(status, 'todo')).toBe('todo');
    expect(stackKeyOf(status, 'deleted-choice')).toBeNull();
    expect(stackKeyOf(owner, ['u1'])).toBe('u1');
    expect(stackKeyOf(owner, null)).toBeNull();
    const counts = stackCounts(status, [
      { key: [null], count: 2 },
      { key: ['todo'], count: 3 },
      { key: ['stale'], count: 1 },
    ]);
    expect(counts.get(null)).toBe(3);
    expect(counts.get('todo')).toBe(3);
  });

  it('shows the saved card fields, or the first three after the title', () => {
    const fields = [
      field('name', 'singleLineText', {}, { isPrimary: true }),
      status,
      owner,
      field('a', 'number'),
      field('b', 'number'),
    ];
    expect(cardFieldsOf(fields, { stackFieldId: 'status' }).map((f) => f.id)).toEqual([
      'owner',
      'a',
      'b',
    ]);
    expect(cardFieldsOf(fields, { cardFields: ['b', 'gone', 'status'] }).map((f) => f.id)).toEqual([
      'b',
      'status',
    ]);
  });
});

describe('kanban moves (#39)', () => {
  it('drops before the card under the pointer half', () => {
    expect(dropIndex(0, 100, 5)).toBe(0);
    expect(dropIndex(49, 100, 5)).toBe(0);
    expect(dropIndex(51, 100, 5)).toBe(1);
    expect(dropIndex(10_000, 100, 5)).toBe(5);
    expect(dropIndex(-20, 100, 5)).toBe(0);
  });

  it('lays out a stack with the leaving card hidden and a slot for the arriving one', () => {
    const rows = (count: number, hidden: number | null, insertAt: number | null) => {
      const r = stackRows(count, hidden, insertAt);
      return Array.from({ length: r.count }, (_, i) => {
        const at = r.at(i);
        return at.slot ? 'slot' : at.index;
      });
    };
    expect(rows(3, null, null)).toEqual([0, 1, 2]);
    expect(rows(3, 1, null)).toEqual([0, 2]);
    expect(rows(3, null, 0)).toEqual(['slot', 0, 1, 2]);
    expect(rows(3, null, 3)).toEqual([0, 1, 2, 'slot']);
    // Within one stack: card 0 dropped before card 2.
    expect(rows(3, 0, 2)).toEqual([1, 'slot', 2]);
    // Card 2 dropped at the top.
    expect(rows(3, 2, 0)).toEqual(['slot', 0, 1]);
  });

  it('places a dropped card after the nearest other card above it', () => {
    const ids = ['a', 'b', 'c'];
    const idAt = (i: number) => ids[i];
    expect(afterIdFor(idAt, 0, 'x')).toBeNull();
    expect(afterIdFor(idAt, 2, 'x')).toBe('b');
    expect(afterIdFor(idAt, 3, 'x')).toBe('c');
    // a dropped right below itself stays first.
    expect(afterIdFor(idAt, 1, 'a')).toBeNull();
    expect(afterIdFor(idAt, 3, 'c')).toBe('b');
  });

  it('plans keyboard moves with Alt+arrows', () => {
    const sizes = { stacks: 3, count: 4 };
    expect(keyboardMove('ArrowUp', { stack: 1, index: 2 }, sizes, true)).toEqual({
      kind: 'reorder',
      insertAt: 1,
    });
    expect(keyboardMove('ArrowDown', { stack: 1, index: 2 }, sizes, true)).toEqual({
      kind: 'reorder',
      insertAt: 4,
    });
    expect(keyboardMove('ArrowDown', { stack: 1, index: 3 }, sizes, true)).toBeNull();
    expect(keyboardMove('ArrowUp', { stack: 1, index: 0 }, sizes, true)).toBeNull();
    expect(keyboardMove('ArrowUp', { stack: 1, index: 2 }, sizes, false)).toBeNull();
    expect(keyboardMove('ArrowLeft', { stack: 1, index: 2 }, sizes, false)).toEqual({
      kind: 'restack',
      stack: 0,
    });
    expect(keyboardMove('ArrowRight', { stack: 2, index: 0 }, sizes, true)).toBeNull();
  });

  it('covers a card with the first image attachment', () => {
    expect(
      coverOf([
        { id: 'f1', filename: 'a.pdf', type: 'application/pdf' },
        { id: 'f2', filename: 'b.png', type: 'image/png' },
      ])
    ).toEqual({ id: 'f2', filename: 'b.png' });
    expect(coverOf(null)).toBeNull();
    expect(coverOf([{ id: 'f1', type: 'text/plain' }])).toBeNull();
  });
});
