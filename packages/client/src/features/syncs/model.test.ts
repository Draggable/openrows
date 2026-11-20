import type { FieldMeta, SyncRun, TableSync } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import {
  canSyncBothWays,
  columnChoices,
  columnsBody,
  defaultTargets,
  isBusy,
  PAUSE_LABELS,
  relativeTime,
  runSummary,
  sourceLine,
  sourcesStatusLine,
  statusLine,
  suggestedKey,
  targetChoices,
} from './model';

const run = (over: Partial<SyncRun> = {}): SyncRun => ({
  id: '01900000-0000-7000-8000-000000000001',
  trigger: 'manual',
  status: 'succeeded',
  created: 0,
  updated: 0,
  deleted: 0,
  unchanged: 3,
  skipped: 0,
  writtenBack: 0,
  removedFromSource: 0,
  error: null,
  createdAt: '2026-10-29T10:00:00.000Z',
  startedAt: '2026-10-29T10:00:00.000Z',
  finishedAt: '2026-10-29T10:00:01.000Z',
  ...over,
});

const sync = (over: Partial<TableSync> = {}): TableSync => ({
  id: '01900000-0000-7000-8000-000000000002',
  baseId: '01900000-0000-7000-8000-000000000003',
  tableId: '01900000-0000-7000-8000-000000000004',
  source: {
    kind: 'table',
    workspaceId: '01900000-0000-7000-8000-000000000005',
    baseId: '01900000-0000-7000-8000-000000000006',
    tableId: '01900000-0000-7000-8000-000000000007',
    viewId: null,
    label: 'CRM / Tasks',
    connector: null,
  },
  keyFieldId: null,
  keyColumn: null,
  fields: [],
  sourceFieldId: '01900000-0000-7000-8000-000000000008',
  ownerFieldId: null,
  ownsUnattributed: false,
  twoWay: false,
  writeBackFieldIds: [],
  schedule: 'hourly',
  status: 'active',
  pauseReason: null,
  createdBy: null,
  lastSyncedAt: '2026-10-29T10:00:00.000Z',
  nextRunAt: null,
  createdAt: '2026-10-29T09:00:00.000Z',
  runs: [run()],
  canManage: true,
  ...over,
});

const now = new Date('2026-10-29T10:05:00.000Z');

describe('sync model', () => {
  it('says when it last synced, or that it is syncing', () => {
    expect(statusLine(sync(), now)).toBe('Last synced 5 min ago');
    expect(statusLine(sync({ runs: [run({ status: 'queued' })] }), now)).toBe('Syncing…');
    expect(isBusy(sync({ runs: [run({ status: 'running' })] }))).toBe(true);
    expect(statusLine(sync({ lastSyncedAt: null, runs: [] }), now)).toBe('Not synced yet');
  });

  it('names why a sync paused and what a failed run said', () => {
    expect(statusLine(sync({ status: 'paused', pauseReason: 'source_deleted' }), now)).toContain(
      'source table or view was deleted'
    );
    expect(statusLine(sync({ runs: [run({ status: 'failed', error: 'No room.' })] }), now)).toBe(
      'Last sync failed: No room.'
    );
  });

  it('summarizes runs', () => {
    expect(runSummary(run())).toBe('Up to date');
    expect(runSummary(run({ created: 2, updated: 1 }))).toBe('2 added, 1 updated, 0 removed');
  });

  it('formats relative times', () => {
    expect(relativeTime('2026-10-29T10:04:50.000Z', now)).toBe('just now');
    expect(relativeTime('2026-10-29T07:05:00.000Z', now)).toBe('3 h ago');
  });
});

describe('external sources (#155)', () => {
  const preview = {
    label: 'example.com/people.csv',
    columns: [
      { name: 'Name', type: 'singleLineText' as const, options: {} },
      { name: 'ID', type: 'number' as const, options: { precision: 0 } },
      { name: 'Email', type: 'email' as const, options: {} },
    ],
    rows: [['Ada', '1', 'ada@example.com']],
  };

  it('suggests an id-like key column, else the first one', () => {
    expect(suggestedKey(preview.columns)).toBe('ID');
    expect(suggestedKey([{ name: 'Name' }, { name: 'Email' }])).toBe('Name');
    expect(suggestedKey([])).toBeNull();
  });

  it('sends the included columns in order and drops a key left out', () => {
    const choices = columnChoices(preview);
    expect(columnsBody(choices, 'ID')).toEqual({
      columns: [
        { name: 'Name', type: 'singleLineText', options: {} },
        { name: 'ID', type: 'number', options: { precision: 0 } },
        { name: 'Email', type: 'email', options: {} },
      ],
      keyColumn: 'ID',
    });
    const without = choices.map((c) => (c.name === 'ID' ? { ...c, include: false } : c));
    expect(columnsBody(without, 'ID')).toMatchObject({ keyColumn: null });
    expect(columnsBody(without, 'ID').columns.map((c) => c.name)).toEqual(['Name', 'Email']);
  });
});

