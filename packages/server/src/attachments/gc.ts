import { sql } from 'drizzle-orm';
import type { Database, Transaction } from '../db/index.js';
import { withTenant } from '../jobs/tenant.js';
import type { Logger } from '../lib/logger.js';
import type { ObjectStore } from './storage.js';

/**
 * Attachment garbage collection, the worker's `attachments.gc` job. Two steps per
 * workspace, in its tenant scope:
 *
 * 1. **Orphaned rows.** An attachment row of a field is orphaned once no record of its base names
 *    it, live or in the trash (in any column of any table of the base, trashed tables and fields
 *    included, since restoring them brings the cells back) and no record revision does (restoring
 *    one would bring the file back), past a grace period: pending uploads never confirmed, files
 *    taken out of every cell, cells of purged records. Rows of views (a form's cover or logo)
 *    are left alone. Deleting the row puts its keys in `storage_garbage` (a trigger, which also
 *    catches the rows a purged field, table or base takes with it, and deleted snapshots).
 * 2. **Garbage keys.** A key in `storage_garbage` is deleted from the object store once no
 *    attachment row names it (a restored base shares the original's files) and, for files that
 *    were ready, no snapshot of the workspace that may hold it is left (a snapshot taken before
 *    the key became garbage, with a margin for snapshots still being written: restoring it would
 *    bring the file back). Then its garbage row goes.
 *
 * With `dryRun` (ATTACHMENT_GC=dry-run, the default) nothing is deleted: the job only counts
 * what it would delete, for the worker's metrics and logs.
 */

/** Uploads and unused files younger than this are left alone (an upload in progress). */
export const GC_GRACE_HOURS = 24;
/** How long after a key became garbage a snapshot that may hold it can still appear. */
const SNAPSHOT_MARGIN = sql`interval '6 hours'`;
/** Workspaces per page, rows and keys per statement. */
const WORKSPACE_PAGE = 100;
const BATCH = 500;
/** A row id or key is only ever a UUID inside these texts. */
const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export type GcMode = 'off' | 'dry-run' | 'on';

export interface GcResult {
  dryRun: boolean;
  workspaces: number;
  /** Orphaned attachment rows deleted (or, in a dry run, found). */
  orphanedRows: number;
  /** Stored objects deleted (or, in a dry run, that are deletable now). */
  objects: number;
  /** Object deletions that failed (left for the next run). */
  errors: number;
}

export interface GcDeps {
  db: Database;
  store: ObjectStore;
  logger: Pick<Logger, 'info' | 'warn'>;
}

