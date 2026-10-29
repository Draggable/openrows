import { MAX_RECORDS_PER_REQUEST, type RecordData } from '@openrows/shared';
import {
  type QueryClient,
  type QueryKey,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { api } from './client';
import { newClientOpId } from './clientOps';
import { queryKeys } from './keys';
import type { Body } from './queries';

/**
 * Record writes with optimistic updates. An edit shows at once in every cached list, view
 * query and record of the table; if the server refuses it (422, 409 on `ifVersion`, 403...) the
 * caches roll back to what they held before. The server's answer (with the new `version`)
 * replaces the optimistic record. View queries are refetched afterwards, because an edit can
 * move a record in or out of a filter, a sort position, a group or an aggregate.
 */

/** Something cached under `queryKeys.records.table(tableId)`. */
type RecordCache = RecordData | { records: RecordData[] } | undefined;

type Snapshot = [QueryKey, unknown][];

function hasRecords(data: unknown): data is { records: RecordData[] } {
  return (
    typeof data === 'object' &&
    data !== null &&
    Array.isArray((data as { records?: unknown }).records)
  );
}

function isRecord(data: unknown): data is RecordData {
  return typeof data === 'object' && data !== null && 'fields' in data && 'version' in data;
}

/**
 * After a write: refetches `key` (the table's view queries, or all its records), and marks the
 * other tables' records stale, since a link cell changes the linked records' inverse cells
 * . Only queries on screen refetch, so that costs nothing when no other table is shown.
 */
function refreshRecords(qc: QueryClient, tableId: string, key: QueryKey) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: key }),
    qc.invalidateQueries({
      queryKey: queryKeys.records.all(),
      predicate: (q) => q.queryKey[1] !== tableId,
    }),
  ]);
}

/**
 * Applies `update` to record `recordId` in every cache of the table (lists, view queries,
 * details); `update` returning `null` removes it from lists. Answers what the caches held, for
 * `restoreCaches`.
 */
export function updateCachedRecord(
  qc: QueryClient,
  tableId: string,
  recordId: string,
  update: (record: RecordData) => RecordData | null
): Snapshot {
  const snapshot = qc.getQueriesData({ queryKey: queryKeys.records.table(tableId) });
  qc.setQueriesData<RecordCache>({ queryKey: queryKeys.records.table(tableId) }, (data) => {
    if (hasRecords(data)) {
      if (!data.records.some((r) => r.id === recordId)) return data;
      const records = data.records.flatMap((r) => {
        if (r.id !== recordId) return [r];
        const next = update(r);
        return next ? [next] : [];
      });
      return { ...data, records };
    }
    if (isRecord(data) && data.id === recordId) return update(data) ?? data;
    return data;
  });
  return snapshot;
}

/** Puts back what `updateCachedRecord` replaced. */
export function restoreCaches(qc: QueryClient, snapshot: Snapshot): void {
  for (const [key, data] of snapshot) qc.setQueryData(key, data);
}

export type UpdateRecordVariables = { recordId: string } & Body<'records', 'update'>;

/** Edit cells of one record (a per-cell patch), optimistically. */
export function useUpdateRecord(tableId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ recordId, ...body }: UpdateRecordVariables) =>
      api.records.update({
        params: { tableId, recordId },
        body: { clientOpId: newClientOpId(), ...body },
      }),
    onMutate: async ({ recordId, fields }) => {
      await qc.cancelQueries({ queryKey: queryKeys.records.table(tableId) });
      const snapshot = updateCachedRecord(qc, tableId, recordId, (r) => ({
        ...r,
        fields: { ...r.fields, ...fields },
      }));
      return { snapshot };
    },
    onError: (_err, _vars, context) => {
      if (context) restoreCaches(qc, context.snapshot);
    },
    onSuccess: (record, { typecast }) => {
      updateCachedRecord(qc, tableId, record.id, () => record);
      afterTypecast(qc, tableId, { typecast });
    },
    onSettled: (_r, _e, { recordId }) =>
      Promise.all([
        refreshRecords(qc, tableId, queryKeys.records.queries(tableId)),
        qc.invalidateQueries({ queryKey: queryKeys.revisions.record(tableId, recordId) }),
      ]),
  });
}