describe('tables with several sources', () => {
  it('sums the sources up in one line', () => {
    const two = [sync(), sync({ lastSyncedAt: '2026-10-29T10:03:00.000Z' })];
    expect(sourcesStatusLine(two, now)).toBe('Last synced 2 min ago');
    expect(
      sourcesStatusLine([sync(), sync({ status: 'paused', pauseReason: 'too_many_records' })], now)
    ).toBe('1 paused · Last synced 5 min ago');
    expect(
      sourcesStatusLine([sync(), sync({ runs: [run({ status: 'failed', error: 'x' })] })], now)
    ).toBe('1 failed · Last synced 5 min ago');
    expect(sourcesStatusLine([sync(), sync({ runs: [run({ status: 'queued' })] })], now)).toBe(
      'Syncing…'
    );
    expect(sourcesStatusLine([sync({ lastSyncedAt: null })], now)).toBe('Not synced yet');
  });

  const fields: Pick<FieldMeta, 'id' | 'name' | 'type' | 'synced' | 'isPrimary'>[] = [
    { id: 'name', name: 'Name', type: 'singleLineText', synced: true, isPrimary: true },
    { id: 'points', name: 'Points', type: 'number', synced: true, isPrimary: false },
    { id: 'status', name: 'Status', type: 'singleSelect', synced: true, isPrimary: false },
    { id: 'mine', name: 'Remark', type: 'singleLineText', isPrimary: false },
    { id: 'key', name: 'Sync source', type: 'syncSource', synced: true, isPrimary: false },
  ];

  it('offers only synced fields of a fitting type', () => {
    expect(targetChoices({ type: 'number' }, fields).map((f) => f.id)).toEqual(['name', 'points']);
    expect(targetChoices({ type: 'singleSelect' }, fields).map((f) => f.id)).toEqual([
      'name',
      'status',
    ]);
  });

  it('maps the first into the primary and the others by name, else into new fields', () => {
    expect(
      defaultTargets(
        [
          { ref: 'a', name: 'Title', type: 'singleLineText' },
          { ref: 'b', name: 'points', type: 'number' },
          { ref: 'c', name: 'Status', type: 'date' },
          { ref: 'd', name: 'Name', type: 'singleLineText' },
        ],
        fields
      )
    ).toEqual({ a: 'name', b: 'points', c: null, d: null });
    // Any value fills a text primary (as its text); one that can't fill it gets a new field.
    expect(defaultTargets([{ ref: 'a', name: 'When', type: 'date' }], fields)).toEqual({
      a: 'name',
    });
    expect(
      defaultTargets(
        [{ ref: 'a', name: 'When', type: 'date' }],
        [{ id: 'n', name: 'N', type: 'number', synced: true, isPrimary: true }]
      )
    ).toEqual({ a: null });
  });
});

describe('two-way sources', () => {
  it('offers two-way for tables and views only', () => {
    expect(canSyncBothWays('table')).toBe(true);
    expect(canSyncBothWays('csv')).toBe(false);
    expect(canSyncBothWays('postgres')).toBe(false);
    expect(canSyncBothWays('connector')).toBe(false);
  });

  it('says which way a source syncs and what a run wrote back', () => {
    expect(sourceLine(sync())).toBe('Synced from CRM / Tasks');
    expect(sourceLine(sync({ twoWay: true }))).toBe('Synced both ways with CRM / Tasks');
    expect(runSummary(run({ updated: 1, writtenBack: 2, removedFromSource: 1 }))).toBe(
      '0 added, 1 updated, 0 removed; in the source: 2 updated, 1 removed'
    );
    expect(runSummary(run({ updated: 1 }))).toBe('0 added, 1 updated, 0 removed');
    expect(statusLine(sync({ status: 'paused', pauseReason: 'write_access_lost' }))).toBe(
      PAUSE_LABELS.write_access_lost
    );
  });
});
