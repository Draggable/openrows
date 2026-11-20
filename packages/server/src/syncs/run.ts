import { createHash } from 'node:crypto';
import {
  type FieldTypeDef,
  getFieldType,
  MAX_SYNC_RECORDS,
  QUERY_PAGE_MAX,
  queryRecordsSchema,
  type RecordData,
  roleAllows,
  type SyncPauseReason,
  type SyncSchedule,
} from '@openrows/shared';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { effectiveRole } from '../authz/policy.js';
import { resolveResource } from '../authz/resolve.js';
import { inScope, setScope } from '../authz/scope.js';
import { type Database, type Transaction, tableSyncRuns, tableSyncs, tables } from '../db/index.js';
import { ossEntitlements } from '../edition/oss.js';
import type { EntitlementsProvider } from '../edition/types.js';
import { type FieldRow, liveFields, type TableRow } from '../fields/service.js';
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
  readLiveRecords,
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
  type StreamedRead,
  type SyncSources,
  TooManyRows,
} from './sources/index.js';

/**
 * The sync engine: one run of a synced table, the worker's `syncs.run` job.
 *
 * A run holds one transaction for its whole length (REPEATABLE READ: the source is read from one
 * snapshot) with an advisory lock on the sync, so two runs of a sync never overlap. It re-checks
 * the creator's access to the source and to this table (lost access or a deleted source pauses
 * the sync and writes nothing), then reads the source as the creator: a table or view in its
 * workspace's scope, counted first and then a page at a time; an external source into a
 * temporary table of that transaction as it downloads. A source past the cap pauses the sync
 * before anything is written.
 *
 * Writes go through the RecordService as the creator, one transaction per batch of source
 * records, with the creator's access to this table checked again in each. A batch is compared
 * with the synced records of the same keys (a fingerprint of their synced cells, read once at the
 * start; the cells themselves only where the fingerprints differ), and only what differs is
 * created or updated: a run over an unchanged source writes nothing, so re-running is idempotent.
 * Records whose key left the source are deleted last, all in one transaction with the run's end,
 * once the whole source was read: a run that fails midway deletes nothing, and the next one
 * converges.
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
  /** Source records one run copies at most (MAX_SYNC_RECORDS). */
  maxRecords?: number;
  /** Source records per write transaction (WRITE_BATCH). */
  batchSize?: number;
}

/** Source records one write transaction (and one RecordService call) takes. */
const WRITE_BATCH = 500;

/** A run deferred because another attempt of it holds the sync waits this long (seconds). */
export const SYNC_BUSY_RETRY_SECONDS = 60;

interface Counts {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  skipped: number;
}

export type SyncRunOutcome =
  | { status: 'gone' }
  /** Another run of this sync holds it: this one should be tried again later. */
  | { status: 'busy' }
  | { status: 'paused'; reason: SyncPauseReason }
  | ({ status: 'succeeded' } & Counts)
  | { status: 'failed'; error: string };

class Paused extends Error {
  constructor(readonly reason: SyncPauseReason) {
    super(reason);
  }
}

/** The synced table, or its sync, went away during the run. */
class Gone extends Error {}

/** Another run of the sync holds its lock. */
class Busy extends Error {}

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

/** A field with its registry definition and options, parsed once per run. */
interface TypedField {
  row: FieldRow;
  def: FieldTypeDef;
  options: unknown;
}

function typed(row: FieldRow): TypedField {
  const def = defOf(row) as FieldTypeDef;
  return { row, def, options: def.optionsSchema.parse(row.config ?? {}) };
}

/** What the target cell is fed for a source value: the same type's value or its text. */
function cellInput(source: TypedField, target: FieldRow, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (source.row.type !== target.type) return source.def.format(value, source.options) || null;
  // Choices by name: typecast adds the ones the synced field doesn't have yet.
  if (source.def.withChoices) return source.def.toPrimitive(value, source.options);
  return value;
}

