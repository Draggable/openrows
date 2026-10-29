/**
 * The grid's undo/redo log: each user action is one entry of steps, each step its own
 * inverse. Undo runs the inverse of the steps last to first, redo runs them again first to last;
 * every operation is a bulk call of the RecordService (`PATCH`, `/delete`, `/restore`). Pure,
 * so it is unit-tested without a DOM or a server.
 */

type Fields = Record<string, unknown>;

/** Cells of records before and after a write (only the cells written). */
export type UpdateStep = {
  kind: 'update';
  records: { id: string; before: Fields; after: Fields }[];
};
/** Records created (undo trashes them, redo restores the same records). */
export type CreateStep = { kind: 'create'; recordIds: string[] };
/** Records moved to the trash (undo restores them). */
export type DeleteStep = { kind: 'delete'; recordIds: string[] };
export type Step = UpdateStep | CreateStep | DeleteStep;

export type HistoryEntry = { label: string; steps: Step[] };

/** One bulk call of the record API. */
export type RecordOp =
  | { type: 'patch'; records: { id: string; fields: Fields }[] }
  | { type: 'delete'; recordIds: string[] }
  | { type: 'restore'; recordIds: string[] };

/** The calls that undo (`'undo'`) or redo (`'redo'`) an entry, in order. */
export function opsFor(entry: HistoryEntry, direction: 'undo' | 'redo'): RecordOp[] {
  const steps = direction === 'undo' ? [...entry.steps].reverse() : entry.steps;
  return steps.map((step): RecordOp => {
    if (step.kind === 'update') {
      return {
        type: 'patch',
        records: step.records.map((r) => ({
          id: r.id,
          fields: direction === 'undo' ? r.before : r.after,
        })),
      };
    }
    const forward = step.kind === 'create' ? 'restore' : 'delete';
    const backward = step.kind === 'create' ? 'delete' : 'restore';
    return { type: direction === 'undo' ? backward : forward, recordIds: step.recordIds };
  });
}

/** Most entries kept; older ones fall off. */
export const HISTORY_LIMIT = 100;

export type HistoryState = { past: HistoryEntry[]; future: HistoryEntry[] };

export const emptyHistory = (): HistoryState => ({ past: [], future: [] });

/** A new action: it goes on the undo stack and clears the redo stack. */
export function record(state: HistoryState, entry: HistoryEntry): HistoryState {
  if (entry.steps.length === 0) return state;
  return { past: [...state.past, entry].slice(-HISTORY_LIMIT), future: [] };
}

/** Takes the entry to undo off the stack (it moves to the redo stack). */
export function takeUndo(state: HistoryState): [HistoryEntry, HistoryState] | null {
  const entry = state.past.at(-1);
  if (!entry) return null;
  return [entry, { past: state.past.slice(0, -1), future: [...state.future, entry] }];
}

/** Takes the entry to redo off the stack (it moves back to the undo stack). */
export function takeRedo(state: HistoryState): [HistoryEntry, HistoryState] | null {
  const entry = state.future.at(-1);
  if (!entry) return null;
  return [entry, { past: [...state.past, entry], future: state.future.slice(0, -1) }];
}

/**
 * An update step from the cells about to be written and the records' current cells: `before`
 * holds exactly the prior value of each written cell (`null` when it was empty).
 */
export function updateStep(
  writes: readonly { id: string; fields: Fields }[],
  current: (id: string) => Fields | undefined
): UpdateStep {
  return {
    kind: 'update',
    records: writes.map((w) => {
      const now = current(w.id) ?? {};
      const before: Fields = {};
      for (const fieldId of Object.keys(w.fields)) before[fieldId] = now[fieldId] ?? null;
      return { id: w.id, before, after: w.fields };
    }),
  };
}