/**
 * Restore a record, or one cell, to how it was right after a revision. The server answers
 * the record; it goes into the caches and the history refetches.
 */
export function useRestoreRevision(tableId: string, recordId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ revisionId, fieldId }: { revisionId: string; fieldId?: string }) =>
      api.revisions.restore({
        params: { tableId, recordId, revisionId },
        body: { clientOpId: newClientOpId(), ...(fieldId ? { fieldId } : {}) },
      }),
    onSuccess: (record) => {
      updateCachedRecord(qc, tableId, record.id, () => record);
    },
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.revisions.record(tableId, recordId) }),
        refreshRecords(qc, tableId, queryKeys.records.queries(tableId)),
      ]),
  });
}

/** Delete records (to the trash), removing them from the caches at once. */
export function useDeleteRecords(tableId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (recordIds: string[]) =>
      api.records.deleteMany({
        params: { tableId },
        body: { recordIds, clientOpId: newClientOpId() },
      }),
    onMutate: async (recordIds) => {
      await qc.cancelQueries({ queryKey: queryKeys.records.table(tableId) });
      const snapshot = qc.getQueriesData({ queryKey: queryKeys.records.table(tableId) });
      for (const id of recordIds) updateCachedRecord(qc, tableId, id, () => null);
      return { snapshot };
    },
    onError: (_err, _vars, context) => {
      if (context) restoreCaches(qc, context.snapshot);
    },
    onSettled: () => refreshRecords(qc, tableId, queryKeys.records.table(tableId)),
  });
}

/** Create records; lists and view queries refetch (the server decides where they land). */
export function useCreateRecords(tableId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Body<'records', 'create'>) =>
      api.records.create({ params: { tableId }, body: { clientOpId: newClientOpId(), ...body } }),
    onSettled: () => refreshRecords(qc, tableId, queryKeys.records.table(tableId)),
  });
}

/** Restore records from the trash (the undo of a delete); lists and view queries refetch. */
export function useRestoreRecords(tableId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (recordIds: string[]) =>
      api.records.restoreMany({
        params: { tableId },
        body: { recordIds, clientOpId: newClientOpId() },
      }),
    onSettled: () => refreshRecords(qc, tableId, queryKeys.records.table(tableId)),
  });
}

/** Merges cells into many records of every cache of the table at once. */
function patchCachedRecords(qc: QueryClient, tableId: string, patches: Map<string, Fields>): void {
  const merge = (r: RecordData) => {
    const fields = patches.get(r.id);
    return fields ? { ...r, fields: { ...r.fields, ...fields } } : r;
  };
  qc.setQueriesData<RecordCache>({ queryKey: queryKeys.records.table(tableId) }, (data) => {
    if (hasRecords(data)) return { ...data, records: data.records.map(merge) };
    if (isRecord(data)) return merge(data);
    return data;
  });
}

type Fields = Record<string, unknown>;

export type BulkResult = { records: RecordData[]; error?: unknown };

/**
 * `typecast`: select cells may name options the field lacks, and the server creates them.
 * Only for owners and creators, and only when a write needs it.
 */
export type WriteOptions = { typecast?: boolean };

const typecastBody = (opts: WriteOptions) => (opts.typecast ? { typecast: true } : {});

/** New options live in the table's fields: refetch them after a typecast write. */
function afterTypecast(qc: QueryClient, tableId: string, opts: WriteOptions) {
  if (opts.typecast) void qc.invalidateQueries({ queryKey: queryKeys.tables.detail(tableId) });
}

const chunks = <T>(items: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += MAX_RECORDS_PER_REQUEST) {
    out.push(items.slice(i, i + MAX_RECORDS_PER_REQUEST));
  }
  return out;
};

