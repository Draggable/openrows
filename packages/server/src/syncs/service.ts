import {
  type AddSyncSourceInput,
  addSyncSourceSchema,
  type BrowseConnectorInput,
  browseConnectorSchema,
  type ConnectorItems,
  type CreateSyncInput,
  createSyncSchema,
  type ExternalSyncSource,
  getFieldType,
  MAX_SYNC_FIELDS,
  MAX_SYNC_SOURCES_PER_TABLE,
  MAX_SYNCS_PER_BASE,
  type PreviewSyncInput,
  permissionAllows,
  previewSyncSchema,
  roleAllows,
  SYNC_RUN_HISTORY,
  SYNC_SCHEDULE_MINUTES,
  SYNC_SOURCE_KINDS,
  type SyncColumn,
  type SyncPauseReason,
  type SyncPreview,
  type SyncRun,
  type SyncSchedule,
  type SyncSourceKind,
  syncedTypeOf,
  syncTargetCompatible,
  type TableSync,
  tablePermissionsOf,
  type tableSyncSourceSchema,
  type UpdateSyncInput,
  type UserRole,
} from '@openrows/shared';
import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { z } from 'zod';
import { effectiveRole } from '../authz/policy.js';
import { resolveResource } from '../authz/resolve.js';
import { setScope } from '../authz/scope.js';
import {
  bases,
  type Database,
  fields,
  type Transaction,
  tableSyncRecords,
  tableSyncRuns,
  tableSyncs,
  tables,
  views,
} from '../db/index.js';
import type { Entitlements } from '../edition/types.js';
import {
  createField,
  type FieldRow,
  fieldType,
  liveFields,
  parseOptions,
  type TableRow,
  updateField,
} from '../fields/service.js';
import { namedJobId } from '../jobs/ids.js';
import type { Jobs } from '../jobs/send.js';
import { withTenant } from '../jobs/tenant.js';
import { AppError } from '../lib/errors.js';
import { createTable } from '../tables/service.js';
import { visibleTo } from '../views/visibility.js';
import {
  accessToken,
  browseConnector,
  type ConnectorToken,
  checkSource,
  connectorConfig,
  previewSource,
  SourceError,
  type SplitSource,
  type SyncSources,
} from './sources/index.js';

/**
 * Synced tables: a table whose records come from another table or view (the source), read
 * as the sync's creator with their live access re-checked at every run. This module holds the
 * sync's metadata (create, read, schedule, pause, remove) and queues runs; run.ts is the engine
 * the worker's `syncs.run` job runs.
 */

export const SYNC_QUEUE = 'syncs.run';

export type SyncRow = typeof tableSyncs.$inferSelect;
type RunRow = typeof tableSyncRuns.$inferSelect;

/** One source field (a table source) or column (an external one) → the synced field. */
export interface FieldMapEntry {
  sourceFieldId?: string;
  column?: string;
  fieldId: string;
}

export function fieldMapOf(row: SyncRow): FieldMapEntry[] {
  return Array.isArray(row.fieldMap) ? (row.fieldMap as FieldMapEntry[]) : [];
}

/** The synced fields a two-way source writes back, as its last run found them. */
export function writeBackFieldsOf(row: Pick<SyncRow, 'writeBackFieldIds'>): string[] {
  return Array.isArray(row.writeBackFieldIds)
    ? (row.writeBackFieldIds as unknown[]).filter((id): id is string => typeof id === 'string')
    : [];
}

/** The synced field's type and options for a source field. */
export function targetTypeOf(source: FieldRow): {
  type: string;
  options: Record<string, unknown>;
} {
  const type = fieldType(source);
  if (syncedTypeOf(type) === type) {
    return { type, options: parseOptions(type, source.config) as Record<string, unknown> };
  }
  return { type: 'longText', options: {} };
}

export function nextRunAt(schedule: SyncSchedule, from: Date): Date | null {
  if (schedule === 'manual') return null;
  return new Date(from.getTime() + SYNC_SCHEDULE_MINUTES[schedule] * 60_000);
}

