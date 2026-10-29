import {
  type Aggregate,
  type Choice,
  type DateRange,
  type FieldTypeDef,
  type FieldTypeName,
  type FilterCondition,
  type FilterGroup,
  isFilterSubgroup,
  MAX_DATE_RANGE_DAYS,
  MAX_FILTER_RECORDS,
  ME_TOKEN,
  matchChoice,
  type ProblemFieldError,
  type Sort,
  type SqlColumnType,
  type ViewQuery,
} from '@openrows/shared';
import { type SQL, sql } from 'drizzle-orm';
import {
  type LinkRead,
  linkEmptyExpr,
  linkHasAnyExpr,
  linkIdsExpr,
  linkMatchExpr,
  linkReadExpr,
  linkSortExpr,
} from '../links.js';

/**
 * The ViewQuery compiler. Turns a ViewQuery into parameterized SQL over a table's
 * physical record table, aliased `r` (ADR-001). Identifiers only come from field metadata of
 * that table (the `fields` whitelist: an id that isn't a live field of the table is a
 * validation error, so a query can't reach another table's columns), and every value is a bound
 * parameter. Type-specific behaviour follows the field-type registry (`filterOperators`,
 * `sort`, `storage`).
 */

/** A live field of the queried table, with its parsed options. */
export interface QueryField {
  id: string;
  name: string;
  type: FieldTypeName;
  dbColumn: string;
  def: FieldTypeDef;
  options: unknown;
  /** Where a link field's links live (link fields only, from RLS-protected metadata). */
  link?: LinkRead;
}

/** One ORDER BY key: its expression, direction and the type its cursor value casts back to. */
export interface SortKey {
  expr: SQL;
  direction: 'asc' | 'desc';
  cast: CursorCast;
  /**
   * Never NULL (the record id): ordered without `NULLS FIRST/LAST`, which gives the same order
   * and lets Postgres read it from a plain btree (the primary key).
   */
  notNull?: boolean;
}

/** Types a cursor value is cast back to; a fixed list, so `sql.raw` only ever sees these. */
type CursorCast =
  | 'text'
  | 'numeric'
  | 'smallint'
  | 'bigint'
  | 'boolean'
  | 'date'
  | 'timestamptz'
  | 'uuid'
  | 'int'
  | 'float8';

export interface CompiledGroup {
  field: QueryField;
  /** The group's ORDER BY keys: one, or a user's name then their id (ties of equal names). */
  keys: SortKey[];
}

export interface CompiledQuery {
  /** Live records matching the filter and search. */
  where: SQL;
  /** Group keys, then sorts, then `r.id` (always last, so the order is total). */
  keys: SortKey[];
  groups: CompiledGroup[];
  /** The fields records carry (visible fields). */
  fields: QueryField[];
  /** Fields the query filters, sorts or groups by: candidates for an index. */
  indexHints: IndexHint[];
}

/** An index that would serve the query (ADR-001: created by a background job, not inline). */
export interface IndexHint {
  fieldId: string;
  column: string;
  method: 'btree' | 'trgm';
}

export interface CompileOptions {
  /** "Now" for relative dates (tests pin it). */
  now?: Date;
  /** Path prefix of validation errors (`query`). */
  path?: string;
  /** The signed-in user, whom the `me` filter value stands for. */
  userId?: string;
  /**
   * Order by this key (a view's manual order) when the query has no sorts: after the
   * group levels, before the record id.
   */
  manualOrder?: SortKey;
  /**
   * A condition tree every record must also meet, beside the query's filter: the REST API's
   * `filterByFormula`, translated to conditions so it runs as SQL. Errors are under
   * `<path>.filterByFormula`.
   */
  predicate?: Predicate;
}

/**
 * A boolean tree of filter conditions. Unlike a view's filter (two levels, no negation) it
 * nests freely and negates; each condition compiles as a view's would.
 */
export type Predicate =
  | { kind: 'and' | 'or'; items: Predicate[] }
  | { kind: 'not'; item: Predicate }
  | { kind: 'condition'; condition: FilterCondition }
  | { kind: 'recordIds'; ids: string[] }
  | { kind: 'constant'; value: boolean };

/** A validation problem in the query (422 with every problem listed). */
export class QueryValidationError extends Error {
  constructor(readonly errors: ProblemFieldError[]) {
    super('invalid view query');
  }
}

const SYSTEM_COLUMNS = new Set(['created_at', 'updated_at', 'created_by', 'updated_by']);

/** The physical column of a field, qualified by the `r` alias. */
export function columnOf(f: QueryField): SQL {
  const storage = f.def.storage;
  const name = storage.kind === 'system' ? storage.column : f.dbColumn;
  if (storage.kind === 'system' ? !SYSTEM_COLUMNS.has(name) : !/^f_[0-9a-f]{32}$/.test(name)) {
    throw new Error(`field ${f.id} has an invalid column ${name}`);
  }
  return sql`r.${sql.identifier(name)}`;
}

