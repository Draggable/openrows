import {
  type Aggregate,
  type AttachmentValue,
  type BulkUpdateRecordsInput,
  type ChoiceColor,
  type FieldTypeDef,
  type FilterCondition,
  type FilterGroup,
  getFieldType,
  gridLayoutOf,
  type LinkCandidatesQuery,
  type ListRecordsQuery,
  MAX_CHOICE_NAME,
  type ProblemFieldError,
  pruneGridLayout,
  pruneViewQuery,
  type QueryRecordsInput,
  RecordSchema,
  type RecordTrashQuery,
  type RowColorCondition,
  roleAllows,
  type SavedViewQuery,
  type SharedRecord,
  type SharedViewShape,
  savedQueryOf,
  sharedViewShape,
  TRASH_RETENTION_DAYS,
  type UserRole,
  type ViewQuery,
  viewQuerySchema,
} from '@openrows/shared';
import { and, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { canonicalAttachments } from '../attachments/service.js';
import { qualified, readExpression, storageOf } from '../data/columns.js';
import { type Dirty, markDirty, recompute, recomputeForRecords } from '../data/computed/engine.js';
import { emitMany, type OutboxEvent } from '../data/outbox.js';
import { manualOrderKey } from '../data/positions.js';
import {
  aggregatesFor,
  compileViewQuery,
  decodeCursor,
  encodeCursor,
  type Predicate,
  type QueryField,
  QueryValidationError,
  type SortKey,
} from '../data/query/compile.js';
import {
  countRecords,
  type GroupValueFn,
  type PageRow,
  selectAggregates,
  selectGroups,
  selectGroupValues,
  selectRecords,
} from '../data/query/execute.js';
import {
  recordComments,
  recordRevisions as revisionsTable,
  type Transaction,
  users,
  views,
} from '../db/index.js';
import type { Entitlements } from '../edition/types.js';
import {
  addChoices,
  type FieldRow,
  fieldType,
  liveFields,
  type TableRow,
} from '../fields/service.js';
import { AppError } from '../lib/errors.js';
import { createNotifications, type NewNotification } from '../notifications/repo.js';
import { type Changes, type RevisionInput, writeRevisions } from '../revisions/repo.js';
import { addRecords } from '../usage/counters.js';
import { assertRecordRoom } from '../usage/quota.js';
import { visibleTo } from '../views/visibility.js';
import {
  decodeLinks,
  inverseEvents,
  type LinkSpec,
  linkedRecords,
  linkSpecs,
  linkTokens,
  matchNames,
  missingTargets,
  nameCandidates,
  outsideView,
  resolveTokens,
  writeLinks,
} from './links.js';
import {
  assertCellsAllowed,
  assertNoSyncedCells,
  assertNotSyncedTable,
  assertTableAllows,
} from './permissions.js';
import {
  insertRows,
  lockByIds,
  type RawRecord,
  type ReadColumn,
  type RowValues,
  selectByIds,
  selectPage,
  setDeleted,
  updateRows,
  type WriteColumn,
} from './repo.js';

/**
 * The RecordService (ADR-003): every record mutation (REST today; forms, the public API,
 * automations and the WebSocket later) goes through here. Each call runs in the request's
 * authorized, workspace-scoped transaction, so a batch of up to 1,000 records, its validation
 * and its outbox events commit or roll back together.
 */

/** Who is reading, which (already authorized) table, in which transaction. */
export interface RecordReadContext {
  tx: Transaction;
  workspaceId: string;
  userId: string;
  table: TableRow;
}

/** Who is writing, to which (already authorized) table, in which transaction. */
export interface RecordContext extends RecordReadContext {
  clientOpId?: string;
  /** Create missing select options from the cells' names. Needs `role` with `field:update`. */
  typecast?: boolean;
  /**
   * The writer's role on the table (the route's): typecast's schema-rights check and the table
   * and field edit permissions every write is checked against.
   */
  role: UserRole;
  /**
   * Link cell text that matches no record of the linked table: `create` the records,
   * `skip` the names, or an `error` (422). Defaults to `create` with typecast, else `error`.
   */
  unmatchedLinks?: 'create' | 'skip' | 'error';
  /**
   * Whether typecast may add select options; default: `role` allows `field:update`. A personal
   * access token without `schema.bases:write` can't, whatever the user's role.
   */
  mayAddChoices?: boolean;
  /** The revision a restore brings back: recorded on the new revision, never coalesced. */
  restoredFrom?: string;
  /**
   * The workspace's plan: creates and restores past its records per base are refused
   * (QUOTA_EXCEEDED); updates and deletes never are.
   */
  entitlements: Entitlements;
  /**
   * A write no person makes: a public form's submission, through this form link. The
   * stored actor (`created_by`, events, revisions) is then null and revisions say
   * `via: 'form'`; `userId` is only the edit-permission subject. Attachment cells then take
   * only files uploaded through this link and not yet submitted.
   */
  form?: { shareId: string };
  /**
   * The sync engine's write: the only writer of a synced table's records, its synced
   * fields and its "Sync source" cells. Anyone else gets 403 EDIT_RESTRICTED there.
   */
  sync?: { syncId: string };
  /**
   * An automation's step: the write is the run's person's (`userId`, their role and
   * edit permissions), and its revisions say `via: 'automation'`.
   */
  automation?: { automationId: string };
}

/** The actor stored with a write: the user, or null for a public form's submission. */
const actorOf = (ctx: RecordContext): string | null => (ctx.form ? null : ctx.userId);

/** A live field with its parsed options and registry definition (and junction, for links). */
export interface FieldInfo {
  row: FieldRow;
  def: FieldTypeDef;
  options: unknown;
  link?: LinkSpec;
}

function fieldInfo(row: FieldRow, link?: LinkSpec): FieldInfo {
  const def = getFieldType(fieldType(row));
  return {
    row,
    def,
    options: def.optionsSchema.parse(row.config ?? {}),
    ...(link ? { link } : {}),
  };
}

/**
 * The live fields of a table with their link specs. A link field whose linked table can't be
 * found (it isn't in this base any more) is left out rather than read wrongly.
 */
export async function tableFields(tx: Transaction, table: TableRow): Promise<FieldInfo[]> {
  const rows = await liveFields(tx, table.id);
  const specs = await linkSpecs(tx, table, rows);
  return rows.flatMap((row) => {
    if (row.type !== 'link') return [fieldInfo(row)];
    const spec = specs.get(row.id);
    return spec ? [fieldInfo(row, spec)] : [];
  });
}

async function loadFields(ctx: RecordReadContext): Promise<FieldInfo[]> {
  return tableFields(ctx.tx, ctx.table);
}

/** Most records one write may create in linked tables from unmatched names (typecast). */
export const MAX_TYPECAST_RECORDS = 1000;

/**
 * Link cells naming records by their primary field (paste, CSV import, the API with text)
 * become record ids: text matches a live record of the linked table by its primary value
 * (ignoring case, whole text first, then its comma-separated parts). With `ctx.typecast`, names
 * nothing matches become new records of the linked table (the writer can create records there:
 * same base, same role); without, they're a 422 naming each cell. Answers the inputs with ids.
 */
async function resolveLinkNames(
  ctx: RecordContext,
  fields: FieldInfo[],
  inputs: { path: string; cells: Record<string, unknown> }[]
): Promise<Record<string, unknown>[]> {
  const links = fields.filter((f) => f.link);
  const out = inputs.map((i) => ({ ...i.cells }));
  if (!links.length) return out;
  const errors: ProblemFieldError[] = [];
  for (const f of links) {
    const spec = f.link as LinkSpec;
    const tokens = inputs.map((i) =>
      Object.hasOwn(i.cells, f.row.id) ? linkTokens(i.cells[f.row.id]) : null
    );
    const names = tokens.flatMap((t) =>
      (t ?? []).flatMap((x) => ('name' in x ? nameCandidates(x.name) : []))
    );
    if (!names.length) continue;
    let matched = await matchNames(ctx.tx, spec, names);
    const unmatched = new Map<string, string>();
    tokens.forEach((t) => {
      for (const n of t ? resolveTokens(t, matched).unmatched : [])
        unmatched.set(n.toLowerCase(), n);
    });
    const mode = ctx.unmatchedLinks ?? (ctx.typecast ? 'create' : 'error');
    if (unmatched.size && mode === 'create') {
      matched = new Map([...matched, ...(await createNamed(ctx, f, [...unmatched.values()]))]);
    }
    tokens.forEach((t, i) => {
      if (!t) return;
      const { ids, unmatched: missing } = resolveTokens(t, matched);
      const cells = out[i] as Record<string, unknown>;
      if (missing.length && mode === 'error') {
        errors.push({
          path: `${inputs[i]?.path}.${f.row.id}`,
          message: `No record named ${missing.map((n) => `"${n}"`).join(', ')} in "${spec.target.name}".`,
        });
      }
      cells[f.row.id] = ids;
    });
  }
  failIfInvalid(errors);
  return out;
}

/** Typecast for links: creates one record per name in the linked table; lower name → id. */
async function createNamed(
  ctx: RecordContext,
  f: FieldInfo,
  names: string[]
): Promise<Map<string, string>> {
  const spec = f.link as LinkSpec;
  const target = await tableFields(ctx.tx, spec.target);
  const primary = target.find((t) => t.row.isPrimary);
  if (!primary || primary.def.readOnly || primary.link) {
    throw new AppError('VALIDATION_FAILED', {
      detail: `Records of "${spec.target.name}" can't be created from names.`,
    });
  }
  if (names.length > MAX_TYPECAST_RECORDS) {
    throw new AppError('VALIDATION_FAILED', {
      detail: `One write can create at most ${MAX_TYPECAST_RECORDS} linked records.`,
    });
  }
  const created = await createRecords(
    { ...ctx, table: spec.target, typecast: false },
    names.map((name) => ({ [primary.row.id]: name }))
  );
  return new Map(created.map((r, i) => [(names[i] as string).toLowerCase(), r.id]));
}

/**
 * Typecast: when `ctx.typecast` is set, the option names in the cells of choice fields
 * that match no option become new options (`addChoices`: the field rows locked, in this
 * transaction) before the cells are coerced. Without schema rights that's a 422
 * TYPECAST_FORBIDDEN naming each cell. Answers the fields with their current options.
 */
async function applyTypecast(
  ctx: RecordContext,
  fields: FieldInfo[],
  inputs: { path: string; cells: Record<string, unknown> }[]
): Promise<FieldInfo[]> {
  if (!ctx.typecast) return fields;
  const byId = new Map(fields.map((f) => [f.row.id, f]));
  const wanted = new Map<string, string[]>();
  const errors: ProblemFieldError[] = [];
  const cellsNaming: ProblemFieldError[] = [];
  for (const { path, cells } of inputs) {
    for (const [fieldId, raw] of Object.entries(cells)) {
      const field = byId.get(fieldId);
      const names = field?.def.unknownChoices?.(raw, field.options) ?? [];
      if (!field || !names.length) continue;
      const at = `${path}.${fieldId}`;
      if (names.some((n) => n.length > MAX_CHOICE_NAME)) {
        errors.push({ path: at, message: `Options are at most ${MAX_CHOICE_NAME} characters.` });
        continue;
      }
      wanted.set(fieldId, [...(wanted.get(fieldId) ?? []), ...names]);
      cellsNaming.push({
        path: at,
        message: `${names.map((n) => `"${n}"`).join(', ')} isn't an option of "${field.row.name}".`,
      });
    }
  }
  failIfInvalid(errors);
  if (!wanted.size) return fields;
  if (!roleAllows(ctx.role, 'field:update') || ctx.mayAddChoices === false) {
    throw new AppError('TYPECAST_FORBIDDEN', {
      detail: 'Only owners and creators can add select options.',
      extensions: { errors: cellsNaming },
    });
  }
  const scope = { tx: ctx.tx, workspaceId: ctx.workspaceId, userId: ctx.userId };
  const current = new Map(
    (await addChoices(scope, ctx.table, wanted)).map((row) => [row.id, fieldInfo(row)])
  );
  return fields.map((f) => current.get(f.row.id) ?? f);
}

function isBlank(input: unknown): boolean {
  return (
    input === null ||
    input === undefined ||
    (typeof input === 'string' && input.trim() === '') ||
    (Array.isArray(input) && input.length === 0)
  );
}

/** A validated cell: the field, its value and what goes into the column. */
interface Cell {
  field: FieldInfo;
  value: unknown;
  storage: unknown;
}

/**
 * Validates and coerces one record's cells through the registry. Unknown (or trashed) fields,
 * read-only fields and values that can't be read as the field's type are collected in `errors`.
 */
function prepareCells(
  byId: Map<string, FieldInfo>,
  input: Record<string, unknown>,
  path: string,
  errors: ProblemFieldError[],
  /** The sync engine writes its table's "Sync source" cells. */
  sync = false
): Map<string, Cell> {
  const cells = new Map<string, Cell>();
  for (const [fieldId, raw] of Object.entries(input)) {
    const at = `${path}.${fieldId}`;
    const field = byId.get(fieldId);
    if (!field) {
      errors.push({ path: at, message: 'No such field in this table.' });
      continue;
    }
    if ((field.def.readOnly || field.def.computed) && !(sync && field.def.name === 'syncSource')) {
      errors.push({ path: at, message: `"${field.row.name}" is computed and can't be set.` });
      continue;
    }
    const value = field.def.coerce(raw, field.options);
    const empty = value === null || value === field.def.emptyValue;
    if (value === null && !isBlank(raw)) {
      errors.push({ path: at, message: `Not a valid ${field.def.label.toLowerCase()} value.` });
      continue;
    }
    if (!empty && !field.def.valueSchema(field.options).safeParse(value).success) {
      errors.push({ path: at, message: `Not a valid ${field.def.label.toLowerCase()} value.` });
      continue;
    }
    cells.set(fieldId, { field, value, storage: field.def.toStorage(value, field.options) });
  }
  return cells;
}

/**
 * Attachment cells may only name ready files of this table's base (a file id from another
 * base or workspace, or one never confirmed, is a 422), and they carry the server's metadata.
 * Files are rows the registry can't see, so this check lives here, next to the write.
 */
async function checkAttachments(
  ctx: RecordContext,
  prepared: { cells: Map<string, Cell> }[],
  errors: ProblemFieldError[]
) {
  const targets: { cell: Cell; path: string; value: AttachmentValue[] }[] = [];
  prepared.forEach((p, i) => {
    for (const [fieldId, cell] of p.cells) {
      if (cell.field.def.name !== 'attachment' || !Array.isArray(cell.value)) continue;
      targets.push({ cell, path: `records.${i}.fields.${fieldId}`, value: cell.value });
    }
  });
  if (!targets.length) return;
  const values = await canonicalAttachments(ctx.tx, ctx.table, targets, errors, ctx.form);
  targets.forEach(({ cell }, i) => {
    const value = values[i]?.length ? values[i] : null;
    cell.value = value;
    cell.storage = cell.field.def.toStorage(value, cell.field.options);
  });
}

/**
 * User cells may only name current collaborators of the table's base: workspace members
 * and the base's own collaborators (both under the tenant's RLS policy in this transaction).
 * Anyone else is a 422, so ids never leak who exists elsewhere. On an update, people already in
 * the cell (a former member, say) may stay: Airtable keeps removed collaborators in cells.
 */
async function checkUsers(
  ctx: RecordContext,
  prepared: { id: string; cells: Map<string, Cell> }[],
  errors: ProblemFieldError[],
  existing: boolean
) {
  const targets: { cell: Cell; path: string; recordId: string; ids: string[] }[] = [];
  prepared.forEach((p, i) => {
    for (const [fieldId, cell] of p.cells) {
      if (cell.field.def.name !== 'user' || !Array.isArray(cell.value)) continue;
      const ids = cell.value as string[];
      targets.push({ cell, path: `records.${i}.fields.${fieldId}`, recordId: p.id, ids });
    }
  });
  if (!targets.length) return;
  const all = [...new Set(targets.flatMap((t) => t.ids))];
  const { rows } = await ctx.tx.execute<{ user_id: string }>(sql`
    SELECT wm.user_id::text AS user_id FROM workspace_members wm
     WHERE wm.workspace_id = ${ctx.workspaceId} AND wm.user_id = ANY(${`{${all.join(',')}}`}::uuid[])
    UNION
    SELECT bm.user_id::text FROM base_members bm
     WHERE bm.base_id = ${ctx.table.baseId} AND bm.user_id = ANY(${`{${all.join(',')}}`}::uuid[])
    UNION
    SELECT im.user_id::text FROM interface_members im
      JOIN interfaces i ON i.workspace_id = im.workspace_id AND i.id = im.interface_id
     WHERE i.base_id = ${ctx.table.baseId} AND im.user_id = ANY(${`{${all.join(',')}}`}::uuid[])`);
  const allowed = new Set(rows.map((r) => r.user_id));
  const kept = existing ? await currentUsers(ctx, targets) : new Map<string, Set<string>>();
  for (const t of targets) {
    const before = kept.get(`${t.recordId}:${t.cell.field.row.id}`);
    if (t.ids.some((id) => !allowed.has(id) && !before?.has(id))) {
      errors.push({ path: t.path, message: 'Only collaborators of this base can be added.' });
    }
  }
}

/** The people in the user cells being updated, by `recordId:fieldId`. */
async function currentUsers(
  ctx: RecordContext,
  targets: { cell: Cell; recordId: string }[]
): Promise<Map<string, Set<string>>> {
  const fields = [...new Map(targets.map((t) => [t.cell.field.row.id, t.cell.field])).values()];
  const recordIds = [...new Set(targets.map((t) => t.recordId))];
  const cols = fields.map(
    (f, i) => sql`, ${sql.identifier(f.row.dbColumn)} AS ${sql.identifier(`c${i}`)}`
  );
  const { rows } = await ctx.tx.execute<Record<string, unknown>>(sql`
    SELECT r.id::text AS id${sql.join(cols, sql``)} FROM ${qualified(ctx.table)} AS r
     WHERE r.id = ANY(${`{${recordIds.join(',')}}`}::uuid[])`);
  const out = new Map<string, Set<string>>();
  for (const row of rows) {
    fields.forEach((f, i) => {
      const v = row[`c${i}`];
      if (Array.isArray(v)) out.set(`${String(row['id'])}:${f.row.id}`, new Set(v.map(String)));
    });
  }
  return out;
}

/**
 * Link cells may only name live records of the linked table: ids from another table, base
 * or workspace are a 404, as if the record didn't exist (it doesn't, for this link). With "limit
 * to a view" (`viewIdForRecordSelection`), the records must also be in that view (422).
 */
async function checkLinks(
  ctx: RecordContext,
  prepared: { cells: Map<string, Cell> }[],
  errors: ProblemFieldError[]
) {
  const byField = new Map<
    string,
    { field: FieldInfo; ids: Set<string>; paths: Map<string, string[]> }
  >();
  prepared.forEach((p, i) => {
    for (const [fieldId, cell] of p.cells) {
      if (!cell.field.link || !Array.isArray(cell.value)) continue;
      const entry = byField.get(fieldId) ?? { field: cell.field, ids: new Set(), paths: new Map() };
      for (const item of cell.value as { id: string }[]) {
        entry.ids.add(item.id);
        entry.paths.set(item.id, [
          ...(entry.paths.get(item.id) ?? []),
          `records.${i}.fields.${fieldId}`,
        ]);
      }
      byField.set(fieldId, entry);
    }
  });
  for (const { field, ids, paths } of byField.values()) {
    const spec = field.link as LinkSpec;
    const missing = await missingTargets(ctx.tx, spec, [...ids]);
    if (missing.length) {
      throw new AppError('NOT_FOUND', {
        detail: `${missing.length} linked record(s) aren't in "${spec.target.name}".`,
        extensions: { recordIds: missing },
      });
    }
    const viewId = spec.options.viewIdForRecordSelection;
    if (!viewId) continue;
    const where = await linkViewWhere(ctx, spec, viewId);
    if (!where) continue;
    for (const id of await outsideView(ctx.tx, spec, [...ids], where)) {
      for (const path of paths.get(id) ?? []) {
        errors.push({ path, message: `Record ${id} isn't in the view this field is limited to.` });
      }
    }
  }
}

/**
 * The filter of the linked table's view a link field is limited to (alias `r`), or `null` when
 * the view is gone (the limit lapses, as in Airtable).
 */
export async function linkViewWhere(ctx: RecordReadContext, spec: LinkSpec, viewId: string) {
  const targetCtx = { ...ctx, table: spec.target };
  // A personal view never limits a link: its filter isn't everyone's to see.
  const [view] = await ctx.tx
    .select({ config: views.config })
    .from(views)
    .where(
      and(
        eq(views.id, viewId),
        eq(views.tableId, spec.target.id),
        isNull(views.deletedAt),
        eq(views.personal, false)
      )
    );
  if (!view) return null;
  const queryFields = toQueryFields(await loadFields(targetCtx));
  const stored = pruneViewQuery(
    savedQueryOf((view.config ?? {}) as Record<string, unknown>),
    queryFields
  );
  const query = viewQuerySchema.parse({ filter: stored.filter });
  return compileViewQuery(query, queryFields, { userId: ctx.userId }).where;
}

/**
 * Writes the link cells of `prepared` (records of this table) to their junctions and answers
 * the other side's `record.updated` events.
 */
async function applyLinks(
  ctx: RecordContext,
  prepared: { id: string; cells: Map<string, Cell> }[],
  dirty: Dirty
): Promise<OutboxEvent[]> {
  const byField = new Map<
    string,
    { field: FieldInfo; writes: { recordId: string; ids: string[] }[] }
  >();
  for (const p of prepared) {
    for (const [fieldId, cell] of p.cells) {
      if (!cell.field.link) continue;
      const entry = byField.get(fieldId) ?? { field: cell.field, writes: [] };
      const ids = Array.isArray(cell.value)
        ? (cell.value as { id: string }[]).map((x) => x.id)
        : [];
      entry.writes.push({ recordId: p.id, ids });
      byField.set(fieldId, entry);
    }
  }
  const events: OutboxEvent[] = [];
  for (const { field, writes } of byField.values()) {
    const spec = field.link as LinkSpec;
    const changed = await writeLinks(ctx.tx, spec, writes);
    // Both sides' link cells changed: computed fields reading either link recompute.
    markDirty(
      dirty,
      spec.field.id,
      writes.map((w) => w.recordId)
    );
    if (spec.inverse) markDirty(dirty, spec.inverse.id, changed);
    events.push(...(await inverseEvents(ctx.tx, spec, changed, eventBase(ctx))));
  }
  return events;
}

/** The other side's events for records of this table that were deleted or restored. */
async function neighbourEvents(ctx: RecordContext, fields: FieldInfo[], ids: string[]) {
  const events: OutboxEvent[] = [];
  for (const f of fields) {
    if (!f.link?.inverse) continue;
    const others = await linkedRecords(ctx.tx, f.link, ids);
    events.push(...(await inverseEvents(ctx.tx, f.link, others, eventBase(ctx))));
  }
  return events;
}

/** Recomputes the lookups, rollups and counts the write made stale, with their events. */
function recomputeDirty(ctx: RecordContext, dirty: Dirty) {
  return recompute(ctx.tx, ctx.table.baseId, dirty, { events: changeOf(ctx) });
}

/** The writer, for the edit permissions. */
const who = (ctx: RecordContext) => ({ role: ctx.role, userId: ctx.userId });

const changeOf = (ctx: RecordContext) => ({
  workspaceId: ctx.workspaceId,
  userId: actorOf(ctx),
  ...(ctx.clientOpId ? { clientOpId: ctx.clientOpId } : {}),
});

const eventBase = (ctx: RecordContext) => ({
  workspaceId: ctx.workspaceId,
  actorId: actorOf(ctx),
  clientOpId: ctx.clientOpId,
});

/**
 * Notifications for people a write adds to user fields with `notify`: `before` holds the
 * cells' previous values by record id (none for new records). The new people were checked as
 * collaborators of the base by `checkUsers`; the writer is never notified.
 */
async function notifyAssignments(
  ctx: RecordContext,
  written: Iterable<FieldInfo>,
  records: { id: string; fields: Record<string, unknown> }[],
  before: Map<string, { fields: Record<string, unknown> }>
) {
  const notifying = [...written].filter(
    (f) => f.def.name === 'user' && (f.options as { notify?: boolean }).notify === true
  );
  if (notifying.length === 0) return;

  const ids = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
  const items: NewNotification[] = [];
  for (const r of records) {
    for (const f of notifying) {
      if (!(f.row.id in r.fields)) continue;
      const had = new Set(ids(before.get(r.id)?.fields[f.row.id]));
      for (const userId of ids(r.fields[f.row.id])) {
        if (!had.has(userId)) {
          items.push({ userId, kind: 'assigned', recordId: r.id, fieldId: f.row.id });
        }
      }
    }
  }
  await createNotifications(
    ctx.tx,
    {
      workspaceId: ctx.workspaceId,
      baseId: ctx.table.baseId,
      tableId: ctx.table.id,
      actorId: actorOf(ctx),
    },
    items
  );
}

/** Records the write's revisions, in its transaction, next to its outbox events. */
function recordRevisions(ctx: RecordContext, inputs: RevisionInput[]) {
  return writeRevisions(
    ctx.tx,
    {
      workspaceId: ctx.workspaceId,
      baseId: ctx.table.baseId,
      tableId: ctx.table.id,
      actorId: actorOf(ctx),
      via: ctx.form ? 'form' : ctx.automation ? 'automation' : undefined,
      clientOpId: ctx.clientOpId,
      restoredFrom: ctx.restoredFrom,
    },
    inputs
  );
}

function failIfInvalid(errors: ProblemFieldError[]) {
  if (errors.length) {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'Some cell values are invalid.',
      extensions: { errors },
    });
  }
}

