import {
  type ActionOn,
  type ApiValueContext,
  apiValueOf,
  type ProblemFieldError,
  queryRecordsSchema,
  type UserRole,
  type V1ListParams,
  type V1Record,
} from '@openrows/shared';
import { and, asc, count, eq, inArray, isNull } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ResourceEnv } from '../authz/middleware.js';
import { assertAllowed, authorize, principalMay } from '../authz/policy.js';
import { resolveResource } from '../authz/resolve.js';
import type { Predicate } from '../data/query/compile.js';
import { recordComments, type Transaction, users, views } from '../db/index.js';
import { fieldType, type TableRow } from '../fields/service.js';
import { AppError } from '../lib/errors.js';
import {
  createRecords,
  type FieldInfo,
  getRecord,
  queryRecords,
  type RecordContext,
  tableFields,
  updateRecords,
} from '../records/service.js';
import { liveTables } from '../tables/service.js';
import { visibleTo } from '../views/visibility.js';
import { equalsPredicate, type FilterField, formulaPredicate } from './formula-filter.js';

/**
 * The REST API v1's records: Airtable's request and response shapes mapped onto the
 * RecordService and the query engine, so validation, permissions, outbox events, realtime,
 * revisions and notifications are exactly those of the app's own writes.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type V1Env = ResourceEnv<'base'>;

/**
 * A live table of the route's (authorized) base by id or name (exact, then ignoring case when
 * only one matches), then `action` authorized on it. A table of another base never matches:
 * 404, as for a table that doesn't exist.
 */
export async function authorizeTable(
  c: Context<V1Env>,
  tableIdOrName: string,
  action: ActionOn<'table'>
): Promise<{ table: TableRow; role: UserRole }> {
  const { tx, resource, principal } = c.var;
  const tables = await liveTables(tx, resource.id);
  const lower = tableIdOrName.toLowerCase();
  const byName = tables.filter((t) => t.name.toLowerCase() === lower);
  const table =
    (UUID.test(tableIdOrName) ? tables.find((t) => t.id === lower) : undefined) ??
    tables.find((t) => t.name === tableIdOrName) ??
    (byName.length === 1 ? byName[0] : undefined);
  if (!table) throw new AppError('NOT_FOUND', { detail: 'No such table in this base.' });
  const resolved = await resolveResource(tx, 'table', table.id, principal.user.id);
  const role = assertAllowed(authorize(principal, action, resolved));
  return { table, role };
}

/** The RecordService's context for a v1 write. */
export async function writeContext(
  c: Context<V1Env>,
  table: TableRow,
  role: UserRole,
  typecast: boolean | undefined
): Promise<RecordContext> {
  const { tx, resource, principal } = c.var;
  return {
    entitlements: await c.var.edition.entitlements.forWorkspace(resource.workspaceId, tx),
    tx,
    workspaceId: resource.workspaceId,
    userId: principal.user.id,
    table,
    role,
    typecast,
    // New select options are a schema change: a token needs schema.bases:write for them.
    mayAddChoices: principalMay(principal, role, 'field:update'),
  };
}

/** A table's live fields, by name and by id, for keys in requests. */
export class FieldKeys {
  readonly byName: Map<string, FieldInfo>;
  readonly byId: Map<string, FieldInfo>;

  constructor(readonly fields: FieldInfo[]) {
    this.byName = new Map(fields.map((f) => [f.row.name, f]));
    this.byId = new Map(fields.map((f) => [f.row.id, f]));
  }

  static async of(tx: Transaction, table: TableRow): Promise<FieldKeys> {
    return new FieldKeys(await tableFields(tx, table));
  }

  /** A field by name (as Airtable keys them), else by id. */
  find(key: string): FieldInfo | undefined {
    return this.byName.get(key) ?? this.byId.get(key);
  }

  /** The field a request names, or a 422 naming the key. */
  get(key: string, path: string): FieldInfo {
    const f = this.find(key);
    if (!f) unknownFields([{ path, message: `Unknown field name: "${key}".` }]);
    return f;
  }

  /** Cells keyed by name or id, keyed by field id (unknown keys collected in `errors`). */
  cells(
    cells: Record<string, unknown>,
    path: string,
    errors: ProblemFieldError[]
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(cells)) {
      const f = this.find(key);
      if (f) out[f.row.id] = value;
      else errors.push({ path: `${path}.${key}`, message: `Unknown field name: "${key}".` });
    }
    return out;
  }

  /** What `filterByFormula` sees. */
  get filterFields(): FilterField[] {
    return this.fields.map((f) => ({ id: f.row.id, name: f.row.name, type: fieldType(f.row) }));
  }
}

