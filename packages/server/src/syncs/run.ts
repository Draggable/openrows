import { createHash } from 'node:crypto';
import {
  type FieldTypeDef,
  getFieldType,
  MAX_SYNC_RECORDS,
  permissionAllows,
  QUERY_PAGE_MAX,
  queryRecordsSchema,
  type RecordData,
  roleAllows,
  type SyncPauseReason,
  type SyncSchedule,
  syncWritesBack,
  tablePermissionsOf,
} from '@openrows/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { effectiveRole } from '../authz/policy.js';
import { resolveResource } from '../authz/resolve.js';
import { inScope, setScope } from '../authz/scope.js';
import {
  type Database,
  pinConnection,
  type Transaction,
  tableSyncRecords,
  tableSyncRuns,
  tableSyncs,
  tables,
} from '../db/index.js';
import { ossEntitlements } from '../edition/oss.js';
import type { EntitlementsProvider } from '../edition/types.js';
import { type FieldRow, fieldType, liveFields, type TableRow } from '../fields/service.js';
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
 * A run works on one connection of its own, taken from the pool for the run and closed (not
 * returned) at its end. That connection holds a session-level advisory lock on the sync, so two
 * runs of a sync never overlap, and the run's staging table; no transaction stays open between
 * its steps, so a long run pins no snapshot and holds no second connection. A worker that dies
 * mid-run loses the connection, and Postgres drops the lock and the staging table with it.
 *
 * A run re-checks the creator's access to the source and to this table (lost access or a
 * deleted source pauses the sync and writes nothing), then reads the source as the creator into
 * the staging table: a table or view in its workspace's scope, counted and read whole in one
 * short REPEATABLE READ transaction (one snapshot, however it is edited meanwhile); an external
 * source as it downloads. A source past the cap pauses the sync before anything is written.
 *
 * Writes go through the RecordService as the creator, one transaction per batch of staged
 * records, with the creator's access to this table checked again in each. A batch is compared
 * with the synced records of the same keys (a fingerprint of their synced cells, read once at the
 * start, by a digest of the key; the cells themselves only where the fingerprints differ), and
 * only what differs is created or updated: a run over an unchanged source writes nothing, so
 * re-running is idempotent. Records whose key left the source are deleted last, all in one
 * transaction with the run's end, once the whole source was read: a run that fails midway
 * deletes nothing, and the next one converges.
 *
 * A table with more than one source: each source's run works on its own records only, those
 * whose "Sync source ID" cell holds its id (and, for the table's first source, the records with
 * a key synced before that field existed, whose cell is empty). It reads, matches, updates and
 * deletes only those, and the records it creates get its id, so the same key from two sources
 * is two records and one source never touches another's (or records no source owns). A run
 * that finds the table's sources changed under it (a source added meanwhile) fails before
 * writing, and the next one starts afresh.
 *
 * Two-way (a table or view source whose creator opted in): the run also takes edits and deletes
 * of its records on this table back to the source, through the RecordService as the creator,
 * with their live role and the source table's edit permissions (lost rights pause the sync,
 * `write_access_lost`, rather than write). Only the written-back fields are (syncWritesBack:
 * copied as themselves, not the key). Per record, `table_sync_records` keeps a short hash of
 * each such field's value as last applied on both sides; a run compares each side with it:
 *
 * - equal on both sides: nothing to do (an unchanged rerun writes nothing, on either side);
 * - only the source changed: the synced record follows, as one-way;
 * - only the synced record changed: the value is written to the source record;
 * - both changed: the record updated last wins (its `updatedAt`), the source on a tie;
 * - no last applied value (the first two-way run, a new record): the source's value.
 *
 * A synced record deleted by a person (it has last applied values, its key is still in the
 * source) deletes its source record at the run's end, with the other deletes; a source record
 * gone from the source (or from its view) deletes the synced record only, as one-way. Both sides
 * of a batch are written in one transaction (the source in its own workspace's scope), the source
 * first: a pause or failure writes neither. After a write-back both sides and the last applied
 * values agree, so the next run (of this sync or another of the same source) writes nothing.
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
  /** Two-way: source records updated, and deleted. */
  writtenBack: number;
  removedFromSource: number;
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
  /** Two-way: the source record's id. */
  sid?: string;
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
      /** A two-way source's write-back side. */
      twoWay?: TwoWaySource | undefined;
    }
  | { notModified: true };