const writeColumnOf = (f: FieldInfo): WriteColumn => {
  const storage = storageOf(f.row.type);
  // A "Sync source" cell is written by its sync only (prepareCells lets nothing else).
  const generated = storage.kind === 'computed' && f.row.type === 'syncSource';
  if (storage.kind !== 'column' && !generated) {
    throw new Error(`field ${f.row.id} has no writable column`);
  }
  return { column: f.row.dbColumn, sqlType: storage.sqlType };
};

/** Column values of a record's cells (link cells live in junctions, not columns). */
function rowValues(id: string, cells: Map<string, Cell>): RowValues {
  const values: Record<string, unknown> = {};
  for (const cell of cells.values()) {
    if (!cell.field.link) values[cell.field.row.dbColumn] = cell.storage;
  }
  return { id, values };
}

/** Turns a raw row into the API's record, every live field included (`null` when empty). */
function toRecord(table: TableRow, fields: FieldInfo[], raw: RawRecord) {
  const values: Record<string, unknown> = {};
  for (const f of fields) {
    const stored = f.link ? decodeLinks(f.link.read, raw[f.row.id]) : raw[f.row.id];
    values[f.row.id] = f.def.fromStorage(stored, f.options);
  }
  return RecordSchema.parse({
    id: raw.id,
    tableId: table.id,
    version: raw.version,
    fields: values,
    createdAt: new Date(raw.created_at).toISOString(),
    createdBy: raw.created_by,
    updatedAt: new Date(raw.updated_at).toISOString(),
    updatedBy: raw.updated_by,
  });
}