const sqlTypeOf = (f: QueryField): SqlColumnType => f.def.storage.sqlType;

/** A `text[]` of user ids (the user field). */
const isUserIds = (f: QueryField) =>
  f.def.storage.kind === 'column' && f.def.storage.items === 'userIds';

/** The text key of a `jsonb` object column (barcode), else `null`. */
const textKeyOf = (f: QueryField): string | null =>
  f.def.storage.kind === 'column' ? (f.def.storage.textKey ?? null) : null;

/** The column as text: the column itself, or its text key for a `jsonb` object (barcode). */
function textOf(f: QueryField): SQL {
  const c = columnOf(f);
  const key = textKeyOf(f);
  return key === null ? c : sql`(${c} ->> ${key})`;
}

/**
 * A computed column that isn't a plain number: a lookup's `text[]` or a rollup's jsonb
 * scalar. Counts are `numeric` and go through the number paths.
 */
const isComputedColumn = (f: QueryField) =>
  f.def.storage.kind === 'computed' && (sqlTypeOf(f) === 'text[]' || sqlTypeOf(f) === 'jsonb');

/** A lookup's items joined with ", ", or a rollup's value, as text. */
function computedText(f: QueryField): SQL {
  const c = columnOf(f);
  return sqlTypeOf(f) === 'text[]' ? sql`array_to_string(${c}, ', ')` : sql`(${c} #>> '{}')`;
}

/** A rollup's value when it's a number (`NULL` for text and for lookups). */
export function computedNumber(f: QueryField): SQL {
  const c = columnOf(f);
  if (sqlTypeOf(f) !== 'jsonb') return sql`NULL::numeric`;
  return sql`(CASE WHEN jsonb_typeof(${c}) = 'number' THEN (${c} #>> '{}')::numeric END)`;
}

/** A JSON array parameter as `text[]` (or `uuid[]`): safe for any string content. */
function textArray(items: readonly string[], type: 'text' | 'uuid' = 'text'): SQL {
  const json = JSON.stringify(items);
  return type === 'uuid'
    ? sql`ARRAY(SELECT jsonb_array_elements_text(${json}::jsonb)::uuid)`
    : sql`ARRAY(SELECT jsonb_array_elements_text(${json}::jsonb))`;
}

/** An `ILIKE` pattern matching `text` anywhere (`%`, `_` and `\` escaped). */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const choicesOf = (f: QueryField): readonly Choice[] =>
  (f.options as { choices?: Choice[] } | null)?.choices ?? [];

/** SQL that's true when the field's cell is empty (never NULL itself). */
export function emptyExpr(f: QueryField): SQL {
  if (f.link) return linkEmptyExpr(f.link);
  const c = columnOf(f);
  switch (sqlTypeOf(f)) {
    case 'text':
      return sql`(${c} IS NULL OR ${c} = '')`;
    case 'text[]':
      return sql`(${c} IS NULL OR cardinality(${c}) = 0)`;
    case 'jsonb':
      return sql`(${c} IS NULL OR ${c} = '[]'::jsonb)`;
    case 'boolean':
      return sql`(${c} IS NOT TRUE)`;
    default:
      return sql`(${c} IS NULL)`;
  }
}

function isBlankValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

// ---- dates -------------------------------------------------------------------------------

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})/;

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function todayIn(tz: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function shiftDay(day: string, days: number, months = 0, years = 0): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years, d.getUTCMonth() + months, d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function readDay(value: unknown, today: string): string | null {
  if (value === 'today') return today;
  if (value === 'tomorrow') return shiftDay(today, 1);
  if (value === 'yesterday') return shiftDay(today, -1);
  if (typeof value !== 'string') return null;
  const m = DAY_RE.exec(value.trim());
  if (!m) return null;
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day ? day : null;
}

/** `isWithin` ranges, inclusive days. */
function readRange(value: unknown, today: string): [string, string] | null {
  switch (value) {
    case 'pastWeek':
      return [shiftDay(today, -7), today];
    case 'pastMonth':
      return [shiftDay(today, 0, -1), today];
    case 'pastYear':
      return [shiftDay(today, 0, 0, -1), today];
    case 'nextWeek':
      return [today, shiftDay(today, 7)];
    case 'nextMonth':
      return [today, shiftDay(today, 0, 1)];
    case 'nextYear':
      return [today, shiftDay(today, 0, 0, 1)];
  }
  if (typeof value === 'object' && value !== null) {
    const v = value as { pastDays?: unknown; nextDays?: unknown };
    const n = v.pastDays ?? v.nextDays;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 100_000) return null;
    return v.pastDays !== undefined ? [shiftDay(today, -n), today] : [today, shiftDay(today, n)];
  }
  return null;
}

// ---- conditions --------------------------------------------------------------------------

interface Ctx {
  errors: ProblemFieldError[];
  now: Date;
  /** Zone of `today` for date-only fields. */
  timeZone: string;
  /** Who `me` is; without one, `me` matches nobody. */
  userId: string | undefined;
}