/**
 * Bulk record writes for paste, fill, range clear, duplicate and undo/redo, in calls of up
 * to 1,000 records (one transaction each, through the RecordService). Cell patches show at once
 * in every cache and roll back if the server refuses them; record lists and view queries
 * refetch afterwards. Plain functions rather than hooks, so the history can run them after the
 * component that started an action is gone.
 */
export const bulkRecords = {
  /**
   * Per-cell patches. Answers the records as the server stored them and, when a call failed,
   * the error (earlier calls stay written; the failed and later ones roll back).
   */
  async patch(
    qc: QueryClient,
    tableId: string,
    records: readonly { id: string; fields: Fields }[],
    opts: WriteOptions = {}
  ): Promise<BulkResult> {
    if (records.length === 0) return { records: [] };
    await qc.cancelQueries({ queryKey: queryKeys.records.table(tableId) });
    const snapshot = qc.getQueriesData({ queryKey: queryKeys.records.table(tableId) });
    patchCachedRecords(qc, tableId, new Map(records.map((r) => [r.id, r.fields])));
    const saved: RecordData[] = [];
    try {
      for (const chunk of chunks(records)) {
        const res = await api.records.updateMany({
          params: { tableId },
          body: { records: chunk, clientOpId: newClientOpId(), ...typecastBody(opts) },
        });
        saved.push(...res.records);
      }
    } catch (error) {
      restoreCaches(qc, snapshot);
      if (saved.length > 0) {
        patchCachedRecords(qc, tableId, new Map(saved.map((r) => [r.id, r.fields])));
      }
      return { records: saved, error };
    } finally {
      void refreshRecords(qc, tableId, queryKeys.records.queries(tableId));
      afterTypecast(qc, tableId, opts);
    }
    // The stored values (option ids, not the pasted names) replace the optimistic ones.
    if (opts.typecast) patchCachedRecords(qc, tableId, new Map(saved.map((r) => [r.id, r.fields])));
    return { records: saved };
  },
  /** New records, in order (and the error when a call failed, as for `patch`). */
  async create(
    qc: QueryClient,
    tableId: string,
    records: readonly Fields[],
    opts: WriteOptions = {}
  ): Promise<BulkResult> {
    const created: RecordData[] = [];
    try {
      for (const chunk of chunks(records)) {
        const res = await api.records.create({
          params: { tableId },
          body: {
            records: chunk.map((fields) => ({ fields })),
            clientOpId: newClientOpId(),
            ...typecastBody(opts),
          },
        });
        if ('records' in res) created.push(...res.records);
      }
    } catch (error) {
      return { records: created, error };
    } finally {
      void refreshRecords(qc, tableId, queryKeys.records.table(tableId));
      afterTypecast(qc, tableId, opts);
    }
    return { records: created };
  },
  /** Moves records to the trash (or restores them), taking them out of the caches at once. */
  async trash(
    qc: QueryClient,
    tableId: string,
    recordIds: readonly string[],
    restore = false
  ): Promise<void> {
    if (recordIds.length === 0) return;
    await qc.cancelQueries({ queryKey: queryKeys.records.table(tableId) });
    const snapshot = qc.getQueriesData({ queryKey: queryKeys.records.table(tableId) });
    if (!restore) {
      const ids = new Set(recordIds);
      qc.setQueriesData<RecordCache>({ queryKey: queryKeys.records.table(tableId) }, (data) =>
        hasRecords(data) ? { ...data, records: data.records.filter((r) => !ids.has(r.id)) } : data
      );
    }
    try {
      for (const chunk of chunks(recordIds)) {
        const body = { recordIds: chunk, clientOpId: newClientOpId() };
        if (restore) await api.records.restoreMany({ params: { tableId }, body });
        else await api.records.deleteMany({ params: { tableId }, body });
      }
    } catch (err) {
      restoreCaches(qc, snapshot);
      throw err;
    } finally {
      void refreshRecords(qc, tableId, queryKeys.records.table(tableId));
    }
  },
};
