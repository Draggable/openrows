import { TRASH_RETENTION_DAYS } from '@openrows/shared';
import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { ObjectStore } from '../attachments/storage.js';
import { purgeBase } from '../bases/service.js';
import { qualified } from '../data/columns.js';
import { dropBaseSchema, setLockTimeout } from '../data/ddl.js';
import { bases, type Database, fields, type Transaction, tables, views } from '../db/index.js';
import { purgeField, type SchemaContext } from '../fields/service.js';
import { withTenant } from '../jobs/tenant.js';
import type { Logger } from '../lib/logger.js';
import { purgeTable } from '../tables/service.js';
import type { IdentityAdmin } from './identity.js';

/**
 * Hard deletion, the commitments of the Privacy Policy: "When you delete your account
 * [...] we delete your personal information and workspace content within 30 days", and items in
 * the trash "are then permanently removed".
 *
 * - **Accounts** marked deleted ("Delete account", `account_request_deletion`) go at the next
 *   `purge.deleted` run (sent by the request itself, and hourly): the user at the identity
 *   provider first (a retry finds them gone), then `account_purge` (the row and everything it
 *   cascades to; workspaces they solely owned get a new owner or are marked deleted).
 * - **Workspaces** marked deleted (the owner deleted one, or with an account) go at the same run:
 *   their stored files (`ws/<id>/`) and snapshots (`snapshots/ws/<id>/`), every base's record
 *   schema, then `workspace_purge` (the row, which every tenant table cascades from). Files go
 *   first, so a failure leaves the workspace marked and the next run lists the prefix again.
 * - **Trash** past TRASH_RETENTION_DAYS (`purge.trash`, daily): bases, tables, fields, views and
 *   records, through the same functions as "Delete permanently". Their stored files go through
 *   the attachment GC (`storage_garbage`, ATTACHMENT_GC must be `on`).
 */

export interface PurgeDeps {
  db: Database;
  logger: Pick<Logger, 'info' | 'warn'>;
  /** The object store; without it workspaces aren't purged (their files would be left). */
  store?: ObjectStore | undefined;
  /** Deletes users at the identity provider; without it only OpenRows' copy goes. */
  identity?: IdentityAdmin | undefined;
}

export interface PurgeResult {
  users: number;
  workspaces: number;
  objects: number;
  /** Users and workspaces left for the next run (a failure, or no object store). */
  skipped: number;
}

/** Users and workspaces per run (each run sends the next one when it hit the limit). */
const PAGE = 100;
/** Records purged per statement. */
const RECORD_BATCH = 1000;

/** Deletes every stored object under the workspace's prefixes; returns how many. */
async function purgeObjects(store: ObjectStore, workspaceId: string): Promise<number> {
  let n = 0;
  for (const prefix of [`ws/${workspaceId}/`, `snapshots/ws/${workspaceId}/`]) {
    for await (const key of store.list(prefix)) {
      await store.delete(key);
      n++;
    }
  }
  return n;
}

/**
 * Deletes a workspace marked deleted for good: its files, each base's record schema (one
 * transaction per base), then its rows. Returns the number of objects deleted.
 */
export async function purgeWorkspace(
  deps: Pick<PurgeDeps, 'db' | 'store'> & { store: ObjectStore },
  workspaceId: string
): Promise<number> {
  const { db, store } = deps;
  const live = await withTenant(db, workspaceId, async (tx) => {
    const { rows } = await tx.execute<{ deleted: boolean }>(
      sql`SELECT deleted_at IS NOT NULL AS deleted FROM workspaces WHERE id = ${workspaceId}`
    );
    return rows[0] ? !rows[0].deleted : null;
  });
  if (live === null) return 0;
  if (live) throw new Error(`purge: workspace ${workspaceId} is not marked deleted`);
  const objects = await purgeObjects(store, workspaceId);
  const ids = await withTenant(db, workspaceId, async (tx) =>
    (await tx.select({ id: bases.id }).from(bases)).map((b) => b.id)
  );
  for (const id of ids) {
    await withTenant(db, workspaceId, async (tx) => {
      // ddl_drop_base_schema only drops schemas of bases in the trash.
      await tx
        .update(bases)
        .set({ deletedAt: sql`coalesce(${bases.deletedAt}, now())` })
        .where(eq(bases.id, id));
      await setLockTimeout(tx);
      await dropBaseSchema(tx, id);
    });
  }
  await withTenant(db, workspaceId, (tx) =>
    tx.execute(sql`SELECT workspace_purge(${workspaceId}::uuid)`)
  );
  return objects;
}