/** A source key as text, or null when the record has none. */
function keyOf(key: TypedField, value: unknown): string | null {
  const text = key.def.format(value ?? null, key.options);
  return getFieldType('syncSource').coerce(text, {}) as string | null;
}

/** A source record as the synced table should hold it: its key and cells by target field. */
interface Wanted {
  key: string | null;
  cells: Record<string, unknown>;
}

/** A source being read: its records a page at a time, or unchanged since the last good run. */
type SourceRead =
  | {
      notModified: false;
      pages: AsyncIterable<Wanted[]>;
      /** The source's label now (a table's or a connector's names). */
      label?: string | undefined;
      /** What the next run's conditional read sends. */
      state?: Record<string, string> | undefined;
    }
  | { notModified: true };

/** What a run works from: the sync, its table and fields, and who it runs as. */
interface Setup {
  sync: SyncRow;
  table: TableRow;
  userId: string;
  targetFields: Map<string, FieldRow>;
  keyField: FieldRow;
  /** The synced fields, compared between the source and the table. */
  compared: TypedField[];
}

export async function runSyncJob(deps: SyncRunDeps, raw: unknown): Promise<SyncRunOutcome> {
  const data = syncJobData.parse(raw);
  try {
    return await deps.db.transaction(
      async (hold) => {
        await setScope(hold, { userId: '', workspaceId: data.workspaceId });
        const { rows } = await hold.execute<{ locked: boolean }>(
          sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`syncs:run:${data.syncId}`}, 0)) AS locked`
        );
        if (!rows[0]?.locked) throw new Busy();
        return runHeld(deps, hold, data);
      },
      { isolationLevel: 'repeatable read' }
    );
  } catch (err) {
    if (err instanceof Busy) return { status: 'busy' };
    throw err;
  }
}

/** The run, under its lock: marks it running, runs it and records how it ended. */
async function runHeld(
  deps: SyncRunDeps,
  hold: Transaction,
  data: z.infer<typeof syncJobData>
): Promise<SyncRunOutcome> {
  const { db } = deps;
  const started = await withTenant(db, data.workspaceId, async (tx) => {
    const [run] = await tx.select().from(tableSyncRuns).where(eq(tableSyncRuns.id, data.runId));
    if (!run || run.syncId !== data.syncId) return null;
    if (run.status !== 'queued' && run.status !== 'running') return null;
    await tx
      .update(tableSyncRuns)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(tableSyncRuns.id, run.id));
    return run;
  });
  if (!started) return { status: 'gone' };

  try {
    const outcome = await runSync(deps, hold, data);
    await finish(db, data, {
      ...('created' in outcome ? outcome : {}),
      status: outcome.status === 'succeeded' ? 'succeeded' : 'failed',
      error:
        outcome.status === 'failed'
          ? outcome.error
          : outcome.status === 'gone'
            ? GONE_MESSAGE
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
    if (err instanceof Gone) {
      await finish(db, data, { status: 'failed', error: GONE_MESSAGE });
      return { status: 'gone' };
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

const GONE_MESSAGE = 'The synced table is gone.';

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

async function runSync(
  deps: SyncRunDeps,
  hold: Transaction,
  data: z.infer<typeof syncJobData>
): Promise<SyncRunOutcome> {
  const { db } = deps;
  const maxRecords = deps.maxRecords ?? MAX_SYNC_RECORDS;
  const batchSize = Math.max(1, Math.min(deps.batchSize ?? WRITE_BATCH, WRITE_BATCH));
  const setup = await withTenant(db, data.workspaceId, (tx) => setUpRun(tx, data.syncId));
  if (setup === null) return { status: 'gone' };
  if ('error' in setup) return { status: 'failed', error: setup.error };
  const { sync } = setup;

  const source =
    sync.sourceKind === 'table'
      ? await tableSource(deps, hold, setup, maxRecords)
      : await externalSource(deps, hold, setup, { maxRecords, batchSize });

  const counts: Counts = { created: 0, updated: 0, deleted: 0, unchanged: 0, skipped: 0 };
  if (source.notModified) {
    // Not modified since the last good run (a CSV's 304): nothing to write.
    counts.unchanged = await countRecords(db, setup);
    await endRun(deps, setup, { gone: [], counts, batchSize });
    deps.logger?.info({ syncId: sync.id, ...counts }, 'sync run done (not modified)');
    return { status: 'succeeded', ...counts };
  }

  const existing = await syncedRecords(db, setup);
  const seen = new Set<string>();
  const writes = { stateCleared: false };
  let batch: { key: string; cells: Record<string, unknown> }[] = [];
  for await (const page of source.pages) {
    for (const record of page) {
      const key = record.key;
      if (key === null || seen.has(key)) {
        counts.skipped++;
        continue;
      }
      seen.add(key);
      batch.push({ key, cells: record.cells });
      if (batch.length >= batchSize) {
        await writeBatch(deps, setup, existing, batch, counts, writes);
        batch = [];
      }
    }
  }
  if (batch.length) await writeBatch(deps, setup, existing, batch, counts, writes);

  // The whole source was read: what left it goes, in one transaction with the run's end.
  const gone: string[] = [];
  for (const [key, record] of existing) if (!seen.has(key)) gone.push(record.id);
  await endRun(deps, setup, {
    gone,
    counts,
    batchSize,
    label: source.label,
    state: source.state,
  });
  deps.logger?.info({ syncId: sync.id, ...counts }, 'sync run done');
  return { status: 'succeeded', ...counts };
}

/** The sync, its table and the creator's live access to it, as the run starts. */
async function setUpRun(
  tx: Transaction,
  syncId: string
): Promise<Setup | { error: string } | null> {
  const [sync] = await tx.select().from(tableSyncs).where(eq(tableSyncs.id, syncId));
  if (!sync) return null;
  if (sync.status === 'paused') throw new Paused((sync.pauseReason as SyncPauseReason) ?? 'paused');
  const [table] = await tx.select().from(tables).where(eq(tables.id, sync.tableId));
  if (!table || table.deletedAt) return null;

  // Access, re-checked every run: the creator must still edit this table (and read the
  // source, for a table source).
  const userId = sync.createdBy;
  const role = userId ? await targetRole(tx, table.id, userId) : null;
  if (!userId || !role) throw new Paused('access_lost');

  const targetFields = new Map((await liveFields(tx, table.id)).map((f) => [f.id, f]));
  const keyField = targetFields.get(sync.sourceFieldId);
  if (!keyField) return { error: 'The "Sync source" field is gone.' };
  const compared = new Map<string, TypedField>();
  for (const m of fieldMapOf(sync)) {
    const field = targetFields.get(m.fieldId);
    if (field && !compared.has(field.id)) compared.set(field.id, typed(field));
  }
  return { sync, table, userId, targetFields, keyField, compared: [...compared.values()] };
}

/** The creator's live role on the synced table, when it lets them write records (editor+). */
async function targetRole(tx: Transaction, tableId: string, userId: string) {
  const resolved = await resolveResource(tx, 'table', tableId, userId);
  const role = resolved && !resolved.suspended ? effectiveRole(resolved) : null;
  return role && roleAllows(role, 'record:create') ? role : null;
}

/**
 * A write transaction's RecordService context, after checking again that the sync is still
 * there and active and that its creator may still write this table (their live role).
 */
async function writeContext(
  deps: SyncRunDeps,
  tx: Transaction,
  setup: Setup
): Promise<{ ctx: RecordContext; sync: SyncRow }> {
  const [sync] = await tx
    .select()
    .from(tableSyncs)
    .where(eq(tableSyncs.id, setup.sync.id))
    // Held to the transaction's end: a pause or removal waits for the batch, and this
    // transaction's own update of the row needs no stronger lock.
    .for('no key update');
  if (!sync) throw new Gone();
  if (sync.status === 'paused') throw new Paused((sync.pauseReason as SyncPauseReason) ?? 'paused');
  const [table] = await tx.select().from(tables).where(eq(tables.id, setup.table.id));
  if (!table || table.deletedAt) throw new Gone();
  const role = await targetRole(tx, table.id, setup.userId);
  if (!role) throw new Paused('access_lost');
  const ctx: RecordContext = {
    tx,
    workspaceId: sync.workspaceId,
    userId: setup.userId,
    table,
    role,
    typecast: true,
    mayAddChoices: roleAllows(role, 'field:update'),
    unmatchedLinks: 'skip',
    entitlements: await (deps.entitlements ?? ossEntitlements).forWorkspace(sync.workspaceId, tx),
    sync: { syncId: sync.id },
  };
  return { ctx, sync };
}

/** A fingerprint of a synced record's compared cells, as the table holds them. */
function heldPrint(compared: TypedField[], fields: Record<string, unknown>): string {
  const hash = createHash('sha1');
  for (const f of compared)
    hash.update(normalized(fields[f.row.id], f.def.emptyValue)).update('\0');
  return hash.digest('base64');
}

/**
 * The fingerprint the record would have with these source cells, and whether a cell names a
 * choice the field doesn't have yet (always a change: typecast adds it).
 */
function wantedPrint(
  compared: TypedField[],
  cells: Record<string, unknown>
): { print: string; pending: boolean } {
  const hash = createHash('sha1');
  let pending = false;
  for (const f of compared) {
    const input = cells[f.row.id] ?? null;
    const next = input === null ? null : f.def.coerce(input, f.options);
    if ((f.def.unknownChoices?.(input, f.options).length ?? 0) > 0) pending = true;
    hash.update(normalized(next, f.def.emptyValue)).update('\0');
  }
  return { print: hash.digest('base64'), pending };
}

/** The cells of `cells` that differ from the record's `current` ones. */
function changedCells(
  compared: Map<string, TypedField>,
  cells: Record<string, unknown>,
  current: Record<string, unknown>
): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const [fieldId, input] of Object.entries(cells)) {
    const f = compared.get(fieldId);
    if (!f) continue;
    const next = input === null ? null : f.def.coerce(input, f.options);
    // Unknown choice names coerce to nothing until typecast adds them: always a change.
    const pendingChoices = f.def.unknownChoices?.(input, f.options).length ?? 0;
    if (
      pendingChoices > 0 ||
      normalized(next, f.def.emptyValue) !== normalized(current[fieldId], f.def.emptyValue)
    ) {
      changed[fieldId] = input;
    }
  }
  return changed;
}

/** A synced record of the table: its id and the fingerprint of its compared cells. */
type Held = Map<string, { id: string; print: string }>;

/** The table's synced records by key, read a page at a time (ids and fingerprints only). */
async function syncedRecords(db: Database, setup: Setup): Promise<Held> {
  return withTenant(db, setup.sync.workspaceId, async (tx) => {
    const read = {
      tx,
      workspaceId: setup.sync.workspaceId,
      userId: setup.userId,
      table: setup.table,
    };
    const held: Held = new Map();
    for (let cursor: string | undefined; ; ) {
      const page = await listRecords(read, {
        limit: QUERY_PAGE_MAX,
        ...(cursor ? { cursor } : {}),
      });
      for (const r of page.records) {
        const key = r.fields[setup.keyField.id];
        if (typeof key === 'string') {
          held.set(key, { id: r.id, print: heldPrint(setup.compared, r.fields) });
        }
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return held;
  });
}

/** The table's live records (an unchanged source's "unchanged" count). */
async function countRecords(db: Database, setup: Setup): Promise<number> {
  return withTenant(db, setup.sync.workspaceId, async (tx) => {
    const page = await queryRecords(
      { tx, workspaceId: setup.sync.workspaceId, userId: setup.userId, table: setup.table },
      queryRecordsSchema.parse({ limit: 1, count: true })
    );
    return page.total ?? 0;
  });
}

/**
 * One batch of source records (unique keys) in one transaction: new keys created, records
 * whose cells differ updated (only those cells), the rest counted unchanged.
 */
async function writeBatch(
  deps: SyncRunDeps,
  setup: Setup,
  existing: Held,
  batch: { key: string; cells: Record<string, unknown> }[],
  counts: Counts,
  writes: { stateCleared: boolean }
): Promise<void> {
  const keyFieldId = setup.keyField.id;
  await withTenant(deps.db, setup.sync.workspaceId, async (tx) => {
    const { ctx } = await writeContext(deps, tx, setup);
    const creates: Record<string, unknown>[] = [];
    const differing: { id: string; key: string; cells: Record<string, unknown> }[] = [];
    let unchanged = 0;
    for (const { key, cells } of batch) {
      const held = existing.get(key);
      if (!held) {
        creates.push({ ...cells, [keyFieldId]: key });
        continue;
      }
      const wanted = wantedPrint(setup.compared, cells);
      if (!wanted.pending && wanted.print === held.print) unchanged++;
      else differing.push({ id: held.id, key, cells });
    }
    const patches: { id: string; fields: Record<string, unknown> }[] = [];
    if (differing.length) {
      const byField = new Map(setup.compared.map((f) => [f.row.id, f]));
      const { records } = await readLiveRecords(
        ctx,
        differing.map((d) => d.id)
      );
      const current = new Map<string, RecordData>(records.map((r) => [r.id, r]));
      for (const d of differing) {
        const record = current.get(d.id);
        if (!record) {
          creates.push({ ...d.cells, [keyFieldId]: d.key });
          continue;
        }
        const changed = changedCells(byField, d.cells, record.fields);
        if (Object.keys(changed).length) patches.push({ id: d.id, fields: changed });
        else unchanged++;
      }
    }
    const created = creates.length ? (await createRecords(ctx, creates)).length : 0;
    const updated = patches.length ? (await updateRecords(ctx, patches)).length : 0;
    // The table no longer matches the last good run's source: the next run reads it whole.
    if ((created || updated) && !writes.stateCleared) {
      await tx.update(tableSyncs).set({ sourceState: {} }).where(eq(tableSyncs.id, setup.sync.id));
    }
    // Counted once the batch's writes are in (a failed batch fails the run).
    counts.created += created;
    counts.updated += updated;
    counts.unchanged += unchanged;
  });
  if (counts.created || counts.updated) writes.stateCleared = true;
}

/**
 * The run's end, in one transaction: the records whose key left the source deleted, then the
 * sync's label, conditional-read state and next run.
 */
async function endRun(
  deps: SyncRunDeps,
  setup: Setup,
  end: {
    gone: string[];
    counts: Counts;
    batchSize: number;
    label?: string | undefined;
    state?: Record<string, string> | undefined;
  }
): Promise<void> {
  await withTenant(deps.db, setup.sync.workspaceId, async (tx) => {
    const { ctx, sync } = await writeContext(deps, tx, setup);
    let deleted = 0;
    for (let i = 0; i < end.gone.length; i += end.batchSize) {
      const ids = end.gone.slice(i, i + end.batchSize);
      await deleteRecords(ctx, ids);
      deleted += ids.length;
    }
    const now = new Date();
    await tx
      .update(tableSyncs)
      .set({
        ...(end.label !== undefined ? { sourceLabel: end.label } : {}),
        ...(end.state !== undefined ? { sourceState: end.state } : {}),
        lastSyncedAt: now,
        nextRunAt: nextRunAt(sync.schedule as SyncSchedule, now),
        updatedAt: now,
      })
      .where(eq(tableSyncs.id, sync.id));
    end.counts.deleted += deleted;
  });
}

/**
 * A table source: the creator's access to it re-checked, then its records (the view's, when
 * the sync has one) read in the run's transaction, in the source workspace's scope, as the
 * creator: personal views are their own, hidden fields left out. Counted before anything is
 * written: past `maxRecords` the sync pauses.
 */
async function tableSource(
  deps: SyncRunDeps,
  hold: Transaction,
  setup: Setup,
  maxRecords: number
): Promise<SourceRead> {
  const { sync, userId, targetFields } = setup;
  if (!sync.sourceTableId || !sync.sourceWorkspaceId) throw new Paused('source_deleted');
  const source = { tableId: sync.sourceTableId, viewId: sync.sourceViewId };
  const access = await sourceAccess(hold, userId, source);
  if (!access.ok) throw new Paused(access.reason);
  if (access.workspaceId !== sync.sourceWorkspaceId) throw new Paused('source_deleted');
  const sourceWorkspaceId = sync.sourceWorkspaceId;
  const shape = await readSourceShape(
    hold,
    { userId, sourceWorkspaceId, homeWorkspaceId: sync.workspaceId },
    source
  );
  if (!shape) throw new Paused('source_deleted');
  const hidden = (deps.visibility ?? allFieldsVisible).hiddenFields(
    { userId, role: access.role },
    shape.table.id
  );
  const readable = new Map(shape.fields.filter((f) => !hidden.has(f.id)).map((f) => [f.id, f]));
  const keyRow = sync.keyFieldId ? readable.get(sync.keyFieldId) : undefined;
  if (sync.keyFieldId && !keyRow) throw new Paused('source_deleted');
  const key = keyRow ? typed(keyRow) : null;
  const map = fieldMapOf(sync).flatMap((m) => {
    const from = m.sourceFieldId ? readable.get(m.sourceFieldId) : undefined;
    const to = targetFields.get(m.fieldId);
    return to ? [{ from: from ? typed(from) : undefined, to }] : [];
  });
  const toWanted = (r: RecordData): Wanted => {
    const cells: Record<string, unknown> = {};
    for (const { from, to } of map) {
      // A field the creator can no longer read (or that left the source) syncs empty.
      cells[to.id] = from ? cellInput(from, to, r.fields[from.row.id] ?? null) : null;
    }
    return { key: key ? keyOf(key, r.fields[key.row.id]) : r.id, cells };
  };

  // The run's transaction reads only the source from here on: it stays in its scope.
  await setScope(hold, { userId, workspaceId: sourceWorkspaceId });
  const read = { tx: hold, workspaceId: sourceWorkspaceId, userId, table: shape.table };
  const query = (cursor: string | undefined, count: boolean) =>
    queryRecords(
      read,
      queryRecordsSchema.parse({
        ...(sync.sourceViewId ? { viewId: sync.sourceViewId } : {}),
        limit: QUERY_PAGE_MAX,
        count,
        ...(cursor ? { cursor } : {}),
      })
    );
  const first = await query(undefined, true);
  if ((first.total ?? 0) > maxRecords) throw new Paused('too_many_records');

  async function* pages(): AsyncGenerator<Wanted[]> {
    let page = first;
    let read = 0;
    for (;;) {
      read += page.records.length;
      // The snapshot doesn't change under the count; this never fires unless it does.
      if (read > maxRecords) throw new Paused('too_many_records');
      yield page.records.map(toWanted);
      if (!page.nextCursor) return;
      page = await query(page.nextCursor, false);
    }
  }
  return { notModified: false, pages: pages(), label: shape.label };
}

/**
 * An external source's rows, staged for the run in a temporary table of the run's transaction
 * (dropped when it ends) as they are read, so a large source is never held in memory. Staged
 * rows are numbered from 1: the row number is the key of a sync without a key column.
 */
class Staging {
  private count = 0;

  private constructor(private readonly tx: Transaction) {}

  static async create(tx: Transaction): Promise<Staging> {
    await tx.execute(
      sql`CREATE TEMP TABLE sync_run_rows (n int PRIMARY KEY, cells jsonb NOT NULL) ON COMMIT DROP`
    );
    return new Staging(tx);
  }

  async add(rows: (string | null)[][]): Promise<void> {
    if (rows.length === 0) return;
    const from = this.count;
    this.count += rows.length;
    // Text can't hold NUL characters, in jsonb or in a record.
    const json = JSON.stringify(
      rows.map((row) => row.map((c) => (c?.includes('\0') ? c.replaceAll('\0', '') : c)))
    );
    await this.tx.execute(sql`
      INSERT INTO sync_run_rows (n, cells)
      SELECT ${from}::int + t.ord::int, t.value
      FROM jsonb_array_elements(${json}::jsonb) WITH ORDINALITY AS t(value, ord)`);
  }

  async *pages(size: number): AsyncGenerator<{ n: number; cells: (string | null)[] }[]> {
    for (let after = 0; ; ) {
      const { rows } = await this.tx.execute<{ n: number; cells: (string | null)[] }>(
        sql`SELECT n, cells FROM sync_run_rows WHERE n > ${after} ORDER BY n LIMIT ${size}`
      );
      const last = rows.at(-1);
      if (!last) return;
      yield rows;
      if (rows.length < size) return;
      after = last.n;
    }
  }
}

/**
 * A CSV URL, Postgres or connector source: its rows staged as they are read (a source past
 * `maxRecords` pauses the sync before anything is written), then mapped to fields by column name
 * and keyed by the key column's text or the row number. Fails (a failed run, records kept) when
 * the source can't be read, its key column is gone or none of the synced columns are left.
 */
async function externalSource(
  deps: SyncRunDeps,
  hold: Transaction,
  setup: Setup,
  opts: { maxRecords: number; batchSize: number }
): Promise<SourceRead> {
  const { sync, userId, targetFields } = setup;
  const sources = deps.sources;
  if (!sources) throw new SourceError('This source is not available here.');
  const staging = await Staging.create(hold);
  const stage = {
    maxRows: opts.maxRecords,
    onRows: (rows: (string | null)[][]) => staging.add(rows),
  };
  let read: StreamedRead;
  try {
    if (sync.sourceKind === 'connector') {
      // Read with the creator's own account (in their user scope); no account, or a revoked
      // one, pauses the sync like lost access.
      read = await readConnector(
        sources,
        sync.sourceConfig,
        (connector) =>
          inScope(deps.db, { userId, workspaceId: sync.workspaceId }, (tx) =>
            accessToken(tx, sources.connectors, connector, userId)
          ),
        stage
      );
    } else {
      read = await readExternal(
        sources,
        sync.sourceKind,
        openSecret(sources, sync.sourceSecret),
        sync.sourceConfig,
        sync.sourceState,
        stage
      );
    }
  } catch (err) {
    if (err instanceof TooManyRows) throw new Paused('too_many_records');
    if (err instanceof NotConnected) throw new Paused('access_lost');
    throw err;
  }
  if (read.notModified) return { notModified: true };
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
  const toWanted = ({ n, cells: row }: { n: number; cells: (string | null)[] }): Wanted => {
    const key = keyType.coerce(keyAt === null ? String(n) : row[keyAt], {}) as string | null;
    const cells: Record<string, unknown> = {};
    // A column that left the source syncs empty.
    for (const { at, to } of map) cells[to.id] = at === undefined ? null : (row[at] ?? null);
    return { key, cells };
  };
  async function* pages(): AsyncGenerator<Wanted[]> {
    for await (const rows of staging.pages(opts.batchSize)) yield rows.map(toWanted);
  }
  return {
    notModified: false,
    pages: pages(),
    state: read.state,
    ...(read.label !== undefined ? { label: read.label } : {}),
  };
}
