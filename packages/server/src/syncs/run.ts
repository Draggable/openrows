import {
  getFieldType,
  MAX_SYNC_RECORDS,
  QUERY_PAGE_MAX,
  queryRecordsSchema,
  roleAllows,
  type SyncPauseReason,
  type SyncSchedule,
  type UserRole,
} from '@openrows/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { effectiveRole } from '../authz/policy.js';
import { resolveResource } from '../authz/resolve.js';
import { setScope } from '../authz/scope.js';
import { type Database, type Transaction, tableSyncRuns, tableSyncs, tables } from '../db/index.js';
import { ossEntitlements } from '../edition/oss.js';
import type { EntitlementsProvider } from '../edition/types.js';
import { type FieldRow, liveFields } from '../fields/service.js';
import { withTenant } from '../jobs/tenant.js';
import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { allFieldsVisible, type FieldVisibility } from '../realtime/projection.js';
import {
  createRecords,
  deleteRecords,
  listRecords,
  queryRecords,
  type RecordContext,
  updateRecords,
} from '../records/service.js';
import {
  defOf,
  fieldMapOf,
  nextRunAt,
  pruneRuns,
  readSourceShape,
  type SyncRow,
  sourceAccess,
} from './service.js';
import {
  accessToken,
  NotConnected,
  openSecret,
  readConnector,
  readSource as readExternal,
  SourceError,
  type SyncSources,
  TooManyRows,
} from './sources/index.js';

/**
 * The sync engine: one run of a synced table, the worker's `syncs.run` job. The run is one
 * transaction. It re-checks the creator's access to the source and to this table (lost access or
 * a deleted source pauses the sync and writes nothing), reads the source's records (the view's
 * filter when it has one) in the source workspace's scope, then, back in this table's scope,
 * upserts by key and deletes what left the source, through the RecordService as the creator.
 * Cells are compared before writing, so a run over an unchanged source writes nothing: re-running
 * is idempotent.
 */

export const syncJobData = z.object({
  workspaceId: z.uuid(),
  syncId: z.uuid(),
  runId: z.uuid(),
});

export interface SyncRunDeps {
  db: Database;
  /** External sources; without them, CSV and Postgres syncs fail. */
  sources?: SyncSources | undefined;
  logger?: Pick<Logger, 'info' | 'error'>;
  entitlements?: EntitlementsProvider | undefined;
  visibility?: FieldVisibility;
}

/** Records one RecordService call writes. */
const WRITE_BATCH = 500;

interface Counts {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  skipped: number;
}

export type SyncRunOutcome =
  | { status: 'gone' }
  | { status: 'paused'; reason: SyncPauseReason }
  | ({ status: 'succeeded' } & Counts)
  | { status: 'failed'; error: string };

class Paused extends Error {
  constructor(readonly reason: SyncPauseReason) {
    super(reason);
  }
}

/** A value as the target compares it: blanks (null, empty, the type's empty value) are null. */
function normalized(value: unknown, empty: unknown): string {
  if (
    value === undefined ||
    value === null ||
    value === empty ||
    (Array.isArray(value) && value.length === 0)
  ) {
    return 'null';
  }
  return JSON.stringify(value);
}

/** What the target cell is fed for a source value: the same type's value or its text. */
function cellInput(source: FieldRow, target: FieldRow, value: unknown): unknown {
  const from = defOf(source);
  const options = from.optionsSchema.parse(source.config ?? {});
  if (value === undefined || value === null) return null;
  if (source.type !== target.type) return from.format(value, options) || null;
  // Choices by name: typecast adds the ones the synced field doesn't have yet.
  if (from.withChoices) return from.toPrimitive(value, options);
  return value;
}

/** A source key as text, or null when the record has none. */
function keyOf(def: ReturnType<typeof defOf>, field: FieldRow, value: unknown): string | null {
  const text = def.format(value ?? null, def.optionsSchema.parse(field.config ?? {}));
  return getFieldType('syncSource').coerce(text, {}) as string | null;
}

