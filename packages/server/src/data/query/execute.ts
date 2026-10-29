import type { Aggregate } from '@openrows/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { Transaction } from '../../db/index.js';
import { decodeLinks } from '../../records/links.js';
import { qualified, readExpression, type TableLocation } from '../columns.js';
import {
  afterCursor,
  type CompiledQuery,
  columnOf,
  computedNumber,
  emptyExpr,
  groupExpr,
  orderBy,
  type QueryField,
} from './compile.js';

/**
 * Runs a compiled ViewQuery on a table's record table (ADR-001). `TableLocation` comes from
 * RLS-protected metadata of the authorized table, so these only ever reach that table.
 */

export interface PageRow extends Record<string, unknown> {
  id: string;
  version: number;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
}

/** Most group rows one query returns (leaf groups). */
export const MAX_GROUPS = 5000;

function selectList(fields: readonly QueryField[], q: CompiledQuery): SQL {
  const system = sql`r.id, r.version, to_json(r.created_at) #>> '{}' AS created_at, r.created_by,
    to_json(r.updated_at) #>> '{}' AS updated_at, r.updated_by`;
  const cells = fields.map((f) => sql`${readExpression(f)} AS ${sql.identifier(f.id)}`);
  // Sort key values as text, for the next keyset cursor (the id is the last key).
  const keys = q.keys.map((k, i) => sql`(${k.expr})::text AS ${sql.identifier(`__k${i}`)}`);
  return sql.join([system, ...cells, ...keys], sql`, `);
}

/** A window (`offset`) or keyset page (`cursor` values) of matching records, in query order. */
export async function selectRecords(
  tx: Transaction,
  table: TableLocation,
  q: CompiledQuery,
  opts: { limit: number; offset?: number; cursor?: (string | null)[] }
): Promise<{ rows: PageRow[]; keyValues: (string | null)[][] }> {
  const after = opts.cursor ? sql` AND ${afterCursor(q.keys, opts.cursor)}` : sql``;
  const offset = opts.offset ? sql` OFFSET ${opts.offset}` : sql``;
  const { rows } = await tx.execute<PageRow>(sql`
    SELECT ${selectList(q.fields, q)} FROM ${qualified(table)} AS r
     WHERE ${q.where}${after}
     ORDER BY ${orderBy(q.keys)}
     LIMIT ${opts.limit}${offset}`);
  const keyValues = rows.map((row) =>
    q.keys.map((_, i) => {
      const v = row[`__k${i}`];
      return typeof v === 'string' ? v : null;
    })
  );
  return { rows, keyValues };
}