const readColumns = (fields: FieldInfo[]) =>
  fields.map((f) => ({
    id: f.row.id,
    type: f.row.type,
    dbColumn: f.row.dbColumn,
    ...(f.link ? { link: f.link.read } : {}),
  }));

async function readRecords(ctx: RecordReadContext, fields: FieldInfo[], ids: string[]) {
  const columns = readColumns(fields);
  const rows = await selectByIds(ctx.tx, ctx.table, columns, ids);
  const byId = new Map(rows.map((r) => [r.id, toRecord(ctx.table, fields, r)]));
  // In request order.
  return ids.flatMap((id) => byId.get(id) ?? []);
}

function event(
  ctx: RecordContext,
  kind: 'record.created' | 'record.updated' | 'record.deleted' | 'record.restored',
  payload: Record<string, unknown>
) {
  return {
    workspaceId: ctx.workspaceId,
    baseId: ctx.table.baseId,
    tableId: ctx.table.id,
    kind,
    payload,
    actorId: actorOf(ctx),
    clientOpId: ctx.clientOpId,
  };
}

function assertUnique(ids: string[]) {
  const seen = new Set<string>();
  const errors: ProblemFieldError[] = [];
  ids.forEach((id, i) => {
    if (seen.has(id)) errors.push({ path: `records.${i}.id`, message: 'Listed twice.' });
    seen.add(id);
  });
  failIfInvalid(errors);
}