export async function runSyncJob(deps: SyncRunDeps, raw: unknown): Promise<SyncRunOutcome> {
  const data = syncJobData.parse(raw);
  const { db } = deps;
  const started = await withTenant(db, data.workspaceId, async (tx) => {
    const [run] = await tx
      .select()
      .from(tableSyncRuns)
      .where(and(eq(tableSyncRuns.id, data.runId), eq(tableSyncRuns.syncId, data.syncId)));
    if (!run || (run.status !== 'queued' && run.status !== 'running')) return null;
    await tx
      .update(tableSyncRuns)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(tableSyncRuns.id, run.id));
    return run;
  });
  if (!started) return { status: 'gone' };

  try {
    const outcome = await withTenant(db, data.workspaceId, (tx) => runInTx(deps, tx, data));
    await finish(db, data, {
      ...('created' in outcome ? outcome : {}),
      status: outcome.status === 'succeeded' ? 'succeeded' : 'failed',
      error:
        outcome.status === 'failed'
          ? outcome.error
          : outcome.status === 'gone'
            ? 'The synced table is gone.'
            : null,
    });
    return outcome;
  } catch (err) {
    if (err instanceof Paused) {
      await withTenant(db, data.workspaceId, (tx) =>
        tx
          .update(tableSyncs)
          .set({ status: 'paused', pauseReason: err.reason, updatedAt: new Date() })
          .where(eq(tableSyncs.id, data.syncId))
      );
      await finish(db, data, { status: 'paused', error: PAUSE_MESSAGES[err.reason] });
      deps.logger?.info({ syncId: data.syncId, reason: err.reason }, 'sync paused');
      return { status: 'paused', reason: err.reason };
    }
    const error =
      err instanceof SourceError
        ? err.message
        : err instanceof AppError && err.status < 500
          ? (err.detail ?? 'The sync failed.')
          : 'The sync failed.';
    if (!(err instanceof AppError) && !(err instanceof SourceError))
      deps.logger?.error({ err, syncId: data.syncId }, 'sync failed');
    await finish(db, data, { status: 'failed', error });
    return { status: 'failed', error };
  }
}

export const PAUSE_MESSAGES: Record<SyncPauseReason, string> = {
  paused: 'The sync was paused.',
  access_lost:
    "The sync's creator can no longer read the source (or their connected account is gone), or edit this table.",
  source_deleted: 'The source table or view was deleted.',
  too_many_records: `The source has more than ${MAX_SYNC_RECORDS.toLocaleString('en')} records.`,
};

async function finish(
  db: Database,
  data: z.infer<typeof syncJobData>,
  result: Partial<Counts> & { status: string; error: string | null }
) {
  await withTenant(db, data.workspaceId, async (tx) => {
    await tx
      .update(tableSyncRuns)
      .set({
        status: result.status,
        created: result.created ?? 0,
        updated: result.updated ?? 0,
        deleted: result.deleted ?? 0,
        unchanged: result.unchanged ?? 0,
        skipped: result.skipped ?? 0,
        error: result.error,
        finishedAt: new Date(),
      })
      .where(eq(tableSyncRuns.id, data.runId));
    await pruneRuns(tx, data.syncId);
  });
}