export async function countRecords(
  tx: Transaction,
  table: TableLocation,
  q: CompiledQuery
): Promise<number> {
  const { rows } = await tx.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM ${qualified(table)} AS r WHERE ${q.where}`
  );
  return rows[0]?.n ?? 0;
}

/**
 * Leaf groups with their counts, in display order. Keys are the cells' values (a link's
 * `[{ id, name }]`). Group values and sort keys are computed per record first, then grouped:
 * a link's are subqueries over the record, which can't be grouped on directly. Every sort
 * key is a function of its group value, so grouping by both splits nothing.
 */
export async function selectGroups(
  tx: Transaction,
  table: TableLocation,
  q: CompiledQuery
): Promise<{ key: unknown[]; count: number }[]> {
  const rows = await selectGroupValues(tx, table, q);
  return rows.map((r) => ({ key: r.key, count: r.count }));
}

/** What a chart plots per group: the records' count, or a number field's aggregate. */
export type GroupValueFn = 'count' | 'sum' | 'avg' | 'min' | 'max';

/**
 * `selectGroups` with, per leaf group, `value`: the aggregate of a field over the group's
 * records (`null` when it has no value; the count for `count`). Dashboards' charts.
 */
export async function selectGroupValues(
  tx: Transaction,
  table: TableLocation,
  q: CompiledQuery,
  aggregate?: { field: QueryField; fn: GroupValueFn }
): Promise<{ key: unknown[]; count: number; value: number | null }[]> {
  if (q.groups.length === 0) return [];
  // Dates as text: node-postgres would turn a `date` into a local-midnight Date.
  const values = q.groups.map(
    (g, i) =>
      sql`${g.field.def.storage.sqlType === 'date' ? sql`${groupExpr(g.field)}::text` : groupExpr(g.field)} AS ${sql.identifier(`g${i}`)}`
  );
  const keys = q.groups.flatMap((g) => g.keys);
  const keyList = keys.map((k, i) => sql`${k.expr} AS ${sql.identifier(`k${i}`)}`);
  const names = [
    ...q.groups.map((_, i) => sql.identifier(`g${i}`)),
    ...keys.map((_, i) => sql.identifier(`k${i}`)),
  ];
  const fn = aggregate && aggregate.fn !== 'count' ? aggregate.fn : null;
  const measured = aggregate && fn ? aggregate.field : null;
  const inner = measured ? [sql`${numberOf(measured)} AS av`] : [];
  const outer = fn ? sql`, (${GROUP_FNS[fn]})::text AS v` : sql``;
  const order = keys.map((k, i) => ({ ...k, expr: sql`x.${sql.identifier(`k${i}`)}` }));
  const { rows } = await tx.execute<Record<string, unknown>>(sql`
    SELECT ${sql.join(
      q.groups.map((_, i) => sql.identifier(`g${i}`)),
      sql`, `
    )}, count(*)::int AS n${outer}
      FROM (SELECT ${sql.join([...values, ...keyList, ...inner], sql`, `)}
              FROM ${qualified(table)} AS r
             WHERE ${q.where}) AS x
     GROUP BY ${sql.join(names, sql`, `)}
     ORDER BY ${orderBy(order)}
     LIMIT ${MAX_GROUPS}`);
  return rows.map((row) => {
    const count = Number(row['n']);
    const raw = row['v'];
    return {
      key: q.groups.map((g, i) => {
        const cell = row[`g${i}`];
        const { link } = g.field;
        return g.field.def.fromStorage(link ? decodeLinks(link, cell) : cell, g.field.options);
      }),
      count,
      value: measured ? (raw === null || raw === undefined ? null : Number(raw)) : count,
    };
  });
}

const GROUP_FNS: Record<Exclude<GroupValueFn, 'count'>, SQL> = {
  sum: sql`sum(x.av)`,
  avg: sql`avg(x.av)`,
  min: sql`min(x.av)`,
  max: sql`max(x.av)`,
};

/** A field's column as a number to aggregate (a rollup's jsonb value as a number). */
function numberOf(f: QueryField): SQL {
  return f.def.storage.kind === 'computed' && f.def.storage.sqlType === 'jsonb'
    ? computedNumber(f)
    : columnOf(f);
}

function aggregateExpr(f: QueryField, fn: Aggregate): SQL {
  const c = columnOf(f);
  // A rollup's jsonb value sums as a number.
  const n = numberOf(f);
  switch (fn) {
    case 'count':
      return sql`count(*)`;
    case 'empty':
      return sql`count(*) FILTER (WHERE ${emptyExpr(f)})`;
    case 'filled':
      return sql`count(*) FILTER (WHERE NOT ${emptyExpr(f)})`;
    case 'unique':
      return sql`count(DISTINCT ${c})`;
    case 'sum':
      return sql`sum(${n})::text`;
    case 'avg':
      return sql`avg(${n})::text`;
    case 'min':
      return sql`to_json(min(${n})) #>> '{}'`;
    case 'max':
      return sql`to_json(max(${n})) #>> '{}'`;
  }
}

/** Summary aggregates over every matching record, `{ [fieldId]: { [fn]: value } }`. */
export async function selectAggregates(
  tx: Transaction,
  table: TableLocation,
  q: CompiledQuery,
  wanted: readonly { field: QueryField; fn: Aggregate }[]
): Promise<Record<string, Record<string, unknown>>> {
  const out: Record<string, Record<string, unknown>> = {};
  if (wanted.length === 0) return out;
  const list = wanted.map(
    (w, i) => sql`${aggregateExpr(w.field, w.fn)} AS ${sql.identifier(`a${i}`)}`
  );
  const { rows } = await tx.execute<Record<string, unknown>>(sql`
    SELECT ${sql.join(list, sql`, `)} FROM ${qualified(table)} AS r WHERE ${q.where}`);
  const row = rows[0] ?? {};
  wanted.forEach((w, i) => {
    const raw = row[`a${i}`];
    let value: unknown;
    if ((w.fn === 'min' || w.fn === 'max') && w.field.def.sort === 'chronological') {
      value = raw === null ? null : w.field.def.fromStorage(raw, w.field.options);
    } else if (w.fn === 'sum' || w.fn === 'avg' || w.fn === 'min' || w.fn === 'max') {
      value = raw === null ? null : Number(raw);
    } else {
      value = Number(raw);
    }
    out[w.field.id] = { ...out[w.field.id], [w.fn]: value };
  });
  return out;
}

/** Whether record `id` meets the compiled query's conditions (an interface page's). */
export async function recordMatches(
  tx: Transaction,
  table: TableLocation,
  q: CompiledQuery,
  id: string
): Promise<boolean> {
  const { rows } = await tx.execute(
    sql`SELECT 1 FROM ${qualified(table)} AS r WHERE ${q.where} AND r.id = ${id} LIMIT 1`
  );
  return rows.length > 0;
}