function notFound(ids: string[]): never {
  throw new AppError('NOT_FOUND', {
    detail: `${ids.length} record(s) aren't in this table.`,
    extensions: { recordIds: ids },
  });
}

/** Creates records (one statement), each with a new UUIDv7 id, and one outbox event each. */
export async function createRecords(ctx: RecordContext, inputs: Record<string, unknown>[]) {
  const withPaths = inputs.map((cells, i) => ({ path: `records.${i}.fields`, cells }));
  const loaded = await loadFields(ctx);
  // Permissions first: nothing (no typecast option, no linked record) happens on a refusal.
  if (!ctx.sync) assertNotSyncedTable(ctx.table, 'add');
  assertTableAllows(ctx.table, 'addRecords', who(ctx));
  assertCellsAllowed(ctx.table, loaded, withPaths, who(ctx), ctx.form ? 'form' : 'create');
  // The plan's records per base, before anything (a select option, a linked record) is made.
  await assertRecordRoom(ctx.tx, ctx.entitlements, ctx.table.baseId, inputs.length);
  const fields = await applyTypecast(ctx, loaded, withPaths);
  const resolved = await resolveLinkNames(ctx, fields, withPaths);
  const byId = new Map(fields.map((f) => [f.row.id, f]));
  const errors: ProblemFieldError[] = [];
  const prepared = resolved.map((input, i) => ({
    id: uuidv7(),
    cells: prepareCells(byId, input, `records.${i}.fields`, errors, Boolean(ctx.sync)),
  }));
  await checkAttachments(ctx, prepared, errors);
  await checkUsers(ctx, prepared, errors, false);
  await checkLinks(ctx, prepared, errors);
  failIfInvalid(errors);

  const used = new Map<string, FieldInfo>();
  for (const p of prepared) {
    for (const c of p.cells.values()) if (!c.field.link) used.set(c.field.row.id, c.field);
  }
  await insertRows(
    ctx.tx,
    ctx.table,
    [...used.values()].map(writeColumnOf),
    prepared.map((p) => rowValues(p.id, p.cells)),
    actorOf(ctx)
  );
  const dirty: Dirty = new Map();
  const linkEvents = await applyLinks(ctx, prepared, dirty);
  // New records: every computed field of the table computes (a count of no links is 0).
  for (const f of fields) {
    markDirty(
      dirty,
      f.row.id,
      prepared.map((p) => p.id)
    );
  }
  await recomputeDirty(ctx, dirty);
  const records = await readRecords(
    ctx,
    fields,
    prepared.map((p) => p.id)
  );
  await emitMany(ctx.tx, [
    ...records.map((r, i) =>
      event(ctx, 'record.created', {
        recordId: r.id,
        version: r.version,
        fieldIds: [...(prepared[i]?.cells.keys() ?? [])],
        record: r,
        // A public form's submission: webhooks deliver it as `form.submitted`.
        ...(ctx.form ? { via: 'form' } : {}),
      })
    ),
    ...linkEvents,
  ]);
  await recordRevisions(
    ctx,
    records.map((r) => ({ recordId: r.id, kind: 'created' }))
  );
  await notifyAssignments(ctx, used.values(), records, new Map());
  // The plan's record count, in this transaction; last, as the counter row stays locked
  // until commit.
  await addRecords(ctx.tx, ctx.table, prepared.length);
  return records;
}

/**
 * Per-cell patches. Locks the records in id order, checks they're live records of this table
 * (404 otherwise, so ids from another table or workspace never match) and `ifVersion` (409 with
 * the current record), then updates only the listed columns, grouped by column set.
 */
export async function updateRecords(
  ctx: RecordContext,
  patches: BulkUpdateRecordsInput['records']
) {
  assertUnique(patches.map((p) => p.id));
  const withPaths = patches.map((p, i) => ({ path: `records.${i}.fields`, cells: p.fields }));
  const loaded = await loadFields(ctx);
  if (!ctx.sync) assertNoSyncedCells(loaded, withPaths);
  if (withPaths.some((p) => Object.keys(p.cells).length > 0)) {
    assertTableAllows(ctx.table, 'editRecords', who(ctx));
  }
  assertCellsAllowed(ctx.table, loaded, withPaths, who(ctx), 'update');
  const fields = await applyTypecast(ctx, loaded, withPaths);
  const resolved = await resolveLinkNames(ctx, fields, withPaths);
  const byId = new Map(fields.map((f) => [f.row.id, f]));
  const errors: ProblemFieldError[] = [];
  const prepared = patches.map((p, i) => ({
    ...p,
    cells: prepareCells(byId, resolved[i] ?? {}, `records.${i}.fields`, errors, Boolean(ctx.sync)),
  }));
  await checkAttachments(ctx, prepared, errors);
  await checkUsers(ctx, prepared, errors, true);
  await checkLinks(ctx, prepared, errors);
  failIfInvalid(errors);

  const locked = new Map(
    (
      await lockByIds(
        ctx.tx,
        ctx.table,
        patches.map((p) => p.id)
      )
    ).map((r) => [r.id, r])
  );
  const missing = patches.filter((p) => !locked.get(p.id) || locked.get(p.id)?.deleted);
  if (missing.length) notFound(missing.map((p) => p.id));
  const stale = patches.filter(
    (p) => p.ifVersion !== undefined && locked.get(p.id)?.version !== p.ifVersion
  );
  if (stale.length) {
    throw new AppError('CONFLICT', {
      detail: 'The record changed since you read it.',
      extensions: {
        records: await readRecords(
          ctx,
          fields,
          stale.map((p) => p.id)
        ),
      },
    });
  }

  // The written cells as they are now, for the revisions.
  const written = new Map<string, FieldInfo>();
  for (const p of prepared) for (const c of p.cells.values()) written.set(c.field.row.id, c.field);
  const before = new Map(
    (
      await readRecords(
        ctx,
        [...written.values()],
        prepared.filter((p) => p.cells.size > 0).map((p) => p.id)
      )
    ).map((r) => [r.id, r])
  );

  // One UPDATE per distinct set of columns (usually one: the same cells across the batch). An
  // empty patch changes nothing: no write, no version bump, no event.
  const groups = new Map<string, typeof prepared>();
  for (const p of prepared) {
    if (p.cells.size === 0) continue;
    const key = [...p.cells.keys()].sort().join(',');
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    // Link cells bump the version too; their links are written to the junctions below.
    await updateRows(
      ctx.tx,
      ctx.table,
      [...first.cells.values()].filter((c) => !c.field.link).map((c) => writeColumnOf(c.field)),
      group.map((p) => rowValues(p.id, p.cells)),
      actorOf(ctx)
    );
  }
  const dirty: Dirty = new Map();
  const linkEvents = await applyLinks(ctx, prepared, dirty);
  for (const p of prepared) for (const fieldId of p.cells.keys()) markDirty(dirty, fieldId, [p.id]);
  await recomputeDirty(ctx, dirty);

  const records = await readRecords(
    ctx,
    fields,
    patches.map((p) => p.id)
  );
  await emitMany(ctx.tx, [
    ...records.flatMap((r, i) => {
      const cells = prepared[i]?.cells;
      if (!cells?.size) return [];
      return event(ctx, 'record.updated', {
        recordId: r.id,
        version: r.version,
        fieldIds: [...cells.keys()],
        // Link cells as read back, with the linked records' names.
        cells: Object.fromEntries(
          [...cells].map(([id, c]) => [id, c.field.link ? (r.fields[id] ?? null) : c.value])
        ),
        // The written cells as they were, for webhooks; never sent to clients.
        before: Object.fromEntries(
          [...cells.keys()].map((id) => [id, before.get(r.id)?.fields[id] ?? null])
        ),
      });
    }),
    ...linkEvents,
  ]);
  await recordRevisions(
    ctx,
    records.flatMap((r, i) => {
      const cells = prepared[i]?.cells;
      if (!cells?.size) return [];
      const changes: Changes = {};
      for (const [id, c] of cells) {
        changes[id] = {
          type: c.field.row.type,
          before: before.get(r.id)?.fields[id] ?? null,
          after: r.fields[id] ?? null,
        };
      }
      return [{ recordId: r.id, kind: 'updated' as const, changes }];
    })
  );
  await notifyAssignments(
    ctx,
    written.values(),
    records.filter((_r, i) => (prepared[i]?.cells.size ?? 0) > 0),
    before
  );
  return records;
}