/** The orphaned attachment rows of a workspace (the transaction's tenant scope). */
async function orphanedRows(tx: Transaction): Promise<string[]> {
  const grace = sql`now() - make_interval(hours => ${GC_GRACE_HOURS})`;
  const { rows: bases } = await tx.execute<{ base_id: string }>(sql`
    SELECT DISTINCT base_id FROM attachments
     WHERE view_id IS NULL AND coalesce(confirmed_at, created_at) < ${grace}`);
  const out: string[] = [];
  for (const { base_id: baseId } of bases) {
    const { rows: tables } = await tx.execute<{ db_schema: string; db_table: string }>(sql`
      SELECT t.db_schema, t.db_table FROM tables t
       WHERE t.base_id = ${baseId}
         AND EXISTS (SELECT 1 FROM pg_catalog.pg_tables p
                      WHERE p.schemaname = t.db_schema AND p.tablename = t.db_table)`);
    // Every UUID in any record of the base (cells of every column, trashed records included)
    // and in its revisions: over-inclusive, so a file is only ever kept by mistake.
    await tx.execute(sql`
      CREATE TEMP TABLE IF NOT EXISTS gc_refs (id uuid PRIMARY KEY) ON COMMIT DROP`);
    await tx.execute(sql`TRUNCATE pg_temp.gc_refs`);
    const sources = [
      ...tables.map(
        (
          t
        ) => sql`SELECT m[1]::uuid FROM ${sql.identifier(t.db_schema)}.${sql.identifier(t.db_table)} r,
                          regexp_matches(to_jsonb(r)::text, ${UUID_RE}, 'g') m`
      ),
      sql`SELECT m[1]::uuid FROM record_revisions v,
                 regexp_matches(v.changes::text, ${UUID_RE}, 'g') m
           WHERE v.base_id = ${baseId}`,
    ];
    for (const source of sources) {
      await tx.execute(sql`INSERT INTO pg_temp.gc_refs ${source} ON CONFLICT DO NOTHING`);
    }
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT a.id::text AS id FROM attachments a
       WHERE a.base_id = ${baseId} AND a.view_id IS NULL
         AND coalesce(a.confirmed_at, a.created_at) < ${grace}
         AND NOT EXISTS (SELECT 1 FROM pg_temp.gc_refs r WHERE r.id = a.id)`);
    out.push(...rows.map((r) => r.id));
  }
  return out;
}

/** Garbage keys that may be deleted from the store now; drops those a row names again. */
async function deletableKeys(
  tx: Transaction,
  after: number,
  dryRun: boolean
): Promise<{ keys: { id: number; key: string }[]; last: number | null }> {
  const { rows } = await tx.execute<{
    id: string;
    storage_key: string;
    named: boolean;
    held: boolean;
  }>(sql`
    SELECT g.id::text AS id, g.storage_key,
           EXISTS (SELECT 1 FROM attachments a
                    WHERE a.storage_key = g.storage_key OR a.thumbnail_key = g.storage_key)
             OR EXISTS (SELECT 1 FROM base_snapshots s WHERE s.storage_key = g.storage_key)
             AS named,
           g.kind = 'file' AND (
             g.created_at > now() - ${SNAPSHOT_MARGIN}
             OR EXISTS (SELECT 1 FROM base_snapshots s
                         WHERE s.created_at <= g.created_at + ${SNAPSHOT_MARGIN})) AS held
      FROM storage_garbage g
     WHERE g.id > ${after}
     ORDER BY g.id
     LIMIT ${BATCH}`);
  const named = rows.filter((r) => r.named).map((r) => r.id);
  // Still in use (a restored base's row): the key comes back here when that row goes.
  if (named.length && !dryRun) {
    await tx.execute(
      sql`DELETE FROM storage_garbage WHERE id = ANY(${`{${named.join(',')}}`}::bigint[])`
    );
  }
  const last = rows.length === BATCH ? Number(rows[rows.length - 1]?.id) : null;
  return {
    keys: rows
      .filter((r) => !r.named && !r.held)
      .map((r) => ({ id: Number(r.id), key: r.storage_key })),
    last,
  };
}

async function collectWorkspace(
  deps: GcDeps,
  workspaceId: string,
  dryRun: boolean,
  result: GcResult
) {
  const { db, store, logger } = deps;
  // Step 1: orphaned rows (their keys land in storage_garbage through the trigger).
  await withTenant(db, workspaceId, async (tx) => {
    const ids = await orphanedRows(tx);
    result.orphanedRows += ids.length;
    if (dryRun || !ids.length) return;
    for (let i = 0; i < ids.length; i += BATCH) {
      const list = `{${ids.slice(i, i + BATCH).join(',')}}`;
      await tx.execute(sql`DELETE FROM attachments WHERE id = ANY(${list}::uuid[])`);
    }
  });
  // Step 2: the objects, a page of garbage keys at a time.
  let after = 0;
  for (;;) {
    const { keys, last } = await withTenant(db, workspaceId, (tx) =>
      deletableKeys(tx, after, dryRun)
    );
    if (dryRun) {
      result.objects += keys.length;
    } else {
      const done: number[] = [];
      for (const { id, key } of keys) {
        try {
          await store.delete(key);
          done.push(id);
        } catch (err) {
          result.errors++;
          logger.warn({ err, key }, 'stored object not deleted');
        }
      }
      result.objects += done.length;
      if (done.length) {
        await withTenant(db, workspaceId, (tx) =>
          tx.execute(
            sql`DELETE FROM storage_garbage WHERE id = ANY(${`{${done.join(',')}}`}::bigint[])`
          )
        );
      }
    }
    if (last === null) return;
    after = last;
  }
}

/** One GC run over every workspace that has something to look at. */
export async function collectAttachmentGarbage(
  deps: GcDeps,
  opts: { dryRun: boolean }
): Promise<GcResult> {
  const result: GcResult = {
    dryRun: opts.dryRun,
    workspaces: 0,
    orphanedRows: 0,
    objects: 0,
    errors: 0,
  };
  let after: string | null = null;
  for (;;) {
    const { rows }: { rows: { workspace_id: string }[] } = await deps.db.execute<{
      workspace_id: string;
    }>(sql`
      SELECT workspace_id FROM storage_gc_workspaces(
        make_interval(hours => ${GC_GRACE_HOURS}), ${after}::uuid, ${WORKSPACE_PAGE})`);
    for (const { workspace_id: workspaceId } of rows) {
      result.workspaces++;
      try {
        await collectWorkspace(deps, workspaceId, opts.dryRun, result);
      } catch (err) {
        result.errors++;
        deps.logger.warn({ err, workspaceId }, 'attachment gc failed for a workspace');
      }
    }
    if (rows.length < WORKSPACE_PAGE) break;
    after = rows[rows.length - 1]?.workspace_id ?? null;
  }
  return result;
}
