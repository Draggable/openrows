import {
  commentExcerpt,
  NOTIFICATIONS_PAGE_DEFAULT,
  type Notification,
  type NotificationEmailPreference,
  type NotificationPreferences,
  roleAllows,
  type UpdateNotificationPreferences,
} from '@openrows/shared';
import { and, count, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { effectiveRole } from '../authz/policy.js';
import { resolveResource } from '../authz/resolve.js';
import { inScope } from '../authz/scope.js';
import {
  bases,
  type Database,
  fields,
  notifications,
  recordComments,
  type Transaction,
  tables,
  users,
} from '../db/index.js';
import { AppError } from '../lib/errors.js';
import { recordNames } from '../records/service.js';
import { displayName } from '../workspaces/collaborators.js';
import { signal } from './repo.js';

/**
 * Notifications. They are created in the transaction of the write that caused them (a
 * comment, a user cell), so they are as durable as the write and carry its workspace; the
 * callers only name recipients who can read the record. The inbox and the mailer check access
 * again when they read them: someone removed from the base since sees and gets nothing.
 */

/** Whether `userId` can read records of the table now (a live table, a role on its base). */
export async function canReadTable(
  db: Database | Transaction,
  tableId: string,
  userId: string
): Promise<boolean> {
  const resolved = await resolveResource(db, 'table', tableId, userId);
  const role = resolved ? effectiveRole(resolved) : null;
  return role !== null && roleAllows(role, 'record:read');
}

type NotificationRow = typeof notifications.$inferSelect;

/** What a notification shows: names and the excerpt, read in its workspace's scope. */
export interface NotificationDetails {
  baseName: string;
  tableName: string;
  recordName: string;
  fieldName: string | null;
  excerpt: string | null;
}

/**
 * The details of `rows` (all of one workspace and recipient), or nothing for those whose record
 * is gone (deleted or in the trash) or that `userId` can't read any more. Runs in the
 * recipient's scope of that workspace.
 */
export async function notificationDetails(
  db: Database,
  userId: string,
  workspaceId: string,
  rows: readonly Pick<NotificationRow, 'id' | 'tableId' | 'recordId' | 'commentId' | 'fieldId'>[]
): Promise<Map<string, NotificationDetails>> {
  const out = new Map<string, NotificationDetails>();
  const tableIds = [...new Set(rows.map((r) => r.tableId))];
  const readable = new Set<string>();
  for (const tableId of tableIds) {
    if (await canReadTable(db, tableId, userId)) readable.add(tableId);
  }
  if (readable.size === 0) return out;
  await inScope(db, { userId, workspaceId }, async (tx) => {
    const tableRows = await tx
      .select({ table: tables, baseName: bases.name })
      .from(tables)
      .innerJoin(bases, eq(bases.id, tables.baseId))
      .where(
        and(inArray(tables.id, [...readable]), isNull(tables.deletedAt), isNull(bases.deletedAt))
      );
    const commentIds = rows.flatMap((r) => (r.commentId ? [r.commentId] : []));
    const comments = commentIds.length
      ? await tx
          .select({ id: recordComments.id, body: recordComments.body })
          .from(recordComments)
          .where(and(inArray(recordComments.id, commentIds), isNull(recordComments.deletedAt)))
      : [];
    const bodies = new Map(comments.map((c) => [c.id, c.body]));
    const fieldIds = rows.flatMap((r) => (r.fieldId ? [r.fieldId] : []));
    const fieldNames = new Map(
      (fieldIds.length
        ? await tx
            .select({ id: fields.id, name: fields.name })
            .from(fields)
            .where(and(inArray(fields.id, fieldIds), isNull(fields.deletedAt)))
        : []
      ).map((f) => [f.id, f.name])
    );
    for (const { table, baseName } of tableRows) {
      const mine = rows.filter((r) => r.tableId === table.id);
      const names = await recordNames(
        { tx, workspaceId, userId, table },
        mine.map((r) => r.recordId)
      );
      for (const r of mine) {
        const recordName = names.get(r.recordId);
        if (recordName === undefined) continue;
        const body = r.commentId ? bodies.get(r.commentId) : undefined;
        out.set(r.id, {
          baseName,
          tableName: table.name,
          recordName,
          fieldName: r.fieldId ? (fieldNames.get(r.fieldId) ?? null) : null,
          excerpt: body !== undefined ? commentExcerpt(body) : null,
        });
      }
    }
  });
  return out;
}

function toNotification(
  row: NotificationRow,
  d: NotificationDetails,
  actors: Map<string, string>
): Notification {
  return {
    id: row.id,
    kind: row.kind,
    actorId: row.actorId,
    actorName: (row.actorId && actors.get(row.actorId)) || 'Someone',
    workspaceId: row.workspaceId,
    baseId: row.baseId,
    tableId: row.tableId,
    recordId: row.recordId,
    commentId: row.commentId,
    fieldId: row.fieldId,
    ...d,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
  };
}

/** The opaque cursor: the last row's creation time and id. */
function encodeCursor(row: NotificationRow): string {
  return Buffer.from(JSON.stringify([row.createdAt.toISOString(), row.id])).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[];
    const createdAt = new Date(String(at));
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id) || Number.isNaN(+createdAt)) {
      throw new Error('bad cursor');
    }
    return { createdAt, id };
  } catch {
    throw new AppError('VALIDATION_FAILED', { detail: 'Invalid cursor.' });
  }
}