/**
 * Deletes a user marked deleted for good: at the identity provider (when it's the configured
 * one), then their row and personal data (`account_purge`).
 */
export async function purgeAccount(
  deps: Pick<PurgeDeps, 'db' | 'identity'>,
  userId: string
): Promise<boolean> {
  const { db, identity } = deps;
  const { rows } = await db.execute<{
    oidc_issuer: string;
    oidc_subject: string;
    deleted: boolean;
  }>(
    sql`SELECT oidc_issuer, oidc_subject, deleted_at IS NOT NULL AS deleted
          FROM users WHERE id = ${userId}`
  );
  const user = rows[0];
  if (!user) return false;
  if (!user.deleted) throw new Error(`purge: user ${userId} is not marked deleted`);
  if (identity) await identity.deleteUser(user.oidc_issuer, user.oidc_subject);
  await db.execute(sql`SELECT * FROM account_purge(${userId}::uuid)`);
  return true;
}

/**
 * The `purge.deleted` job: every user, then every workspace marked deleted (users first: their
 * purge may mark the workspaces nobody else is in). A failure is logged and left for the next
 * run; the job fails (and retries) only if nothing could be done.
 */
export async function purgeDeleted(deps: PurgeDeps): Promise<PurgeResult> {
  const { db, logger, store } = deps;
  const result: PurgeResult = { users: 0, workspaces: 0, objects: 0, skipped: 0 };
  const pending = async (kind: 'user' | 'workspace') => {
    const { rows } = await db.execute<{ kind: string; id: string }>(
      sql`SELECT kind, id FROM purge_pending(${PAGE})`
    );
    return rows.filter((r) => r.kind === kind).map((r) => r.id);
  };
  const failures: unknown[] = [];
  for (const id of await pending('user')) {
    try {
      if (await purgeAccount(deps, id)) result.users++;
    } catch (err) {
      failures.push(err);
      result.skipped++;
      logger.warn({ err, userId: id }, 'account purge failed');
    }
  }
  for (const id of await pending('workspace')) {
    if (!store) {
      result.skipped++;
      continue;
    }
    try {
      result.objects += await purgeWorkspace({ db, store }, id);
      result.workspaces++;
    } catch (err) {
      failures.push(err);
      result.skipped++;
      logger.warn({ err, workspaceId: id }, 'workspace purge failed');
    }
  }
  if (!store && result.skipped > 0) {
    logger.warn({ workspaces: result.skipped }, 'deleted workspaces kept: no object store (S3_*)');
  }
  if (failures.length > 0 && result.users + result.workspaces === 0) throw failures[0];
  return result;
}

export interface TrashPurgeResult {
  workspaces: number;
  bases: number;
  tables: number;
  fields: number;
  views: number;
  records: number;
  errors: number;
}

/** The worker purges as nobody: outbox events of a purge have no actor. */
const systemContext = (tx: Transaction, workspaceId: string): SchemaContext => ({
  tx,
  workspaceId,
  userId: '',
});

