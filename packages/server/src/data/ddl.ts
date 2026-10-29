import type { FieldStorage } from '@openrows/shared';
import { sql } from 'drizzle-orm';
import type { Transaction } from '../db/index.js';
import { AppError } from '../lib/errors.js';

/**
 * The DDL manager (ADR-001). The server connects as openrows_app, which can't run DDL; these
 * wrappers call the SECURITY DEFINER functions of drizzle/0005_ddl_manager.sql, which run as the
 * schema owner, so metadata writes (under RLS) and DDL share the request's transaction and roll
 * back together. The functions only touch bases and tables of the transaction's workspace and
 * take every physical name from metadata or check it against `f_<32 hex>`.
 */

/** How long DDL may wait for a lock before giving up with 503 (ADR-001: 2 s). */
export const DDL_LOCK_TIMEOUT = '2s';

const hex = (id: string) => id.replaceAll('-', '');

/** Physical names derive from ids, never from user-visible names (ADR-001). */
export const physicalName = {
  schema: (baseId: string) => `b_${hex(baseId)}`,
  table: (tableId: string) => `t_${hex(tableId)}`,
  column: (id: string) => `f_${hex(id)}`,
  /** A link field's junction (its inverse field shares it). */
  junction: (fieldId: string) => `l_${hex(fieldId)}`,
};

/** Postgres "lock_not_available": lock_timeout expired. */
const LOCK_NOT_AVAILABLE = '55P03';

function pgCode(err: unknown): string | undefined {
  for (let e = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

async function ddl(tx: Transaction, statement: ReturnType<typeof sql>): Promise<void> {
  try {
    await tx.execute(statement);
  } catch (err) {
    if (pgCode(err) === LOCK_NOT_AVAILABLE) {
      throw new AppError('SERVICE_UNAVAILABLE', {
        detail: 'The table is busy. Try again in a moment.',
        cause: err,
      });
    }
    throw err;
  }
}

/** Bounds how long the rest of the transaction's DDL waits for locks. */
export async function setLockTimeout(tx: Transaction): Promise<void> {
  await tx.execute(sql`SELECT set_config('lock_timeout', ${DDL_LOCK_TIMEOUT}, true)`);
}

/** Creates the base's `b_<hex>` schema (idempotent). */
export function createBaseSchema(tx: Transaction, baseId: string) {
  return ddl(tx, sql`SELECT ddl_create_base_schema(${baseId}::uuid)`);
}

/** Creates the table's record table with the system columns, no field columns. */
export function createRecordTable(tx: Transaction, tableId: string) {
  return ddl(tx, sql`SELECT ddl_create_table(${tableId}::uuid)`);
}

/**
 * Adds the column a field of `storage` needs: nullable without default (instant), or an
 * identity column for autonumbers. System-column fields (created time…) and links need none.
 */
export async function addFieldColumn(
  tx: Transaction,
  tableId: string,
  column: string,
  storage: FieldStorage
): Promise<void> {
  if (storage.kind === 'system' || storage.kind === 'link') return;
  await ddl(
    tx,
    sql`SELECT ddl_add_column(${tableId}::uuid, ${column}, ${storage.sqlType}, ${storage.kind === 'identity'})`
  );
}

/** Drops a column no field points at any more (a no-op when it doesn't exist). */
export function dropColumn(tx: Transaction, tableId: string, column: string) {
  return ddl(tx, sql`SELECT ddl_drop_column(${tableId}::uuid, ${column})`);
}

/**
 * Creates the junction of a link field (its `db_column`, `l_<field hex>`) between its table and
 * the linked table of the same base (`options.linkedTableId`), from the field's metadata row.
 */
export function createJunction(tx: Transaction, fieldId: string) {
  return ddl(tx, sql`SELECT ddl_create_junction(${fieldId}::uuid)`);
}

/** Drops a junction, with its links, once no live field uses it. */
export function dropJunction(tx: Transaction, tableId: string, junction: string) {
  return ddl(tx, sql`SELECT ddl_drop_junction(${tableId}::uuid, ${junction})`);
}

/** Drops a trashed table's record table; its junctions must be gone already. */
export function dropRecordTable(tx: Transaction, tableId: string) {
  return ddl(tx, sql`SELECT ddl_drop_table(${tableId}::uuid)`);
}

/** Drops a trashed base's record schema with everything in it. */
export function dropBaseSchema(tx: Transaction, baseId: string) {
  return ddl(tx, sql`SELECT ddl_drop_base_schema(${baseId}::uuid)`);
}
