import {
  type FieldMeta,
  MAX_SYNC_RECORDS,
  type SyncColumn,
  type SyncColumnType,
  type SyncPauseReason,
  type SyncPreview,
  type SyncRun,
  type SyncSchedule,
  type SyncSourceKind,
  syncTargetCompatible,
  type TableSync,
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
  too_many_records: `The sync is paused: the source has more than ${MAX_SYNC_RECORDS.toLocaleString('en')} records.`,
  write_access_lost:
    "The sync is paused: its creator can no longer edit or delete the source's records, which syncing both ways needs.",
};

/** The "Sync both ways" option: what it does, in one breath, for the builder and settings. */
export const TWO_WAY_HELP =
  "Edits to synced fields and deleted records here go back to the source, as the sync's creator. When both sides change the same field, the record updated last wins (the source on a tie); a record removed from the source or its view is removed here only. Fields copied as text, your own fields and the key stay one-way.";

/** Whether a source can sync both ways: a table or view of OpenRows only. */
export const canSyncBothWays = (kind: SyncSourceKind) => kind === 'table';

/** "Synced both ways with …" or "Synced from …" for one source. */
export function sourceLine(sync: Pick<TableSync, 'twoWay' | 'source'>): string {
  const label = sync.source.label || 'another table';
  return sync.twoWay ? `Synced both ways with ${label}` : `Synced from ${label}`;
}

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
  const back = run.writtenBack + run.removedFromSource;
  const changed = run.created + run.updated + run.deleted + back;
  if (changed === 0) return 'Up to date';
  const here = `${run.created} added, ${run.updated} updated, ${run.deleted} removed`;
  if (!back) return here;
  return `${here}; in the source: ${run.writtenBack} updated, ${run.removedFromSource} removed`;
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

/**
 * A table with several sources: one line for all of them. Paused ones are counted, a run in
 * progress says so, otherwise the latest sync of any source.
 */
export function sourcesStatusLine(sources: readonly TableSync[], now: Date = new Date()): string {
  if (sources.some((s) => isBusy(s))) return 'Syncing…';
  const paused = sources.filter((s) => s.status === 'paused').length;
  const failed = sources.filter(
    (s) =>
      s.status !== 'paused' &&
      s.runs.find((r) => r.status !== 'queued' && r.status !== 'running')?.status === 'failed'
  ).length;
  const latest = sources
    .map((s) => s.lastSyncedAt)
    .filter((at): at is string => at !== null)
    .sort()
    .at(-1);
  const parts = [
    ...(paused ? [`${paused} paused`] : []),
    ...(failed ? [`${failed} failed`] : []),
    latest ? `Last synced ${relativeTime(latest, now)}` : 'Not synced yet',
  ];
  return parts.join(' · ');
}

/** What a new source copies: a source field or a column, the type it has here, its name. */
export interface SourceCopy {
  /** The source field's id (a table source) or the column's name (an external one). */
  ref: string;
  name: string;
  type: string;
}

/** The synced table's fields a copy may fill: synced, not the engine's, of a fitting type. */
export function targetChoices(
  copy: Pick<SourceCopy, 'type'>,
  fields: readonly Pick<FieldMeta, 'id' | 'name' | 'type' | 'synced'>[]
): Pick<FieldMeta, 'id' | 'name' | 'type'>[] {
  return fields.filter(
    (f) => f.synced === true && f.type !== 'syncSource' && syncTargetCompatible(copy.type, f.type)
  );
}

/**
 * Where each copy goes by default: the first (the source's primary field, or first column) into
 * the table's primary field, the others into a synced field of the same name, when they fit and
 * aren't taken; else a new field (null).
 */
export function defaultTargets(
  copies: readonly SourceCopy[],
  fields: readonly Pick<FieldMeta, 'id' | 'name' | 'type' | 'synced' | 'isPrimary'>[]
): Record<string, string | null> {
  const taken = new Set<string>();
  const out: Record<string, string | null> = {};
  copies.forEach((copy, i) => {
    const choices = targetChoices(copy, fields).filter((f) => !taken.has(f.id));
    const pick =
      (i === 0 ? choices.find((f) => fields.find((x) => x.id === f.id)?.isPrimary) : undefined) ??
      choices.find((f) => f.name.trim().toLowerCase() === copy.name.trim().toLowerCase());
    if (pick) taken.add(pick.id);
    out[copy.ref] = pick?.id ?? null;
  });
  return out;
}
