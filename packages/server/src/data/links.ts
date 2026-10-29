import type { Choice, FieldTypeDef } from '@openrows/shared';
import { type SQL, sql } from 'drizzle-orm';

/**
 * SQL over link junctions (ADR-001). A link field has no column: its links are rows of the
 * junction `l_<hex>` (in the base schema) that it shares with its inverse field, `from_id` being
 * the record of the table whose field owns the junction and `to_id` the linked record. Every
 * name comes from RLS-protected metadata (`LinkRead`, built in records/links.ts) and is checked
 * here before it's quoted; values are bound parameters.
 */

/** The linked table's primary field, whose text names a linked record. */
export interface LinkedPrimary {
  type: string;
  dbColumn: string;
  def: FieldTypeDef;
  options: unknown;
}

/** Where a link field's links live, as seen from the field's table. */
export interface LinkRead {
  /** The base schema: the junction and both tables are in it. */
  schema: string;
  junction: string;
  /** This side's junction column: `from_id` for the field that owns the junction. */
  self: 'from_id' | 'to_id';
  /** The linked table's record table. */
  target: { dbSchema: string; dbTable: string };
  /** The linked table's primary field (`null` if it has none, which shouldn't happen). */
  primary: LinkedPrimary | null;
}

const SCHEMA_RE = /^b_[0-9a-f]{32}$/;
const TABLE_RE = /^t_[0-9a-f]{32}$/;
const JUNCTION_RE = /^l_[0-9a-f]{32}$/;
const COLUMN_RE = /^f_[0-9a-f]{32}$/;
const SYSTEM_COLUMNS = new Set(['created_at', 'updated_at', 'created_by', 'updated_by']);

function checked(l: LinkRead): LinkRead {
  if (
    !SCHEMA_RE.test(l.schema) ||
    l.target.dbSchema !== l.schema ||
    !TABLE_RE.test(l.target.dbTable) ||
    !JUNCTION_RE.test(l.junction)
  ) {
    throw new Error(`invalid link location ${l.schema}.${l.junction}`);
  }
  return l;
}

export const otherSide = (l: LinkRead) => (l.self === 'from_id' ? 'to_id' : 'from_id');
export const selfPosition = (l: LinkRead) =>
  l.self === 'from_id' ? 'position' : 'inverse_position';
export const otherPosition = (l: LinkRead) =>
  l.self === 'from_id' ? 'inverse_position' : 'position';

/** The junction, schema-qualified. */
export function junctionOf(l: LinkRead): SQL {
  const c = checked(l);
  return sql`${sql.identifier(c.schema)}.${sql.identifier(c.junction)}`;
}

/** The linked table, schema-qualified. */
export function targetOf(l: LinkRead): SQL {
  const c = checked(l);
  return sql`${sql.identifier(c.schema)}.${sql.identifier(c.target.dbTable)}`;
}

/** `FROM … WHERE` reaching the live records (`t`) linked to the record `outer.id` (`j`). */
function linkedRows(l: LinkRead, outer: SQL): SQL {
  return sql`FROM ${junctionOf(l)} AS j JOIN ${targetOf(l)} AS t ON t.id = j.${sql.identifier(otherSide(l))}
    WHERE j.${sql.identifier(l.self)} = ${outer}.id AND t.deleted_at IS NULL`;
}

/** The primary field's column on the linked record `t`, or `null` when there is none. */
function primaryColumn(l: LinkRead): SQL | null {
  const p = l.primary;
  if (!p) return null;
  const storage = p.def.storage;
  if (storage.kind === 'link') return null;
  const name = storage.kind === 'system' ? storage.column : p.dbColumn;
  if (storage.kind === 'system' ? !SYSTEM_COLUMNS.has(name) : !COLUMN_RE.test(name)) {
    throw new Error(`invalid primary column ${name}`);
  }
  return sql`t.${sql.identifier(name)}`;
}

/** The primary field's raw value on `t`, as its type's `fromStorage` reads it. */
function primaryValue(l: LinkRead): SQL {
  const c = primaryColumn(l);
  if (!c || !l.primary) return sql`NULL`;
  return l.primary.def.storage.sqlType === 'date' ? sql`${c}::text` : c;
}

/**
 * The primary field of `t` as text, for filters, sorts, search and matching names: the column
 * for text types, choice names for single selects, the cast column otherwise.
 */
export function primaryText(l: LinkRead): SQL {
  const c = primaryColumn(l);
  const p = l.primary;
  if (!c || !p) return sql`NULL::text`;
  if (p.def.sort === 'choiceOrder' && p.def.storage.sqlType === 'text') {
    const choices = (p.options as { choices?: Choice[] } | null)?.choices ?? [];
    if (!choices.length) return sql`NULL::text`;
    const arms = choices.map((ch) => sql`WHEN ${ch.id} THEN ${ch.name}`);
    return sql`(CASE ${c} ${sql.join(arms, sql` `)} END)`;
  }
  return p.def.storage.sqlType === 'text' ? c : sql`${c}::text`;
}

/**
 * A link cell: the linked live records in this side's order as `[{ id, v }]` (`v` the primary
 * field's raw value), `NULL` when there are none. records/links.ts turns `v` into the name.
 */
export function linkReadExpr(l: LinkRead, outer: SQL = sql`r`): SQL {
  const order = sql`j.${sql.identifier(selfPosition(l))}, j.${sql.identifier(otherSide(l))}`;
  return sql`(SELECT jsonb_agg(jsonb_build_object('id', t.id, 'v', ${primaryValue(l)}) ORDER BY ${order})
    ${linkedRows(l, outer)})`;
}

/** True when the record `r` links no live record. */
export function linkEmptyExpr(l: LinkRead): SQL {
  return sql`(NOT EXISTS (SELECT 1 ${linkedRows(l, sql`r`)}))`;
}

/** True when a record linked from `r` has a primary value matching the `ILIKE` pattern. */
export function linkMatchExpr(l: LinkRead, pattern: string): SQL {
  return sql`(EXISTS (SELECT 1 ${linkedRows(l, sql`r`)} AND ${primaryText(l)} ILIKE ${pattern}))`;
}

/**
 * True when `r` links one of the live records `ids` (`hasAnyOf`). Only this junction's rows
 * can match, so ids of another table, base or workspace match nothing.
 */
export function linkHasAnyExpr(l: LinkRead, ids: readonly string[]): SQL {
  const list = sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)`;
  return sql`(EXISTS (SELECT 1 ${linkedRows(l, sql`r`)} AND t.id = ANY(${list})))`;
}

/**
 * The linked live records' ids in order, joined (`NULL` when none): ties of equal names in a
 * sort, and what tells two groups of the same names apart.
 */
export function linkIdsExpr(l: LinkRead): SQL {
  const order = sql`j.${sql.identifier(selfPosition(l))}, j.${sql.identifier(otherSide(l))}`;
  return sql`(SELECT string_agg(t.id::text, ',' ORDER BY ${order}) ${linkedRows(l, sql`r`)})`;
}

/** Sort key: the linked records' names in order, joined, lower-cased (`NULL` when none). */
export function linkSortExpr(l: LinkRead): SQL {
  const order = sql`j.${sql.identifier(selfPosition(l))}, j.${sql.identifier(otherSide(l))}`;
  return sql`(SELECT lower(string_agg(coalesce(${primaryText(l)}, ''), ', ' ORDER BY ${order}))
    ${linkedRows(l, sql`r`)})`;
}
