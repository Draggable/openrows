import { sql } from 'drizzle-orm';
import { qualified, type TableLocation } from '../data/columns.js';
import type { Database, Transaction } from '../db/index.js';
import { withTenant } from '../jobs/tenant.js';
import type { Logger } from '../lib/logger.js';

/**
 * The record counters: live records (not in the trash) per user table, in
 * `table_record_counts`, what a base's plan limit counts.
 *
 * - The RecordService adds each write's change in the write's own transaction (`addRecords`):
 *   an insert counts its rows, a trash or restore the rows it actually changed (the rows are
 *   locked first, so two concurrent deletes of a record count it once). The counter row's lock
 *   serializes the increments, and a rollback takes its increment with it.
 * - The writes that bypass the RecordService (duplicating a table, restoring a snapshot) recount
 *   the tables they filled (`recountTable`).
 * - The worker's daily `usage.reconcile` recounts every live table (`reconcileRecordCounts`).
 */

export interface CountedTable extends TableLocation {
  workspaceId: string;
  baseId: string;
}

/** Adds `delta` live records to the table's counter (creating it), in the caller's transaction. */
export async function addRecords(
  tx: Transaction,
  table: CountedTable,
  delta: number
): Promise<void> {
  if (delta === 0) return;
  await tx.execute(sql`
    INSERT INTO table_record_counts AS c (workspace_id, base_id, table_id, records)
    VALUES (${table.workspaceId}::uuid, ${table.baseId}::uuid, ${table.id}::uuid,
            greatest(${delta}::bigint, 0))
    ON CONFLICT (table_id) DO UPDATE SET records = greatest(c.records + ${delta}::bigint, 0)`);
}

/**
 * Sets the table's counter to its live records, and returns how far off it was. The counter row
 * is locked FIRST and the rows counted in a later statement: under READ COMMITTED that count's
 * snapshot is taken after every write that had already incremented the counter committed, and a
 * write that hasn't incremented yet adds its rows after this transaction (it waits for the lock).
 */
export async function recountTable(tx: Transaction, table: CountedTable): Promise<number> {
  await tx.execute(sql`
    INSERT INTO table_record_counts (workspace_id, base_id, table_id, records)
    VALUES (${table.workspaceId}::uuid, ${table.baseId}::uuid, ${table.id}::uuid, 0)
    ON CONFLICT (table_id) DO NOTHING`);
  const { rows: locked } = await tx.execute<{ records: string }>(sql`
    SELECT records FROM table_record_counts WHERE table_id = ${table.id}::uuid FOR UPDATE`);
  const { rows: counted } = await tx.execute<{ n: string }>(
    sql`SELECT count(*) AS n FROM ${qualified(table)} WHERE deleted_at IS NULL`
  );
  const before = Number(locked[0]?.records ?? 0);
  const actual = Number(counted[0]?.n ?? 0);
  await tx.execute(sql`
    UPDATE table_record_counts SET records = ${actual}::bigint, reconciled_at = now()
     WHERE table_id = ${table.id}::uuid`);
  return actual - before;
}

/** Tables per page of the reconcile. */
const RECONCILE_PAGE = 200;

export interface ReconcileResult {
  tables: number;
  /** Tables whose counter was off. */
  drifted: number;
}

/**
 * The worker's `usage.reconcile`: recounts every live table, each in its own tenant-scoped
 * transaction (a failing table is logged and skipped). Drift means a write path missed the
 * counter: it is logged as a warning.
 */
export async function reconcileRecordCounts(
  db: Database,
  logger: Pick<Logger, 'info' | 'warn'>,
  page = RECONCILE_PAGE
): Promise<ReconcileResult> {
  const result: ReconcileResult = { tables: 0, drifted: 0 };
  let after: string | null = null;
  for (;;) {
    const { rows }: { rows: { workspace_id: string; base_id: string; table_id: string }[] } =
      await db.execute(sql`SELECT * FROM record_count_tables(${after}::uuid, ${page})`);
    for (const row of rows) {
      try {
        const drift = await withTenant(db, row.workspace_id, async (tx) => {
          const { rows: found } = await tx.execute<{ db_schema: string; db_table: string }>(sql`
            SELECT db_schema, db_table FROM tables
             WHERE id = ${row.table_id}::uuid AND deleted_at IS NULL`);
          const location = found[0];
          if (!location) return 0;
          return recountTable(tx, {
            id: row.table_id,
            workspaceId: row.workspace_id,
            baseId: row.base_id,
            dbSchema: location.db_schema,
            dbTable: location.db_table,
          });
        });
        result.tables++;
        if (drift !== 0) {
          result.drifted++;
          logger.warn({ tableId: row.table_id, drift }, 'record counter drifted; recounted');
        }
      } catch (err) {
        logger.warn({ err, tableId: row.table_id }, 'record counter not reconciled');
      }
    }
    const last = rows.at(-1);
    if (!last || rows.length < page) break;
    after = last.table_id;
  }
  logger.info({ ...result }, 'record counters reconciled');
  return result;
}