/** Soft-deletes live records of this table (404 if any isn't one). */
export async function deleteRecords(ctx: RecordContext, ids: string[]) {
  assertUnique(ids);
  if (!ctx.sync) assertNotSyncedTable(ctx.table, 'delete');
  assertTableAllows(ctx.table, 'deleteRecords', who(ctx));
  const locked = new Map((await lockByIds(ctx.tx, ctx.table, ids)).map((r) => [r.id, r]));
  const missing = ids.filter((id) => !locked.get(id) || locked.get(id)?.deleted);
  if (missing.length) notFound(missing);
  // Links stay in the junctions (a restore brings them back) but reads skip deleted records,
  // so the linked records' inverse cells change: they get events too.
  const fields = await loadFields(ctx);
  // The records as they were, for webhooks; never sent to clients.
  const gone = new Map((await readRecords(ctx, fields, ids)).map((r) => [r.id, r]));
  const done = await setDeleted(ctx.tx, ctx.table, ids, true);
  await recomputeForRecords(ctx.tx, ctx.table, ids, { events: changeOf(ctx), ai: { skip: ids } });
  await emitMany(ctx.tx, [
    ...done.map((r) =>
      event(ctx, 'record.deleted', {
        recordId: r.id,
        version: r.version,
        ...(gone.has(r.id) ? { before: gone.get(r.id)?.fields } : {}),
      })
    ),
    ...(await neighbourEvents(ctx, fields, ids)),
  ]);
  await recordRevisions(
    ctx,
    done.map((r) => ({ recordId: r.id, kind: 'deleted' }))
  );
  // The plan's record count: last, as the counter row stays locked until commit.
  await addRecords(ctx.tx, ctx.table, -done.length);
  return ids.map((id) => ({ id, deleted: true as const }));
}

/** Restores deleted records of this table (404 if any isn't one) and returns them. */
export async function restoreRecords(ctx: RecordContext, ids: string[]) {
  assertUnique(ids);
  // Restoring undoes a delete: the same permission.
  if (!ctx.sync) assertNotSyncedTable(ctx.table, 'restore');
  assertTableAllows(ctx.table, 'deleteRecords', who(ctx));
  const locked = new Map((await lockByIds(ctx.tx, ctx.table, ids)).map((r) => [r.id, r]));
  const missing = ids.filter((id) => !locked.get(id)?.deleted);
  if (missing.length) notFound(missing);
  // Restored records count against the plan's records per base again.
  await assertRecordRoom(ctx.tx, ctx.entitlements, ctx.table.baseId, ids.length);
  const restored = await setDeleted(ctx.tx, ctx.table, ids, false);
  await recomputeForRecords(ctx.tx, ctx.table, ids, { events: changeOf(ctx), ai: { skip: ids } });
  const fields = await loadFields(ctx);
  const records = await readRecords(ctx, fields, ids);
  await emitMany(ctx.tx, [
    ...records.map((r) =>
      event(ctx, 'record.restored', { recordId: r.id, version: r.version, record: r })
    ),
    ...(await neighbourEvents(ctx, fields, ids)),
  ]);
  await recordRevisions(
    ctx,
    records.map((r) => ({ recordId: r.id, kind: 'restored' }))
  );
  // The plan's record count: last, as the counter row stays locked until commit.
  await addRecords(ctx.tx, ctx.table, restored.length);
  return records;
}

/**
 * A page of the table's record trash, most recently deleted first: id, name (the primary
 * field as text), when and by whom (the actor of the record's last `deleted` revision).
 */
export async function trashedRecords(ctx: RecordReadContext, query: RecordTrashQuery) {
  const primary = (await loadFields(ctx)).find((f) => f.row.isPrimary);
  const name = primary ? readExpression(readColumns([primary])[0] as ReadColumn) : sql`NULL`;
  const micros = sql`(extract(epoch FROM r.deleted_at) * 1000000)::bigint`;
  const [at, id] = query.cursor?.split('_') ?? [];
  const after = at && id ? sql`AND (${micros}, r.id) < (${at}::bigint, ${id}::uuid)` : sql``;
  const { rows } = await ctx.tx.execute<{
    id: string;
    name: unknown;
    deleted_at: string;
    micros: string;
    deleted_by: string | null;
  }>(sql`
    SELECT r.id, ${name} AS name, to_json(r.deleted_at) #>> '{}' AS deleted_at,
           ${micros}::text AS micros,
           (SELECT v.actor_id FROM ${revisionsTable} v
             WHERE v.table_id = ${ctx.table.id} AND v.record_id = r.id AND v.kind = 'deleted'
             ORDER BY v.created_at DESC LIMIT 1) AS deleted_by
      FROM ${qualified(ctx.table)} AS r
     WHERE r.deleted_at IS NOT NULL ${after}
     ORDER BY r.deleted_at DESC, r.id DESC
     LIMIT ${query.limit + 1}`);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const day = 24 * 60 * 60 * 1000;
  return {
    records: page.map((r) => {
      const value = primary ? primary.def.fromStorage(r.name, primary.options) : null;
      const deletedAt = new Date(r.deleted_at);
      return {
        id: r.id,
        name: primary && value !== null ? primary.def.format(value as never, primary.options) : '',
        deletedAt: deletedAt.toISOString(),
        deletedBy: r.deleted_by,
        purgeAfter: new Date(deletedAt.getTime() + TRASH_RETENTION_DAYS * day).toISOString(),
      };
    }),
    nextCursor: rows.length > query.limit && last ? `${last.micros}_${last.id}` : null,
  };
}

/**
 * Deletes records in the trash for good (404 unless every id is one): their rows, which
 * takes their links (the junctions cascade), and their comments and revisions. The table's
 * delete permission applies, as for deleting them.
 */
export async function purgeRecords(ctx: RecordContext, ids: string[]) {
  assertUnique(ids);
  assertTableAllows(ctx.table, 'deleteRecords', who(ctx));
  const locked = new Map((await lockByIds(ctx.tx, ctx.table, ids)).map((r) => [r.id, r]));
  const missing = ids.filter((id) => !locked.get(id)?.deleted);
  if (missing.length) notFound(missing);
  const list = sql`${`{${ids.join(',')}}`}::uuid[]`;
  await ctx.tx.execute(
    sql`DELETE FROM ${qualified(ctx.table)} WHERE id = ANY(${list}) AND deleted_at IS NOT NULL`
  );
  await ctx.tx
    .delete(recordComments)
    .where(and(eq(recordComments.tableId, ctx.table.id), inArray(recordComments.recordId, ids)));
  await ctx.tx
    .delete(revisionsTable)
    .where(and(eq(revisionsTable.tableId, ctx.table.id), inArray(revisionsTable.recordId, ids)));
  return { purged: ids.length };
}

/** Live records of this table by id with every field, in `ids` order (AI prompts). */
export async function readLiveRecords(ctx: RecordReadContext, ids: string[]) {
  const fields = await loadFields(ctx);
  return { fields, records: await readRecords(ctx, fields, ids) };
}

/** One live record of this table, or 404. */
export async function getRecord(ctx: RecordReadContext, id: string) {
  const [record] = await readRecords(ctx, await loadFields(ctx), [id]);
  if (!record) throw new AppError('NOT_FOUND', { detail: 'No such record in this table.' });
  return record;
}

/**
 * The display names of live records (their primary field as text, '' when empty), by id; ids
 * that aren't live records of the table are left out. For notifications.
 */
export async function recordNames(
  ctx: RecordReadContext,
  ids: readonly string[]
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const primary = (await loadFields(ctx)).filter((f) => f.row.isPrimary);
  const records = await readRecords(ctx, primary, [...new Set(ids)]);
  return new Map(
    records.map((r) => {
      const p = primary[0];
      const value = p ? (r.fields[p.row.id] ?? null) : null;
      return [r.id, p && value !== null ? p.def.format(value, p.options) : ''];
    })
  );
}

/**
 * A page of live records, oldest first (UUIDv7 order, which is also autonumber order). Filters,
 * sorts and views come with the query engine.
 */
export async function listRecords(ctx: RecordReadContext, query: ListRecordsQuery) {
  const fields = await loadFields(ctx);
  const columns = readColumns(fields);
  const rows = await selectPage(ctx.tx, ctx.table, columns, {
    limit: query.limit + 1,
    cursor: query.cursor,
  });
  const page = rows.slice(0, query.limit).map((r) => toRecord(ctx.table, fields, r));
  const last = page.at(-1);
  return { records: page, nextCursor: rows.length > query.limit && last ? last.id : null };
}

/** The query of a saved view of this table (404 if it isn't one), as stored. */
async function viewQueryOf(
  ctx: RecordReadContext,
  viewId: string
): Promise<{ config: unknown; type: string }> {
  const [view] = await ctx.tx
    .select({ config: views.config, type: views.type })
    .from(views)
    .where(
      and(
        eq(views.id, viewId),
        eq(views.tableId, ctx.table.id),
        isNull(views.deletedAt),
        visibleTo(ctx.userId)
      )
    );
  if (!view) throw new AppError('NOT_FOUND', { detail: 'No such view in this table.' });
  return view;
}

function invalidQuery(errors: ProblemFieldError[]): never {
  throw new AppError('VALIDATION_FAILED', {
    detail: 'The query is invalid.',
    extensions: { errors },
  });
}

/** The compiler's view of a table's live fields. */
export function toQueryFields(fields: FieldInfo[]): QueryField[] {
  return fields.map((f) => ({
    id: f.row.id,
    name: f.row.name,
    type: fieldType(f.row),
    dbColumn: f.row.dbColumn,
    def: f.def,
    options: f.options,
    ...(f.link ? { link: f.link.read } : {}),
  }));
}

/** Postgres "data exception" class: a tampered cursor value that doesn't cast. */
function isDataException(err: unknown): boolean {
  for (let e = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code.startsWith('22');
  }
  return false;
}

/**
 * Runs a ViewQuery: a saved view's (`viewId`) and/or an inline one, compiled to SQL over
 * the table's record table with this table's live fields as the only reachable columns. Answers
 * a window (`offset`, for the grid) or a keyset page (`cursor`, for the API), the total, and on
 * request the group header counts and summary aggregates.
 */