/** No user has this id: what `me` means when the query runs without a user. */
const NOBODY = '00000000-0000-0000-0000-000000000000';

function readBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return null;
}

function readFiniteNumber(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/** Choice ids for ids or names; unknown names stay as they are (and match nothing). */
function choiceIds(f: QueryField, value: unknown): string[] | null {
  const ids: string[] = [];
  for (const item of list(value)) {
    if (typeof item !== 'string') return null;
    const id = matchChoice(item, choicesOf(f)) ?? item;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** One condition as SQL, `null` when it's ignored (blank value), or an error. */
function conditionSql(f: QueryField, cond: FilterCondition, ctx: Ctx, path: string): SQL | null {
  const { operator: op, value } = cond;
  const fail = (message: string) => {
    ctx.errors.push({ path, message });
    return null;
  };
  if (!f.def.filterOperators.includes(op)) {
    return fail(`"${op}" isn't a filter for ${f.def.label.toLowerCase()} fields.`);
  }
  if (op === 'isEmpty') return emptyExpr(f);
  if (op === 'isNotEmpty') return sql`NOT ${emptyExpr(f)}`;
  if (isBlankValue(value)) return null;

  // Links: specific linked records by id, or the linked records' primary field text.
  if (f.link) {
    if (op === 'hasAnyOf' || op === 'hasNoneOf') {
      const ids = list(value);
      if (ids.length > MAX_FILTER_RECORDS) {
        return fail(`A link filter names at most ${MAX_FILTER_RECORDS} records.`);
      }
      if (!ids.every((id) => typeof id === 'string' && UUID_RE.test(id))) {
        return fail(`"${op}" on links takes record ids.`);
      }
      const match = linkHasAnyExpr(f.link, [
        ...new Set((ids as string[]).map((id) => id.toLowerCase())),
      ]);
      return op === 'hasAnyOf' ? match : sql`(NOT ${match})`;
    }
    if (typeof value !== 'string') return fail(`Not a valid value for "${op}" on links.`);
    const match = linkMatchExpr(f.link, containsPattern(value));
    if (op === 'contains') return match;
    if (op === 'doesNotContain') return sql`(NOT ${match})`;
    return fail(`Not a valid value for "${op}" on links.`);
  }

  const c = columnOf(f);
  const type = sqlTypeOf(f);
  const invalid = () => fail(`Not a valid value for "${op}" on ${f.def.label.toLowerCase()}.`);

  // Lookups (text[]) and rollups (a jsonb number or text): compared as numbers or text.
  if (isComputedColumn(f)) {
    if (op === 'contains' || op === 'doesNotContain') {
      if (typeof value !== 'string') return invalid();
      const t = computedText(f);
      return op === 'contains'
        ? sql`(${t} ILIKE ${containsPattern(value)})`
        : sql`(${t} IS NULL OR ${t} NOT ILIKE ${containsPattern(value)})`;
    }
    const n = readFiniteNumber(value);
    if (n === null) return invalid();
    const v = sql`${String(n)}::numeric`;
    const x = computedNumber(f);
    switch (op) {
      case '=':
        return sql`(${x} = ${v})`;
      case '!=':
        return sql`(${x} IS NULL OR ${x} <> ${v})`;
      case '<':
        return sql`(${x} < ${v})`;
      case '<=':
        return sql`(${x} <= ${v})`;
      case '>':
        return sql`(${x} > ${v})`;
      case '>=':
        return sql`(${x} >= ${v})`;
    }
    return invalid();
  }

  // Checkbox.
  if (type === 'boolean') {
    const b = readBoolean(value);
    if (b === null) return invalid();
    return b ? sql`(${c} IS TRUE)` : sql`(${c} IS NOT TRUE)`;
  }

  // Numbers: number, currency, percent, duration, rating, autonumber.
  if (f.def.sort === 'number') {
    const n = readFiniteNumber(value);
    if (n === null) return invalid();
    const v = sql`${String(n)}::numeric`;
    switch (op) {
      case '=':
        return sql`(${c} = ${v})`;
      case '!=':
        return sql`(${c} IS NULL OR ${c} <> ${v})`;
      case '<':
        return sql`(${c} < ${v})`;
      case '<=':
        return sql`(${c} <= ${v})`;
      case '>':
        return sql`(${c} > ${v})`;
      case '>=':
        return sql`(${c} >= ${v})`;
    }
    return invalid();
  }

  // Dates and datetimes: by day, in the field's zone for datetimes.
  if (f.def.sort === 'chronological') {
    const zoned = type === 'timestamptz';
    const tz = zoned ? ((f.options as { timeZone?: string }).timeZone ?? 'UTC') : ctx.timeZone;
    const today = todayIn(tz, ctx.now);
    // The first instant of a day (or the day itself for `date` columns): index-friendly bounds.
    const start = (day: string) =>
      zoned ? sql`(${day}::date::timestamp AT TIME ZONE ${tz})` : sql`${day}::date`;
    if (op === 'isWithin') {
      const range = readRange(value, today);
      if (!range) return invalid();
      return sql`(${c} >= ${start(range[0])} AND ${c} < ${start(shiftDay(range[1], 1))})`;
    }
    const day = readDay(value, today);
    if (!day) return invalid();
    const next = shiftDay(day, 1);
    switch (op) {
      case 'is':
        return sql`(${c} >= ${start(day)} AND ${c} < ${start(next)})`;
      case 'isNot':
        return sql`(${c} IS NULL OR ${c} < ${start(day)} OR ${c} >= ${start(next)})`;
      case 'isBefore':
        return sql`(${c} < ${start(day)})`;
      case 'isOnOrBefore':
        return sql`(${c} < ${start(next)})`;
      case 'isAfter':
        return sql`(${c} >= ${start(next)})`;
      case 'isOnOrAfter':
        return sql`(${c} >= ${start(day)})`;
    }
    return invalid();
  }

  // Users (createdBy, lastModifiedBy): ids, or `me` for the signed-in user.
  if (type === 'uuid') {
    const ids = list(value);
    const valid = (id: unknown) => typeof id === 'string' && (id === ME_TOKEN || UUID_RE.test(id));
    if (!ids.every(valid)) return invalid();
    const lower = (ids as string[]).map((id) =>
      id === ME_TOKEN ? (ctx.userId ?? NOBODY) : id.toLowerCase()
    );
    switch (op) {
      case 'is':
        return lower.length === 1 ? sql`(${c} = ${lower[0]}::uuid)` : invalid();
      case 'isNot':
        return lower.length === 1 ? sql`(${c} IS NULL OR ${c} <> ${lower[0]}::uuid)` : invalid();
      case 'isAnyOf':
        return sql`(${c} = ANY(${textArray(lower, 'uuid')}))`;
      case 'isNoneOf':
        return sql`(${c} IS NULL OR NOT (${c} = ANY(${textArray(lower, 'uuid')})))`;
    }
    return invalid();
  }

  // User fields: user ids, or `me` for the signed-in user.
  if (isUserIds(f)) {
    const ids = list(value);
    const valid = (id: unknown) => typeof id === 'string' && (id === ME_TOKEN || UUID_RE.test(id));
    if (!ids.every(valid)) return invalid();
    const arr = textArray([
      ...new Set(
        (ids as string[]).map((id) => (id === ME_TOKEN ? (ctx.userId ?? NOBODY) : id.toLowerCase()))
      ),
    ]);
    switch (op) {
      case 'hasAnyOf':
        return sql`(${c} && ${arr})`;
      case 'hasAllOf':
        return sql`(${c} @> ${arr})`;
      case 'isExactly':
        return sql`(${c} @> ${arr} AND ${c} <@ ${arr})`;
      case 'hasNoneOf':
        return sql`(${c} IS NULL OR NOT (${c} && ${arr}))`;
    }
    return invalid();
  }

  // Multiple select.
  if (type === 'text[]') {
    const ids = choiceIds(f, value);
    if (!ids) return invalid();
    const arr = textArray(ids);
    switch (op) {
      case 'hasAnyOf':
        return sql`(${c} && ${arr})`;
      case 'hasAllOf':
        return sql`(${c} @> ${arr})`;
      case 'isExactly':
        return sql`(${c} @> ${arr} AND ${c} <@ ${arr})`;
      case 'hasNoneOf':
        return sql`(${c} IS NULL OR NOT (${c} && ${arr}))`;
    }
    return invalid();
  }

  // Attachments: file names.
  if (type === 'jsonb' && textKeyOf(f) === null) {
    if (typeof value !== 'string') return invalid();
    const match = sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${c}) AS a
      WHERE a->>'filename' ILIKE ${containsPattern(value)})`;
    if (op === 'contains') return sql`(${c} IS NOT NULL AND ${match})`;
    if (op === 'doesNotContain') return sql`(${c} IS NULL OR NOT ${match})`;
    return invalid();
  }

  // Single select: choice ids.
  if (f.def.sort === 'choiceOrder') {
    const ids = choiceIds(f, value);
    if (!ids) return invalid();
    switch (op) {
      case 'is':
        return ids.length === 1 ? sql`(${c} = ${ids[0]})` : invalid();
      case 'isNot':
        return ids.length === 1 ? sql`(${c} IS NULL OR ${c} <> ${ids[0]})` : invalid();
      case 'isAnyOf':
        return sql`(${c} = ANY(${textArray(ids)}))`;
      case 'isNoneOf':
        return sql`(${c} IS NULL OR NOT (${c} = ANY(${textArray(ids)})))`;
    }
    return invalid();
  }

  // Text: single line, long text, email, URL, phone, a barcode's text. Case-insensitive.
  if (typeof value !== 'string') return invalid();
  const t = textOf(f);
  switch (op) {
    case 'is':
      return sql`(lower(${t}) = lower(${value}))`;
    case 'isNot':
      return sql`(${t} IS NULL OR lower(${t}) <> lower(${value}))`;
    case 'contains':
      return sql`(${t} ILIKE ${containsPattern(value)})`;
    case 'doesNotContain':
      return sql`(${t} IS NULL OR ${t} NOT ILIKE ${containsPattern(value)})`;
  }
  return invalid();
}

function joinConditions(parts: SQL[], conjunction: 'and' | 'or'): SQL | null {
  if (parts.length === 0) return null;
  return sql`(${sql.join(parts, conjunction === 'and' ? sql` AND ` : sql` OR `)})`;
}

function filterSql(
  filter: FilterGroup,
  byId: Map<string, QueryField>,
  ctx: Ctx,
  path: string,
  used: Set<QueryField>
): SQL | null {
  const compileOne = (cond: FilterCondition, at: string) => {
    const f = byId.get(cond.fieldId);
    if (!f) {
      ctx.errors.push({ path: `${at}.fieldId`, message: 'No such field in this table.' });
      return null;
    }
    used.add(f);
    return conditionSql(f, cond, ctx, at);
  };
  const parts: SQL[] = [];
  filter.conditions.forEach((entry, i) => {
    const at = `${path}.conditions.${i}`;
    if (isFilterSubgroup(entry)) {
      const inner = entry.conditions.flatMap(
        (cond, j) => compileOne(cond, `${at}.conditions.${j}`) ?? []
      );
      const joined = joinConditions(inner, entry.conjunction);
      if (joined) parts.push(joined);
    } else {
      const one = compileOne(entry, at);
      if (one) parts.push(one);
    }
  });
  return joinConditions(parts, filter.conjunction);
}

/**
 * A predicate as SQL that is never NULL (a NULL cell makes `{n} = 5` NULL, and `NOT` of it must
 * still be true, as Airtable's `NOT({n} = 5)` is for an empty `n`).
 */
function predicateSql(
  p: Predicate,
  byId: Map<string, QueryField>,
  ctx: Ctx,
  path: string,
  used: Set<QueryField>
): SQL {
  switch (p.kind) {
    case 'constant':
      return p.value ? sql`TRUE` : sql`FALSE`;
    case 'recordIds': {
      const ids = p.ids.filter((id) => UUID_RE.test(id)).map((id) => id.toLowerCase());
      return ids.length ? sql`(r.id = ANY(${textArray(ids, 'uuid')}))` : sql`FALSE`;
    }
    case 'not':
      return sql`(NOT ${predicateSql(p.item, byId, ctx, path, used)})`;
    case 'and':
    case 'or': {
      if (p.items.length === 0) return p.kind === 'and' ? sql`TRUE` : sql`FALSE`;
      const parts = p.items.map((item) => predicateSql(item, byId, ctx, path, used));
      return sql`(${sql.join(parts, p.kind === 'and' ? sql` AND ` : sql` OR `)})`;
    }
    case 'condition': {
      const f = byId.get(p.condition.fieldId);
      if (!f) {
        ctx.errors.push({ path, message: 'No such field in this table.' });
        return sql`FALSE`;
      }
      used.add(f);
      const one = conditionSql(f, p.condition, ctx, path);
      // A blank value is ignored, as in a view's filter.
      return one ? sql`(${one} IS TRUE)` : sql`TRUE`;
    }
  }
}

// ---- search ------------------------------------------------------------------------------

/** Search: any visible text, select or number field contains the term (ignoring case). */
function searchSql(term: string, fields: readonly QueryField[]): SQL {
  const pattern = containsPattern(term);
  const lower = term.toLowerCase();
  const parts: SQL[] = [];
  for (const f of fields) {
    if (f.link) {
      parts.push(linkMatchExpr(f.link, pattern));
      continue;
    }
    const c = columnOf(f);
    const type = sqlTypeOf(f);
    if (isComputedColumn(f)) {
      parts.push(sql`${computedText(f)} ILIKE ${pattern}`);
    } else if (f.def.sort === 'choiceOrder') {
      const ids = choicesOf(f)
        .filter((ch) => ch.name.toLowerCase().includes(lower))
        .map((ch) => ch.id);
      if (ids.length === 0) continue;
      parts.push(
        type === 'text[]' ? sql`${c} && ${textArray(ids)}` : sql`${c} = ANY(${textArray(ids)})`
      );
    } else if (type === 'text' || textKeyOf(f) !== null) {
      parts.push(sql`${textOf(f)} ILIKE ${pattern}`);
    } else if (f.def.sort === 'number' && /\d/.test(term)) {
      parts.push(sql`${c}::text ILIKE ${pattern}`);
    }
  }
  return parts.length ? sql`(${sql.join(parts, sql` OR `)})` : sql`false`;
}

// ---- sorts -------------------------------------------------------------------------------

/**
 * A user's sort name: their display name (the name, else the email), lower-cased, read
 * from `users` only for people of this workspace (members, or collaborators of one of its
 * bases: `workspace_members` and `base_members` are under the tenant's RLS policy in the
 * request's transaction). Former members and empty cells give NULL, so they sort first.
 */
export function userNameExpr(c: SQL): SQL {
  return sql`(SELECT lower(coalesce(nullif(u.name, ''), u.email)) FROM users u
    WHERE u.id = ${c}
      AND (EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.user_id = u.id)
        OR EXISTS (SELECT 1 FROM base_members bm WHERE bm.user_id = u.id)))`;
}

/**
 * The ORDER BY keys of a field (registry `sort` kind), or `null` if it can't sort. Users sort by
 * name, then by id, so two people with the same name never interleave.
 */
export function sortExprs(f: QueryField): { expr: SQL; cast: CursorCast }[] | null {
  // Links sort by the linked records' names, in order, then by their ids, so groups of
  // equal names but other records never interleave.
  if (f.link) {
    return [
      { expr: linkSortExpr(f.link), cast: 'text' },
      { expr: linkIdsExpr(f.link), cast: 'text' },
    ];
  }
  if (f.def.sort === 'none') return null;
  const c = columnOf(f);
  if (f.def.sort === 'text' && sqlTypeOf(f) === 'uuid') {
    return [
      { expr: userNameExpr(c), cast: 'text' },
      { expr: c, cast: 'uuid' },
    ];
  }
  // User fields: by the first person's name, then by the whole list (groups by the list).
  if (isUserIds(f)) {
    return [
      { expr: userNameExpr(sql`(${c}[1])::uuid`), cast: 'text' },
      { expr: sql`array_to_string(${c}, ',')`, cast: 'text' },
    ];
  }
  // Barcodes: by text, then the whole value (groups by text and type).
  if (textKeyOf(f) !== null) {
    return [
      { expr: sql`lower(${textOf(f)})`, cast: 'text' },
      { expr: sql`(${c})::text`, cast: 'text' },
    ];
  }
  // Rollups by number, then text (one function gives all numbers or all text); lookups by
  // their items' text.
  if (isComputedColumn(f)) {
    const text = { expr: sql`lower(${computedText(f)})`, cast: 'text' as const };
    return sqlTypeOf(f) === 'jsonb' ? [{ expr: computedNumber(f), cast: 'numeric' }, text] : [text];
  }
  const one = sortExpr(f);
  return one ? [one] : null;
}

/** The single ORDER BY expression of a non-user field, or `null` if it can't sort. */
function sortExpr(f: QueryField): { expr: SQL; cast: CursorCast } | null {
  const c = columnOf(f);
  const type = sqlTypeOf(f);
  switch (f.def.sort) {
    case 'text':
      return type === 'text' ? { expr: sql`lower(${c})`, cast: 'text' } : { expr: c, cast: 'uuid' };
    case 'boolean':
      // Unset checkboxes (NULL) are unchecked: one group, one sort position.
      return { expr: sql`coalesce(${c}, false)`, cast: 'boolean' };
    case 'number':
    case 'chronological':
      return { expr: c, cast: type as CursorCast };
    case 'choiceOrder': {
      const choices = choicesOf(f);
      const first = type === 'text[]' ? sql`${c}[1]` : c;
      const ids = textArray(choices.map((ch) => ch.id));
      // Unknown ids after every known choice, empty first.
      return {
        expr: sql`(CASE WHEN ${first} IS NULL THEN NULL ELSE coalesce(array_position(${ids}, ${first}), ${choices.length}) END)`,
        cast: 'int',
      };
    }
    default:
      return null;
  }
}

function sortKeys(
  sorts: readonly Sort[],
  byId: Map<string, QueryField>,
  ctx: Ctx,
  path: string,
  used: Set<QueryField>
): { field: QueryField; keys: SortKey[] }[] {
  return sorts.flatMap((s, i) => {
    const f = byId.get(s.fieldId);
    if (!f) {
      ctx.errors.push({ path: `${path}.${i}.fieldId`, message: 'No such field in this table.' });
      return [];
    }
    const e = sortExprs(f);
    if (!e) {
      ctx.errors.push({
        path: `${path}.${i}.fieldId`,
        message: `${f.def.label} fields can't be sorted or grouped.`,
      });
      return [];
    }
    used.add(f);
    return [{ field: f, keys: e.map((k) => ({ ...k, direction: s.direction })) }];
  });
}