function toRun(row: RunRow): SyncRun {
  return {
    id: row.id,
    trigger: row.trigger as SyncRun['trigger'],
    status: row.status as SyncRun['status'],
    created: row.created,
    updated: row.updated,
    deleted: row.deleted,
    unchanged: row.unchanged,
    skipped: row.skipped,
    writtenBack: row.writtenBack,
    removedFromSource: row.removedFromSource,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export async function toTableSync(
  tx: Transaction,
  row: SyncRow,
  role: UserRole
): Promise<TableSync> {
  const runs = await tx
    .select()
    .from(tableSyncRuns)
    .where(eq(tableSyncRuns.syncId, row.id))
    .orderBy(desc(tableSyncRuns.createdAt), desc(tableSyncRuns.id))
    .limit(SYNC_RUN_HISTORY);
  return {
    id: row.id,
    baseId: row.baseId,
    tableId: row.tableId,
    source: {
      kind: (SYNC_SOURCE_KINDS as readonly string[]).includes(row.sourceKind)
        ? (row.sourceKind as SyncSourceKind)
        : 'table',
      workspaceId: row.sourceWorkspaceId,
      baseId: row.sourceBaseId,
      tableId: row.sourceTableId,
      viewId: row.sourceViewId,
      label: row.sourceLabel,
      connector:
        row.sourceKind === 'connector'
          ? (connectorConfig(row.sourceConfig)?.connector ?? null)
          : null,
    },
    keyFieldId: row.keyFieldId,
    keyColumn: row.keyColumn,
    fields: fieldMapOf(row).map((m) => ({
      sourceFieldId: m.sourceFieldId ?? null,
      column: m.column ?? null,
      fieldId: m.fieldId,
    })),
    sourceFieldId: row.sourceFieldId,
    ownerFieldId: row.ownerFieldId,
    ownsUnattributed: row.ownsUnattributed,
    twoWay: row.twoWay,
    writeBackFieldIds: row.twoWay ? writeBackFieldsOf(row) : [],
    schedule: row.schedule as SyncSchedule,
    status: row.status === 'paused' ? 'paused' : 'active',
    pauseReason: (row.pauseReason as SyncPauseReason | null) ?? null,
    createdBy: row.createdBy,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    runs: runs.map(toRun),
    canManage: roleAllows(role, 'table:manage_sync'),
  };
}

/**
 * The table's sources, oldest (the one it was made with) first; none when it isn't synced.
 * Optionally locked for the transaction.
 *
 * Locked, they are read twice: a locking read that waited for another transaction returns only
 * the rows its snapshot had, so a source added by that transaction (which held these rows while
 * adding it) would be missed. The second read, once the rows are held, sees and locks it too; no
 * other source can be added meanwhile, as adding one locks the table's sources first.
 */
export async function loadSyncs(tx: Transaction, tableId: string, lock = false) {
  const query = () =>
    tx
      .select()
      .from(tableSyncs)
      .where(eq(tableSyncs.tableId, tableId))
      .orderBy(asc(tableSyncs.createdAt), asc(tableSyncs.id));
  if (!lock) return query();
  await query().for('update');
  return query().for('update');
}

/** The table's first source (404 when it isn't synced), optionally locked. */
export async function loadSync(tx: Transaction, tableId: string, lock = false): Promise<SyncRow> {
  const [row] = await loadSyncs(tx, tableId, lock);
  if (!row) throw new AppError('NOT_FOUND', { detail: "This table isn't synced." });
  return row;
}

/** One source of the table (404 when it isn't one), locked for the transaction. */
async function loadSource(tx: Transaction, tableId: string, syncId: string): Promise<SyncRow> {
  const [row] = await tx
    .select()
    .from(tableSyncs)
    .where(and(eq(tableSyncs.id, syncId), eq(tableSyncs.tableId, tableId)))
    .for('update');
  if (!row) throw new AppError('NOT_FOUND', { detail: 'No such source of this table.' });
  return row;
}

/** The table's sources as the API shows them, oldest first. */
export async function listSources(
  tx: Transaction,
  tableId: string,
  role: UserRole
): Promise<{ sources: TableSync[] }> {
  const rows = await loadSyncs(tx, tableId);
  if (!rows.length) throw new AppError('NOT_FOUND', { detail: "This table isn't synced." });
  const sources: TableSync[] = [];
  for (const row of rows) sources.push(await toTableSync(tx, row, role));
  return { sources };
}

/** What a run needs to read the source, as `userId`: the role there, or why it can't. */
export type SourceAccess =
  | { ok: true; workspaceId: string; role: UserRole }
  | { ok: false; reason: Extract<SyncPauseReason, 'access_lost' | 'source_deleted'> };

/**
 * Whether `userId` may still read the source (re-checked at every run): the table (or the
 * view, when the sync has one) must exist, be live and be readable with their live role.
 */
export async function sourceAccess(
  tx: Transaction,
  userId: string | null,
  source: { tableId: string; viewId: string | null }
): Promise<SourceAccess> {
  if (!userId) return { ok: false, reason: 'access_lost' };
  const resolved = source.viewId
    ? await resolveResource(tx, 'view', source.viewId, userId)
    : await resolveResource(tx, 'table', source.tableId, userId);
  if (!resolved) return { ok: false, reason: 'source_deleted' };
  const role = resolved.suspended ? null : effectiveRole(resolved);
  if (!role || !roleAllows(role, 'record:read')) return { ok: false, reason: 'access_lost' };
  return { ok: true, workspaceId: resolved.workspaceId, role };
}

/** The source as seen in its own workspace's scope: the table, its view and their fields. */
export interface SourceShape {
  base: { id: string; name: string };
  table: TableRow;
  view: { id: string; name: string } | null;
  fields: FieldRow[];
  label: string;
}

/**
 * Reads the source's shape in its workspace's scope, then puts the transaction back in the
 * caller's scope. The view must belong to the table and be visible to `userId` (personal views
 * are their owner's).
 */
export async function readSourceShape(
  tx: Transaction,
  scopes: { userId: string; sourceWorkspaceId: string; homeWorkspaceId: string },
  source: { tableId: string; viewId: string | null }
): Promise<SourceShape | null> {
  await setScope(tx, { userId: scopes.userId, workspaceId: scopes.sourceWorkspaceId });
  try {
    const [table] = await tx
      .select()
      .from(tables)
      .where(and(eq(tables.id, source.tableId), isNull(tables.deletedAt)));
    if (!table) return null;
    const [base] = await tx
      .select({ id: bases.id, name: bases.name })
      .from(bases)
      .where(and(eq(bases.id, table.baseId), isNull(bases.deletedAt)));
    if (!base) return null;
    let view: SourceShape['view'] = null;
    if (source.viewId) {
      const [row] = await tx
        .select({ id: views.id, name: views.name })
        .from(views)
        .where(
          and(
            eq(views.id, source.viewId),
            eq(views.tableId, table.id),
            isNull(views.deletedAt),
            visibleTo(scopes.userId)
          )
        );
      if (!row) return null;
      view = { id: row.id, name: row.name };
    }
    const fieldRows = await liveFields(tx, table.id);
    const label = [base.name, table.name, view?.name].filter(Boolean).join(' / ');
    return { base, table, view, fields: fieldRows, label };
  } finally {
    await setScope(tx, { userId: scopes.userId, workspaceId: scopes.homeWorkspaceId });
  }
}

/** A field name not taken among `taken` (lower-cased): `name`, `name 2`, `name 3`… */
function freeName(taken: Set<string>, name: string): string {
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${name} ${n}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

export interface SyncContext {
  tx: Transaction;
  workspaceId: string;
  baseId: string;
  userId: string;
  role: UserRole;
  jobs: Jobs | undefined;
  entitlements: Entitlements;
  /** External sources; without them, CSV and Postgres sources are refused. */
  sources?: SyncSources | undefined;
}

/** A table source, checked: the caller's access, its shape and the fields to copy (primary first). */
interface CheckedTableSource {
  access: Extract<SourceAccess, { ok: true }>;
  shape: SourceShape;
  /** The fields to copy, the primary first. */
  ordered: FieldRow[];
}

type TableSourceInput = z.infer<typeof tableSyncSourceSchema>;

/**
 * Checks a table source as the caller: they can read it (404 otherwise), it isn't synced
 * itself, and the fields and key named are its own (422).
 */
async function checkTableSource(
  ctx: SyncContext,
  body: { source: TableSourceInput; fieldIds?: string[] | undefined; keyFieldId: string | null }
): Promise<CheckedTableSource> {
  const access = await sourceAccess(ctx.tx, ctx.userId, body.source);
  if (!access.ok) throw new AppError('NOT_FOUND', { detail: 'No such source table or view.' });
  const shape = await readSourceShape(
    ctx.tx,
    {
      userId: ctx.userId,
      sourceWorkspaceId: access.workspaceId,
      homeWorkspaceId: ctx.workspaceId,
    },
    body.source
  );
  if (!shape || shape.table.baseId !== body.source.baseId) {
    throw new AppError('NOT_FOUND', { detail: 'No such source table or view.' });
  }
  if (shape.table.synced) {
    throw invalid('source.tableId', "A synced table can't be the source of another sync.");
  }
  const byId = new Map(shape.fields.map((f) => [f.id, f]));
  const primary = shape.fields.find((f) => f.isPrimary);
  if (!primary) throw new Error('source table without a primary field');
  const wanted = body.fieldIds ?? shape.fields.map((f) => f.id);
  const unknown = wanted.filter((id) => !byId.has(id));
  if (unknown.length) throw invalid('fieldIds', 'Every field must be a field of the source.');
  if (body.keyFieldId && !byId.has(body.keyFieldId)) {
    throw invalid('keyFieldId', 'The key must be a field of the source.');
  }
  const ordered = [primary, ...shape.fields.filter((f) => !f.isPrimary && wanted.includes(f.id))];
  if (ordered.length > MAX_SYNC_FIELDS) {
    throw invalid('fieldIds', `A sync copies at most ${MAX_SYNC_FIELDS} fields.`);
  }
  return { access, shape, ordered };
}

/** An external source, checked: its columns (with their options) and its stored form. */
interface CheckedExternalSource {
  sources: SyncSources;
  split: SplitSource;
  /** The columns to sync, in order, their options checked against their types. */
  columns: (SyncColumn & { options: Record<string, unknown> })[];
}

/**
 * Checks an external source (address rules, TLS, the query's shape: 422 with its problem) and
 * the columns to sync: each once, the key among them. The source isn't read.
 */
async function checkExternalSource(
  ctx: SyncContext,
  body: { source: ExternalSyncSource; columns?: SyncColumn[] | undefined; keyColumn: string | null }
): Promise<CheckedExternalSource> {
  const sources = externalSources(ctx);
  const columns = body.columns;
  if (!columns?.length) throw invalid('columns', 'Pick the columns to sync.');
  const seen = new Set<string>();
  for (const [i, c] of columns.entries()) {
    if (seen.has(c.name)) throw invalid(`columns.${i}.name`, 'Each column can be synced once.');
    seen.add(c.name);
  }
  if (body.keyColumn !== null && !seen.has(body.keyColumn)) {
    throw invalid('keyColumn', 'The key must be one of the synced columns.');
  }
  const typed = columns.map((c, i) => ({ ...c, options: columnOptions(c, i) }));
  let split: SplitSource;
  try {
    split = await checkSource(sources, body.source, tokenOf(ctx, sources));
  } catch (err) {
    sourceInvalid(err);
  }
  return { sources, split, columns: typed };
}

/** The columns of a new `table_syncs` row that say where its source is. */
function sourceColumns(
  checked:
    | { kind: 'table'; src: CheckedTableSource }
    | { kind: 'external'; src: CheckedExternalSource }
): Partial<typeof tableSyncs.$inferInsert> & { sourceLabel: string } {
  if (checked.kind === 'table') {
    const { access, shape } = checked.src;
    return {
      sourceWorkspaceId: access.workspaceId,
      sourceBaseId: shape.table.baseId,
      sourceTableId: shape.table.id,
      sourceViewId: shape.view?.id ?? null,
      sourceLabel: shape.label,
    };
  }
  const { split, sources } = checked.src;
  return {
    sourceKind: split.kind,
    sourceConfig: split.config,
    // A connector source has no secret of its own: the creator's account reads it.
    sourceSecret: split.secret ? sources.cipher.encrypt(split.secret) : null,
    sourceLabel: split.label,
  };
}

/**
 * Creates a synced table in the base: checks the caller can read the source (in this or
 * another workspace they belong to), makes the table with the source's fields (the primary first,
 * copied types as they are, the rest as text) plus its "Sync source" field, and queues the first
 * run. 422 for a source field that isn't the source's, 404 for a source the caller can't read.
 * A CSV URL, Postgres or connector source's fields are the chosen columns (the first is the
 * primary) with their types; the source is checked (address rules, TLS, the query's shape) but
 * not read, and its URL or connection string is stored encrypted.
 */
export async function createSync(ctx: SyncContext, input: CreateSyncInput): Promise<TableSync> {
  const parsed = createSyncSchema.parse(input);
  const { source } = parsed;
  if (parsed.twoWay && source.kind !== undefined && source.kind !== 'table') throw oneWayOnly();
  // Each column or field to copy: its name, type and options, and what it is in the source.
  let checked:
    | { kind: 'table'; src: CheckedTableSource }
    | { kind: 'external'; src: CheckedExternalSource };
  let copies: {
    name: string;
    type: string;
    options: Record<string, unknown>;
    description?: string | null;
    from: Pick<FieldMapEntry, 'sourceFieldId' | 'column'>;
  }[];
  let defaultName: string;
  if (source.kind === 'csv' || source.kind === 'postgres' || source.kind === 'connector') {
    const src = await checkExternalSource(ctx, { ...parsed, source });
    checked = { kind: 'external', src };
    copies = src.columns.map((c) => ({
      name: c.name,
      type: c.type,
      options: c.options,
      from: { column: c.name },
    }));
    defaultName = src.split.tableName;
  } else {
    const src = await checkTableSource(ctx, { ...parsed, source });
    checked = { kind: 'table', src };
    copies = src.ordered.map((f) => ({
      name: f.name,
      ...targetTypeOf(f),
      description: f.description,
      from: { sourceFieldId: f.id },
    }));
    defaultName = src.shape.table.name;
  }
  await assertSyncRoom(ctx);

  const [base] = await ctx.tx.select().from(bases).where(eq(bases.id, ctx.baseId));
  if (!base) throw new Error('authorized base not visible under RLS');
  const schema = { tx: ctx.tx, workspaceId: ctx.workspaceId, userId: ctx.userId };
  const [first, ...rest] = copies;
  if (!first) throw invalid('columns', 'Pick the columns to sync.');
  const name = parsed.name ?? freeName(await tableNames(ctx), defaultName);
  const table = await createTable(schema, base, { name, primaryFieldName: first.name });
  const [targetPrimary] = await liveFields(ctx.tx, table.id);
  if (!targetPrimary) throw new Error('synced table without its primary field');
  // The primary keeps single line text unless the source's is a typed one of its own (a table
  // source's long text, or the text of a type that isn't copied, stays single line text).
  const textPrimary =
    first.type === 'singleLineText' || (checked.kind === 'table' && first.type === 'longText');
  if (!textPrimary) {
    await updateField(schema, targetPrimary, { type: first.type as never, options: first.options });
  }
  const [target] = await ctx.tx.select().from(tables).where(eq(tables.id, table.id));
  if (!target) throw new Error('synced table not visible');
  const map: FieldMapEntry[] = [{ ...first.from, fieldId: targetPrimary.id }];
  const names = new Set([first.name.toLowerCase()]);
  for (const c of rest) {
    const row = await createField(
      schema,
      target,
      {
        name: freeName(names, c.name),
        type: c.type as never,
        options: c.options,
        ...(c.description ? { description: c.description } : {}),
      },
      { sync: true }
    );
    map.push({ ...c.from, fieldId: row.id });
  }
  const sourceField = await createField(
    schema,
    target,
    { name: freeName(names, 'Sync source'), type: 'syncSource' },
    { sync: true }
  );
  await ctx.tx
    .update(fields)
    .set({ synced: true })
    .where(inArray(fields.id, [targetPrimary.id, ...map.map((m) => m.fieldId), sourceField.id]));
  await ctx.tx.update(tables).set({ synced: true }).where(eq(tables.id, table.id));

  if (parsed.twoWay) {
    await assertTwoWayAllowed(ctx, {
      tableId: table.id,
      syncId: null,
      sourceKind: checked.kind === 'table' ? 'table' : checked.src.split.kind,
      source:
        checked.kind === 'table'
          ? { tableId: checked.src.shape.table.id, viewId: checked.src.shape.view?.id ?? null }
          : null,
    });
  }
  const [row] = await ctx.tx
    .insert(tableSyncs)
    .values({
      id: uuidv7(),
      workspaceId: ctx.workspaceId,
      baseId: ctx.baseId,
      tableId: table.id,
      ...sourceColumns(checked),
      twoWay: parsed.twoWay,
      keyFieldId: checked.kind === 'table' ? parsed.keyFieldId : null,
      keyColumn: checked.kind === 'external' ? parsed.keyColumn : null,
      fieldMap: map,
      sourceFieldId: sourceField.id,
      schedule: parsed.schedule,
      createdBy: ctx.userId,
      nextRunAt: nextRunAt(parsed.schedule, new Date()),
    })
    .returning();
  if (!row) throw new Error('sync insert returned nothing');
  await queueRun(ctx.tx, ctx.jobs, row, 'create');
  return toTableSync(ctx.tx, row, ctx.role);
}

/**
 * Adds a source to a synced table (creators and up): the source is checked as for a new synced
 * table, then each of its fields (or columns) fills an existing synced field of the table where
 * `targets` (or, for the source's primary field or first column, the table's primary field) says
 * so, and gets a new synced field otherwise. A target must take the source's values as they are
 * (syncTargetCompatible): any other is a 422. The table's first extra source also adds its
 * "Sync source ID" field, which names each record's source from then on; the records synced
 * until then stay the first source's. The new source's first run is queued.
 */
export async function addSource(
  ctx: SyncContext,
  tableId: string,
  input: AddSyncSourceInput
): Promise<TableSync> {
  if (!(await loadSyncs(ctx.tx, tableId)).length) {
    throw new AppError('NOT_FOUND', { detail: "This table isn't synced." });
  }
  const body = addSyncSourceSchema.parse(input);
  const { source } = body;
  if (body.twoWay && source.kind !== undefined && source.kind !== 'table') throw oneWayOnly();

  // What the source copies, each with the type a new field of it would have.
  let checked:
    | { kind: 'table'; src: CheckedTableSource }
    | { kind: 'external'; src: CheckedExternalSource };
  let copies: {
    name: string;
    type: string;
    options: Record<string, unknown>;
    description?: string | null;
    from: Pick<FieldMapEntry, 'sourceFieldId' | 'column'>;
  }[];
  if (source.kind === 'csv' || source.kind === 'postgres' || source.kind === 'connector') {
    const src = await checkExternalSource(ctx, { ...body, source });
    checked = { kind: 'external', src };
    copies = src.columns.map((c) => ({
      name: c.name,
      type: c.type,
      options: c.options,
      from: { column: c.name },
    }));
  } else {
    const src = await checkTableSource(ctx, { ...body, source });
    checked = { kind: 'table', src };
    copies = src.ordered.map((f) => ({
      name: f.name,
      ...targetTypeOf(f),
      description: f.description,
      from: { sourceFieldId: f.id },
    }));
  }

  // Locked once the source is checked (which may wait on the network): from here, runs of the
  // table's sources wait for the add (and then see it), and so do other adds and removals.
  const existing = await loadSyncs(ctx.tx, tableId, true);
  const first = existing[0];
  if (!first) throw new AppError('NOT_FOUND', { detail: "This table isn't synced." });
  const [table] = await ctx.tx
    .select()
    .from(tables)
    .where(and(eq(tables.id, tableId), isNull(tables.deletedAt)));
  if (!table) throw new AppError('NOT_FOUND', { detail: "This table isn't synced." });
  const tableFields = await liveFields(ctx.tx, tableId);
  const byId = new Map(tableFields.map((f) => [f.id, f]));
  const engineFields = new Set([first.sourceFieldId, first.ownerFieldId].filter(Boolean));

  // Where each copied field goes: the targets as given, checked, then the defaults.
  const chosen = new Map<number, FieldRow | null>();
  const used = new Set<string>();
  for (const [i, t] of body.targets.entries()) {
    const at = copies.findIndex((c) =>
      checked.kind === 'table'
        ? t.sourceFieldId !== undefined && c.from.sourceFieldId === t.sourceFieldId
        : t.column !== undefined && c.from.column === t.column
    );
    if (at < 0) {
      throw invalid(
        `targets.${i}`,
        checked.kind === 'table'
          ? 'Map only the fields the source copies.'
          : 'Map only the columns the source syncs.'
      );
    }
    if (chosen.has(at)) throw invalid(`targets.${i}`, 'Map each field of the source once.');
    if (t.fieldId === null) {
      chosen.set(at, null);
      continue;
    }
    const field = byId.get(t.fieldId);
    const copy = copies[at];
    if (!field || !copy || !field.synced || engineFields.has(field.id)) {
      throw invalid(`targets.${i}.fieldId`, 'Pick a synced field of this table, or a new field.');
    }
    if (used.has(field.id)) {
      throw invalid(`targets.${i}.fieldId`, `"${field.name}" can take one field of the source.`);
    }
    const toType = fieldType(field);
    if (!syncTargetCompatible(copy.type, toType)) {
      throw invalid(
        `targets.${i}.fieldId`,
        `"${copy.name}" (${getFieldType(copy.type as never).label}) can't fill "${field.name}" (${getFieldType(toType).label}): pick a field of the same type, a text field, or a new field.`
      );
    }
    used.add(field.id);
    chosen.set(at, field);
  }
  // The source's primary field (or first column) fills the table's, unless it can't.
  const primary = tableFields.find((f) => f.isPrimary);
  const firstCopy = copies[0];
  if (
    !chosen.has(0) &&
    firstCopy &&
    primary?.synced &&
    !used.has(primary.id) &&
    syncTargetCompatible(firstCopy.type, fieldType(primary))
  ) {
    chosen.set(0, primary);
    used.add(primary.id);
  }

  await assertSyncRoom(ctx, tableId);

  const schema = { tx: ctx.tx, workspaceId: ctx.workspaceId, userId: ctx.userId };
  const names = new Set(tableFields.map((f) => f.name.toLowerCase()));
  const map: FieldMapEntry[] = [];
  for (const [i, c] of copies.entries()) {
    const target = chosen.get(i);
    if (target) {
      map.push({ ...c.from, fieldId: target.id });
      continue;
    }
    const row = await createField(
      schema,
      table,
      {
        name: freeName(names, c.name),
        type: c.type as never,
        options: c.options,
        ...(c.description ? { description: c.description } : {}),
      },
      { sync: true }
    );
    map.push({ ...c.from, fieldId: row.id });
  }

  // The table's second source: from now on each record names its source.
  let ownerFieldId = first.ownerFieldId;
  if (!ownerFieldId) {
    const owner = await createField(
      schema,
      table,
      { name: freeName(names, 'Sync source ID'), type: 'syncSource' },
      { sync: true }
    );
    ownerFieldId = owner.id;
    await ctx.tx
      .update(tableSyncs)
      .set({ ownerFieldId, ownsUnattributed: true, updatedAt: new Date() })
      .where(eq(tableSyncs.id, first.id));
  }

  if (body.twoWay) {
    await assertTwoWayAllowed(ctx, {
      tableId,
      syncId: null,
      sourceKind: checked.kind === 'table' ? 'table' : checked.src.split.kind,
      source:
        checked.kind === 'table'
          ? { tableId: checked.src.shape.table.id, viewId: checked.src.shape.view?.id ?? null }
          : null,
    });
  }
  const [row] = await ctx.tx
    .insert(tableSyncs)
    .values({
      id: uuidv7(),
      workspaceId: ctx.workspaceId,
      baseId: table.baseId,
      tableId,
      ...sourceColumns(checked),
      twoWay: body.twoWay,
      keyFieldId: checked.kind === 'table' ? body.keyFieldId : null,
      keyColumn: checked.kind === 'external' ? body.keyColumn : null,
      fieldMap: map,
      sourceFieldId: first.sourceFieldId,
      ownerFieldId,
      schedule: body.schedule,
      createdBy: ctx.userId,
      nextRunAt: nextRunAt(body.schedule, new Date()),
    })
    .returning();
  if (!row) throw new Error('sync insert returned nothing');
  await queueRun(ctx.tx, ctx.jobs, row, 'create');
  return toTableSync(ctx.tx, row, ctx.role);
}

/**
 * One source more in the base (and on `tableId`, when adding to a table), one at a time per base
 * past this point, so the caps hold under concurrent creates: MAX_SYNCS_PER_BASE sources per
 * base, MAX_SYNC_SOURCES_PER_TABLE per table (409 past them).
 */
async function assertSyncRoom(ctx: SyncContext, tableId?: string) {
  await ctx.tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`syncs:${ctx.baseId}`}, 0))`
  );
  const [stats] = await ctx.tx
    .select({
      count: sql<number>`count(*)::int`,
      onTable: tableId
        ? sql<number>`(count(*) FILTER (WHERE ${tableSyncs.tableId} = ${tableId}))::int`
        : sql<number>`0`,
    })
    .from(tableSyncs)
    .where(eq(tableSyncs.baseId, ctx.baseId));
  if ((stats?.count ?? 0) >= MAX_SYNCS_PER_BASE) {
    throw new AppError('CONFLICT', {
      detail: `A base can have at most ${MAX_SYNCS_PER_BASE} sync sources.`,
    });
  }
  if ((stats?.onTable ?? 0) >= MAX_SYNC_SOURCES_PER_TABLE) {
    throw new AppError('CONFLICT', {
      detail: `A table can sync from at most ${MAX_SYNC_SOURCES_PER_TABLE} sources.`,
    });
  }
}

/** The base's live table names, lower-cased. */
async function tableNames(ctx: SyncContext): Promise<Set<string>> {
  const rows = await ctx.tx
    .select({ name: tables.name })
    .from(tables)
    .where(and(eq(tables.baseId, ctx.baseId), isNull(tables.deletedAt)));
  return new Set(rows.map((t) => t.name.toLowerCase()));
}

function externalSources(ctx: Pick<SyncContext, 'sources'>): SyncSources {
  if (!ctx.sources) {
    throw invalid('source.kind', 'This source is not available on this server.');
  }
  return ctx.sources;
}

/** A source problem as a 422 on the source (its message is safe to show). */
function sourceInvalid(err: unknown, path = 'source'): never {
  if (err instanceof SourceError) throw invalid(path, err.message);
  throw err;
}

/**
 * "Preview": an external source's columns, suggested types and first rows, read now as
 * the caller (the same address rules and caps as a run). 422 with the source's problem.
 */
export async function previewSync(
  ctx: Pick<SyncContext, 'sources' | 'tx' | 'userId'>,
  input: PreviewSyncInput
): Promise<SyncPreview> {
  const { source } = previewSyncSchema.parse(input);
  try {
    const sources = externalSources(ctx);
    return await previewSource(sources, source, tokenOf(ctx, sources));
  } catch (err) {
    sourceInvalid(err);
  }
}

/** The caller's own account at a connector, in the request's scope. */
function tokenOf(ctx: Pick<SyncContext, 'tx' | 'userId'>, sources: SyncSources): ConnectorToken {
  return (connector) => accessToken(ctx.tx, sources.connectors, connector, ctx.userId);
}

/**
 * A sync connector's picker: a level's items (spreadsheets, then a spreadsheet's sheets)
 * through the caller's connected account. 422 with the problem (not connected, not found).
 */
export async function browseSync(
  ctx: Pick<SyncContext, 'sources' | 'tx' | 'userId'>,
  input: BrowseConnectorInput
): Promise<ConnectorItems> {
  const body = browseConnectorSchema.parse(input);
  try {
    const sources = externalSources(ctx);
    const items = await browseConnector(ctx.tx, sources.connectors, ctx.userId, body);
    return {
      items: items.map((i) => ({
        id: i.id.slice(0, 1024),
        name: i.name.slice(0, 255),
        detail: i.detail?.slice(0, 255) ?? null,
        leaf: i.leaf,
      })),
    };
  } catch (err) {
    sourceInvalid(err, 'connector');
  }
}

/** A column's options, checked against its type's schema (422 otherwise). */
function columnOptions(column: SyncColumn, index: number): Record<string, unknown> {
  const parsed = getFieldType(column.type).optionsSchema.safeParse(column.options ?? {});
  if (!parsed.success) {
    throw invalid(`columns.${index}.options`, `These aren't options of a ${column.type} field.`);
  }
  return parsed.data as Record<string, unknown>;
}

