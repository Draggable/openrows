import type {
  SyncColumn,
  SyncColumnType,
  SyncPauseReason,
  SyncPreview,
  SyncRun,
  SyncSchedule,
  SyncSourceKind,
  TableSync,
} from '@openrows/shared';

/**
 * Synced tables: the words the sync bar and the "Sync data" dialog use. The engine and its
 * rules are the server's (packages/server/src/syncs/).
 */

export const SCHEDULE_LABELS: Record<SyncSchedule, string> = {
  manual: 'Only when I click Sync now',
  '5m': 'Every 5 minutes',
  hourly: 'Every hour',
  daily: 'Every day',
};

export const PAUSE_LABELS: Record<SyncPauseReason, string> = {
  paused: 'The sync is paused.',
  access_lost: 'The sync is paused: its creator can no longer read the source or edit this table.',
  source_deleted: 'The sync is paused: the source table or view was deleted.',
  too_many_records: 'The sync is paused: the source has more than 10,000 records.',
};

/** Whether a run is waiting or going. */
export const isBusy = (sync: Pick<TableSync, 'runs'> | undefined) =>
  sync?.runs.some((r) => r.status === 'queued' || r.status === 'running') ?? false;

/** "2 min ago", "3 h ago", "Oct 4" for the last sync. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

/** One line for a finished run: "2 added, 1 updated, 0 removed". */
export function runSummary(run: SyncRun): string {
  if (run.status === 'failed') return run.error ?? 'The sync failed.';
  if (run.status === 'paused') return run.error ?? 'The sync paused.';
  if (run.status === 'queued') return 'Waiting to sync…';
  if (run.status === 'running') return 'Syncing…';
  const changed = run.created + run.updated + run.deleted;
  if (changed === 0) return 'Up to date';
  return `${run.created} added, ${run.updated} updated, ${run.deleted} removed`;
}

/** The sync's status line: syncing, paused, the last run's problem or when it last synced. */
export function statusLine(sync: TableSync, now: Date = new Date()): string {
  if (sync.status === 'paused') return PAUSE_LABELS[sync.pauseReason ?? 'paused'];
  if (isBusy(sync)) return 'Syncing…';
  const last = sync.runs.find((r) => r.status !== 'queued' && r.status !== 'running');
  if (last?.status === 'failed') return `Last sync failed: ${runSummary(last)}`;
  return sync.lastSyncedAt
    ? `Last synced ${relativeTime(sync.lastSyncedAt, now)}`
    : 'Not synced yet';
}

/** The "Sync data" dialog's sources. */
export const SOURCE_KIND_LABELS: Record<SyncSourceKind, string> = {
  table: 'A table in OpenRows',
  csv: 'A CSV file at a URL',
  postgres: 'A Postgres database',
  connector: 'A connected app',
};

/** One previewed column as the dialog edits it: synced or not, and its field type. */
export interface ColumnChoice {
  name: string;
  include: boolean;
  type: SyncColumnType;
  options: Record<string, unknown>;
}

export function columnChoices(preview: SyncPreview): ColumnChoice[] {
  return preview.columns.map((c) => ({ ...c, include: true }));
}

/**
 * The key a new sync suggests: a column named like an id (id, key, uuid, code), else the first
 * column; null (the row number) when there is none.
 */
export function suggestedKey(columns: readonly { name: string }[]): string | null {
  const idLike = columns.find((c) => /^(id|key|uuid|code|_id)$/i.test(c.name.trim()));
  return (idLike ?? columns[0])?.name ?? null;
}

/**
 * The create body's columns: the included ones, in order (the first becomes the table's primary
 * field). A key that isn't included falls back to the row number.
 */
export function columnsBody(
  choices: readonly ColumnChoice[],
  key: string | null
): { columns: SyncColumn[]; keyColumn: string | null } {
  const columns = choices
    .filter((c) => c.include)
    .map((c) => ({ name: c.name, type: c.type, options: c.options }));
  return { columns, keyColumn: key && columns.some((c) => c.name === key) ? key : null };
}