export async function queryRecords(
  ctx: RecordReadContext,
  input: QueryRecordsInput,
  /** A condition tree beside the filter: the REST API's `filterByFormula`. */
  extra: { predicate?: Predicate } = {}
) {
  const fields = await loadFields(ctx);
  const queryFields = toQueryFields(fields);

  let stored: Record<string, unknown> = {};
  let manualOrder: SortKey | undefined;
  if (input.viewId) {
    // The grid layout (`config.grid`) sits beside the query keys; it doesn't filter. A
    // view config this engine can't read (older or hand-edited) shows the records unfiltered,
    // and entries of fields deleted or converted since the view was saved are dropped.
    const view = await viewQueryOf(ctx, input.viewId);
    const config = (view.config ?? {}) as Record<string, unknown>;
    stored = pruneViewQuery(savedQueryOf(config), queryFields);
    // Kanban cards keep the view's manual order when it has no sorts.
    if (view.type === 'kanban') {
      manualOrder = manualOrderKey(input.viewId);
    }
  }
  const query = viewQuerySchema.parse({ ...stored, ...input.query });

  let compiled: ReturnType<typeof compileViewQuery>;
  try {
    compiled = compileViewQuery(query, queryFields, {
      userId: ctx.userId,
      ...(manualOrder ? { manualOrder } : {}),
      ...(extra.predicate ? { predicate: extra.predicate } : {}),
    });
  } catch (err) {
    if (err instanceof QueryValidationError) invalidQuery(err.errors);
    throw err;
  }

  const byId = new Map(queryFields.map((f) => [f.id, f]));
  const aggregateErrors: ProblemFieldError[] = [];
  const wanted = (input.aggregates ?? []).flatMap((a, i) => {
    const field = byId.get(a.fieldId);
    if (!field) {
      aggregateErrors.push({
        path: `aggregates.${i}.fieldId`,
        message: 'No such field in this table.',
      });
      return [];
    }
    if (!aggregatesFor(field).includes(a.fn)) {
      aggregateErrors.push({
        path: `aggregates.${i}.fn`,
        message: `"${a.fn}" isn't a summary for ${field.def.label.toLowerCase()} fields.`,
      });
      return [];
    }
    return [{ field, fn: a.fn as Aggregate }];
  });
  let cursor: (string | null)[] | undefined;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, compiled.keys.length);
    if (!decoded) aggregateErrors.push({ path: 'cursor', message: 'Not a cursor of this query.' });
    else cursor = decoded;
  }
  if (aggregateErrors.length) invalidQuery(aggregateErrors);
  const colorCases = compileRowColors(ctx, input.rowColors ?? [], queryFields);

  const visible = compiled.fields
    .map((f) => fields.find((x) => x.row.id === f.id))
    .filter((f): f is FieldInfo => f !== undefined);
  let page: Awaited<ReturnType<typeof selectRecords>>;
  try {
    page = await selectRecords(ctx.tx, ctx.table, compiled, {
      limit: input.limit + 1,
      offset: input.offset,
      cursor,
    });
  } catch (err) {
    if (cursor && isDataException(err))
      invalidQuery([{ path: 'cursor', message: 'Not a cursor of this query.' }]);
    throw err;
  }
  const more = page.rows.length > input.limit;
  const rows = page.rows.slice(0, input.limit);
  const lastKeys = page.keyValues[rows.length - 1];

  return {
    records: rows.map((r) => toRecord(ctx.table, visible, r)),
    offset: input.cursor === undefined ? (input.offset ?? 0) : null,
    total: input.count ? await countRecords(ctx.tx, ctx.table, compiled) : null,
    nextCursor: more && lastKeys ? encodeCursor(lastKeys) : null,
    ...(input.groups ? { groups: await selectGroups(ctx.tx, ctx.table, compiled) } : {}),
    ...(input.aggregates
      ? { aggregates: await selectAggregates(ctx.tx, ctx.table, compiled, wanted) }
      : {}),
    ...(input.rowColors
      ? {
          rowColors: await selectRowColors(
            ctx,
            colorCases,
            rows.map((r) => r.id)
          ),
        }
      : {}),
  };
}

/**
 * What a dashboard element summarizes: the records of the table, or of a view of it (its
 * filter only: sorts and groups don't change a summary), meeting `within` and every filter of
 * `filters` too, each compiled as a view's filter would be (422s under its `path`).
 */
export interface SummaryInput {
  viewId?: string | null;
  filters?: readonly { filter: FilterGroup; path: string }[];
  within?: FilterCondition[];
}

/**
 * The summary itself: an aggregate of `fieldId` (or the record count, `count` without a field);
 * grouped by `groupFieldId` (and `seriesFieldId`) for a chart, whose values are numbers only.
 * 422 paths are `<path>.fieldId` and so on, as a number or chart element names them.
 */
export interface SummarySpec {
  fieldId: string | null;
  fn: Aggregate;
  groupFieldId?: string | undefined;
  seriesFieldId?: string | null | undefined;
  path?: string;
}

async function prepareSummary(ctx: RecordReadContext, input: SummaryInput & SummarySpec) {
  const queryFields = toQueryFields(await loadFields(ctx));
  const byId = new Map(queryFields.map((f) => [f.id, f]));
  const at = (key: string) => (input.path ? `${input.path}.${key}` : key);
  const errors: ProblemFieldError[] = [];
  const groupBy = [input.groupFieldId, input.seriesFieldId].flatMap((id) => (id ? [id] : []));
  const chart = input.groupFieldId !== undefined;
  const field = input.fieldId ? byId.get(input.fieldId) : undefined;
  if (input.fieldId && !field) {
    errors.push({ path: at('fieldId'), message: 'No such field in this table.' });
  } else if (!field && input.fn !== 'count') {
    errors.push({ path: at('fieldId'), message: 'Pick the field to summarize.' });
  } else if (
    field &&
    chart &&
    input.fn !== 'count' &&
    (field.def.sort !== 'number' || field.link)
  ) {
    errors.push({ path: at('fieldId'), message: 'Charts sum, average and compare numbers.' });
  } else if (field && !aggregatesFor(field).includes(input.fn)) {
    errors.push({
      path: at('fn'),
      message: `"${input.fn}" isn't a summary for ${field.def.label.toLowerCase()} fields.`,
    });
  }
  for (const key of ['groupFieldId', 'seriesFieldId'] as const) {
    const id = input[key];
    if (id && !byId.has(id))
      errors.push({ path: at(key), message: 'No such field in this table.' });
  }
  if (errors.length) invalidQuery(errors);

  let stored: SavedViewQuery = {};
  if (input.viewId) {
    const view = await viewQueryOf(ctx, input.viewId);
    stored = pruneViewQuery(
      savedQueryOf((view.config ?? {}) as Record<string, unknown>),
      queryFields
    );
  }
  const compile = (query: ViewQuery, path: string) => {
    try {
      return compileViewQuery(query, queryFields, { userId: ctx.userId, path });
    } catch (err) {
      if (!(err instanceof QueryValidationError)) throw err;
      // A group field's problems under its own key, not `query.groupBy.<i>`.
      errors.push(
        ...err.errors.map((e) => ({
          ...e,
          path: e.path
            .replace(/^query\.groupBy\.0/, at('groupFieldId'))
            .replace(/^query\.groupBy\.1/, at('seriesFieldId')),
        }))
      );
      return null;
    }
  };
  const main = compile(
    viewQuerySchema.parse({
      ...(stored.filter ? { filter: stored.filter } : {}),
      groupBy: groupBy.map((fieldId) => ({ fieldId, direction: 'asc' })),
      ...(input.within?.length ? { within: input.within } : {}),
    }),
    'query'
  );
  const extra = (input.filters ?? []).map((f) =>
    compile(viewQuerySchema.parse({ filter: f.filter }), at(f.path))
  );
  if (errors.length || !main) invalidQuery(errors);
  const where = sql.join(
    [main.where, ...extra.flatMap((q) => (q ? [q.where] : []))].map((w) => sql`(${w})`),
    sql` AND `
  );
  return { compiled: { ...main, where }, field };
}

/** Checks a summary a page is about to save as it would run: 422 on any problem. */
export async function assertValidSummary(
  ctx: RecordReadContext,
  input: SummaryInput & SummarySpec
): Promise<void> {
  await prepareSummary(ctx, input);
}

/**
 * A number element: one of the grid's summary aggregates of a field (or the count of
 * records when `fieldId` is null) over the summary's records, as `queryRecords` computes them.
 */
export async function aggregateRecords(
  ctx: RecordReadContext,
  input: SummaryInput & SummarySpec
): Promise<{ value: unknown; records: number }> {
  const { compiled, field } = await prepareSummary(ctx, { ...input, groupFieldId: undefined });
  const records = await countRecords(ctx.tx, ctx.table, compiled);
  if (!field) return { value: records, records };
  const out = await selectAggregates(ctx.tx, ctx.table, compiled, [{ field, fn: input.fn }]);
  return { value: out[field.id]?.[input.fn] ?? null, records };
}

/**
 * A chart: the summary's records grouped by `groupFieldId` (and `seriesFieldId`), in the
 * order a view groups them, each leaf group with the records' count or a number field's
 * aggregate; `series` lists the second level's values in the field's order.
 */