/**
 * What records group on: the column, with unset checkboxes as unchecked; a link's whole list of
 * linked records (Airtable groups by the list).
 */
export function groupExpr(f: QueryField): SQL {
  if (f.link) return linkReadExpr(f.link);
  const c = columnOf(f);
  return f.def.sort === 'boolean' ? sql`coalesce(${c}, false)` : c;
}

/** `ORDER BY` for keys: empty values first ascending, last descending (a full reversal). */
export function orderBy(keys: readonly SortKey[]): SQL {
  return sql.join(
    keys.map((k) => {
      if (k.notNull) return k.direction === 'asc' ? sql`${k.expr} ASC` : sql`${k.expr} DESC`;
      return k.direction === 'asc'
        ? sql`${k.expr} ASC NULLS FIRST`
        : sql`${k.expr} DESC NULLS LAST`;
    }),
    sql`, `
  );
}

export const ID_KEY: SortKey = { expr: sql`r.id`, direction: 'asc', cast: 'uuid', notNull: true };

// ---- date ranges (calendar) ---------------------------------------------------------

/**
 * Records whose range meets the days `from`..`to` for at least one date field pair: the start
 * is before the day after `to`, and the end (the start when the end is empty) is on or after
 * `from`. Each bound is the first instant of a day in its own field's zone (datetimes) or the
 * day itself (dates), so a date-only field never shifts and the bounds stay index-friendly.
 */