function invalid(path: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', {
    detail: message,
    extensions: { errors: [{ path, message }] },
  });
}

/**
 * Queues a run of the sync unless one is already queued or running (then that one stands): a
 * run row, and the `syncs.run` job in the same transaction.
 */
export async function queueRun(
  tx: Transaction,
  jobs: Jobs | undefined,
  sync: SyncRow,
  trigger: 'create' | 'manual' | 'schedule'
): Promise<string> {
  const [open] = await tx
    .select({ id: tableSyncRuns.id })
    .from(tableSyncRuns)
    .where(
      and(eq(tableSyncRuns.syncId, sync.id), inArray(tableSyncRuns.status, ['queued', 'running']))
    )
    .limit(1);
  if (open) return open.id;
  const runId = uuidv7();
  await tx
    .insert(tableSyncRuns)
    .values({ id: runId, workspaceId: sync.workspaceId, syncId: sync.id, trigger });
  await jobs?.send(
    tx,
    SYNC_QUEUE,
    { workspaceId: sync.workspaceId, syncId: sync.id, runId },
    { id: namedJobId(`openrows:sync-run:${runId}`), singletonKey: `sync:${sync.id}:${runId}` }
  );
  await pruneRuns(tx, sync.id);
  return runId;
}

/** Keeps the newest SYNC_RUN_HISTORY runs of a sync. */
export async function pruneRuns(tx: Transaction, syncId: string) {
  const keep = await tx
    .select({ id: tableSyncRuns.id })
    .from(tableSyncRuns)
    .where(eq(tableSyncRuns.syncId, syncId))
    .orderBy(desc(tableSyncRuns.createdAt), desc(tableSyncRuns.id))
    .limit(SYNC_RUN_HISTORY);
  if (keep.length < SYNC_RUN_HISTORY) return;
  await tx.delete(tableSyncRuns).where(
    and(
      eq(tableSyncRuns.syncId, syncId),
      notInArray(
        tableSyncRuns.id,
        keep.map((k) => k.id)
      )
    )
  );
}

