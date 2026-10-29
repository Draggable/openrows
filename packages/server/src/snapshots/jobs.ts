import { MAX_SNAPSHOTS_PER_BASE } from '@openrows/shared';
import { eq, sql } from 'drizzle-orm';
import type { ObjectStore } from '../attachments/storage.js';
import { inScope } from '../authz/scope.js';
import { baseSnapshots, type Database } from '../db/index.js';
import type { Logger } from '../lib/logger.js';
import { takeSnapshot } from './writer.js';

/** Bases snapshotted per run (the worker runs hourly); the rest wait for the next run. */
export const AUTO_SNAPSHOTS_PER_RUN = 50;
const PRUNE_BATCH = 500;

/**
 * The daily automatic snapshots: every live base changed since its newest snapshot, and
 * without one in the last 24 hours, gets an `auto` snapshot. A base at MAX_SNAPSHOTS_PER_BASE
 * gives up its oldest automatic one first. Returns how many were taken.
 */
export async function runAutoSnapshots(
  db: Database,
  store: ObjectStore,
  logger: Pick<Logger, 'info' | 'warn'>,
  limit = AUTO_SNAPSHOTS_PER_RUN
): Promise<number> {
  const { rows } = await db.execute<{ workspace_id: string; base_id: string }>(
    sql`SELECT workspace_id, base_id FROM base_snapshots_due(${limit})`
  );
  let taken = 0;
  for (const { workspace_id: workspaceId, base_id: baseId } of rows) {
    try {
      const oldest = await inScope(db, { userId: '', workspaceId }, async (tx) => {
        const [count] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(baseSnapshots)
          .where(eq(baseSnapshots.baseId, baseId));
        if ((count?.n ?? 0) < MAX_SNAPSHOTS_PER_BASE) return null;
        const [row] = await tx
          .delete(baseSnapshots)
          .where(
            eq(
              baseSnapshots.id,
              sql`(SELECT id FROM base_snapshots WHERE base_id = ${baseId} AND kind = 'auto'
                    ORDER BY created_at LIMIT 1)`
            )
          )
          .returning();
        return row ?? 'full';
      });
      if (oldest === 'full') continue;
      if (oldest) await store.delete(oldest.storageKey);
      const row = await takeSnapshot(db, store, {
        workspaceId,
        baseId,
        userId: null,
        kind: 'auto',
      });
      taken++;
      logger.info({ baseId, snapshotId: row.id, records: row.recordCount }, 'automatic snapshot');
    } catch (err) {
      logger.warn({ err, baseId }, 'automatic snapshot failed');
    }
  }
  return taken;
}

/** Deletes snapshots past their workspace's retention, rows first, then their objects. */
export async function pruneSnapshots(
  db: Database,
  store: ObjectStore | undefined,
  logger: Pick<Logger, 'warn'>
): Promise<number> {
  let total = 0;
  for (;;) {
    const { rows } = await db.execute<{ storage_key: string }>(
      sql`SELECT storage_key FROM base_snapshots_prune(${PRUNE_BATCH})`
    );
    for (const { storage_key: key } of rows) {
      await store?.delete(key).catch((err: unknown) => {
        logger.warn({ err, key }, 'snapshot object not deleted');
      });
    }
    total += rows.length;
    if (rows.length < PRUNE_BATCH) return total;
  }
}
