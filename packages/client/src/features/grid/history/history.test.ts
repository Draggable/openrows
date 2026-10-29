import { describe, expect, it } from 'vitest';
import {
  emptyHistory,
  HISTORY_LIMIT,
  type HistoryEntry,
  opsFor,
  record,
  takeRedo,
  takeUndo,
  updateStep,
} from './history';

const paste: HistoryEntry = {
  label: 'the paste',
  steps: [
    updateStep(
      [
        { id: 'r1', fields: { f1: 'new', f2: 5 } },
        { id: 'r2', fields: { f1: null } },
      ],
      (id) => (id === 'r1' ? { f1: 'old', f2: null, f3: 'untouched' } : { f1: ['a', 'b'] })
    ),
    { kind: 'create', recordIds: ['r3'] },
  ],
};

describe('history', () => {
  it('keeps exactly the prior value of each written cell', () => {
    expect(paste.steps[0]).toEqual({
      kind: 'update',
      records: [
        { id: 'r1', before: { f1: 'old', f2: null }, after: { f1: 'new', f2: 5 } },
        { id: 'r2', before: { f1: ['a', 'b'] }, after: { f1: null } },
      ],
    });
  });

  it('undoes steps last to first with their inverses, and redoes them in order', () => {
    expect(opsFor(paste, 'undo')).toEqual([
      { type: 'delete', recordIds: ['r3'] },
      {
        type: 'patch',
        records: [
          { id: 'r1', fields: { f1: 'old', f2: null } },
          { id: 'r2', fields: { f1: ['a', 'b'] } },
        ],
      },
    ]);
    expect(opsFor(paste, 'redo')).toEqual([
      {
        type: 'patch',
        records: [
          { id: 'r1', fields: { f1: 'new', f2: 5 } },
          { id: 'r2', fields: { f1: null } },
        ],
      },
      { type: 'restore', recordIds: ['r3'] },
    ]);
    const deletion: HistoryEntry = { label: 'x', steps: [{ kind: 'delete', recordIds: ['r1'] }] };
    expect(opsFor(deletion, 'undo')).toEqual([{ type: 'restore', recordIds: ['r1'] }]);
    expect(opsFor(deletion, 'redo')).toEqual([{ type: 'delete', recordIds: ['r1'] }]);
  });

  it('moves entries between the undo and redo stacks; a new action clears redo', () => {
    const other: HistoryEntry = { label: 'other', steps: [{ kind: 'delete', recordIds: ['x'] }] };
    let state = record(record(emptyHistory(), paste), other);
    const undone = takeUndo(state);
    expect(undone?.[0]).toBe(other);
    state = undone?.[1] ?? state;
    expect(state).toEqual({ past: [paste], future: [other] });
    const redone = takeRedo(state);
    expect(redone?.[0]).toBe(other);
    expect(redone?.[1]).toEqual({ past: [paste, other], future: [] });
    expect(record(state, paste).future).toEqual([]);
    expect(takeUndo(emptyHistory())).toBeNull();
    expect(takeRedo(emptyHistory())).toBeNull();
    expect(record(emptyHistory(), { label: 'empty', steps: [] }).past).toEqual([]);
  });

  it(`keeps the last ${HISTORY_LIMIT} entries`, () => {
    let state = emptyHistory();
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) state = record(state, { ...paste, label: `${i}` });
    expect(state.past).toHaveLength(HISTORY_LIMIT);
    expect(state.past[0]?.label).toBe('5');
  });
});