/**
 * Changes one source's schedule, pauses or resumes it (a resume runs it now), or turns two-way
 * on or off. Turning it on (assertTwoWayAllowed) makes the caller the source's creator, whose
 * access every run uses, and queues a run unless the source is paused; turning it off makes the
 * source one-way again. Either way the last applied values are dropped: the next two-way run
 * starts again from the source's values. Resuming a two-way source checks the same rules, as the
 * person resuming becomes its creator.
 */
async function updateOne(ctx: SyncContext, row: SyncRow, input: UpdateSyncInput): Promise<SyncRow> {
  const schedule = input.schedule ?? (row.schedule as SyncSchedule);
  const set: Partial<typeof tableSyncs.$inferInsert> = {
    schedule,
    nextRunAt: nextRunAt(schedule, new Date()),
    updatedAt: new Date(),
  };
  const resume = input.paused === false && row.status === 'paused';
  const twoWay = input.twoWay ?? row.twoWay;
  const toggled = twoWay !== row.twoWay;
  if (twoWay && (toggled || resume)) await assertTwoWayAllowed(ctx, syncTarget(row));
  if (input.paused === true) Object.assign(set, { status: 'paused', pauseReason: 'paused' });
  if (resume) Object.assign(set, { status: 'active', pauseReason: null });
  // A resume runs as whoever resumed it: they become the source's reader.
  if (resume) set.createdBy = ctx.userId;
  if (toggled) {
    // Turning two-way on: the caller becomes the source's reader and writer.
    Object.assign(set, { twoWay, writeBackFieldIds: [] });
    if (twoWay) set.createdBy = ctx.userId;
    await ctx.tx.delete(tableSyncRecords).where(eq(tableSyncRecords.syncId, row.id));
  }
  const [updated] = await ctx.tx
    .update(tableSyncs)
    .set(set)
    .where(eq(tableSyncs.id, row.id))
    .returning();
  if (!updated) throw new AppError('NOT_FOUND', { detail: "This table isn't synced." });
  if (resume || (toggled && twoWay && updated.status !== 'paused')) {
    await queueRun(ctx.tx, ctx.jobs, updated, 'manual');
  }
  return updated;
}

