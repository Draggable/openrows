import {
  type BrowseConnectorInput,
  browseConnectorSchema,
  type ConnectorItems,
  type CreateSyncInput,
  createSyncSchema,
  type ExternalSyncSource,
  getFieldType,
  MAX_SYNC_FIELDS,
  MAX_SYNCS_PER_BASE,
  type PreviewSyncInput,
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
  type TableSync,
  type UpdateSyncInput,
  type UserRole,
} from '@openrows/shared';
import { and, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { effectiveRole } from '../authz/policy.js';
import { resolveResource } from '../authz/resolve.js';
import { setScope } from '../authz/scope.js';
import {
  bases,
  type Database,
  fields,
  type Transaction,
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

/**
 * Source types copied as they are (same type and options); every other type (links, lookups,
 * formulas, attachments, people, system fields…) is copied as its display text in a long text
 * field, so a synced table never points at records, files or people of the source.
 */
const COPIED_TYPES: ReadonlySet<string> = new Set([
  'singleLineText',
  'longText',
  'number',
  'currency',
  'percent',
  'checkbox',
  'date',
  'dateTime',
  'duration',
  'rating',
  'singleSelect',
  'multipleSelect',
  'email',
  'url',
  'phone',
  'barcode',
]);

/** The synced field's type and options for a source field. */
export function targetTypeOf(source: FieldRow): {
  type: string;
  options: Record<string, unknown>;
} {
  const type = fieldType(source);
  if (COPIED_TYPES.has(type)) {
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

/** The table's sync (404 when it isn't synced), optionally locked for the transaction. */
export async function loadSync(tx: Transaction, tableId: string, lock = false): Promise<SyncRow> {
  const query = tx.select().from(tableSyncs).where(eq(tableSyncs.tableId, tableId));
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw new AppError('NOT_FOUND', { detail: "This table isn't synced." });
  return row;
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

/**
 * Creates a synced table in the base: checks the caller can read the source (in this or
 * another workspace they belong to), makes the table with the source's fields (the primary first,
 * copied types as they are, the rest as text) plus its "Sync source" field, and queues the first
 * run. 422 for a source field that isn't the source's, 404 for a source the caller can't read.
 */
export async function createSync(ctx: SyncContext, input: CreateSyncInput): Promise<TableSync> {
  const parsed = createSyncSchema.parse(input);
  const { source } = parsed;
  if (source.kind === 'csv' || source.kind === 'postgres' || source.kind === 'connector') {
    return createExternalSync(ctx, { ...parsed, source });
  }
  const body = { ...parsed, source };
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

  await assertSyncRoom(ctx);

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

  const [base] = await ctx.tx.select().from(bases).where(eq(bases.id, ctx.baseId));
  if (!base) throw new Error('authorized base not visible under RLS');
  const schema = { tx: ctx.tx, workspaceId: ctx.workspaceId, userId: ctx.userId };
  const name = body.name ?? freeName(await tableNames(ctx), shape.table.name);
  const table = await createTable(schema, base, { name, primaryFieldName: primary.name });
  const [targetPrimary] = await liveFields(ctx.tx, table.id);
  if (!targetPrimary) throw new Error('synced table without its primary field');
  const map: FieldMapEntry[] = [];
  const names = new Set([primary.name.toLowerCase()]);
  // The primary keeps single line text unless the source's is a copied type of its own.
  const primaryType = targetTypeOf(primary);
  if (primaryType.type !== 'longText' && primaryType.type !== 'singleLineText') {
    await updateField(schema, targetPrimary, {
      type: primaryType.type as never,
      options: primaryType.options,
    });
  }
  map.push({ sourceFieldId: primary.id, fieldId: targetPrimary.id });
  const tableRow = await ctx.tx.select().from(tables).where(eq(tables.id, table.id));
  const target = tableRow[0];
  if (!target) throw new Error('synced table not visible');
  for (const f of ordered.slice(1)) {
    const { type, options } = targetTypeOf(f);
    const row = await createField(
      schema,
      target,
      {
        name: freeName(names, f.name),
        type: type as never,
        options,
        ...(f.description ? { description: f.description } : {}),
      },
      { sync: true }
    );
    map.push({ sourceFieldId: f.id, fieldId: row.id });
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

  const [row] = await ctx.tx
    .insert(tableSyncs)
    .values({
      id: uuidv7(),
      workspaceId: ctx.workspaceId,
      baseId: ctx.baseId,
      tableId: table.id,
      sourceWorkspaceId: access.workspaceId,
      sourceBaseId: shape.table.baseId,
      sourceTableId: shape.table.id,
      sourceViewId: shape.view?.id ?? null,
      sourceLabel: shape.label,
      keyFieldId: body.keyFieldId,
      fieldMap: map,
      sourceFieldId: sourceField.id,
      schedule: body.schedule,
      createdBy: ctx.userId,
      nextRunAt: nextRunAt(body.schedule, new Date()),
    })
    .returning();
  if (!row) throw new Error('sync insert returned nothing');
  await queueRun(ctx.tx, ctx.jobs, row, 'create');
  return toTableSync(ctx.tx, row, ctx.role);
}

/** One sync per base at a time past this point, so the cap holds under concurrent creates. */
async function assertSyncRoom(ctx: SyncContext) {
  await ctx.tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`syncs:${ctx.baseId}`}, 0))`
  );
  const [stats] = await ctx.tx
    .select({ count: sql<number>`count(*)::int` })
    .from(tableSyncs)
    .where(eq(tableSyncs.baseId, ctx.baseId));
  if ((stats?.count ?? 0) >= MAX_SYNCS_PER_BASE) {
    throw new AppError('CONFLICT', {
      detail: `A base can have at most ${MAX_SYNCS_PER_BASE} synced tables.`,
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

/**
 * Creates a table synced from a CSV URL or a Postgres source: its fields are the chosen
 * columns (the first is the primary) with their types, plus the "Sync source" field. The source
 * is checked (address rules, TLS, the query's shape) but not read: the first run, queued now,
 * reads it. The URL or connection string is stored encrypted.
 */
async function createExternalSync(
  ctx: SyncContext,
  body: ReturnType<typeof createSyncSchema.parse> & { source: ExternalSyncSource }
): Promise<TableSync> {
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
  await assertSyncRoom(ctx);

  const [base] = await ctx.tx.select().from(bases).where(eq(bases.id, ctx.baseId));
  if (!base) throw new Error('authorized base not visible under RLS');
  const schema = { tx: ctx.tx, workspaceId: ctx.workspaceId, userId: ctx.userId };
  const [first, ...rest] = typed;
  if (!first) throw invalid('columns', 'Pick the columns to sync.');
  const name = body.name ?? freeName(await tableNames(ctx), split.tableName);
  const table = await createTable(schema, base, { name, primaryFieldName: first.name });
  const [targetPrimary] = await liveFields(ctx.tx, table.id);
  if (!targetPrimary) throw new Error('synced table without its primary field');
  if (first.type !== 'singleLineText') {
    await updateField(schema, targetPrimary, { type: first.type as never, options: first.options });
  }
  const [target] = await ctx.tx.select().from(tables).where(eq(tables.id, table.id));
  if (!target) throw new Error('synced table not visible');
  const map: FieldMapEntry[] = [{ column: first.name, fieldId: targetPrimary.id }];
  const names = new Set([first.name.toLowerCase()]);
  for (const c of rest) {
    const row = await createField(
      schema,
      target,
      { name: freeName(names, c.name), type: c.type as never, options: c.options },
      { sync: true }
    );
    map.push({ column: c.name, fieldId: row.id });
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
    .where(inArray(fields.id, [...map.map((m) => m.fieldId), sourceField.id]));
  await ctx.tx.update(tables).set({ synced: true }).where(eq(tables.id, table.id));

  const [row] = await ctx.tx
    .insert(tableSyncs)
    .values({
      id: uuidv7(),
      workspaceId: ctx.workspaceId,
      baseId: ctx.baseId,
      tableId: table.id,
      sourceKind: split.kind,
      sourceConfig: split.config,
      // A connector source has no secret of its own: the creator's account reads it.
      sourceSecret: split.secret ? sources.cipher.encrypt(split.secret) : null,
      sourceLabel: split.label,
      keyColumn: body.keyColumn,
      fieldMap: map,
      sourceFieldId: sourceField.id,
      schedule: body.schedule,
      createdBy: ctx.userId,
      nextRunAt: nextRunAt(body.schedule, new Date()),
    })
    .returning();
  if (!row) throw new Error('sync insert returned nothing');
  await queueRun(ctx.tx, ctx.jobs, row, 'create');
  return toTableSync(ctx.tx, row, ctx.role);
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

/** Changes the schedule, pauses or resumes (a resume runs it now). */
export async function updateSync(
  ctx: SyncContext,
  tableId: string,
  input: UpdateSyncInput
): Promise<TableSync> {
  const row = await loadSync(ctx.tx, tableId, true);
  const schedule = input.schedule ?? (row.schedule as SyncSchedule);
  const set: Partial<typeof tableSyncs.$inferInsert> = {
    schedule,
    nextRunAt: nextRunAt(schedule, new Date()),
    updatedAt: new Date(),
  };
  const resume = input.paused === false && row.status === 'paused';
  if (input.paused === true) Object.assign(set, { status: 'paused', pauseReason: 'paused' });
  if (resume) Object.assign(set, { status: 'active', pauseReason: null });
  // A resume runs as whoever resumed it: they become the sync's reader of the source.
  if (resume) set.createdBy = ctx.userId;
  const [updated] = await ctx.tx
    .update(tableSyncs)
    .set(set)
    .where(eq(tableSyncs.id, row.id))
    .returning();
  if (!updated) throw new AppError('NOT_FOUND', { detail: "This table isn't synced." });
  if (resume) await queueRun(ctx.tx, ctx.jobs, updated, 'manual');
  return toTableSync(ctx.tx, updated, ctx.role);
}

/** "Sync now": queues a run of an active sync (409 when it's paused). */
export async function requestRun(ctx: SyncContext, tableId: string): Promise<TableSync> {
  const row = await loadSync(ctx.tx, tableId, true);
  if (row.status === 'paused') {
    throw new AppError('CONFLICT', { detail: 'The sync is paused: resume it to run it.' });
  }
  await queueRun(ctx.tx, ctx.jobs, row, 'manual');
  return toTableSync(ctx.tx, row, ctx.role);
}

/**
 * Stops syncing: the table keeps its records and fields as a normal, editable table (the "Sync
 * source" field stays as read-only text).
 */
export async function removeSync(ctx: SyncContext, tableId: string): Promise<void> {
  const row = await loadSync(ctx.tx, tableId, true);
  await ctx.tx.update(fields).set({ synced: false }).where(eq(fields.tableId, row.tableId));
  await ctx.tx.update(tables).set({ synced: false }).where(eq(tables.id, row.tableId));
  await ctx.tx.delete(tableSyncs).where(eq(tableSyncs.id, row.id));
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