/** One workspace's trash past the retention, each item in its own transaction. */
async function purgeWorkspaceTrash(
  deps: PurgeDeps,
  workspaceId: string,
  cutoff: Date,
  result: TrashPurgeResult
) {
  const { db, logger } = deps;
  const each = async (
    kind: keyof TrashPurgeResult,
    id: string,
    fn: (tx: Transaction) => unknown
  ) => {
    try {
      await withTenant(db, workspaceId, async (tx) => {
        await fn(tx);
      });
      result[kind]++;
    } catch (err) {
      result.errors++;
      logger.warn({ err, workspaceId, kind, id }, 'trash purge failed');
    }
  };
  const due = await withTenant(db, workspaceId, async (tx) => ({
    bases: await tx.select({ id: bases.id }).from(bases).where(lt(bases.deletedAt, cutoff)),
    tables: await tx
      .select({ id: tables.id, baseId: tables.baseId })
      .from(tables)
      .innerJoin(bases, eq(bases.id, tables.baseId))
      .where(and(lt(tables.deletedAt, cutoff), isNull(bases.deletedAt))),
    fields: await tx
      .select({ id: fields.id, table: tables })
      .from(fields)
      .innerJoin(tables, eq(tables.id, fields.tableId))
      .innerJoin(bases, eq(bases.id, tables.baseId))
      .where(
        and(
          lt(fields.deletedAt, cutoff),
          isNull(fields.trashedWith),
          isNull(tables.deletedAt),
          isNull(bases.deletedAt)
        )
      ),
    views: await tx
      .select({ id: views.id })
      .from(views)
      .innerJoin(tables, eq(tables.id, views.tableId))
      .where(and(lt(views.deletedAt, cutoff), isNull(tables.deletedAt))),
  }));
  for (const b of due.bases) {
    await each('bases', b.id, (tx) => purgeBase(systemContext(tx, workspaceId), b.id));
  }
  for (const t of due.tables) {
    await each('tables', t.id, (tx) => purgeTable(systemContext(tx, workspaceId), t.baseId, t.id));
  }
  for (const f of due.fields) {
    await each('fields', f.id, (tx) => purgeField(systemContext(tx, workspaceId), f.table, f.id));
  }
  for (const v of due.views) {
    await each('views', v.id, (tx) =>
      tx.delete(views).where(and(eq(views.id, v.id), isNotNull(views.deletedAt)))
    );
  }
  // Records in the trash of any table whose record table is (still) there, trashed tables' too.
  const recordTables = await withTenant(db, workspaceId, (tx) =>
    tx
      .select({ id: tables.id, dbSchema: tables.dbSchema, dbTable: tables.dbTable })
      .from(tables)
      .where(
        sql`EXISTS (SELECT 1 FROM pg_catalog.pg_tables p
                     WHERE p.schemaname = ${tables.dbSchema} AND p.tablename = ${tables.dbTable})`
      )
  );
  for (const t of recordTables) {
    try {
      for (;;) {
        const n = await withTenant(db, workspaceId, (tx) => purgeRecordBatch(tx, t, cutoff));
        result.records += n;
        if (n < RECORD_BATCH) break;
      }
    } catch (err) {
      result.errors++;
      logger.warn({ err, workspaceId, tableId: t.id }, 'record trash purge failed');
    }
  }
}

/** Up to RECORD_BATCH records of a table deleted before `cutoff`, with comments and revisions. */
async function purgeRecordBatch(
  tx: Transaction,
  table: { id: string; dbSchema: string; dbTable: string },
  cutoff: Date
): Promise<number> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    DELETE FROM ${qualified(table)} WHERE id IN (
      SELECT id FROM ${qualified(table)}
       WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff.toISOString()}::timestamptz
       LIMIT ${RECORD_BATCH})
    RETURNING id::text AS id`);
  if (rows.length === 0) return 0;
  const ids = sql`${`{${rows.map((r) => r.id).join(',')}}`}::uuid[]`;
  await tx.execute(
    sql`DELETE FROM record_comments WHERE table_id = ${table.id} AND record_id = ANY(${ids})`
  );
  await tx.execute(
    sql`DELETE FROM record_revisions WHERE table_id = ${table.id} AND record_id = ANY(${ids})`
  );
  return rows.length;
}

/**
 * The `purge.trash` job: everything in any workspace's trash for more than
 * TRASH_RETENTION_DAYS. Items that fail (a lock timeout) are logged and left for the next day.
 */
export async function purgeExpiredTrash(
  deps: PurgeDeps,
  now: Date = new Date()
): Promise<TrashPurgeResult> {
  const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * 24 * 3600 * 1000);
  const result: TrashPurgeResult = {
    workspaces: 0,
    bases: 0,
    tables: 0,
    fields: 0,
    views: 0,
    records: 0,
    errors: 0,
  };
  let after: string | null = null;
  for (;;) {
    const { rows }: { rows: { workspace_id: string }[] } = await deps.db.execute<{
      workspace_id: string;
    }>(sql`SELECT workspace_id FROM purge_trash_workspaces(${after}::uuid, ${PAGE})`);
    for (const { workspace_id: workspaceId } of rows) {
      result.workspaces++;
      await purgeWorkspaceTrash(deps, workspaceId, cutoff, result);
    }
    if (rows.length < PAGE) break;
    after = rows[rows.length - 1]?.workspace_id ?? null;
  }
  return result;
}