/** What assertTwoWayAllowed checks of an existing source. */
function syncTarget(row: SyncRow): TwoWayTarget {
  return {
    tableId: row.tableId,
    syncId: row.id,
    sourceKind: row.sourceKind,
    source: row.sourceTableId ? { tableId: row.sourceTableId, viewId: row.sourceViewId } : null,
  };
}

interface TwoWayTarget {
  /** The synced table. */
  tableId: string;
  /** The source being changed; null for a new one. */
  syncId: string | null;
  sourceKind: string;
  /** A table source's table and view. */
  source: { tableId: string; viewId: string | null } | null;
}

/** A CSV, database or connector source asked to sync both ways (422). */
function oneWayOnly(): AppError {
  return invalid(
    'twoWay',
    'Only a table or view in OpenRows can sync both ways: this source syncs one way.'
  );
}

/** Lock name serializing two-way opt-ins, so two of them can't close a loop together. */
const TWO_WAY_LOCK = 'syncs:two-way';

/**
 * Whether the caller may turn two-way on for a source of `target.tableId` (422 with the reason
 * otherwise): the source is a table or view of OpenRows; it isn't the synced table itself, nor
 * joined to it already by a chain of two-way syncs (`table_sync_two_way_loop`, across every
 * workspace: one two-way sync per pair of tables, and no loops); and the caller can read it and
 * edit its records, as they would by hand (their live role, editors and up, and the source
 * table's record edit permission). A run checks the same again before it writes.
 */
