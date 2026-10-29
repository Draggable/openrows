import { pruneViewQuery, type SavedViewQuery, savedQueryOf } from '@openrows/shared';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import pg from 'pg';
import { qualified } from '../data/columns.js';
import type { Database } from '../db/index.js';
import { tables, views } from '../db/schema.js';
import { withTenant } from '../jobs/tenant.js';
import type { Logger } from '../lib/logger.js';
import { tableFields, toQueryFields } from '../records/service.js';
import {
  INDEX_LIMITS,
  INDEX_MIN_ROWS,
  type IndexLimits,
  type IndexSpec,
  planIndexes,
} from './plan.js';

/**
 * The field index job (ADR-001): builds the indexes saved views want (plan.ts) on tables
 * past INDEX_MIN_ROWS rows, and drops managed indexes no view wants any more (a view deleted or
 * changed, a field trashed or converted) or that a failed build left invalid.
 *
 * `CREATE INDEX CONCURRENTLY` never blocks writes, but it can't run in a transaction or a
 * function, and only the table's owner may run it. So the plan is made under the tenant's scope
 * as openrows_app, the SECURITY DEFINER functions of drizzle/0049_field_indexes.sql check it and
 * answer each statement, and only those statements run on the owner connection (`IndexDdl`).
 */

/** Runs the statements the DDL functions answered, as the record tables' owner. */
export interface IndexDdl {
  run(statement: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * One connection as the schema owner (INDEX_DATABASE_URL), used for nothing but the statements
 * of `ddl_index_statement` and `ddl_index_drop_statement`. A build waits at most 10 s for its
 * lock (a schema change holding the table) and runs at most 2 hours.
 */
export function ownerIndexDdl(connectionString: string): IndexDdl {
  const pool = new pg.Pool({
    connectionString,
    max: 1,
    application_name: 'openrows-indexer',
    lock_timeout: 10_000,
    statement_timeout: 2 * 3600_000,
    idleTimeoutMillis: 60_000,
  });
  pool.on('error', () => {});
  return {
    async run(statement) {
      if (!/^(CREATE INDEX CONCURRENTLY|DROP INDEX CONCURRENTLY) /.test(statement)) {
        throw new Error('index ddl: unexpected statement');
      }
      await pool.query(statement);
    },
    close: () => pool.end(),
  };
}

export interface IndexSyncDeps {
  /** openrows_app: plans are made in each tenant's scope. */
  db: Database;
  ddl: IndexDdl;
  logger: Pick<Logger, 'info' | 'warn'>;
}

export interface IndexSyncOptions {
  /** Tables smaller than this get no new indexes (ADR-001: 10,000 rows). */
  minRows?: number;
  limits?: IndexLimits;
}

export interface IndexSyncResult {
  created: number;
  dropped: number;
  errors: number;
}

interface TablePlan {
  create: { spec: IndexSpec; statement: string }[];
  drop: { name: string; statement: string }[];
}

/** What to build and drop on one table, from its live fields and saved views. */
async function planTable(
  db: Database,
  workspaceId: string,
  tableId: string,
  opts: Required<IndexSyncOptions>
): Promise<TablePlan | null> {
  return withTenant(db, workspaceId, async (tx) => {
    const [table] = await tx
      .select()
      .from(tables)
      .where(and(eq(tables.id, tableId), isNull(tables.deletedAt)));
    if (!table) return null;
    const fields = toQueryFields(await tableFields(tx, table));
    const rows = await tx
      .select({ config: views.config })
      .from(views)
      .where(and(eq(views.tableId, tableId), isNull(views.deletedAt)))
      .orderBy(asc(views.position), asc(views.createdAt));
    const queries: SavedViewQuery[] = rows.map((v) =>
      pruneViewQuery(savedQueryOf((v.config ?? {}) as Record<string, unknown>), fields)
    );
    const wanted = planIndexes(fields, queries, opts.limits);

    const { rows: existing } = await tx.execute<{ name: string; valid: boolean }>(
      sql`SELECT name, valid FROM ddl_index_list(${tableId}::uuid)`
    );
    // Only the first `minRows` rows are counted: the question is "past the threshold?".
    const { rows: counted } = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM (SELECT 1 FROM ${qualified(table)} LIMIT ${opts.minRows}) x`);
    const large = (counted[0]?.n ?? 0) >= opts.minRows;

    const valid = new Set(existing.filter((e) => e.valid).map((e) => e.name));
    const keep = new Set(wanted.map((w) => w.name));
    const plan: TablePlan = { create: [], drop: [] };
    for (const e of existing) {
      if (e.valid && keep.has(e.name)) continue;
      const { rows: s } = await tx.execute<{ statement: string }>(
        sql`SELECT ddl_index_drop_statement(${tableId}::uuid, ${e.name}) AS statement`
      );
      if (s[0]) plan.drop.push({ name: e.name, statement: s[0].statement });
    }
    // A small table keeps the indexes it has (no flapping around the threshold) but gets no new.
    if (!large) return plan;
    for (const spec of wanted) {
      if (valid.has(spec.name)) continue;
      const { rows: s } = await tx.execute<{ statement: string }>(
        sql`SELECT ddl_index_statement(${tableId}::uuid, ${spec.name}, ${spec.method}, ${JSON.stringify(spec.keys)}::jsonb) AS statement`
      );
      if (s[0]) plan.create.push({ spec, statement: s[0].statement });
    }
    return plan;
  });
}

/**
 * Brings one table's managed indexes in line with its saved views: drops first (invalid
 * leftovers and unwanted indexes), then builds the missing ones one at a time. A failed
 * statement is logged and counted; an invalid index it leaves is dropped on the next run.
 */
export async function syncTableIndexes(
  deps: IndexSyncDeps,
  workspaceId: string,
  tableId: string,
  options: IndexSyncOptions = {}
): Promise<IndexSyncResult> {
  const opts = {
    minRows: options.minRows ?? INDEX_MIN_ROWS,
    limits: options.limits ?? INDEX_LIMITS,
  };
  const result: IndexSyncResult = { created: 0, dropped: 0, errors: 0 };
  const plan = await planTable(deps.db, workspaceId, tableId, opts);
  if (!plan) return result;
  for (const d of plan.drop) {
    try {
      await deps.ddl.run(d.statement);
      result.dropped++;
    } catch (err) {
      result.errors++;
      deps.logger.warn({ err, tableId, index: d.name }, 'field index drop failed');
    }
  }
  for (const c of plan.create) {
    const started = Date.now();
    try {
      await deps.ddl.run(c.statement);
      result.created++;
      deps.logger.info(
        { tableId, index: c.spec.name, kind: c.spec.kind, ms: Date.now() - started },
        'field index built'
      );
    } catch (err) {
      result.errors++;
      deps.logger.warn({ err, tableId, index: c.spec.name }, 'field index build failed');
    }
  }
  return result;
}

/** Tables per page of `field_index_tables`. */
const TABLE_PAGE = 100;

/**
 * The `indexes.sync` job: every table with a view that filters, sorts or groups, or with managed
 * indexes, in each one's tenant scope.
 */
export async function syncFieldIndexes(
  deps: IndexSyncDeps,
  options: IndexSyncOptions = {}
): Promise<IndexSyncResult & { tables: number }> {
  const total = { tables: 0, created: 0, dropped: 0, errors: 0 };
  let after: string | null = null;
  for (;;) {
    const page: { rows: { workspace_id: string; table_id: string }[] } = await deps.db.execute(
      sql`SELECT workspace_id, table_id FROM field_index_tables(${after}::uuid, ${TABLE_PAGE})`
    );
    const { rows } = page;
    for (const row of rows) {
      total.tables++;
      try {
        const r = await syncTableIndexes(deps, row.workspace_id, row.table_id, options);
        total.created += r.created;
        total.dropped += r.dropped;
        total.errors += r.errors;
      } catch (err) {
        total.errors++;
        deps.logger.warn({ err, tableId: row.table_id }, 'field index plan failed');
      }
    }
    const last: { table_id: string } | undefined = rows.at(-1);
    if (!last || rows.length < TABLE_PAGE) break;
    after = last.table_id;
  }
  return total;
}
