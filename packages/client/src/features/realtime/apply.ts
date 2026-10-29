import { CommentSchema, type RealtimeEvent, type RecordData } from '@openrows/shared';
import type { Query, QueryClient } from '@tanstack/react-query';
import { isOwnClientOp } from '../../api/clientOps';
import { queryKeys } from '../../api/keys';
import { removeComment, upsertComment } from '../../api/queries';

/**
 * Applies realtime events to the TanStack Query caches (ADR-003 §7).
 *
 * - `record.updated`: the cells are merged into the record wherever a cache of its table holds
 *   it (grid windows, kanban stacks, calendar, gallery, timeline and list queries, the record
 *   expand view), by record id. Nothing refetches, so a record that no longer matches a view's
 *   filter or sort stays where it is until the next refetch (a user action, a create or delete,
 *   a schema change), as in Airtable. An event older than the cached version is ignored.
 * - `record.deleted`: the record leaves every list at once; `record.created`/`restored` and
 *   deletes then refetch the table's lists and view queries (the server decides where a record
 *   lands, and counts change). `view.recordMoved` refetches them too.
 * - Schema events (field, table, view, section, base) invalidate the matching queries; only
 *   those on screen refetch.
 * - Comment events put the comment in (or take it out of) its record's list, by id, so
 *   they are idempotent and applied even for this tab's own writes; the table's comment counts
 *   refetch when one is added or deleted.
 * - Record events tagged with one of this tab's `clientOpId`s are its own echoes and are
 *   skipped: the optimistic update and the server's answer already applied them.
 * - Every record and field event, echoes included, tells the `onTableChanges` listeners which
 *   tables changed: dashboards refetch their server-side aggregates from it.
 */

type TableChangeListener = (tableIds: ReadonlySet<string>) => void;
const tableChangeListeners = new Set<TableChangeListener>();

/** Calls `listener` with the tables whose records or fields changed; answers the unsubscribe. */
export function onTableChanges(listener: TableChangeListener): () => void {
  tableChangeListeners.add(listener);
  return () => {
    tableChangeListeners.delete(listener);
  };
}

type Cells = Record<string, unknown>;
type Change = { cells: Cells; version: number | undefined; at: string; actorId: string | null };

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

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const cellsOf = (v: unknown): Cells =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Cells) : {};

/** Applies a record's remote changes, in order, skipping those it already has. */
function merge(record: RecordData, changes: readonly Change[]): RecordData {
  let next = record;
  for (const c of changes) {
    if (c.version !== undefined && next.version >= c.version) continue;
    next = {
      ...next,
      fields: { ...next.fields, ...c.cells },
      ...(c.version !== undefined
        ? { version: c.version, updatedAt: c.at, updatedBy: c.actorId }
        : {}),
    };
  }
  return next;
}

/** Lists and view queries of a table (not record details). */
const isListQuery = (q: Query) => q.queryKey[2] !== 'detail';

