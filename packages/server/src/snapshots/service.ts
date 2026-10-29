import { MAX_SNAPSHOTS_PER_BASE, type Snapshot, type SnapshotList } from '@openrows/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { ObjectStore } from '../attachments/storage.js';
import { baseSnapshots, type Database, type Transaction, workspaces } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import type { SnapshotRow } from './writer.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function needStore(store: ObjectStore | undefined): ObjectStore {
  if (!store) {
    throw new AppError('SERVICE_UNAVAILABLE', { detail: "File storage isn't configured." });
  }
  return store;
}

export function toSnapshot(row: SnapshotRow, retentionDays: number): Snapshot {
  return {
    id: row.id,
    baseId: row.baseId,
    baseName: row.baseName,
    kind: row.kind,
    size: row.size,
    tables: row.tableCount,
    records: row.recordCount,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    expiresAt: new Date(row.createdAt.getTime() + retentionDays * DAY_MS).toISOString(),
  };
}

/** The workspace's snapshot retention in days (the workspace in scope). */
export async function retentionDays(tx: Transaction | Database, workspaceId: string) {
  const [row] = await tx
    .select({ days: workspaces.snapshotRetentionDays })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return row?.days ?? 30;
}

export async function listSnapshots(
  tx: Transaction,
  workspaceId: string,
  baseId: string
): Promise<SnapshotList> {
  const days = await retentionDays(tx, workspaceId);
  const rows = await tx
    .select()
    .from(baseSnapshots)
    .where(eq(baseSnapshots.baseId, baseId))
    .orderBy(desc(baseSnapshots.createdAt))
    .limit(MAX_SNAPSHOTS_PER_BASE);
  return { snapshots: rows.map((r) => toSnapshot(r, days)), retentionDays: days };
}

/** A snapshot of the base, or 404 (another base's or another tenant's look like none). */
export async function loadSnapshot(tx: Transaction, baseId: string, id: string) {
  const [row] = await tx
    .select()
    .from(baseSnapshots)
    .where(and(eq(baseSnapshots.id, id), eq(baseSnapshots.baseId, baseId)));
  if (!row) throw new AppError('NOT_FOUND', { detail: 'No such snapshot.' });
  return row;
}

/** 409 when the base already has the most snapshots it may keep. */
export async function assertRoom(tx: Transaction, baseId: string) {
  const [stats] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(baseSnapshots)
    .where(eq(baseSnapshots.baseId, baseId));
  if ((stats?.n ?? 0) >= MAX_SNAPSHOTS_PER_BASE) {
    throw new AppError('CONFLICT', {
      detail: `A base keeps at most ${MAX_SNAPSHOTS_PER_BASE} snapshots. Delete an older one first.`,
    });
  }
}

/** Deletes a snapshot's row, then its object (a leftover object is only unreachable). */
export async function deleteSnapshot(
  tx: Transaction,
  store: ObjectStore | undefined,
  row: SnapshotRow
) {
  await tx.delete(baseSnapshots).where(eq(baseSnapshots.id, row.id));
  await store?.delete(row.storageKey);
}