/** How many of the user's notifications are unread (whatever their access now: a count only). */
export async function unreadCount(db: Database, userId: string): Promise<number> {
  return inScope(db, { userId }, async (tx) => {
    const [row] = await tx
      .select({ n: count() })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    return row?.n ?? 0;
  });
}

/**
 * A page of the user's notifications, newest first, across workspaces (RLS: only theirs). Those
 * whose record they can't read any more are left out of the page (and marked read, so the bell
 * doesn't count what the inbox can't show).
 */
export async function listNotifications(
  db: Database,
  userId: string,
  query: { limit?: number; cursor?: string | undefined; unread?: 'true' | 'false' | undefined }
): Promise<{ notifications: Notification[]; nextCursor: string | null; unread: number }> {
  const limit = query.limit ?? NOTIFICATIONS_PAGE_DEFAULT;
  const after = query.cursor ? decodeCursor(query.cursor) : undefined;
  const rows = await inScope(db, { userId }, (tx) =>
    tx
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          query.unread === 'true' ? isNull(notifications.readAt) : undefined,
          after
            ? or(
                lt(notifications.createdAt, after.createdAt),
                and(eq(notifications.createdAt, after.createdAt), lt(notifications.id, after.id))
              )
            : undefined
        )
      )
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit + 1)
  );
  const page = rows.slice(0, limit);
  const details = new Map<string, NotificationDetails>();
  for (const workspaceId of new Set(page.map((r) => r.workspaceId))) {
    const of = page.filter((r) => r.workspaceId === workspaceId);
    for (const [id, d] of await notificationDetails(db, userId, workspaceId, of)) {
      details.set(id, d);
    }
  }
  const hidden = page.filter((r) => !details.has(r.id) && r.readAt === null).map((r) => r.id);
  if (hidden.length > 0) await markRead(db, userId, hidden);
  const last = page.at(-1);
  const actorIds = [...new Set(page.flatMap((r) => (r.actorId ? [r.actorId] : [])))];
  const actors = new Map(
    (actorIds.length ? await db.select().from(users).where(inArray(users.id, actorIds)) : []).map(
      (u) => [u.id, displayName(u, false)]
    )
  );
  return {
    notifications: page.flatMap((r) => {
      const d = details.get(r.id);
      return d ? [toNotification(r, d, actors)] : [];
    }),
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    unread: await unreadCount(db, userId),
  };
}

/** Marks the user's notifications read (`ids`, or all of them); someone else's ids match nothing. */
export async function markRead(
  db: Database,
  userId: string,
  ids?: readonly string[]
): Promise<number> {
  return inScope(db, { userId }, async (tx) => {
    const changed = await tx
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.userId, userId),
          isNull(notifications.readAt),
          ids ? inArray(notifications.id, [...ids]) : undefined
        )
      )
      .returning({ id: notifications.id });
    if (changed.length > 0) await signal(tx, userId);
    const [row] = await tx
      .select({ n: count() })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    return row?.n ?? 0;
  });
}

/** Marks one notification read: 404 when it isn't the user's. */
export async function markOneRead(db: Database, userId: string, id: string): Promise<number> {
  const [row] = await inScope(db, { userId }, (tx) =>
    tx
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
  );
  if (!row) throw new AppError('NOT_FOUND');
  return markRead(db, userId, [id]);
}

export async function emailPreference(
  db: Database | Transaction,
  userId: string
): Promise<NotificationEmailPreference> {
  const [row] = await db
    .select({ email: users.notificationEmail })
    .from(users)
    .where(eq(users.id, userId));
  return row?.email ?? 'all';
}

/** The user's email preferences: which notifications, and when. */
export async function notificationPreferences(
  db: Database | Transaction,
  userId: string
): Promise<NotificationPreferences> {
  const [row] = await db
    .select({ email: users.notificationEmail, frequency: users.notificationFrequency })
    .from(users)
    .where(eq(users.id, userId));
  return row ?? { email: 'all', frequency: 'immediately' };
}

export async function updateNotificationPreferences(
  db: Database | Transaction,
  userId: string,
  patch: UpdateNotificationPreferences
): Promise<NotificationPreferences> {
  await db
    .update(users)
    .set({
      ...(patch.email ? { notificationEmail: patch.email } : {}),
      ...(patch.frequency ? { notificationFrequency: patch.frequency } : {}),
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
  return notificationPreferences(db, userId);
}

export async function setEmailPreference(
  db: Database | Transaction,
  userId: string,
  email: NotificationEmailPreference
): Promise<void> {
  await db
    .update(users)
    .set({ notificationEmail: email, updatedAt: new Date() })
    .where(eq(users.id, userId));
}