async function runInTx(
  deps: SyncRunDeps,
  tx: Transaction,
  data: z.infer<typeof syncJobData>
): Promise<SyncRunOutcome> {
  const [sync] = await tx
    .select()
    .from(tableSyncs)
    .where(eq(tableSyncs.id, data.syncId))
    .for('update');
  if (!sync) return { status: 'gone' };
  if (sync.status === 'paused') throw new Paused((sync.pauseReason as SyncPauseReason) ?? 'paused');
  const [table] = await tx.select().from(tables).where(eq(tables.id, sync.tableId));
  if (!table || table.deletedAt) return { status: 'gone' };

  // Access, re-checked every run: the creator must still edit this table (and read the
  // source, for a table source).
  const userId = sync.createdBy;
  const role = userId ? await targetRole(tx, table.id, userId) : null;
  if (!userId || !role) throw new Paused('access_lost');

  const targetFields = new Map((await liveFields(tx, table.id)).map((f) => [f.id, f]));
  const keyField = targetFields.get(sync.sourceFieldId);
  if (!keyField) return { status: 'failed', error: 'The "Sync source" field is gone.' };
  const desired =
    sync.sourceKind === 'table'
      ? await desiredFromTable(deps, tx, sync, userId, targetFields)
      : await desiredFromExternal(deps, tx, sync, userId, targetFields);
  const { wanted, skipped } = desired;

  const ctx: RecordContext = {
    tx,
    workspaceId: sync.workspaceId,
    userId,
    table,
    role,
    typecast: true,
    mayAddChoices: roleAllows(role, 'field:update'),
    unmatchedLinks: 'skip',
    entitlements: await (deps.entitlements ?? ossEntitlements).forWorkspace(sync.workspaceId, tx),
    sync: { syncId: sync.id },
  };

  // The table's synced records by key.
  const existing = new Map<string, { id: string; fields: Record<string, unknown> }>();
  for (let cursor: string | undefined; ; ) {
    const page = await listRecords(ctx, { limit: QUERY_PAGE_MAX, ...(cursor ? { cursor } : {}) });
    for (const r of page.records) {
      const key = r.fields[keyField.id];
      if (typeof key === 'string') existing.set(key, { id: r.id, fields: r.fields });
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  const counts: Counts = { created: 0, updated: 0, deleted: 0, unchanged: 0, skipped };
  const now = new Date();
  if (wanted === null) {
    // Not modified since the last good run (a CSV's 304): nothing to write.
    counts.unchanged = existing.size;
    await tx
      .update(tableSyncs)
      .set({
        lastSyncedAt: now,
        nextRunAt: nextRunAt(sync.schedule as SyncSchedule, now),
        updatedAt: now,
      })
      .where(eq(tableSyncs.id, sync.id));
    deps.logger?.info({ syncId: sync.id, ...counts }, 'sync run done (not modified)');
    return { status: 'succeeded', ...counts };
  }
  const creates: Record<string, unknown>[] = [];
  const patches: { id: string; fields: Record<string, unknown> }[] = [];
  for (const [key, cells] of wanted) {
    const current = existing.get(key);
    if (!current) {
      creates.push({ ...cells, [keyField.id]: key });
      continue;
    }
    const changed: Record<string, unknown> = {};
    for (const [fieldId, input] of Object.entries(cells)) {
      const field = targetFields.get(fieldId);
      if (!field) continue;
      const def = defOf(field);
      const options = def.optionsSchema.parse(field.config ?? {});
      const next = input === null ? null : def.coerce(input, options);
      // Unknown choice names coerce to nothing until typecast adds them: always a change.
      const pendingChoices = def.unknownChoices?.(input, options).length ?? 0;
      if (
        pendingChoices > 0 ||
        normalized(next, def.emptyValue) !== normalized(current.fields[fieldId], def.emptyValue)
      ) {
        changed[fieldId] = input;
      }
    }
    if (Object.keys(changed).length) patches.push({ id: current.id, fields: changed });
    else counts.unchanged++;
  }
  const gone = [...existing].filter(([key]) => !wanted.has(key)).map(([, r]) => r.id);

  for (let i = 0; i < creates.length; i += WRITE_BATCH) {
    counts.created += (await createRecords(ctx, creates.slice(i, i + WRITE_BATCH))).length;
  }
  for (let i = 0; i < patches.length; i += WRITE_BATCH) {
    counts.updated += (await updateRecords(ctx, patches.slice(i, i + WRITE_BATCH))).length;
  }
  for (let i = 0; i < gone.length; i += WRITE_BATCH) {
    const ids = gone.slice(i, i + WRITE_BATCH);
    await deleteRecords(ctx, ids);
    counts.deleted += ids.length;
  }

  await tx
    .update(tableSyncs)
    .set({
      ...(desired.label !== undefined ? { sourceLabel: desired.label } : {}),
      ...(desired.state !== undefined ? { sourceState: desired.state } : {}),
      lastSyncedAt: now,
      nextRunAt: nextRunAt(sync.schedule as SyncSchedule, now),
      updatedAt: now,
    })
    .where(eq(tableSyncs.id, sync.id));
  deps.logger?.info({ syncId: sync.id, ...counts }, 'sync run done');
  return { status: 'succeeded', ...counts };
}

/** What the table should hold: cells by key (null: unchanged since the last run). */
interface Desired {
  wanted: Map<string, Record<string, unknown>> | null;
  skipped: number;
  /** The source's label now (a table source's names). */
  label?: string;
  /** What the next run's conditional read sends. */
  state?: Record<string, string>;
}

/** A table source: its records as the creator, mapped field by field. */
async function desiredFromTable(
  deps: SyncRunDeps,
  tx: Transaction,
  sync: SyncRow,
  userId: string,
  targetFields: Map<string, FieldRow>
): Promise<Desired> {
  if (!sync.sourceTableId || !sync.sourceWorkspaceId) throw new Paused('source_deleted');
  const access = await sourceAccess(tx, userId, {
    tableId: sync.sourceTableId,
    viewId: sync.sourceViewId,
  });
  if (!access.ok) throw new Paused(access.reason);
  if (access.workspaceId !== sync.sourceWorkspaceId) throw new Paused('source_deleted');
  const source = await readTableSource(deps, tx, sync, userId, access.role);

  const map = fieldMapOf(sync).flatMap((m) => {
    const from = m.sourceFieldId ? source.fields.get(m.sourceFieldId) : undefined;
    const to = targetFields.get(m.fieldId);
    return to ? [{ from, to }] : [];
  });
  const wanted = new Map<string, Record<string, unknown>>();
  let skipped = 0;
  for (const record of source.records) {
    const key = record.key;
    if (key === null || wanted.has(key)) {
      skipped++;
      continue;
    }
    const cells: Record<string, unknown> = {};
    for (const { from, to } of map) {
      // A field the creator can no longer read (or that left the source) syncs empty.
      cells[to.id] = from ? cellInput(from, to, record.fields[from.id]) : null;
    }
    wanted.set(key, cells);
  }
  return { wanted, skipped, label: source.label };
}

/**
 * A CSV URL or Postgres source: its rows, columns mapped to fields by name, keyed by the
 * key column's text or the row number. Fails (a failed run, records kept) when the source can't
 * be read, its key column is gone or none of the synced columns are left; pauses past
 * MAX_SYNC_RECORDS.
 */
async function desiredFromExternal(
  deps: SyncRunDeps,
  tx: Transaction,
  sync: SyncRow,
  userId: string,
  targetFields: Map<string, FieldRow>
): Promise<Desired> {
  const sources = deps.sources;
  if (!sources) throw new SourceError('This source is not available here.');
  let read: Awaited<ReturnType<typeof readExternal>> & { label?: string };
  try {
    if (sync.sourceKind === 'connector') {
      // read with the creator's own account (their user scope for its row); no account,
      // or a revoked one, pauses the sync like lost access.
      await setScope(tx, { userId, workspaceId: sync.workspaceId });
      read = await readConnector(sources, sync.sourceConfig, (connector) =>
        accessToken(tx, sources.connectors, connector, userId)
      );
    } else {
      read = await readExternal(
        sources,
        sync.sourceKind,
        openSecret(sources, sync.sourceSecret),
        sync.sourceConfig,
        sync.sourceState
      );
    }
  } catch (err) {
    if (err instanceof TooManyRows) throw new Paused('too_many_records');
    if (err instanceof NotConnected) throw new Paused('access_lost');
    throw err;
  }
  if (read.notModified) return { wanted: null, skipped: 0 };
  const index = new Map(read.columns.map((name, i) => [name, i]));
  const map = fieldMapOf(sync).flatMap((m) => {
    const to = targetFields.get(m.fieldId);
    return to && m.column !== undefined ? [{ at: index.get(m.column), to }] : [];
  });
  if (map.length > 0 && map.every((m) => m.at === undefined)) {
    throw new SourceError("None of the sync's columns are in the source any more.");
  }
  const keyAt = sync.keyColumn === null ? null : index.get(sync.keyColumn);
  if (keyAt === undefined) {
    throw new SourceError(`The key column "${sync.keyColumn}" is gone from the source.`);
  }
  const keyType = getFieldType('syncSource');
  const wanted = new Map<string, Record<string, unknown>>();
  let skipped = 0;
  for (const [n, row] of read.rows.entries()) {
    const key = keyType.coerce(keyAt === null ? String(n + 1) : row[keyAt], {}) as string | null;
    if (key === null || wanted.has(key)) {
      skipped++;
      continue;
    }
    const cells: Record<string, unknown> = {};
    // A column that left the source syncs empty.
    for (const { at, to } of map) cells[to.id] = at === undefined ? null : (row[at] ?? null);
    wanted.set(key, cells);
  }
  return {
    wanted,
    skipped,
    state: read.state,
    ...(read.label !== undefined ? { label: read.label } : {}),
  };
}

/** The creator's live role on the synced table, when it lets them write records (editor+). */
async function targetRole(tx: Transaction, tableId: string, userId: string) {
  const resolved = await resolveResource(tx, 'table', tableId, userId);
  const role = resolved && !resolved.suspended ? effectiveRole(resolved) : null;
  return role && roleAllows(role, 'record:create') ? role : null;
}

interface SourceRecords {
  label: string;
  /** The source's live fields the creator may read, by id. */
  fields: Map<string, FieldRow>;
  records: { key: string | null; fields: Record<string, unknown> }[];
}

/**
 * The source's records (the view's, when the sync has one) in the source workspace's scope, as
 * the creator: personal views are their own, hidden fields left out. Pauses the sync past
 * MAX_SYNC_RECORDS. Puts the transaction back in the synced table's scope.
 */
async function readTableSource(
  deps: SyncRunDeps,
  tx: Transaction,
  sync: SyncRow,
  userId: string,
  role: UserRole
): Promise<SourceRecords> {
  const scopes = {
    userId,
    sourceWorkspaceId: sync.sourceWorkspaceId ?? sync.workspaceId,
    homeWorkspaceId: sync.workspaceId,
  };
  if (!sync.sourceTableId || !sync.sourceWorkspaceId) throw new Paused('source_deleted');
  const sourceWorkspaceId = sync.sourceWorkspaceId;
  const shape = await readSourceShape(tx, scopes, {
    tableId: sync.sourceTableId,
    viewId: sync.sourceViewId,
  });
  if (!shape) throw new Paused('source_deleted');
  const hidden = (deps.visibility ?? allFieldsVisible).hiddenFields(
    { userId, role },
    shape.table.id
  );
  const readable = new Map(shape.fields.filter((f) => !hidden.has(f.id)).map((f) => [f.id, f]));
  const keyField = sync.keyFieldId ? readable.get(sync.keyFieldId) : undefined;
  if (sync.keyFieldId && !keyField) throw new Paused('source_deleted');
  const keyDef = keyField ? defOf(keyField) : null;

  await setScope(tx, { userId, workspaceId: sourceWorkspaceId });
  try {
    const read = { tx, workspaceId: sourceWorkspaceId, userId, table: shape.table };
    const records: SourceRecords['records'] = [];
    for (let cursor: string | undefined; ; ) {
      const page = await queryRecords(
        read,
        queryRecordsSchema.parse({
          ...(sync.sourceViewId ? { viewId: sync.sourceViewId } : {}),
          limit: QUERY_PAGE_MAX,
          count: false,
          ...(cursor ? { cursor } : {}),
        })
      );
      for (const r of page.records) {
        const fields: Record<string, unknown> = {};
        for (const id of readable.keys()) fields[id] = r.fields[id] ?? null;
        const key = keyField && keyDef ? keyOf(keyDef, keyField, r.fields[keyField.id]) : r.id;
        records.push({ key, fields });
      }
      if (records.length > MAX_SYNC_RECORDS) throw new Paused('too_many_records');
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return { label: shape.label, fields: readable, records };
  } finally {
    await setScope(tx, { userId, workspaceId: sync.workspaceId });
  }
}
