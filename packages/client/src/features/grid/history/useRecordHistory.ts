import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { ApiError } from '../../../api/client';
import { bulkRecords } from '../../../api/records';
import { toast } from '../../../components/ui';
import {
  emptyHistory,
  type HistoryEntry,
  type HistoryState,
  opsFor,
  type RecordOp,
  record,
  takeRedo,
  takeUndo,
} from './history';

/** Per table, so switching views of a table keeps its history for the session. */
const histories = new Map<string, HistoryState>();
/** Writes, undo and redo run one at a time, in order, so an undo never overtakes its write. */
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task);
  queue = next.catch(() => undefined);
  return next;
}

const message = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong');

/**
 * Undo/redo of the grid's record edits (Ctrl/⌘ Z and Shift+Ctrl/⌘ Z): every cell edit,
 * paste, fill, clear, duplicate and delete records an entry; undo and redo replay its inverse
 * patches as bulk calls of the RecordService.
 */
export function useRecordHistory(tableId: string) {
  const qc = useQueryClient();

  const run = useCallback(
    async (op: RecordOp) => {
      if (op.type === 'patch') {
        const res = await bulkRecords.patch(qc, tableId, op.records);
        if (res.error) throw res.error;
      } else {
        await bulkRecords.trash(qc, tableId, op.recordIds, op.type === 'restore');
      }
    },
    [qc, tableId]
  );

  const replay = useCallback(
    (direction: 'undo' | 'redo') => {
      return enqueue(async () => {
        const state = histories.get(tableId) ?? emptyHistory();
        const taken = direction === 'undo' ? takeUndo(state) : takeRedo(state);
        if (!taken) return;
        const [entry, next] = taken;
        histories.set(tableId, next);
        try {
          for (const op of opsFor(entry, direction)) await run(op);
          toast(`${direction === 'undo' ? 'Undid' : 'Redid'} ${entry.label}`);
        } catch (err) {
          // Leave the entry where it was, so the user can try again.
          histories.set(tableId, state);
          toast.error(`Couldn't ${direction} ${entry.label}: ${message(err)}`);
        }
      });
    },
    [run, tableId]
  );

  return useMemo(
    () => ({
      /** Runs a write after every write, undo and redo before it. */
      enqueue,
      record: (entry: HistoryEntry) =>
        histories.set(tableId, record(histories.get(tableId) ?? emptyHistory(), entry)),
      undo: () => replay('undo'),
      redo: () => replay('redo'),
    }),
    [replay, tableId]
  );
}