function dateRangeSql(
  range: DateRange,
  byId: ReadonlyMap<string, QueryField>,
  ctx: Ctx,
  path: string,
  used: Set<QueryField>
): SQL | null {
  const from = readDay(range.from, '');
  const to = readDay(range.to, '');
  if (!from) ctx.errors.push({ path: `${path}.from`, message: 'Not a date.' });
  if (!to) ctx.errors.push({ path: `${path}.to`, message: 'Not a date.' });
  if (!from || !to) return null;
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (days < 0) {
    ctx.errors.push({ path: `${path}.to`, message: 'The range ends before it starts.' });
    return null;
  }
  if (days >= MAX_DATE_RANGE_DAYS) {
    ctx.errors.push({
      path: `${path}.to`,
      message: `A range spans at most ${MAX_DATE_RANGE_DAYS} days.`,
    });
    return null;
  }
  const after = shiftDay(to, 1);
  const dateField = (id: string, at: string) => {
    const f = byId.get(id);
    if (!f) ctx.errors.push({ path: at, message: 'No such field in this table.' });
    else if (f.def.sort !== 'chronological' || f.link) {
      ctx.errors.push({ path: at, message: 'Not a date field.' });
    } else {
      used.add(f);
      return f;
    }
    return undefined;
  };
  const dayStart = (f: QueryField, day: string) => {
    if (sqlTypeOf(f) !== 'timestamptz') return sql`${day}::date`;
    const tz = (f.options as { timeZone?: string }).timeZone ?? 'UTC';
    return sql`(${day}::date::timestamp AT TIME ZONE ${tz})`;
  };
  const parts = range.fields.flatMap((pair, i): SQL[] => {
    const start = dateField(pair.startFieldId, `${path}.fields.${i}.startFieldId`);
    const end = pair.endFieldId
      ? dateField(pair.endFieldId, `${path}.fields.${i}.endFieldId`)
      : undefined;
    if (!start || (pair.endFieldId && !end)) return [];
    const s = columnOf(start);
    const startsInTime = sql`${s} < ${dayStart(start, after)}`;
    if (!end) return [sql`(${startsInTime} AND ${s} >= ${dayStart(start, from)})`];
    const e = columnOf(end);
    // An end before the start counts as no end (the record is one day long, as on screen).
    return [
      sql`(${startsInTime} AND CASE WHEN ${e} IS NULL OR ${e} < ${s} THEN ${s} >= ${dayStart(start, from)} ELSE ${e} >= ${dayStart(end, from)} END)`,
    ];
  });
  return joinConditions(parts, 'or');
}

