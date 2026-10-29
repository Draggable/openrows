import type { NotificationKind } from '@openrows/shared';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { type Database, notifications, type Transaction } from '../db/index.js';

/**
 * Notification writes. Notifications are created in the transaction of the write that
 * caused them (a comment, a user cell): as durable as the write, with its workspace. Callers only
 * name recipients who can read the record; the inbox and the mailer check again on reading.
 */

/** NOTIFY channel: a recipient's notifications changed (payload: the user id, nothing else). */
export const NOTIFICATIONS_CHANNEL = 'notifications';

/** Most notifications one write creates (a big import into a notifying user field). */
export const MAX_NOTIFICATIONS_PER_WRITE = 1000;

/** Where a notification points: the record, in the writer's (RLS-scoped) transaction. */
export interface NotificationTarget {
  workspaceId: string;
  baseId: string;
  tableId: string;
  actorId: string | null;
}

export interface NewNotification {
  userId: string;
  kind: NotificationKind;
  recordId: string;
  commentId?: string;
  fieldId?: string;
}

/**
 * Inserts notifications (never for the actor) and tells the recipients' open tabs. The NOTIFY is
 * transactional: it goes out on commit, and not at all on a rollback.
 */
export async function createNotifications(
  tx: Transaction,
  target: NotificationTarget,
  items: readonly NewNotification[]
): Promise<void> {
  const rows = items
    .filter((n) => n.userId !== target.actorId)
    .slice(0, MAX_NOTIFICATIONS_PER_WRITE)
    .map((n) => ({
      id: uuidv7(),
      workspaceId: target.workspaceId,
      userId: n.userId,
      actorId: target.actorId,
      kind: n.kind,
      baseId: target.baseId,
      tableId: target.tableId,
      recordId: n.recordId,
      commentId: n.commentId ?? null,
      fieldId: n.fieldId ?? null,
    }));
  if (rows.length === 0) return;
  // No RETURNING: only the recipient may read the rows (RLS).
  await tx.insert(notifications).values(rows);
  for (const userId of new Set(rows.map((r) => r.userId))) await signal(tx, userId);
}

export async function signal(tx: Transaction, userId: string) {
  await tx.execute(sql`SELECT pg_notify(${NOTIFICATIONS_CHANNEL}, ${userId})`);
}

/** How long notifications are kept, read or not. */
export const NOTIFICATION_RETENTION_DAYS = 90;

/** Deletes notifications older than `days` (the worker's hourly prune). */
export async function pruneNotifications(db: Database, days: number): Promise<number> {
  const { rows } = await db.execute<{ n: string }>(sql`SELECT notifications_prune(${days}) AS n`);
  return Number(rows[0]?.n ?? 0);
}