export async function groupRecordValues(
  ctx: RecordReadContext,
  input: SummaryInput & SummarySpec & { groupFieldId: string; fn: GroupValueFn }
): Promise<{
  groups: { key: unknown[]; value: number | null }[];
  series: unknown[] | null;
  records: number;
}> {
  const { compiled, field } = await prepareSummary(ctx, input);
  const rows = await selectGroupValues(
    ctx.tx,
    ctx.table,
    compiled,
    field && input.fn !== 'count' ? { field, fn: input.fn } : undefined
  );
  const records = await countRecords(ctx.tx, ctx.table, compiled);
  let series: unknown[] | null = null;
  const second = compiled.groups[1]?.field;
  if (second) {
    const seen = new Map<string, unknown>();
    for (const r of rows) seen.set(JSON.stringify(r.key[1] ?? null), r.key[1] ?? null);
    const compare = second.def.compare as (a: unknown, b: unknown, o: unknown) => number;
    series = [...seen.values()].sort((a, b) => compare(a, b, second.options));
  }
  return { groups: rows.map((r) => ({ key: r.key, value: r.value })), series, records };
}

/**
 * Each row colour condition's filter compiled as a view's filter is (422 with paths under
 * `rowColors.<i>`), paired with its colour.
 */
function compileRowColors(
  ctx: RecordReadContext,
  conditions: readonly RowColorCondition[],
  queryFields: QueryField[]
): { color: ChoiceColor; where: SQL }[] {
  const errors: ProblemFieldError[] = [];
  const cases = conditions.flatMap((c, i) => {
    try {
      const { where } = compileViewQuery(viewQuerySchema.parse({ filter: c.filter }), queryFields, {
        userId: ctx.userId,
        path: `rowColors.${i}`,
      });
      return [{ color: c.color, where }];
    } catch (err) {
      if (!(err instanceof QueryValidationError)) throw err;
      errors.push(...err.errors);
      return [];
    }
  });
  if (errors.length) invalidQuery(errors);
  return cases;
}

/** The colour of the first condition each of the records matches, for those matching one. */
async function selectRowColors(
  ctx: RecordReadContext,
  cases: readonly { color: ChoiceColor; where: SQL }[],
  ids: readonly string[]
): Promise<Record<string, ChoiceColor>> {
  if (cases.length === 0 || ids.length === 0) return {};
  const color = sql.join(
    cases.map((c) => sql`WHEN ${c.where} THEN ${c.color}`),
    sql` `
  );
  const { rows } = await ctx.tx.execute<{ id: string; color: ChoiceColor | null }>(sql`
    SELECT r.id, CASE ${color} END AS color FROM ${qualified(ctx.table)} AS r
     WHERE r.id IN (${sql.join(
       ids.map((id) => sql`${id}::uuid`),
       sql`, `
     )})`);
  return Object.fromEntries(rows.flatMap((r) => (r.color ? [[r.id, r.color]] : [])));
}

/**
 * Checks a query a view is about to save against the table's live fields, as a query
 * would be: unknown fields, operators the type doesn't offer and malformed values are a 422.
 */
export async function assertValidViewQuery(ctx: RecordReadContext, query: SavedViewQuery) {
  const fields = await loadFields(ctx);
  try {
    compileViewQuery(viewQuerySchema.parse(query), toQueryFields(fields));
  } catch (err) {
    if (err instanceof QueryValidationError) invalidQuery(err.errors);
    throw err;
  }
}

/**
 * The problems of filters as a view's filter would have them (paths under `query.filter`), each
 * compiled against the table's live fields, loaded once: a form's conditions.
 */
export async function filterProblems(
  ctx: RecordReadContext,
  filters: readonly FilterGroup[]
): Promise<ProblemFieldError[][]> {
  if (filters.length === 0) return [];
  const fields = toQueryFields(await loadFields(ctx));
  return filters.map((filter) => {
    try {
      compileViewQuery(viewQuerySchema.parse({ filter }), fields);
      return [];
    } catch (err) {
      if (err instanceof QueryValidationError) return err.errors;
      throw err;
    }
  });
}

/**
 * The link picker: live records of the linked table of `fieldId` (a link field of this
 * table) whose primary field contains `search`, in the order of the view the field is limited to
 * (and only that view's records), else oldest first. The linked table is in the same base, so
 * the caller's role there is the one already checked on this table.
 */
export async function linkCandidates(
  ctx: RecordReadContext,
  fieldId: string,
  input: LinkCandidatesQuery
) {
  const field = (await loadFields(ctx)).find((f) => f.row.id === fieldId);
  const spec = field?.link;
  if (!spec || spec.target.deletedAt) {
    throw new AppError('NOT_FOUND', { detail: 'No linked table to pick records from.' });
  }
  const targetInfos = await loadFields({ ...ctx, table: spec.target });
  const targetFields = toQueryFields(targetInfos);
  const primaryId = targetInfos.find((f) => f.row.isPrimary)?.row.id;
  const primary = targetFields.find((f) => f.id === primaryId) ?? null;
  const nameOf = (row: PageRow) =>
    primary
      ? primary.def.format(
          primary.def.fromStorage(row[primary.id], primary.options),
          primary.options
        )
      : '';
  // Named records (a filter's chips): those of the ids that are live records of the linked
  // table, in the given order. Ids of other tables, bases or workspaces aren't in this table, so
  // they never come back.
  if (input.ids) {
    const ids = [...new Set(input.ids.toLowerCase().split(','))];
    const compiled = compileViewQuery(
      viewQuerySchema.parse({ fields: primary ? [primary.id] : [] }),
      targetFields,
      { userId: ctx.userId }
    );
    const named = sql`${compiled.where} AND r.id = ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid))`;
    const page = await selectRecords(
      ctx.tx,
      spec.target,
      { ...compiled, where: named },
      {
        limit: ids.length,
      }
    );
    const byId = new Map(page.rows.map((row) => [row.id, row]));
    return {
      tableId: spec.target.id,
      records: ids.flatMap((id) => {
        const row = byId.get(id);
        return row ? [{ id: row.id, name: nameOf(row) }] : [];
      }),
      nextOffset: null,
    };
  }
  let stored: SavedViewQuery = {};
  // A filter picks among every record; linking honours "limit record selection to a view".
  const viewId = input.purpose === 'link' ? spec.options.viewIdForRecordSelection : null;
  if (viewId) {
    const [view] = await ctx.tx
      .select({ config: views.config })
      .from(views)
      .where(
        and(
          eq(views.id, viewId),
          eq(views.tableId, spec.target.id),
          isNull(views.deletedAt),
          eq(views.personal, false)
        )
      );
    if (view) {
      const config = (view.config ?? {}) as Record<string, unknown>;
      stored = pruneViewQuery(savedQueryOf(config), targetFields);
    }
  }
  const query = viewQuerySchema.parse({
    filter: stored.filter,
    sorts: stored.sorts ?? [],
    fields: primary ? [primary.id] : [],
    ...(input.search?.trim() ? { search: input.search.trim() } : {}),
  });
  const compiled = compileViewQuery(query, targetFields, { userId: ctx.userId });
  // One more than asked: whether there is a next page.
  const page = await selectRecords(ctx.tx, spec.target, compiled, {
    limit: input.limit + 1,
    offset: input.offset,
  });
  const rows = page.rows.slice(0, input.limit);
  return {
    tableId: spec.target.id,
    records: rows.map((row) => ({ id: row.id, name: nameOf(row) })),
    nextOffset: page.rows.length > input.limit ? input.offset + input.limit : null,
  };
}

/**
 * A public form's link picker: live records of the linked table of `field` that the
 * form's chosen view `viewId` shows (its filter; `me` matches nobody) and, when the field is
 * limited to a view too, that one; searched by the primary field only, in the chosen view's
 * order. With `ids`, those of them that pass, in no particular order (a submission's check).
 * Only ids and primary text come back. `null` when `viewId` isn't a live, shared (not
 * personal), non-form view of the linked table.
 */
export async function formLinkRecords(
  ctx: RecordReadContext,
  field: FieldInfo,
  viewId: string,
  input: { search?: string | undefined; offset: number; limit: number } | { ids: string[] }
): Promise<{ records: { id: string; name: string }[]; nextOffset: number | null } | null> {
  const spec = field.link;
  if (!spec || spec.target.deletedAt) return null;
  const [view] = await ctx.tx
    .select({ config: views.config })
    .from(views)
    .where(
      and(
        eq(views.id, viewId),
        eq(views.tableId, spec.target.id),
        isNull(views.deletedAt),
        eq(views.personal, false),
        sql`${views.type} <> 'form'`
      )
    );
  if (!view) return null;
  const targetInfos = await loadFields({ ...ctx, table: spec.target });
  const targetFields = toQueryFields(targetInfos);
  const primary = targetFields.find(
    (f) => f.id === targetInfos.find((i) => i.row.isPrimary)?.row.id
  );
  const stored = pruneViewQuery(
    savedQueryOf((view.config ?? {}) as Record<string, unknown>),
    targetFields
  );
  const search = 'ids' in input ? '' : (input.search?.trim() ?? '');
  let compiled: ReturnType<typeof compileViewQuery>;
  try {
    compiled = compileViewQuery(
      viewQuerySchema.parse({
        filter: stored.filter,
        sorts: stored.sorts ?? [],
        fields: primary ? [primary.id] : [],
        ...(search ? { search } : {}),
      }),
      targetFields,
      { userId: ctx.userId }
    );
  } catch {
    // A view whose query no longer compiles offers nothing rather than every record.
    return null;
  }
  const conditions = [compiled.where];
  const limitedTo = spec.options.viewIdForRecordSelection;
  const limit = limitedTo ? await linkViewWhere(ctx, spec, limitedTo) : null;
  if (limit) conditions.push(limit);
  if ('ids' in input) {
    conditions.push(
      sql`r.id = ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(input.ids)}::jsonb)::uuid))`
    );
  }
  const where = sql.join(
    conditions.map((c) => sql`(${c})`),
    sql` AND `
  );
  const nameOf = (row: PageRow) =>
    primary
      ? primary.def.format(
          primary.def.fromStorage(row[primary.id], primary.options),
          primary.options
        )
      : '';
  const page =
    'ids' in input
      ? { limit: Math.max(input.ids.length, 1), offset: 0 }
      : { limit: input.limit + 1, offset: input.offset };
  const { rows } = await selectRecords(ctx.tx, spec.target, { ...compiled, where }, page);
  const shown = 'ids' in input ? rows : rows.slice(0, input.limit);
  return {
    records: shown.map((row) => ({ id: row.id, name: nameOf(row) })),
    nextOffset: 'ids' in input || rows.length <= input.limit ? null : input.offset + input.limit,
  };
}