// ---- the query ---------------------------------------------------------------------------

/** Compiles a query against the live fields of one table. Throws QueryValidationError. */
export function compileViewQuery(
  query: ViewQuery,
  fields: readonly QueryField[],
  opts: CompileOptions = {}
): CompiledQuery {
  const path = opts.path ?? 'query';
  const byId = new Map(fields.map((f) => [f.id, f]));
  const timeZone = query.timeZone ?? 'UTC';
  const ctx: Ctx = { errors: [], now: opts.now ?? new Date(), timeZone, userId: opts.userId };
  if (!validTimeZone(timeZone)) {
    ctx.errors.push({ path: `${path}.timeZone`, message: 'Unknown time zone.' });
    ctx.timeZone = 'UTC';
  }

  let visible: QueryField[] = [...fields];
  if (query.fields) {
    visible = [];
    query.fields.forEach((id, i) => {
      const f = byId.get(id);
      if (!f)
        ctx.errors.push({ path: `${path}.fields.${i}`, message: 'No such field in this table.' });
      else if (!visible.includes(f)) visible.push(f);
    });
  }

  const filtered = new Set<QueryField>();
  const sorted = new Set<QueryField>();
  const conditions: SQL[] = [sql`r.deleted_at IS NULL`];
  if (query.filter) {
    const f = filterSql(query.filter, byId, ctx, `${path}.filter`, filtered);
    if (f) conditions.push(f);
  }
  if (query.within?.length) {
    const w = filterSql(
      { conjunction: 'and', conditions: query.within },
      byId,
      ctx,
      `${path}.within`,
      filtered
    );
    if (w) conditions.push(w);
  }
  if (opts.predicate) {
    conditions.push(predicateSql(opts.predicate, byId, ctx, `${path}.filterByFormula`, filtered));
  }
  if (query.dateRange) {
    const r = dateRangeSql(query.dateRange, byId, ctx, `${path}.dateRange`, filtered);
    if (r) conditions.push(r);
  }
  if (query.search) conditions.push(searchSql(query.search, visible));

  const groups = sortKeys(query.groupBy, byId, ctx, `${path}.groupBy`, sorted);
  const sorts = sortKeys(query.sorts, byId, ctx, `${path}.sorts`, sorted);
  if (ctx.errors.length) throw new QueryValidationError(ctx.errors);

  const hints = new Map<string, IndexHint>();
  // Links are served by the junction's own indexes.
  for (const f of sorted) if (!f.link) hints.set(f.id, hintFor(f, 'btree'));
  for (const f of filtered) {
    if (!hints.has(f.id) && !f.link)
      hints.set(f.id, hintFor(f, sqlTypeOf(f) === 'text' ? 'trgm' : 'btree'));
  }

  return {
    where: sql.join(conditions, sql` AND `),
    keys: [
      ...groups.flatMap((g) => g.keys),
      ...sorts.flatMap((s) => s.keys),
      ...(sorts.length === 0 && opts.manualOrder ? [opts.manualOrder] : []),
      ID_KEY,
    ],
    groups,
    fields: visible,
    indexHints: [...hints.values()].filter((h) => h.column !== ''),
  };
}