function unknownFields(errors: ProblemFieldError[]): never {
  throw new AppError('VALIDATION_FAILED', {
    detail: errors.map((e) => e.message).join(' '),
    extensions: { errors },
  });
}

/** How to present records: keys, cell format, locale. */
export interface PresentOptions {
  returnFieldsByFieldId?: boolean;
  cellFormat?: 'json' | 'string';
  userLocale?: string;
}

interface RecordOut {
  id: string;
  createdAt: string;
  fields: Record<string, unknown>;
}

/** Whether Airtable leaves a cell out: empty, unchecked, an empty list or text. */
const isEmptyCell = (v: unknown) =>
  v === null || v === undefined || v === false || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * People as Airtable's collaborator objects, by id: their name, and their email for workspace
 * members (base-only collaborators don't see emails in the directory).
 */
export async function collaborators(c: Context<V1Env>, ids: readonly string[]) {
  const valid = [...new Set(ids)].filter((id) => UUID.test(id));
  const rows = valid.length
    ? await c.var.tx
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(inArray(users.id, valid))
    : [];
  const people = new Map(rows.map((u) => [u.id, u]));
  const emails = c.var.resource.workspaceRole !== null;
  return (id: string): { id: string; email?: string; name?: string } => {
    const u = people.get(id);
    if (!u) return { id };
    const name = u.name ?? u.email?.split('@')[0];
    return { id, ...(emails && u.email ? { email: u.email } : {}), ...(name ? { name } : {}) };
  };
}

/**
 * Records in Airtable's shape: `createdTime`, and only non-empty cells, by field name (or id),
 * as `cellFormat=json` values (choice names, linked record ids, collaborators, files with a
 * URL) or display text. Collaborators carry their name, and their email for workspace members.
 */
export async function present(
  c: Context<V1Env>,
  keys: FieldKeys,
  records: readonly RecordOut[],
  opts: PresentOptions = {},
  appUrl = ''
): Promise<V1Record[]> {
  const tableId = keys.fields[0]?.row.tableId ?? '';
  const typed = (f: FieldInfo) => ({ type: fieldType(f.row), options: f.options });
  // First the people the cells name, then one query for their names.
  const wanted = new Set<string>();
  const collect: ApiValueContext = {
    user: (id) => {
      wanted.add(id);
      return { id };
    },
    fileUrl: () => '',
  };
  for (const r of records) {
    for (const [id, value] of Object.entries(r.fields)) {
      const f = keys.byId.get(id);
      if (f) apiValueOf(typed(f), value, collect);
    }
  }
  const person = await collaborators(c, [...wanted]);
  const ctx: ApiValueContext = {
    user: person,
    fileUrl: (id) => `${appUrl}/api/tables/${tableId}/attachments/${id}`,
  };
  const format = { locale: opts.userLocale, userName: (id: string) => ctx.user(id).name };
  return records.map((r) => {
    const fields: Record<string, unknown> = {};
    for (const [id, value] of Object.entries(r.fields)) {
      const f = keys.byId.get(id);
      if (!f) continue;
      const cell =
        opts.cellFormat === 'string'
          ? f.def.format(value, f.options, format)
          : apiValueOf(typed(f), value, ctx);
      if (!isEmptyCell(cell)) fields[opts.returnFieldsByFieldId ? f.row.id : f.row.name] = cell;
    }
    return { id: r.id, createdTime: r.createdAt, fields };
  });
}

/** The offset Airtable hands back: the query's keyset cursor and how many came before. */
function encodeOffset(cursor: string, seen: number): string {
  return Buffer.from(JSON.stringify({ c: cursor, n: seen })).toString('base64url');
}

function decodeOffset(offset: string): { cursor: string; seen: number } {
  try {
    const v = JSON.parse(Buffer.from(offset, 'base64url').toString('utf8')) as unknown;
    if (v && typeof v === 'object' && 'c' in v && 'n' in v) {
      const { c, n } = v as { c: unknown; n: unknown };
      if (typeof c === 'string' && Number.isSafeInteger(n) && (n as number) >= 0) {
        return { cursor: c, seen: n as number };
      }
    }
  } catch {
    // Below.
  }
  throw new AppError('VALIDATION_FAILED', {
    detail: 'The offset is invalid or belongs to another query.',
    extensions: { errors: [{ path: 'offset', message: 'Not an offset of this list.' }] },
  });
}

/** A view of the table by id or name that the user can see, else a 422. */
async function viewOf(tx: Transaction, table: TableRow, userId: string, key: string) {
  const rows = await tx
    .select({ id: views.id, name: views.name })
    .from(views)
    .where(and(eq(views.tableId, table.id), isNull(views.deletedAt), visibleTo(userId)))
    .orderBy(asc(views.position));
  const view = rows.find((v) => v.id === key.toLowerCase()) ?? rows.find((v) => v.name === key);
  if (!view) {
    throw new AppError('VALIDATION_FAILED', {
      detail: `No view "${key}" in this table.`,
      extensions: { errors: [{ path: 'view', message: 'No such view in this table.' }] },
    });
  }
  return view.id;
}

/** A 422 of the query engine about the formula becomes INVALID_FILTER_BY_FORMULA. */
function formulaError(err: unknown): unknown {
  if (!(err instanceof AppError) || err.code !== 'VALIDATION_FAILED') return err;
  const errors = (err.extensions?.['errors'] ?? []) as ProblemFieldError[];
  const own = errors.filter((e) => e.path.includes('filterByFormula'));
  if (own.length === 0) return err;
  return new AppError('INVALID_FILTER_BY_FORMULA', {
    detail: own.map((e) => e.message).join(' '),
  });
}

/**
 * A page of records (`GET /api/v1/:baseId/:table`): the view's records and order (or the
 * table's, oldest first), `sort` replacing the view's sorts, `fields` narrowing the cells,
 * `filterByFormula` as SQL, `maxRecords` across pages, `offset` the next page's keyset cursor.
 */
export async function listV1Records(
  c: Context<V1Env>,
  table: TableRow,
  params: V1ListParams,
  appUrl: string
) {
  const { tx, resource, principal } = c.var;
  const userId = principal.user.id;
  const keys = await FieldKeys.of(tx, table);
  const errors: ProblemFieldError[] = [];
  const fieldIds = params.fields?.map((k, i) => keys.find(k)?.row.id ?? missing(k, `fields.${i}`));
  const sorts = params.sort?.map((s, i) => ({
    fieldId: keys.find(s.field)?.row.id ?? missing(s.field, `sort.${i}.field`),
    direction: s.direction ?? ('asc' as const),
  }));
  function missing(key: string, path: string): string {
    errors.push({ path, message: `Unknown field name: "${key}".` });
    return '';
  }
  if (errors.length) unknownFields(errors);
  const viewId = params.view ? await viewOf(tx, table, userId, params.view) : undefined;
  const predicate: Predicate | undefined = params.filterByFormula?.trim()
    ? formulaPredicate(params.filterByFormula, keys.filterFields)
    : undefined;
  const from = params.offset ? decodeOffset(params.offset) : { cursor: undefined, seen: 0 };
  const max = params.maxRecords ?? Number.POSITIVE_INFINITY;
  const limit = Math.max(0, Math.min(params.pageSize ?? 100, max - from.seen));
  const input = queryRecordsSchema.parse({
    ...(viewId ? { viewId } : {}),
    query: {
      ...(sorts ? { sorts } : {}),
      ...(fieldIds ? { fields: fieldIds } : {}),
      ...(params.timeZone ? { timeZone: params.timeZone } : {}),
    },
    limit,
    count: false,
    ...(from.cursor !== undefined ? { cursor: from.cursor } : {}),
  });
  let page: Awaited<ReturnType<typeof queryRecords>>;
  try {
    page = await queryRecords(
      { tx, workspaceId: resource.workspaceId, userId, table },
      input,
      predicate ? { predicate } : {}
    );
  } catch (err) {
    throw formulaError(err);
  }
  const seen = from.seen + page.records.length;
  const records = await present(c, keys, page.records, params, appUrl);
  if (params.recordMetadata?.includes('commentCount')) {
    const counts = await commentCountsOf(
      c,
      table,
      records.map((r) => r.id)
    );
    for (const r of records) r.commentCount = counts.get(r.id) ?? 0;
  }
  return {
    records,
    ...(page.nextCursor && seen < max ? { offset: encodeOffset(page.nextCursor, seen) } : {}),
  };
}

async function commentCountsOf(c: Context<V1Env>, table: TableRow, ids: string[]) {
  if (!ids.length) return new Map<string, number>();
  const rows = await c.var.tx
    .select({ recordId: recordComments.recordId, n: count() })
    .from(recordComments)
    .where(
      and(
        eq(recordComments.tableId, table.id),
        inArray(recordComments.recordId, ids),
        isNull(recordComments.deletedAt)
      )
    )
    .groupBy(recordComments.recordId);
  return new Map(rows.map((r) => [r.recordId, r.n]));
}

/** One record's cells, all fields (`GET .../:recordId`). */
export async function getV1Record(
  c: Context<V1Env>,
  table: TableRow,
  recordId: string,
  opts: PresentOptions,
  appUrl: string
) {
  const { tx, resource, principal } = c.var;
  const keys = await FieldKeys.of(tx, table);
  const record = await getRecord(
    { tx, workspaceId: resource.workspaceId, userId: principal.user.id, table },
    recordId
  );
  const [out] = await present(c, keys, [record], opts, appUrl);
  if (!out) throw new Error('present: no record');
  return out;
}

/** A record write as the RecordService takes it: cells by field id. */
export interface V1Write {
  id?: string | undefined;
  fields: Record<string, unknown>;
}

/**
 * The cells a destructive update (`PUT`) also clears: every writable field left out of the
 * request that has a value now. Fields already empty aren't written, so a locked field
 * that is empty doesn't refuse the write.
 */
async function withCleared(ctx: RecordContext, keys: FieldKeys, writes: V1Write[]) {
  const out: V1Write[] = [];
  for (const w of writes) {
    if (!w.id) {
      out.push(w);
      continue;
    }
    const current = await getRecord(ctx, w.id);
    const fields = { ...w.fields };
    for (const f of keys.fields) {
      if (f.def.readOnly || f.def.computed || Object.hasOwn(fields, f.row.id)) continue;
      const value = current.fields[f.row.id];
      if (value !== null && value !== undefined && value !== f.def.emptyValue) {
        fields[f.row.id] = null;
      }
    }
    out.push({ id: w.id, fields });
  }
  return out;
}

/**
 * `PATCH`/`PUT` of records, with `performUpsert`: records without an id are matched on
 * `fieldsToMergeOn` (the same equality as `filterByFormula`'s `=`); no match creates one, one
 * match updates it, more is a 422. Answers the records in request order.
 */
export async function updateV1Records(
  c: Context<V1Env>,
  ctx: RecordContext,
  keys: FieldKeys,
  writes: V1Write[],
  opts: { destructive: boolean; mergeOn?: string[] | undefined }
) {
  const { principal } = c.var;
  const created: number[] = [];
  const ids: (string | undefined)[] = writes.map((w) => w.id);
  if (opts.mergeOn) {
    const merge = opts.mergeOn.map((k, i) => keys.get(k, `performUpsert.fieldsToMergeOn.${i}`));
    for (const [i, w] of writes.entries()) {
      if (w.id) continue;
      const errors: ProblemFieldError[] = [];
      const items = merge.map((f) => {
        if (!Object.hasOwn(w.fields, f.row.id)) {
          errors.push({
            path: `records.${i}.fields.${f.row.name}`,
            message: `"${f.row.name}" is a field to merge on: give it a value.`,
          });
        }
        return equalsPredicate(
          { id: f.row.id, name: f.row.name, type: fieldType(f.row) },
          w.fields[f.row.id]
        );
      });
      if (errors.length) unknownFields(errors);
      const page = await queryRecords(
        ctx,
        queryRecordsSchema.parse({ limit: 2, count: false, query: { fields: [] } }),
        { predicate: { kind: 'and', items } }
      );
      if (page.records.length > 1) {
        throw new AppError('VALIDATION_FAILED', {
          detail: `Record ${i + 1} matches more than one record on the fields to merge on.`,
          extensions: { errors: [{ path: `records.${i}`, message: 'Matches several records.' }] },
        });
      }
      const match = page.records[0];
      if (match) ids[i] = match.id;
      else created.push(i);
    }
  }
  if (created.length && !principalMay(principal, ctx.role, 'record:create')) {
    throw new AppError('FORBIDDEN', { detail: 'Upserting new records needs record creation.' });
  }
  const updates = writes.flatMap((w, i) => {
    const id = ids[i];
    return id && !created.includes(i) ? [{ id, fields: w.fields }] : [];
  });
  const patches = opts.destructive ? await withCleared(ctx, keys, updates) : updates;
  const updated = patches.length
    ? await updateRecords(
        ctx,
        patches.map((p) => ({ id: p.id as string, fields: p.fields }))
      )
    : [];
  const made = created.length
    ? await createRecords(
        ctx,
        created.map((i) => writes[i]?.fields ?? {})
      )
    : [];
  const byId = new Map(updated.map((r) => [r.id, r]));
  const records = writes.map((_w, i) => {
    const at = created.indexOf(i);
    const r = at >= 0 ? made[at] : byId.get(ids[i] ?? '');
    if (!r) throw new Error('update: record missing from the answer');
    return r;
  });
  return {
    records,
    createdRecords: made.map((r) => r.id),
    updatedRecords: updated.map((r) => r.id),
  };
}

/** Cells of each write keyed by field id; a 422 for unknown keys. */
export function writesOf(
  keys: FieldKeys,
  records: { id?: string; fields: Record<string, unknown> }[]
) {
  const errors: ProblemFieldError[] = [];
  const writes = records.map((r, i) => ({
    id: r.id,
    fields: keys.cells(r.fields, `records.${i}.fields`, errors),
  }));
  if (errors.length) unknownFields(errors);
  return writes;
}