/** What a run works from: the sync, its table and fields, and who it runs as. */
interface Setup {
  sync: SyncRow;
  table: TableRow;
  userId: string;
  targetFields: Map<string, FieldRow>;
  keyField: FieldRow;
  /**
   * The "Sync source ID" field of a table with more than one source, and whether this source
   * also owns the records with a key and an empty cell there; null: it owns every keyed record.
   */
  owner: { field: FieldRow; unattributed: boolean } | null;
  /** The synced fields, compared between the source and the table. */
  compared: TypedField[];
}

/**
 * The name of a sync's run lock (session-level, held for the run on its own connection), as
 * `pg_try_advisory_lock(hashtextextended(name, 0))` takes it. Its `syncs:run:` prefix keeps it
 * apart from the app's other advisory locks, `syncs:<baseId>` (creating syncs) among them.
 */
export function syncRunLockName(syncId: string): string {
  return `syncs:run:${syncId}`;
}

export async function runSyncJob(deps: SyncRunDeps, raw: unknown): Promise<SyncRunOutcome> {
  const data = syncJobData.parse(raw);
  // The run's own connection, closed at its end: its session lock and staging table go with it.
  const session = await pinConnection(deps.db);
  try {
    const { rows } = await session.db.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_lock(hashtextextended(${syncRunLockName(data.syncId)}, 0)) AS locked`
    );
    if (!rows[0]?.locked) return { status: 'busy' };
    return await runHeld({ ...deps, db: session.db }, data);
  } finally {
    await session.close();
  }
}

/**
 * The run, under its lock (`deps.db` is the run's own connection): marks it running, runs it and
 * records how it ended.
 */
async function runHeld(
  deps: SyncRunDeps,
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
    const outcome = await runSync(deps, data);
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
const SOURCES_CHANGED =
  "The table's sources changed during the run: nothing was deleted, and the next run catches up.";
const SYNC_CHANGED =
  'The sync was changed during the run: nothing was deleted, and the next run catches up.';

export const PAUSE_MESSAGES: Record<SyncPauseReason, string> = {
  paused: 'The sync was paused.',
  access_lost:
    "The sync's creator can no longer read the source (or their connected account is gone), or edit this table.",
  source_deleted: 'The source table or view was deleted.',
  too_many_records: `The source has more than ${MAX_SYNC_RECORDS.toLocaleString('en')} records.`,
  write_access_lost:
    "The sync's creator can no longer edit (or delete) the source's records, which syncing both ways needs: nothing was written to the source.",
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
        writtenBack: result.writtenBack ?? 0,
        removedFromSource: result.removedFromSource ?? 0,
        error: result.error,
        finishedAt: new Date(),
      })
      .where(eq(tableSyncRuns.id, data.runId));
    await pruneRuns(tx, data.syncId);
  });
}

async function runSync(
  deps: SyncRunDeps,
  data: z.infer<typeof syncJobData>
): Promise<SyncRunOutcome> {
  const { db } = deps;
  const maxRecords = deps.maxRecords ?? MAX_SYNC_RECORDS;
  const batchSize = Math.max(1, Math.min(deps.batchSize ?? WRITE_BATCH, WRITE_BATCH));
  const setup = await withTenant(db, data.workspaceId, (tx) => setUpRun(tx, data.syncId));
  if (setup === null) return { status: 'gone' };
  if ('error' in setup) return { status: 'failed', error: setup.error };
  const { sync } = setup;

  const staging = await Staging.create(db);
  const source =
    sync.sourceKind === 'table'
      ? await tableSource(deps, staging, setup, { maxRecords, batchSize })
      : await externalSource(deps, staging, setup, { maxRecords, batchSize });

  const counts: Counts = {
    created: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    skipped: 0,
    writtenBack: 0,
    removedFromSource: 0,
  };
  if (source.notModified) {
    // Not modified since the last good run (a CSV's 304): nothing to write.
    counts.unchanged = await countRecords(db, setup);
    await endRun(deps, setup, { gone: [], counts, batchSize });
    deps.logger?.info({ syncId: sync.id, ...counts }, 'sync run done (not modified)');
    return { status: 'succeeded', ...counts };
  }

  const existing = await syncedRecords(db, setup);
  const twoWay = source.twoWay
    ? { source: source.twoWay, applied: await appliedKeys(db, setup), removed: [] as Removed[] }
    : null;
  const seen = new Set<string>();
  const writes = { stateCleared: false };
  let batch: Staged[] = [];
  const write = (rows: Staged[]) =>
    twoWay
      ? writeTwoWayBatch(deps, setup, twoWay.source, existing, rows, counts, twoWay.removed)
      : writeBatch(deps, setup, existing, rows, counts, writes);
  for await (const page of source.pages) {
    for (const record of page) {
      const { key } = record;
      const digest = key === null ? null : keyDigest(key);
      if (key === null || digest === null || seen.has(digest)) {
        counts.skipped++;
        continue;
      }
      seen.add(digest);
      batch.push({ key, cells: record.cells, ...(record.sid ? { sid: record.sid } : {}) });
      if (batch.length >= batchSize) {
        await write(batch);
        batch = [];
      }
    }
  }
  if (batch.length) await write(batch);

  // The whole source was read: what left it goes, in one transaction with the run's end.
  const gone: string[] = [];
  for (const [digest, record] of existing) if (!seen.has(digest)) gone.push(record.id);
  await endRun(deps, setup, {
    gone,
    counts,
    batchSize,
    label: source.label,
    state: source.state,
    ...(twoWay
      ? {
          twoWay: {
            source: twoWay.source,
            removed: twoWay.removed,
            // Last applied values of keys no longer in the source (or deleted with it below).
            dropped: [
              ...[...twoWay.applied].filter((d) => !seen.has(d)),
              ...twoWay.removed.map((r) => r.digest),
            ],
          },
        }
      : {}),
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
  let owner: Setup['owner'] = null;
  if (sync.ownerFieldId) {
    const field = targetFields.get(sync.ownerFieldId);
    if (!field) return { error: 'The "Sync source ID" field is gone.' };
    owner = { field, unattributed: sync.ownsUnattributed };
  }
  const compared = new Map<string, TypedField>();
  for (const m of fieldMapOf(sync)) {
    const field = targetFields.get(m.fieldId);
    if (field && !compared.has(field.id)) compared.set(field.id, typed(field));
  }
  return {
    sync,
    table,
    userId,
    targetFields,
    keyField,
    owner,
    compared: [...compared.values()],
  };
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
  // Which records are this source's changed (a source was added): what was read may be wrong.
  if (
    sync.ownerFieldId !== setup.sync.ownerFieldId ||
    sync.ownsUnattributed !== setup.sync.ownsUnattributed
  ) {
    throw new AppError('CONFLICT', { detail: SOURCES_CHANGED });
  }
  // Two-way was turned on or off (or the source got another creator) during the run.
  if (sync.twoWay !== setup.sync.twoWay || sync.createdBy !== setup.sync.createdBy) {
    throw new AppError('CONFLICT', { detail: SYNC_CHANGED });
  }
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

/**
 * The synced records of the table by their key's digest (keyDigest): their ids and the
 * fingerprints of their compared cells. A few dozen bytes a record, however long the keys.
 */
type Held = Map<string, { id: string; print: string }>;

/** A source key's digest: what the run's indexes hold instead of keys of up to 1,000 characters. */
function keyDigest(key: string): string {
  return createHash('sha1').update(key).digest('base64');
}

/**
 * The filter matching this source's records on a table with more than one source: its id in
 * the "Sync source ID" field, or (the table's first source) a key and an empty cell there.
 */
function ownedFilter(setup: Setup) {
  const { owner, keyField, sync } = setup;
  if (!owner) return undefined;
  return {
    conjunction: 'or' as const,
    conditions: [
      { fieldId: owner.field.id, operator: 'is' as const, value: sync.id },
      ...(owner.unattributed
        ? [
            {
              conjunction: 'and' as const,
              conditions: [
                { fieldId: owner.field.id, operator: 'isEmpty' as const },
                { fieldId: keyField.id, operator: 'isNotEmpty' as const },
              ],
            },
          ]
        : []),
    ],
  };
}

/** The source's own synced records by key digest, a page at a time (ids and fingerprints only). */
async function syncedRecords(db: Database, setup: Setup): Promise<Held> {
  return withTenant(db, setup.sync.workspaceId, async (tx) => {
    const read = {
      tx,
      workspaceId: setup.sync.workspaceId,
      userId: setup.userId,
      table: setup.table,
    };
    const filter = ownedFilter(setup);
    const held: Held = new Map();
    for (let cursor: string | undefined; ; ) {
      const page = filter
        ? await queryRecords(
            read,
            queryRecordsSchema.parse({
              query: { filter },
              limit: QUERY_PAGE_MAX,
              count: false,
              ...(cursor ? { cursor } : {}),
            })
          )
        : await listRecords(read, {
            limit: QUERY_PAGE_MAX,
            ...(cursor ? { cursor } : {}),
          });
      for (const r of page.records) {
        const key = r.fields[setup.keyField.id];
        if (typeof key === 'string') {
          held.set(keyDigest(key), { id: r.id, print: heldPrint(setup.compared, r.fields) });
        }
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return held;
  });
}

/** The source's own live records (an unchanged source's "unchanged" count). */
async function countRecords(db: Database, setup: Setup): Promise<number> {
  return withTenant(db, setup.sync.workspaceId, async (tx) => {
    const filter = ownedFilter(setup);
    const page = await queryRecords(
      { tx, workspaceId: setup.sync.workspaceId, userId: setup.userId, table: setup.table },
      queryRecordsSchema.parse({ limit: 1, count: true, ...(filter ? { query: { filter } } : {}) })
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
  batch: Staged[],
  counts: Counts,
  writes: { stateCleared: boolean }
): Promise<void> {
  const keyFieldId = setup.keyField.id;
  // A new record names its source, on a table with more than one.
  const owned = setup.owner ? { [setup.owner.field.id]: setup.sync.id } : {};
  await withTenant(deps.db, setup.sync.workspaceId, async (tx) => {
    const { ctx } = await writeContext(deps, tx, setup);
    const creates: Record<string, unknown>[] = [];
    const differing: { id: string; key: string; cells: Record<string, unknown> }[] = [];
    let unchanged = 0;
    for (const { key, cells } of batch) {
      const held = existing.get(keyDigest(key));
      if (!held) {
        creates.push({ ...cells, [keyFieldId]: key, ...owned });
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
          creates.push({ ...d.cells, [keyFieldId]: d.key, ...owned });
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
    /** Two-way: the source records to delete, and the last applied values to drop. */
    twoWay?: { source: TwoWaySource; removed: Removed[]; dropped: string[] } | undefined;
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
    let removed = 0;
    if (end.twoWay) {
      const { source, dropped } = end.twoWay;
      if (end.twoWay.removed.length) {
        // Deleted on this table by a person: their source records go too, if the creator may.
        const sctx = await sourceContext(deps, tx, setup, source, 'record:delete');
        for (let i = 0; i < end.twoWay.removed.length; i += end.batchSize) {
          const sids = end.twoWay.removed.slice(i, i + end.batchSize).map((r) => r.sid);
          // Already gone from the source (deleted there meanwhile): nothing to do.
          const live = (await readLiveRecords(sctx, sids)).records.map((r) => r.id);
          if (live.length) await asCreator(() => deleteRecords(sctx, live));
          removed += live.length;
        }
        await setScope(tx, homeScope(setup));
      }
      for (let i = 0; i < dropped.length; i += SNAPSHOT_BATCH) {
        await tx
          .delete(tableSyncRecords)
          .where(
            and(
              eq(tableSyncRecords.syncId, sync.id),
              inArray(tableSyncRecords.keyDigest, dropped.slice(i, i + SNAPSHOT_BATCH))
            )
          );
      }
    }
    const now = new Date();
    await tx
      .update(tableSyncs)
      .set({
        ...(end.label !== undefined ? { sourceLabel: end.label } : {}),
        ...(end.state !== undefined ? { sourceState: end.state } : {}),
        ...(end.twoWay
          ? { writeBackFieldIds: end.twoWay.source.fields.map((f) => f.to.row.id) }
          : {}),
        lastSyncedAt: now,
        nextRunAt: nextRunAt(sync.schedule as SyncSchedule, now),
        updatedAt: now,
      })
      .where(eq(tableSyncs.id, sync.id));
    end.counts.deleted += deleted;
    end.counts.removedFromSource += removed;
  });
}

/**
 * A table source: the creator's access to it re-checked, then its records (the view's, when
 * the sync has one) read in the source workspace's scope, as the creator (personal views are
 * their own, hidden fields left out), and staged as the synced table should hold them. Counted
 * and read in one REPEATABLE READ transaction, so the run works from one snapshot of the source
 * however it is edited meanwhile, and only for as long as the read takes. Past `maxRecords` the
 * sync pauses before anything is staged or written.
 */
async function tableSource(
  deps: SyncRunDeps,
  staging: Staging,
  setup: Setup,
  opts: { maxRecords: number; batchSize: number }
): Promise<SourceRead> {
  const { sync, userId, targetFields } = setup;
  if (!sync.sourceTableId || !sync.sourceWorkspaceId) throw new Paused('source_deleted');
  let writeBack: TwoWaySource | undefined;
  const source = { tableId: sync.sourceTableId, viewId: sync.sourceViewId };
  const sourceWorkspaceId = sync.sourceWorkspaceId;
  const label = await deps.db.transaction(
    async (tx) => {
      await setScope(tx, { userId: '', workspaceId: sync.workspaceId });
      const access = await sourceAccess(tx, userId, source);
      if (!access.ok) throw new Paused(access.reason);
      if (access.workspaceId !== sourceWorkspaceId) throw new Paused('source_deleted');
      const shape = await readSourceShape(
        tx,
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
      const twoWay = sync.twoWay;
      const toWanted = (r: RecordData): Wanted => {
        const cells: Record<string, unknown> = {};
        for (const { from, to } of map) {
          // A field the creator can no longer read (or that left the source) syncs empty.
          cells[to.id] = from ? cellInput(from, to, r.fields[from.row.id] ?? null) : null;
        }
        const wanted: Wanted = { key: key ? keyOf(key, r.fields[key.row.id]) : r.id, cells };
        if (twoWay) wanted.sid = r.id;
        return wanted;
      };
      if (twoWay) {
        // Writing back needs the creator's edit rights on the source, as a person there would.
        const who = { role: access.role, userId };
        if (
          shape.table.synced ||
          !roleAllows(access.role, 'record:update') ||
          !permissionAllows(tablePermissionsOf(shape.table.permissions).editRecords, who)
        ) {
          throw new Paused('write_access_lost');
        }
        writeBack = {
          sourceWorkspaceId,
          sourceTable: shape.table,
          toWanted,
          fields: map.flatMap(({ from, to }) =>
            from &&
            !from.def.readOnly &&
            !from.def.computed &&
            syncWritesBack(fieldType(from.row), fieldType(to), from.row.id === sync.keyFieldId)
              ? [{ from, to: typed(to) }]
              : []
          ),
        };
      }

      // The transaction reads only the source from here on: it stays in its scope.
      await setScope(tx, { userId, workspaceId: sourceWorkspaceId });
      const read = { tx, workspaceId: sourceWorkspaceId, userId, table: shape.table };
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
      let page = await query(undefined, true);
      if ((page.total ?? 0) > opts.maxRecords) throw new Paused('too_many_records');
      for (let staged = 0; ; ) {
        staged += page.records.length;
        // The snapshot doesn't change under the count; this never fires unless it does.
        if (staged > opts.maxRecords) throw new Paused('too_many_records');
        await staging.add(page.records.map(toWanted), tx);
        if (!page.nextCursor) break;
        page = await query(page.nextCursor, false);
      }
      return shape.label;
    },
    { isolationLevel: 'repeatable read' }
  );

  async function* pages(): AsyncGenerator<Wanted[]> {
    for await (const rows of staging.pages(opts.batchSize)) {
      yield rows.map(({ item }) => item as Wanted);
    }
  }
  return { notModified: false, pages: pages(), label, twoWay: writeBack };
}

/**
 * A run's source rows, staged in a temporary table of the run's connection as they are read
 * (gone with the connection), so a large source is never held in memory and the writes can
 * follow the read without a transaction held open across them. Staged rows are numbered from 1,
 * in the order they were read: the row number is the key of a sync without a key column.
 */
class Staging {
  private count = 0;

  private constructor(private readonly db: Database) {}

  static async create(db: Database): Promise<Staging> {
    await db.execute(sql`DROP TABLE IF EXISTS pg_temp.sync_run_rows`);
    // `json`, not `jsonb`: values come back exactly as staged (the same keys in the same order).
    await db.execute(sql`CREATE TEMP TABLE sync_run_rows (n int PRIMARY KEY, item json NOT NULL)`);
    return new Staging(db);
  }

  /** Stages `items` after the ones before, in `tx` when given (else on its own). */
  async add(items: unknown[], tx?: Transaction): Promise<void> {
    if (items.length === 0) return;
    const from = this.count;
    this.count += items.length;
    await (tx ?? this.db).execute(sql`
      INSERT INTO sync_run_rows (n, item)
      SELECT ${from}::int + t.ord::int, t.value
      FROM json_array_elements(${JSON.stringify(items)}::json) WITH ORDINALITY AS t(value, ord)`);
  }

  async *pages(size: number): AsyncGenerator<{ n: number; item: unknown }[]> {
    for (let after = 0; ; ) {
      const { rows } = await this.db.execute<{ n: number; item: unknown }>(
        sql`SELECT n, item FROM sync_run_rows WHERE n > ${after} ORDER BY n LIMIT ${size}`
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
  staging: Staging,
  setup: Setup,
  opts: { maxRecords: number; batchSize: number }
): Promise<SourceRead> {
  const { sync, userId, targetFields } = setup;
  const sources = deps.sources;
  if (!sources) throw new SourceError('This source is not available here.');
  const stage = {
    maxRows: opts.maxRecords,
    // Text can't hold NUL characters, in a record.
    onRows: (rows: (string | null)[][]) =>
      staging.add(
        rows.map((row) => row.map((c) => (c?.includes('\0') ? c.replaceAll('\0', '') : c)))
      ),
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
  const toWanted = ({ n, item }: { n: number; item: unknown }): Wanted => {
    const row = item as (string | null)[];
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

/** A source record staged for writing: its key (unique in the run) and cells. */
interface Staged {
  key: string;
  cells: Record<string, unknown>;
  /** Two-way: the source record's id. */
  sid?: string;
}

/** Two-way: a key whose synced record a person deleted, and its source record. */
interface Removed {
  digest: string;
  sid: string;
}

/** A two-way source, as the run's read found it: where it is and what it writes back. */
interface TwoWaySource {
  sourceWorkspaceId: string;
  sourceTable: TableRow;
  /** A source record as the synced table would hold it (with its id). */
  toWanted: (r: RecordData) => Wanted;
  /** The written-back fields: the synced field and the source field it writes to. */
  fields: { from: TypedField; to: TypedField }[];
}

/** Last applied values: field id → hash of the value. */
type Applied = Record<string, string>;

/** Last applied values read or written per statement. */
const SNAPSHOT_BATCH = 1000;

/** The scope a run's write transaction works in (withTenant's). */
const homeScope = (setup: Setup) => ({ userId: '', workspaceId: setup.sync.workspaceId });

/** A short hash of a compared value (as `normalized` gives it). */
function shortHash(text: string): string {
  return createHash('sha1').update(text).digest('base64').slice(0, 16);
}

/** The hash of a value the synced field holds. */
function heldHash(f: TypedField, value: unknown): string {
  return shortHash(normalized(value ?? null, f.def.emptyValue));
}

/**
 * The hash a source cell would have in the synced field: its coerced value's, or (a choice the
 * field doesn't have yet) one that matches no held value.
 */
function inputHash(f: TypedField, input: unknown): string {
  if ((f.def.unknownChoices?.(input, f.options).length ?? 0) > 0) {
    return shortHash(`pending\0${JSON.stringify(input)}`);
  }
  return heldHash(f, input === null || input === undefined ? null : f.def.coerce(input, f.options));
}

function sameApplied(a: Applied | undefined, b: Applied): boolean {
  if (!a) return false;
  const keys = Object.keys(b);
  return keys.length === Object.keys(a).length && keys.every((k) => a[k] === b[k]);
}

/** What a synced field's value is written to its source field as (choices by name). */
function sourceValue(f: TypedField, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (f.def.withChoices) return f.def.toPrimitive(value as never, f.options as never);
  return value;
}

/**
 * A write to the source as its creator: a refusal of their rights there (the table's or a
 * field's edit permissions) pauses the sync instead, and the transaction writes nothing.
 */
async function asCreator<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError && (err.code === 'EDIT_RESTRICTED' || err.code === 'FORBIDDEN')) {
      throw new Paused('write_access_lost');
    }
    throw err;
  }
}

/**
 * Switches `tx` to the source workspace's scope and answers the RecordService context of a
 * write there as the creator, after checking their live role allows `action` on the source
 * table (editors and up), which must still be a live table that isn't synced itself. The caller
 * switches back (homeScope) when done.
 */
async function sourceContext(
  deps: SyncRunDeps,
  tx: Transaction,
  setup: Setup,
  source: TwoWaySource,
  action: 'record:update' | 'record:delete'
): Promise<RecordContext> {
  const { userId } = setup;
  const resolved = await resolveResource(tx, 'table', source.sourceTable.id, userId);
  if (!resolved || resolved.workspaceId !== source.sourceWorkspaceId) {
    throw new Paused('source_deleted');
  }
  const role = resolved.suspended ? null : effectiveRole(resolved);
  if (!role || !roleAllows(role, action)) throw new Paused('write_access_lost');
  await setScope(tx, { userId, workspaceId: source.sourceWorkspaceId });
  const [table] = await tx.select().from(tables).where(eq(tables.id, source.sourceTable.id));
  if (!table || table.deletedAt) throw new Paused('source_deleted');
  // Never into a synced table: its records are its own sources'.
  if (table.synced) throw new Paused('write_access_lost');
  return {
    tx,
    workspaceId: source.sourceWorkspaceId,
    userId,
    table,
    role,
    typecast: true,
    mayAddChoices: roleAllows(role, 'field:update'),
    unmatchedLinks: 'skip',
    entitlements: await (deps.entitlements ?? ossEntitlements).forWorkspace(
      source.sourceWorkspaceId,
      tx
    ),
  };
}

/** The keys (digests) the sync has last applied values for. */
async function appliedKeys(db: Database, setup: Setup): Promise<Set<string>> {
  return withTenant(db, setup.sync.workspaceId, async (tx) => {
    const rows = await tx
      .select({ digest: tableSyncRecords.keyDigest })
      .from(tableSyncRecords)
      .where(eq(tableSyncRecords.syncId, setup.sync.id));
    return new Set(rows.map((r) => r.digest));
  });
}

/** The last applied values of these keys. */
async function readApplied(
  tx: Transaction,
  syncId: string,
  digests: string[]
): Promise<Map<string, Applied>> {
  const out = new Map<string, Applied>();
  for (let i = 0; i < digests.length; i += SNAPSHOT_BATCH) {
    const rows = await tx
      .select({ digest: tableSyncRecords.keyDigest, cells: tableSyncRecords.cells })
      .from(tableSyncRecords)
      .where(
        and(
          eq(tableSyncRecords.syncId, syncId),
          inArray(tableSyncRecords.keyDigest, digests.slice(i, i + SNAPSHOT_BATCH))
        )
      );
    for (const r of rows) out.set(r.digest, (r.cells ?? {}) as Applied);
  }
  return out;
}

async function writeApplied(tx: Transaction, setup: Setup, values: Map<string, Applied>) {
  const rows = [...values].map(([keyDigest, cells]) => ({
    workspaceId: setup.sync.workspaceId,
    syncId: setup.sync.id,
    keyDigest,
    cells,
  }));
  for (let i = 0; i < rows.length; i += SNAPSHOT_BATCH) {
    await tx
      .insert(tableSyncRecords)
      .values(rows.slice(i, i + SNAPSHOT_BATCH))
      .onConflictDoUpdate({
        target: [tableSyncRecords.syncId, tableSyncRecords.keyDigest],
        set: { cells: sql`excluded.cells` },
      });
  }
}

/**
 * One record's two-way decision, field by field: the cells the synced record takes (source
 * inputs by synced field) and the cells its source record takes (by source field). `cells` are
 * the live source record's, `record` the live synced one's.
 */
function decide(
  setup: Setup,
  source: TwoWaySource,
  cells: Record<string, unknown>,
  record: RecordData,
  sourceUpdatedAt: string,
  applied: Applied | undefined
): { dest: Record<string, unknown>; back: Record<string, unknown> } {
  const writable = new Map(source.fields.map((f) => [f.to.row.id, f]));
  // Both sides changed a field: the record updated last wins, the source on a tie.
  const destNewer = Date.parse(record.updatedAt) > Date.parse(sourceUpdatedAt);
  const dest: Record<string, unknown> = {};
  const back: Record<string, unknown> = {};
  for (const f of setup.compared) {
    const id = f.row.id;
    const input = cells[id] ?? null;
    const held = heldHash(f, record.fields[id]);
    const wanted = inputHash(f, input);
    if (wanted === held) continue;
    const w = writable.get(id);
    const last = applied?.[id];
    // Not written back, no last applied value, or only the source changed: the source's value.
    if (!w || last === undefined || held === last) {
      dest[id] = input;
      continue;
    }
    // Only this table changed, or both did and this record is newer: back to the source.
    if (wanted === last || destNewer) back[w.from.row.id] = sourceValue(w.to, record.fields[id]);
    else dest[id] = input;
  }
  return { dest, back };
}

/** The last applied values a synced record's cells make. */
function appliedOf(source: TwoWaySource, fields: Record<string, unknown>): Applied {
  return Object.fromEntries(
    source.fields.map((f) => [f.to.row.id, heldHash(f.to, fields[f.to.row.id])])
  );
}

/**
 * One batch of a two-way source, in one transaction: new keys created; records equal on both
 * sides only get their last applied values (when those differ); the others are decided field by
 * field against the live records of both sides (`decide`), the source written first (as the
 * creator, `asCreator`), then this table, then the last applied values. A key whose synced record
 * is gone though it has last applied values was deleted by a person: `removed` collects it for
 * the run's end. A record changed or deleted on either side since the read is left to the next
 * run.
 */
async function writeTwoWayBatch(
  deps: SyncRunDeps,
  setup: Setup,
  source: TwoWaySource,
  existing: Held,
  batch: Staged[],
  counts: Counts,
  removed: Removed[]
): Promise<void> {
  const keyFieldId = setup.keyField.id;
  const owned = setup.owner ? { [setup.owner.field.id]: setup.sync.id } : {};
  await withTenant(deps.db, setup.sync.workspaceId, async (tx) => {
    const { ctx } = await writeContext(deps, tx, setup);
    const digests = batch.map((b) => keyDigest(b.key));
    const applied = await readApplied(tx, setup.sync.id, digests);
    const next = new Map<string, Applied>();
    const settle = (digest: string, values: Applied) => {
      if (!sameApplied(applied.get(digest), values)) next.set(digest, values);
    };
    const creates: { digest: string; input: Record<string, unknown> }[] = [];
    const differing: { id: string; digest: string; sid: string }[] = [];
    const deletedHere: Removed[] = [];
    let unchanged = 0;
    batch.forEach((b, i) => {
      const digest = digests[i] as string;
      const held = existing.get(digest);
      if (!held || !b.sid) {
        if (applied.has(digest) && b.sid) deletedHere.push({ digest, sid: b.sid });
        else creates.push({ digest, input: { ...b.cells, [keyFieldId]: b.key, ...owned } });
        return;
      }
      const wanted = wantedPrint(setup.compared, b.cells);
      if (!wanted.pending && wanted.print === held.print) {
        unchanged++;
        settle(
          digest,
          Object.fromEntries(
            source.fields.map((f) => [f.to.row.id, inputHash(f.to, b.cells[f.to.row.id] ?? null)])
          )
        );
        return;
      }
      differing.push({ id: held.id, digest, sid: b.sid });
    });

    const destPatches: { id: string; fields: Record<string, unknown> }[] = [];
    const backPatches: { id: string; fields: Record<string, unknown> }[] = [];
    const decided: { digest: string; record: RecordData }[] = [];
    if (differing.length) {
      const live = new Map(
        (
          await readLiveRecords(
            ctx,
            differing.map((d) => d.id)
          )
        ).records.map((r) => [r.id, r])
      );
      await setScope(tx, { userId: setup.userId, workspaceId: source.sourceWorkspaceId });
      const sourceRead = {
        tx,
        workspaceId: source.sourceWorkspaceId,
        userId: setup.userId,
        table: source.sourceTable,
      };
      const sourceLive = new Map(
        (
          await readLiveRecords(
            sourceRead,
            differing.map((d) => d.sid)
          )
        ).records.map((r) => [r.id, r])
      );
      await setScope(tx, homeScope(setup));
      for (const d of differing) {
        const record = live.get(d.id);
        const from = sourceLive.get(d.sid);
        if (!record || !from) continue;
        const { dest, back } = decide(
          setup,
          source,
          source.toWanted(from).cells,
          record,
          from.updatedAt,
          applied.get(d.digest)
        );
        if (Object.keys(dest).length) destPatches.push({ id: d.id, fields: dest });
        if (Object.keys(back).length) backPatches.push({ id: d.sid, fields: back });
        if (!Object.keys(dest).length && !Object.keys(back).length) unchanged++;
        decided.push({ digest: d.digest, record });
      }
    }

    // The source first: a refusal there pauses the sync before this table is written.
    let writtenBack = 0;
    if (backPatches.length) {
      const sctx = await sourceContext(deps, tx, setup, source, 'record:update');
      writtenBack = (await asCreator(() => updateRecords(sctx, backPatches))).length;
      await setScope(tx, homeScope(setup));
    }
    const created = creates.length
      ? await createRecords(
          ctx,
          creates.map((c) => c.input)
        )
      : [];
    created.forEach((r, i) => {
      const c = creates[i];
      if (c) next.set(c.digest, appliedOf(source, r.fields));
    });
    const updated = destPatches.length ? await updateRecords(ctx, destPatches) : [];
    const after = new Map(updated.map((r) => [r.id, r]));
    for (const { digest, record } of decided) {
      settle(digest, appliedOf(source, (after.get(record.id) ?? record).fields));
    }
    if (next.size) await writeApplied(tx, setup, next);
    // Counted once the batch's writes are in (a failed batch fails the run).
    removed.push(...deletedHere);
    counts.created += created.length;
    counts.updated += updated.length;
    counts.unchanged += unchanged;
    counts.writtenBack += writtenBack;
  });
}