function hintFor(f: QueryField, method: IndexHint['method']): IndexHint {
  const storage = f.def.storage;
  return {
    fieldId: f.id,
    column: storage.kind === 'system' ? storage.column : f.dbColumn,
    method,
  };
}

// ---- keyset cursors ----------------------------------------------------------------------

/** A keyset cursor: the last row's sort key values (as text) and its id. */
interface Cursor {
  k: (string | null)[];
}

export function encodeCursor(values: (string | null)[]): string {
  return Buffer.from(JSON.stringify({ k: values } satisfies Cursor)).toString('base64url');
}

export function decodeCursor(cursor: string, keyCount: number): (string | null)[] | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const k = (parsed as Cursor | null)?.k;
    if (!Array.isArray(k) || k.length !== keyCount) return null;
    if (!k.every((v) => v === null || (typeof v === 'string' && v.length <= 2000))) return null;
    return k;
  } catch {
    return null;
  }
}

/**
 * Rows strictly after the cursor in `keys` order (lexicographic, honouring each key's
 * direction and where its empty values sort). `values` come from `decodeCursor`.
 */
export function afterCursor(keys: readonly SortKey[], values: readonly (string | null)[]): SQL {
  const cast = (v: string, k: SortKey) => sql`${v}::${sql.raw(k.cast)}`;
  const branches: SQL[] = [];
  for (let i = 0; i < keys.length; i++) {
    const parts: SQL[] = [];
    for (let j = 0; j < i; j++) {
      const k = keys[j] as SortKey;
      const v = values[j] ?? null;
      parts.push(v === null ? sql`${k.expr} IS NULL` : sql`${k.expr} = ${cast(v, k)}`);
    }
    const k = keys[i] as SortKey;
    const v = values[i] ?? null;
    if (k.direction === 'asc') {
      // NULLS FIRST: after a NULL comes any value; after a value, larger ones.
      parts.push(v === null ? sql`${k.expr} IS NOT NULL` : sql`${k.expr} > ${cast(v, k)}`);
    } else {
      // NULLS LAST: nothing comes after a NULL; after a value, smaller ones and NULLs.
      if (v === null) continue;
      parts.push(sql`(${k.expr} < ${cast(v, k)} OR ${k.expr} IS NULL)`);
    }
    branches.push(sql`(${sql.join(parts, sql` AND `)})`);
  }
  if (!branches.length) return sql`false`;
  const after = sql`(${sql.join(branches, sql` OR `)})`;
  // A redundant lower bound on an ascending first key gives the planner an index range to start
  // from: the OR above alone makes it scan the index from its beginning.
  const [first] = keys;
  const v = values[0] ?? null;
  if (keys.length > 1 && first && first.direction === 'asc' && v !== null) {
    return sql`(${first.expr} >= ${cast(v, first)} AND ${after})`;
  }
  return after;
}

/** Aggregates a field type supports. */
export function aggregatesFor(f: QueryField): readonly Aggregate[] {
  if (f.link) return ['count', 'empty', 'filled'];
  const base: Aggregate[] = ['count', 'empty', 'filled', 'unique'];
  if (f.def.sort === 'number') return [...base, 'sum', 'avg', 'min', 'max'];
  if (f.def.sort === 'chronological') return [...base, 'min', 'max'];
  return base;
}