export async function assertTwoWayAllowed(ctx: SyncContext, target: TwoWayTarget): Promise<void> {
  if (target.sourceKind !== 'table' || !target.source) throw oneWayOnly();
  const source = target.source;
  await ctx.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${TWO_WAY_LOCK}, 0))`);
  const { rows } = await ctx.tx.execute<{ loop: boolean }>(
    sql`SELECT table_sync_two_way_loop(${target.tableId}::uuid, ${source.tableId}::uuid, ${target.syncId}::uuid) AS loop`
  );
  if (rows[0]?.loop) {
    throw invalid(
      'twoWay',
      source.tableId === target.tableId
        ? "A table can't sync both ways with itself."
        : 'These tables are already joined by a two-way sync: another would make changes go round in a loop.'
    );
  }
  const noEdit = () =>
    invalid('twoWay', "To sync both ways, you need to be able to edit the source's records.");
  const access = await sourceAccess(ctx.tx, ctx.userId, source);
  if (!access.ok || !roleAllows(access.role, 'record:update')) throw noEdit();
  const shape = await readSourceShape(
    ctx.tx,
    { userId: ctx.userId, sourceWorkspaceId: access.workspaceId, homeWorkspaceId: ctx.workspaceId },
    source
  );
  if (!shape) throw noEdit();
  if (shape.table.synced) {
    throw invalid(
      'twoWay',
      'A synced table is never a source: syncing both ways with it would make a loop.'
    );
  }
  const who = { role: access.role, userId: ctx.userId };
  if (!permissionAllows(tablePermissionsOf(shape.table.permissions).editRecords, who)) {
    throw noEdit();
  }
}

/**
 * The table-wide change: every source of the table gets the schedule, pauses or resumes (a
 * table with one source: that source). Answers the first source.
 */
export async function updateSync(
  ctx: SyncContext,
  tableId: string,
  input: UpdateSyncInput
): Promise<TableSync> {
  const rows = await loadSyncs(ctx.tx, tableId, true);
  if (!rows.length) throw new AppError('NOT_FOUND', { detail: "This table isn't synced." });
  const updated: SyncRow[] = [];
  for (const row of rows) updated.push(await updateOne(ctx, row, input));
  const [first] = updated;
  if (!first) throw new AppError('NOT_FOUND', { detail: "This table isn't synced." });
  return toTableSync(ctx.tx, first, ctx.role);
}

/** Changes one source of the table: its schedule, or pauses or resumes it. */
export async function updateSource(
  ctx: SyncContext,
  tableId: string,
  syncId: string,
  input: UpdateSyncInput
): Promise<TableSync> {
  const row = await loadSource(ctx.tx, tableId, syncId);
  return toTableSync(ctx.tx, await updateOne(ctx, row, input), ctx.role);
}

/** "Sync now" on the whole table: a run of each active source (409 when every one is paused). */
export async function requestRun(ctx: SyncContext, tableId: string): Promise<TableSync> {
  const rows = await loadSyncs(ctx.tx, tableId, true);
  const [first] = rows;
  if (!first) throw new AppError('NOT_FOUND', { detail: "This table isn't synced." });
  const active = rows.filter((r) => r.status !== 'paused');
  if (!active.length) {
    throw new AppError('CONFLICT', { detail: 'The sync is paused: resume it to run it.' });
  }
  for (const row of active) await queueRun(ctx.tx, ctx.jobs, row, 'manual');
  return toTableSync(ctx.tx, first, ctx.role);
}

/** "Sync now" on one source (409 when it's paused). */
export async function requestSourceRun(
  ctx: SyncContext,
  tableId: string,
  syncId: string
): Promise<TableSync> {
  const row = await loadSource(ctx.tx, tableId, syncId);
  if (row.status === 'paused') {
    throw new AppError('CONFLICT', { detail: 'This source is paused: resume it to run it.' });
  }
  await queueRun(ctx.tx, ctx.jobs, row, 'manual');
  return toTableSync(ctx.tx, row, ctx.role);
}

/**
 * Stops syncing: every source goes, and the table keeps its records and fields as a normal,
 * editable table (the "Sync source" and "Sync source ID" fields stay as read-only text).
 */
export async function removeSync(ctx: SyncContext, tableId: string): Promise<void> {
  const rows = await loadSyncs(ctx.tx, tableId, true);
  if (!rows.length) throw new AppError('NOT_FOUND', { detail: "This table isn't synced." });
  await ctx.tx.update(fields).set({ synced: false }).where(eq(fields.tableId, tableId));
  await ctx.tx.update(tables).set({ synced: false }).where(eq(tables.id, tableId));
  await ctx.tx.delete(tableSyncs).where(eq(tableSyncs.tableId, tableId));
}

/**
 * Removes one source of the table. Its records stay, owned by no source: no run updates or
 * deletes them, and like every record of a synced table they are read-only until the table
 * stops syncing. Fields no remaining source fills become ordinary, editable fields; the other
 * sources keep running. The last source's removal is "Stop syncing" (removeSync).
 */
export async function removeSource(
  ctx: SyncContext,
  tableId: string,
  syncId: string
): Promise<void> {
  const rows = await loadSyncs(ctx.tx, tableId, true);
  const row = rows.find((r) => r.id === syncId);
  if (!row) throw new AppError('NOT_FOUND', { detail: 'No such source of this table.' });
  const rest = rows.filter((r) => r.id !== syncId);
  if (!rest.length) return removeSync(ctx, tableId);
  await ctx.tx.delete(tableSyncs).where(eq(tableSyncs.id, row.id));
  const filled = new Set(rest.flatMap((r) => fieldMapOf(r).map((m) => m.fieldId)));
  const kept = [row.sourceFieldId, row.ownerFieldId].filter((id): id is string => !!id);
  const freed = fieldMapOf(row)
    .map((m) => m.fieldId)
    .filter((id) => !filled.has(id) && !kept.includes(id));
  if (freed.length) {
    await ctx.tx
      .update(fields)
      .set({ synced: false })
      .where(and(eq(fields.tableId, tableId), inArray(fields.id, freed)));
  }
}

/** Due syncs per scheduler run; the rest wait for the next minute. */
const DUE_BATCH = 200;

/**
 * The `syncs.schedule` job (every minute): queues a run of each active scheduled sync whose
 * next run is due, and moves its next run past now (a sync that fell behind runs once).
 */
export async function scheduleDueSyncs(
  db: Database,
  jobs: Jobs,
  now: () => Date = () => new Date()
): Promise<{ queued: number }> {
  const { rows } = await db.execute<{ id: string; workspace_id: string }>(
    sql`SELECT id, workspace_id FROM table_syncs_due(${DUE_BATCH})`
  );
  let queued = 0;
  for (const due of rows) {
    await withTenant(db, due.workspace_id, async (tx) => {
      const [row] = await tx
        .select()
        .from(tableSyncs)
        .where(eq(tableSyncs.id, due.id))
        .for('update', { skipLocked: true });
      if (row?.status !== 'active' || row.schedule === 'manual') return;
      await queueRun(tx, jobs, row, 'schedule');
      await tx
        .update(tableSyncs)
        .set({ nextRunAt: nextRunAt(row.schedule as SyncSchedule, now()) })
        .where(eq(tableSyncs.id, row.id));
      queued++;
    });
  }
  return { queued };
}

/** A field's registry definition by its row. */
export function defOf(row: FieldRow) {
  return getFieldType(fieldType(row));
}