export function applyRealtimeEvents(qc: QueryClient, events: readonly RealtimeEvent[]): void {
  const updates = new Map<string, Map<string, Change[]>>();
  const deletes = new Map<string, Set<string>>();
  const refetchLists = new Set<string>();
  const tables = new Set<string>();
  const commentCounts = new Set<string>();
  const revisions = new Set<string>();
  let views = false;
  let bases = false;
  let tableLists = false;
  /** Tables whose record trash changed. */
  const recordTrash = new Set<string>();
  /** Tables with any record or field change, for `onTableChanges`. */
  const changed = new Set<string>();

  for (const e of events) {
    const tableId = e.tableId ?? undefined;
    const p = e.payload;
    if (tableId && (e.kind.startsWith('record.') || e.kind.startsWith('field.'))) {
      changed.add(tableId);
    }
    if (e.kind.startsWith('record.') || e.kind === 'view.recordMoved') {
      const recordId = str(p['recordId']);
      // The record's history has a new revision, this tab's own writes included.
      if (tableId && recordId && e.kind.startsWith('record.')) {
        revisions.add(`${tableId}:${recordId}`);
      }
      if (tableId && (e.kind === 'record.deleted' || e.kind === 'record.restored')) {
        recordTrash.add(tableId);
      }
      if (!tableId || isOwnClientOp(e.clientOpId)) continue;
      if (e.kind === 'record.updated' && recordId) {
        const byRecord = updates.get(tableId) ?? new Map<string, Change[]>();
        updates.set(tableId, byRecord);
        const changes = byRecord.get(recordId) ?? [];
        byRecord.set(recordId, changes);
        changes.push({
          cells: cellsOf(p['cells']),
          version: typeof p['version'] === 'number' ? p['version'] : undefined,
          at: e.at,
          actorId: e.actorId,
        });
      } else if (e.kind === 'record.deleted' && recordId) {
        const ids = deletes.get(tableId) ?? new Set<string>();
        deletes.set(tableId, ids.add(recordId));
        refetchLists.add(tableId);
      } else {
        // created, restored, recordMoved
        refetchLists.add(tableId);
      }
      continue;
    }
    // An AI field's generation state: its status query refetches.
    if (e.kind === 'ai.status') {
      const fieldId = str(p['fieldId']);
      if (fieldId) void qc.invalidateQueries({ queryKey: queryKeys.aiFields.status(fieldId) });
      continue;
    }
    if (e.kind.startsWith('comment.')) {
      if (!tableId) continue;
      const parsed = CommentSchema.safeParse(p['comment']);
      if ((e.kind === 'comment.created' || e.kind === 'comment.updated') && parsed.success) {
        upsertComment(qc, parsed.data);
      }
      const recordId = str(p['recordId']);
      const commentId = str(p['commentId']);
      if (e.kind === 'comment.deleted' && recordId && commentId) {
        removeComment(qc, tableId, recordId, commentId);
      }
      if (e.kind !== 'comment.updated') commentCounts.add(tableId);
      continue;
    }
    if (e.kind.startsWith('field.')) {
      if (tableId) tables.add(tableId);
      views = true;
    } else if (e.kind.startsWith('view.') || e.kind.startsWith('viewSection.')) {
      views = true;
    } else if (e.kind.startsWith('table.')) {
      tableLists = true;
      if (tableId) tables.add(tableId);
      views = true;
    } else if (e.kind.startsWith('base.')) {
      bases = true;
    }
  }

  for (const [tableId, byRecord] of updates) {
    qc.setQueriesData<unknown>({ queryKey: queryKeys.records.table(tableId) }, (data: unknown) => {
      if (hasRecords(data)) {
        if (!data.records.some((r) => byRecord.has(r.id))) return data;
        return {
          ...data,
          records: data.records.map((r) => {
            const changes = byRecord.get(r.id);
            return changes ? merge(r, changes) : r;
          }),
        };
      }
      if (isRecord(data)) {
        const changes = byRecord.get(data.id);
        return changes ? merge(data, changes) : data;
      }
      return data;
    });
  }
  for (const [tableId, ids] of deletes) {
    qc.setQueriesData<unknown>({ queryKey: queryKeys.records.table(tableId) }, (data: unknown) =>
      hasRecords(data) && data.records.some((r) => ids.has(r.id))
        ? { ...data, records: data.records.filter((r) => !ids.has(r.id)) }
        : data
    );
  }
  for (const tableId of refetchLists) {
    if (tables.has(tableId)) continue;
    void qc.invalidateQueries({
      queryKey: queryKeys.records.table(tableId),
      predicate: isListQuery,
    });
  }
  // A field change can change every value of the table (a new column, a type conversion, a
  // formula): its table detail (where fields live), records and field trash refetch.
  for (const tableId of tables) {
    void qc.invalidateQueries({ queryKey: queryKeys.tables.detail(tableId) });
    void qc.invalidateQueries({ queryKey: queryKeys.records.table(tableId) });
    void qc.invalidateQueries({ queryKey: queryKeys.fields.trash(tableId) });
  }
  for (const key of revisions) {
    const [tableId = '', recordId = ''] = key.split(':');
    void qc.invalidateQueries({ queryKey: queryKeys.revisions.record(tableId, recordId) });
  }
  for (const tableId of commentCounts) {
    void qc.invalidateQueries({ queryKey: queryKeys.comments.counts(tableId) });
  }
  for (const tableId of recordTrash) {
    void qc.invalidateQueries({ queryKey: queryKeys.trash.records(tableId) });
  }
  if (tableLists) void qc.invalidateQueries({ queryKey: queryKeys.tables.all() });
  if (views) void qc.invalidateQueries({ queryKey: queryKeys.views.all() });
  if (bases) void qc.invalidateQueries({ queryKey: queryKeys.bases.all() });
  // Deleted and restored fields, views and tables come and go in the base trash.
  if (views || tableLists) void qc.invalidateQueries({ queryKey: ['trash', 'base'] });
  if (bases) void qc.invalidateQueries({ queryKey: ['trash', 'workspace'] });
  if (changed.size > 0) for (const listener of tableChangeListeners) listener(changed);
}

/**
 * The events of a base are lost (past retention, or the catch-up failed): refetch everything
 * that could come from it. Only queries on screen refetch.
 */
export function resyncCaches(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: queryKeys.bases.all() });
  void qc.invalidateQueries({ queryKey: queryKeys.tables.all() });
  void qc.invalidateQueries({ queryKey: queryKeys.views.all() });
  void qc.invalidateQueries({ queryKey: queryKeys.records.all() });
  void qc.invalidateQueries({ queryKey: queryKeys.comments.all() });
  void qc.invalidateQueries({ queryKey: queryKeys.revisions.all() });
  void qc.invalidateQueries({ queryKey: queryKeys.notifications.all() });
}
