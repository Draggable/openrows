import type { RealtimeEvent, RecordData } from '@openrows/shared';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { newClientOpId } from '../../api/clientOps';
import { queryKeys } from '../../api/keys';
import { applyRealtimeEvents, onTableChanges } from './apply';

const BASE = '0190a000-0000-7000-8000-00000000000b';
const TABLE = '0190a000-0000-7000-8000-00000000000a';
const R1 = '0190a000-0000-7000-8000-000000000001';
const R2 = '0190a000-0000-7000-8000-000000000002';

const record = (id: string, fields: Record<string, unknown>, version = 1): RecordData => ({
  id,
  tableId: TABLE,
  version,
  fields,
  createdAt: '2026-10-26T09:00:00.000Z',
  createdBy: null,
  updatedAt: '2026-10-26T09:00:00.000Z',
  updatedBy: null,
});

let seq = 100;
const event = (
  kind: string,
  payload: Record<string, unknown>,
  extra: Partial<RealtimeEvent> = {}
) =>
  ({
    seq: seq++,
    baseId: BASE,
    tableId: TABLE,
    kind,
    payload,
    actorId: '0190a000-0000-7000-8000-0000000000ee',
    clientOpId: null,
    at: '2026-10-26T10:00:00.000Z',
    ...extra,
  }) satisfies RealtimeEvent;

/** A query client holding a grid window, a kanban stack and a record detail of the table. */
function caches() {
  const qc = new QueryClient();
  const window = queryKeys.records.query(TABLE, { viewId: 'grid', offset: 0 });
  const stack = queryKeys.records.query(TABLE, { viewId: 'kanban', offset: 0 });
  const detail = queryKeys.records.detail(TABLE, R1);
  qc.setQueryData(window, {
    records: [record(R1, { name: 'A', n: 1 }), record(R2, { name: 'B' })],
    total: 2,
    offset: 0,
  });
  qc.setQueryData(stack, { records: [record(R1, { name: 'A', n: 1 })] });
  qc.setQueryData(detail, record(R1, { name: 'A', n: 1 }));
  const get = (key: readonly unknown[]) => qc.getQueryData<{ records: RecordData[] }>(key);
  return { qc, window, stack, detail, get };
}