// ---- share links -------------------------------------------------------------------

/** A public share link's read of its table: no user (`me` in a filter matches nobody). */
export type SharedReadContext = Omit<RecordReadContext, 'userId'>;

/**
 * What a share link shows of its view: the visible fields, the self-link fields whose structure
 * it shows, the grid layout, the view's shape and its compiled query.
 */
export interface SharedViewQuery {
  fields: FieldInfo[];
  links: FieldInfo[];
  layout: ReturnType<typeof gridLayoutOf>;
  shape: SharedViewShape;
  query: ViewQuery;
  queryFields: ReturnType<typeof toQueryFields>;
  manualOrder?: SortKey;
  compiled: ReturnType<typeof compileViewQuery>;
  /** Who `me` is in its filter: an interface page's viewer; a share link has nobody. */
  userId?: string;
}

/**
 * Compiles a shared view as the server stores it: its own filter, sorts and groups
 * (a kanban's manual order without sorts), and only the fields its type shows
 * (`sharedViewShape`: a grid's unhidden fields, a kanban's cards, a calendar's dates...). Nothing
 * from the request goes in, so a share can't be widened. A view whose query no longer compiles
 * is answered as no such link rather than shown unfiltered.
 */
export async function compileSharedView(
  ctx: SharedReadContext,
  view: { id: string; type: string; config: unknown }
): Promise<SharedViewQuery> {
  const fields = await tableFields(ctx.tx, ctx.table);
  const queryFields = toQueryFields(fields);
  const config = (view.config ?? {}) as Record<string, unknown>;
  const layout = pruneGridLayout(
    gridLayoutOf(config),
    fields.map((f) => ({ id: f.row.id, isPrimary: f.row.isPrimary }))
  );
  const shape = sharedViewShape(
    view,
    fields.map((f) => ({
      id: f.row.id,
      type: f.row.type,
      isPrimary: f.row.isPrimary,
      options: f.options,
    })),
    ctx.table.id
  );
  const shown = new Set(shape.fieldIds);
  const linkIds = new Set(shape.links);
  const visible = fields.filter((f) => shown.has(f.row.id));
  const links = fields.filter((f) => linkIds.has(f.row.id) && f.link);
  const stored = pruneViewQuery(savedQueryOf(config), queryFields);
  const manualOrder = view.type === 'kanban' ? manualOrderKey(view.id) : undefined;
  try {
    const query = viewQuerySchema.parse({
      ...stored,
      fields: [...new Set([...visible, ...links].map((f) => f.row.id))],
    });
    const compiled = compileViewQuery(query, queryFields, manualOrder ? { manualOrder } : {});
    return {
      fields: visible,
      links,
      layout,
      shape,
      query,
      queryFields,
      ...(manualOrder ? { manualOrder } : {}),
      compiled,
    };
  } catch (err) {
    throw new AppError('NOT_FOUND', { detail: 'No such share link.', cause: err });
  }
}

/**
 * The shared view narrowed to a date window: records whose dates in the view's own date
 * fields overlap `from`..`to`. 422 for a view without dates.
 */
function sharedWindow(shared: SharedViewQuery, from: string, to: string) {
  if (shared.shape.dateFields.length === 0) {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'This view has no dates to window.',
      extensions: { errors: [{ path: 'from', message: 'This view has no dates to window.' }] },
    });
  }
  const query = { ...shared.query, dateRange: { from, to, fields: shared.shape.dateFields } };
  try {
    return compileViewQuery(query, shared.queryFields, {
      ...(shared.manualOrder ? { manualOrder: shared.manualOrder } : {}),
      ...(shared.userId ? { userId: shared.userId } : {}),
    });
  } catch (err) {
    throw new AppError('NOT_FOUND', { detail: 'No such share link.', cause: err });
  }
}

/** Ids of a people cell's value (one id or a list), for the names lookup. */
const peopleIds = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.filter((v) => typeof v === 'string')
      : [];

/**
 * A window of a shared view's records, projected for the public: the record id and the
 * visible fields only (no versions, creators or timestamps beyond visible fields). Link cells
 * become the linked records' names, people cells the people's names; nothing else of another
 * table, and no user id or email, leaves.
 */
export async function sharedRecords(
  ctx: SharedReadContext,
  shared: SharedViewQuery,
  page: { offset: number; limit: number; from?: string | undefined; to?: string | undefined }
): Promise<{ records: SharedRecord[]; offset: number; total: number }> {
  const compiled =
    page.from !== undefined && page.to !== undefined
      ? sharedWindow(shared, page.from, page.to)
      : shared.compiled;
  const window = { offset: page.offset, limit: page.limit };
  const { rows } = await selectRecords(ctx.tx, ctx.table, compiled, window);
  const total = await countRecords(ctx.tx, ctx.table, compiled);
  const records = rows.map((r) => toRecord(ctx.table, [...shared.fields, ...shared.links], r));
  const links = await shownLinks(ctx, shared, records);
  const people = shared.fields.filter((f) => !f.link && f.def.category === 'people');
  const ids = new Set(records.flatMap((r) => people.flatMap((f) => peopleIds(r.fields[f.row.id]))));
  const names = new Map<string, string>();
  if (ids.size > 0) {
    const found = await ctx.tx
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, [...ids]));
    for (const u of found) names.set(u.id, u.name?.trim() || 'Unnamed user');
  }
  return {
    offset: page.offset,
    total,
    records: records.map((r) => {
      const fields: Record<string, unknown> = {};
      for (const f of shared.fields) {
        const value = r.fields[f.row.id] ?? null;
        if (value === null) fields[f.row.id] = null;
        else if (f.link) {
          fields[f.row.id] = (value as { name?: string }[]).map((item) => item.name ?? '');
        } else if (f.def.category === 'people') {
          fields[f.row.id] = peopleIds(value).map((id) => names.get(id) ?? 'Former collaborator');
        } else fields[f.row.id] = value;
      }
      const structure = links.get(r.id);
      return { id: r.id, fields, ...(structure ? { links: structure } : {}) };
    }),
  };
}

/**
 * The self-link structure of a page of shared records: per record and self-link field of
 * the shape, the linked records' ids that the view itself shows (its filter, not the date
 * window), so no hidden record's id leaves.
 */
async function shownLinks(
  ctx: SharedReadContext,
  shared: SharedViewQuery,
  records: { id: string; fields: Record<string, unknown> }[]
): Promise<Map<string, Record<string, string[]>>> {
  const out = new Map<string, Record<string, string[]>>();
  if (shared.links.length === 0) return out;
  const idsOf = (value: unknown) =>
    Array.isArray(value)
      ? value.flatMap((item) =>
          item && typeof (item as { id?: unknown }).id === 'string'
            ? [(item as { id: string }).id]
            : []
        )
      : [];
  const wanted = new Set(
    records.flatMap((r) => shared.links.flatMap((f) => idsOf(r.fields[f.row.id])))
  );
  const shown = new Set<string>();
  if (wanted.size > 0) {
    const { rows } = await ctx.tx.execute<{ id: string }>(sql`
      SELECT r.id FROM ${qualified(ctx.table)} AS r
       WHERE ${shared.compiled.where}
         AND r.id IN (${sql.join(
           [...wanted].map((id) => sql`${id}::uuid`),
           sql`, `
         )})`);
    for (const row of rows) shown.add(row.id);
  }
  for (const r of records) {
    const entry: Record<string, string[]> = {};
    for (const f of shared.links) {
      entry[f.row.id] = idsOf(r.fields[f.row.id]).filter((id) => shown.has(id));
    }
    out.set(r.id, entry);
  }
  return out;
}

/**
 * Whether a file is in a visible attachment field of a record the shared view shows: the
 * only files its link may download.
 */
export async function sharedViewHasFile(
  ctx: SharedReadContext,
  shared: SharedViewQuery,
  attachmentId: string
): Promise<boolean> {
  const files = shared.fields.filter((f) => !f.link && f.def.editor.kind === 'attachment');
  if (files.length === 0) return false;
  const item = JSON.stringify([{ id: attachmentId }]);
  const holds = sql.join(
    files.map((f) => sql`${sql.identifier(f.row.dbColumn)} @> ${item}::jsonb`),
    sql` OR `
  );
  const { rows } = await ctx.tx.execute(sql`
    SELECT 1 FROM ${qualified(ctx.table)} AS r
     WHERE ${shared.compiled.where} AND (${holds}) LIMIT 1`);
  return rows.length > 0;
}
