import type { SqlColumnType } from '@openrows/shared';
import { type SQL, sql } from 'drizzle-orm';
import { castFromJson, qualified, readExpression, type TableLocation } from '../data/columns.js';
import type { LinkRead } from '../data/links.js';
import type { Transaction } from '../db/index.js';

/**
 * Queries on a table's physical record table (ADR-001). `TableLocation` always comes from
 * RLS-protected metadata of the authorized table, so these only ever reach that table; record
 * ids are bound parameters, never part of a name.
 */

/** A field as the repo reads it: its id (the result alias), type and physical column. */
export interface ReadColumn {
  id: string;
  type: string;
  dbColumn: string;
  link?: LinkRead;
}

/** A column to write and its SQL type. */
export interface WriteColumn {
  column: string;
  sqlType: SqlColumnType;
}

export interface RawRecord extends Record<string, unknown> {
  id: string;
  version: number;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
}

/** A Postgres array literal of uuids (Drizzle would expand a JS array into a row). */
const uuidArray = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

function selectList(fields: readonly ReadColumn[]): SQL {
  // Times as ISO text: the driver's timestamp parsing is Drizzle's, not ours.
  const system = sql`r.id, r.version, to_json(r.created_at) #>> '{}' AS created_at, r.created_by,
    to_json(r.updated_at) #>> '{}' AS updated_at, r.updated_by`;
  if (fields.length === 0) return system;
  const cells = fields.map((f) => sql`${readExpression(f)} AS ${sql.identifier(f.id)}`);
  return sql`${system}, ${sql.join(cells, sql`, `)}`;
}

/** Live records by id, in id order (missing and deleted ones are left out). */
export async function selectByIds(
  tx: Transaction,
  table: TableLocation,
  fields: readonly ReadColumn[],
  ids: readonly string[]
): Promise<RawRecord[]> {
  const { rows } = await tx.execute<RawRecord>(sql`
    SELECT ${selectList(fields)} FROM ${qualified(table)} AS r
     WHERE r.id = ANY(${uuidArray(ids)}) AND r.deleted_at IS NULL
     ORDER BY r.id`);
  return rows;
}

/** A page of live records, oldest first (ids are UUIDv7), after `cursor`. */
export async function selectPage(
  tx: Transaction,
  table: TableLocation,
  fields: readonly ReadColumn[],
  opts: { limit: number; cursor?: string }
): Promise<RawRecord[]> {
  const after = opts.cursor ? sql`AND r.id > ${opts.cursor}::uuid` : sql``;
  const { rows } = await tx.execute<RawRecord>(sql`
    SELECT ${selectList(fields)} FROM ${qualified(table)} AS r
     WHERE r.deleted_at IS NULL ${after}
     ORDER BY r.id
     LIMIT ${opts.limit}`);
  return rows;
}

export interface LockedRecord extends Record<string, unknown> {
  id: string;
  version: number;
  deleted: boolean;
}

/**
 * Locks the records with these ids (`FOR UPDATE`, in id order so concurrent bulk writes can't
 * deadlock each other) and returns their versions. Ids not in this table are left out.
 */
export async function lockByIds(
  tx: Transaction,
  table: TableLocation,
  ids: readonly string[]
): Promise<LockedRecord[]> {
  const { rows } = await tx.execute<LockedRecord>(sql`
    SELECT id, version, deleted_at IS NOT NULL AS deleted FROM ${qualified(table)}
     WHERE id = ANY(${uuidArray(ids)})
     ORDER BY id
       FOR UPDATE`);
  return rows;
}

export interface RowValues {
  id: string;
  /** Storage values by column name. */
  values: Record<string, unknown>;
}

/** `[{ id, c: { <column>: value } }]` and the select list reading it back as typed columns. */
function jsonSource(columns: readonly WriteColumn[], rows: readonly RowValues[]) {
  const json = JSON.stringify(rows.map((r) => ({ id: r.id, c: r.values })));
  const cells = columns.map(
    (c) =>
      sql`${castFromJson(sql`e->'c'->${c.column}::text`, c.sqlType)} AS ${sql.identifier(c.column)}`
  );
  const list = cells.length ? sql`, ${sql.join(cells, sql`, `)}` : sql``;
  return sql`(SELECT (e->>'id')::uuid AS id${list} FROM jsonb_array_elements(${json}::jsonb) AS e)`;
}

/**
 * Inserts records in one statement. Columns a row doesn't set stay NULL (no field column has a
 * default); autonumbers come from their identity column, times from the column defaults.
 */
export async function insertRows(
  tx: Transaction,
  table: TableLocation,
  columns: readonly WriteColumn[],
  rows: readonly RowValues[],
  userId: string | null
): Promise<void> {
  const names = columns.map((c) => sql`, ${sql.identifier(c.column)}`);
  const values = columns.map((c) => sql`, s.${sql.identifier(c.column)}`);
  await tx.execute(sql`
    INSERT INTO ${qualified(table)} (id, created_by, updated_by${sql.join(names, sql``)})
    SELECT s.id, ${userId}::uuid, ${userId}::uuid${sql.join(values, sql``)}
      FROM ${jsonSource(columns, rows)} AS s
     ORDER BY s.id`);
}

/**
 * Per-cell patch of rows that all set the same `columns`: only those columns change, plus
 * `version = version + 1` and the modified time and user (ADR-003). No read-merge-write: the
 * values never depend on what the row held, so concurrent patches of other cells survive.
 */
export async function updateRows(
  tx: Transaction,
  table: TableLocation,
  columns: readonly WriteColumn[],
  rows: readonly RowValues[],
  userId: string | null
): Promise<void> {
  const set = columns.map((c) => sql`${sql.identifier(c.column)} = s.${sql.identifier(c.column)}`);
  const cells = set.length ? sql`${sql.join(set, sql`, `)}, ` : sql``;
  await tx.execute(sql`
    UPDATE ${qualified(table)} AS r
       SET ${cells}version = r.version + 1, updated_at = now(), updated_by = ${userId}::uuid
      FROM ${jsonSource(columns, rows)} AS s
     WHERE r.id = s.id AND r.deleted_at IS NULL`);
}

/** Soft-deletes (or restores) records; each one's version goes up. Returns the new versions. */
export async function setDeleted(
  tx: Transaction,
  table: TableLocation,
  ids: readonly string[],
  deleted: boolean
): Promise<{ id: string; version: number }[]> {
  const { rows } = await tx.execute<{ id: string; version: number }>(sql`
    UPDATE ${qualified(table)}
       SET deleted_at = ${deleted ? sql`now()` : sql`NULL`}, version = version + 1
     WHERE id = ANY(${uuidArray(ids)}) AND (deleted_at IS NULL) = ${deleted}
     RETURNING id, version`);
  return rows;
}