describe('applyRealtimeEvents', () => {
  it('merges a remote cell change into every cache of the table by record id', () => {
    const c = caches();
    const untouched = c.get(c.window)?.records[1];
    applyRealtimeEvents(c.qc, [
      event('record.updated', { recordId: R1, version: 2, fieldIds: ['n'], cells: { n: 5 } }),
    ]);
    expect(c.get(c.window)?.records[0]?.fields).toEqual({ name: 'A', n: 5 });
    expect(c.get(c.window)?.records[0]?.version).toBe(2);
    expect(c.get(c.stack)?.records[0]?.fields).toEqual({ name: 'A', n: 5 });
    expect(c.qc.getQueryData<RecordData>(c.detail)?.fields).toEqual({ name: 'A', n: 5 });
    // The other record is the same object (no re-render for it).
    expect(c.get(c.window)?.records[1]).toBe(untouched);
  });

  it('applies several changes in order and skips those older than the cache', () => {
    const c = caches();
    c.qc.setQueryData(c.stack, { records: [record(R1, { name: 'Fresh', n: 9 }, 4)] });
    applyRealtimeEvents(c.qc, [
      event('record.updated', { recordId: R1, version: 2, cells: { name: 'X' } }),
      event('record.updated', { recordId: R1, version: 3, cells: { n: 7 } }),
      // A computed cell has no version: always applied.
      event('record.updated', { recordId: R1, cells: { total: 10 }, computed: true }),
    ]);
    expect(c.get(c.window)?.records[0]).toMatchObject({
      version: 3,
      fields: { name: 'X', n: 7, total: 10 },
    });
    // The stack already had version 4.
    expect(c.get(c.stack)?.records[0]).toMatchObject({
      version: 4,
      fields: { name: 'Fresh', n: 9, total: 10 },
    });
  });

  it('keeps a record that no longer matches the filter in place (no refetch)', () => {
    const c = caches();
    applyRealtimeEvents(c.qc, [
      event('record.updated', { recordId: R2, version: 2, cells: { name: 'Filtered out' } }),
    ]);
    expect(c.get(c.window)?.records.map((r) => r.id)).toEqual([R1, R2]);
    expect(c.qc.getQueryState(c.window)?.isInvalidated).toBe(false);
  });

  it('skips its own echoes by clientOpId', () => {
    const c = caches();
    const own = newClientOpId();
    applyRealtimeEvents(c.qc, [
      event('record.updated', { recordId: R1, version: 2, cells: { n: 99 } }, { clientOpId: own }),
      event('record.created', { recordId: R2 }, { clientOpId: own }),
    ]);
    expect(c.get(c.window)?.records[0]?.fields['n']).toBe(1);
    expect(c.qc.getQueryState(c.window)?.isInvalidated).toBe(false);
    // Another tab's id is applied.
    applyRealtimeEvents(c.qc, [
      event('record.updated', { recordId: R1, version: 2, cells: { n: 99 } }, { clientOpId: 'x' }),
    ]);
    expect(c.get(c.window)?.records[0]?.fields['n']).toBe(99);
  });

  it('removes a deleted record from the lists and refetches them; creates refetch too', () => {
    const c = caches();
    applyRealtimeEvents(c.qc, [event('record.deleted', { recordId: R1, version: 2 })]);
    expect(c.get(c.window)?.records.map((r) => r.id)).toEqual([R2]);
    expect(c.get(c.stack)?.records).toEqual([]);
    expect(c.qc.getQueryState(c.window)?.isInvalidated).toBe(true);
    // The record expand view keeps what it shows.
    expect(c.qc.getQueryState(c.detail)?.isInvalidated).toBe(false);

    const d = caches();
    applyRealtimeEvents(d.qc, [event('record.created', { recordId: R2, record: {} })]);
    expect(d.qc.getQueryState(d.window)?.isInvalidated).toBe(true);
    expect(d.qc.getQueryState(d.detail)?.isInvalidated).toBe(false);
  });

  it('invalidates schema queries on field, table, view and base events', () => {
    const qc = new QueryClient();
    const keys = [
      queryKeys.tables.detail(TABLE),
      queryKeys.tables.list(BASE),
      queryKeys.views.list(TABLE),
      queryKeys.bases.detail(BASE),
      queryKeys.records.query(TABLE, {}),
    ];
    for (const key of keys) qc.setQueryData(key, { x: 1 });
    const state = () => keys.map((k) => qc.getQueryState(k)?.isInvalidated);

    applyRealtimeEvents(qc, [event('view.updated', { personalTo: null })]);
    expect(state()).toEqual([false, false, true, false, false]);
    applyRealtimeEvents(qc, [event('field.created', { field: {} })]);
    expect(state()).toEqual([true, false, true, false, true]);
    applyRealtimeEvents(qc, [event('table.updated', { table: {} })]);
    expect(state()).toEqual([true, true, true, false, true]);
    applyRealtimeEvents(qc, [event('base.updated', { base: {} }, { tableId: null })]);
    expect(state()).toEqual([true, true, true, true, true]);
  });

  it("refreshes a record's history on its changes, this tab's own included (#94)", () => {
    const c = caches();
    const history = queryKeys.revisions.record(TABLE, R1);
    const other = queryKeys.revisions.record(TABLE, R2);
    c.qc.setQueryData(history, { pages: [], pageParams: [] });
    c.qc.setQueryData(other, { pages: [], pageParams: [] });
    applyRealtimeEvents(c.qc, [
      event(
        'record.updated',
        { recordId: R1, version: 2, cells: {} },
        { clientOpId: newClientOpId() }
      ),
    ]);
    expect(c.qc.getQueryState(history)?.isInvalidated).toBe(true);
    expect(c.qc.getQueryState(other)?.isInvalidated).toBe(false);
  });

  it('puts comments in their record list by id, and refreshes the counts (#92)', () => {
    const qc = new QueryClient();
    const key = queryKeys.comments.record(TABLE, R1);
    qc.setQueryData(key, { comments: [], previousCursor: null });
    qc.setQueryData(queryKeys.comments.counts(TABLE), { counts: {} });
    const comment = {
      id: '0190a000-0000-7000-8000-0000000000c1',
      tableId: TABLE,
      recordId: R1,
      authorId: null,
      body: 'Hi',
      mentions: [],
      reactions: [],
      createdAt: '2026-10-26T10:00:00.000Z',
      editedAt: null,
    };
    applyRealtimeEvents(qc, [event('comment.created', { recordId: R1, comment })]);
    // Idempotent: the same comment again (this tab's own echo) is still one comment.
    applyRealtimeEvents(qc, [event('comment.created', { recordId: R1, comment })]);
    expect(qc.getQueryData<{ comments: unknown[] }>(key)?.comments).toEqual([comment]);
    expect(qc.getQueryState(queryKeys.comments.counts(TABLE))?.isInvalidated).toBe(true);

    const edited = { ...comment, body: 'Hello', editedAt: '2026-10-26T10:01:00.000Z' };
    applyRealtimeEvents(qc, [event('comment.updated', { recordId: R1, comment: edited })]);
    expect(qc.getQueryData<{ comments: unknown[] }>(key)?.comments).toEqual([edited]);

    applyRealtimeEvents(qc, [event('comment.deleted', { recordId: R1, commentId: comment.id })]);
    expect(qc.getQueryData<{ comments: unknown[] }>(key)?.comments).toEqual([]);
  });
});

describe('table change listeners (#146)', () => {
  it('names the tables whose records or fields changed, own echoes included', () => {
    const qc = new QueryClient();
    const seen: string[][] = [];
    const stop = onTableChanges((ids) => seen.push([...ids]));
    applyRealtimeEvents(qc, [
      event('record.created', { recordId: 'r1' }, { clientOpId: newClientOpId() }),
      event('field.updated', { fieldId: 'f1' }, { tableId: 'other' }),
      event('view.updated', { viewId: 'v1' }, { tableId: 'third' }),
    ]);
    applyRealtimeEvents(qc, [event('view.updated', { viewId: 'v1' })]);
    stop();
    applyRealtimeEvents(qc, [event('record.deleted', { recordId: 'r1' })]);
    expect(seen).toEqual([[TABLE, 'other']]);
  });
});
