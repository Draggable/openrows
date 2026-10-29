import {
  COMMENT_REACTION_KEYS,
  COMMENTS_PAGE_DEFAULT,
  type Comment,
  type CommentReaction,
  commentMentions,
  MAX_COLLABORATORS,
  MAX_COMMENT_LENGTH,
  MAX_COMMENT_MENTIONS,
  MAX_COMMENTS_PER_RECORD,
  roleAllows,
  sanitizeComment,
  type UserRole,
} from '@openrows/shared';
import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { emitMany, type OutboxEvent } from '../data/outbox.js';
import {
  baseMembers,
  recordCommentReactions,
  recordComments,
  type Transaction,
  workspaceMembers,
} from '../db/index.js';
import type { TableRow } from '../fields/service.js';
import { AppError } from '../lib/errors.js';
import { createNotifications, type NewNotification } from '../notifications/repo.js';
import { selectByIds } from '../records/repo.js';

/**
 * Record comments. Every function runs in the authorized table's transaction (RLS scoped
 * to its workspace) and only reaches comments of that table and a live record of it, so no id
 * from another table or tenant matches. Writes emit `comment.*` outbox events in the same
 * transaction (live updates, ADR-003), and new mentions a `comment.mentioned` event: the domain
 * event notifications consume. That one is internal: the realtime projection drops it.
 */

export interface CommentContext {
  tx: Transaction;
  workspaceId: string;
  userId: string;
  role: UserRole;
  table: TableRow;
  clientOpId?: string | undefined;
}

/** The payload of `comment.mentioned`: who a write newly mentioned (never the author). */
export interface MentionEventPayload {
  commentId: string;
  recordId: string;
  authorId: string;
  userIds: string[];
}

type CommentRow = typeof recordComments.$inferSelect;

async function assertLiveRecord(ctx: CommentContext, recordId: string): Promise<void> {
  const [row] = await selectByIds(ctx.tx, ctx.table, [], [recordId]);
  if (!row) throw new AppError('NOT_FOUND');
}

async function toComments(ctx: CommentContext, rows: readonly CommentRow[]): Promise<Comment[]> {
  if (rows.length === 0) return [];
  const reactions = await ctx.tx
    .select({
      commentId: recordCommentReactions.commentId,
      userId: recordCommentReactions.userId,
      reaction: recordCommentReactions.reaction,
    })
    .from(recordCommentReactions)
    .where(
      inArray(
        recordCommentReactions.commentId,
        rows.map((r) => r.id)
      )
    )
    .orderBy(asc(recordCommentReactions.createdAt), asc(recordCommentReactions.userId));
  return rows.map((row) => {
    const mine = reactions.filter((r) => r.commentId === row.id);
    return {
      id: row.id,
      tableId: row.tableId,
      recordId: row.recordId,
      authorId: row.authorId,
      body: row.body,
      mentions: row.mentions,
      reactions: COMMENT_REACTION_KEYS.flatMap((reaction) => {
        const userIds = mine.filter((r) => r.reaction === reaction).map((r) => r.userId);
        return userIds.length > 0 ? [{ reaction, userIds }] : [];
      }),
      createdAt: row.createdAt.toISOString(),
      editedAt: row.editedAt?.toISOString() ?? null,
    };
  });
}

async function toComment(ctx: CommentContext, row: CommentRow): Promise<Comment> {
  const [comment] = await toComments(ctx, [row]);
  if (!comment) throw new Error('comment: no row');
  return comment;
}

/**
 * Who can read the table's records: members of the workspace and collaborators on its base
 * (`among` narrows to those ids). Up to `MAX_COLLABORATORS`, like the directory.
 */
async function baseAccessUsers(ctx: CommentContext, among?: readonly string[]): Promise<string[]> {
  const inWorkspace = await ctx.tx
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, ctx.workspaceId),
        among ? inArray(workspaceMembers.userId, [...among]) : undefined
      )
    )
    .limit(MAX_COLLABORATORS);
  const inBase = await ctx.tx
    .select({ userId: baseMembers.userId })
    .from(baseMembers)
    .where(
      and(
        eq(baseMembers.workspaceId, ctx.workspaceId),
        eq(baseMembers.baseId, ctx.table.baseId),
        among ? inArray(baseMembers.userId, [...among]) : undefined
      )
    )
    .limit(MAX_COLLABORATORS);
  return [...new Set([...inWorkspace, ...inBase].map((r) => r.userId))].slice(0, MAX_COLLABORATORS);
}

/** The people a comment on this table may mention (the mention autocomplete). */
export function mentionableUsers(ctx: CommentContext): Promise<string[]> {
  return baseAccessUsers(ctx);
}

/**
 * The sanitized body and its mentions. Every mentioned user must be able to read the record:
 * a member of the workspace or a collaborator on this base; anyone else is a 422 (it would
 * otherwise tell the author nothing, and notify someone who can't open the record).
 */
async function prepareBody(
  ctx: CommentContext,
  input: string
): Promise<{ body: string; mentions: string[] }> {
  const body = sanitizeComment(input);
  if (body.length === 0) {
    throw new AppError('VALIDATION_FAILED', { detail: 'A comment needs some text.' });
  }
  if (body.length > MAX_COMMENT_LENGTH) {
    throw new AppError('VALIDATION_FAILED', {
      detail: `A comment holds up to ${MAX_COMMENT_LENGTH.toLocaleString('en')} characters.`,
    });
  }
  const mentions = commentMentions(body);
  if (mentions.length > MAX_COMMENT_MENTIONS) {
    throw new AppError('VALIDATION_FAILED', {
      detail: `A comment can mention up to ${MAX_COMMENT_MENTIONS} people.`,
    });
  }
  if (mentions.length > 0) {
    const allowed = new Set(await baseAccessUsers(ctx, mentions));
    if (mentions.some((id) => !allowed.has(id))) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'You can only mention people who have access to this base.',
        extensions: { errors: [{ path: 'body', message: 'Mentions someone without access.' }] },
      });
    }
  }
  return { body, mentions };
}

function event(
  ctx: CommentContext,
  kind: OutboxEvent['kind'],
  payload: Record<string, unknown>
): OutboxEvent {
  return {
    workspaceId: ctx.workspaceId,
    baseId: ctx.table.baseId,
    tableId: ctx.table.id,
    kind,
    payload,
    actorId: ctx.userId,
    clientOpId: ctx.clientOpId,
  };
}

/** A `comment.mentioned` event for the users `mentions` adds to `before`, if any. */
function mentionEvent(
  ctx: CommentContext,
  row: CommentRow,
  before: readonly string[]
): OutboxEvent[] {
  const userIds = row.mentions.filter((id) => !before.includes(id) && id !== ctx.userId);
  if (userIds.length === 0) return [];
  const payload: MentionEventPayload = {
    commentId: row.id,
    recordId: row.recordId,
    authorId: ctx.userId,
    userIds,
  };
  return [event(ctx, 'comment.mentioned', { ...payload })];
}

/**
 * Notifications for a comment write: `mention` for everyone it newly mentions, and on a new
 * comment `reply` for the other people who commented on the record and still have access to the
 * base (the thread's watchers; someone mentioned gets the mention instead). Never the author.
 */
async function notifyComment(
  ctx: CommentContext,
  row: CommentRow,
  before: readonly string[],
  isNew: boolean
) {
  const mentioned = row.mentions.filter((id) => !before.includes(id) && id !== ctx.userId);
  const items: NewNotification[] = mentioned.map((userId) => ({
    userId,
    kind: 'mention',
    recordId: row.recordId,
    commentId: row.id,
  }));
  if (isNew) {
    const authors = await ctx.tx
      .selectDistinct({ authorId: recordComments.authorId })
      .from(recordComments)
      .where(
        and(
          eq(recordComments.tableId, ctx.table.id),
          eq(recordComments.recordId, row.recordId),
          isNull(recordComments.deletedAt)
        )
      )
      .limit(MAX_COLLABORATORS);
    const watchers = authors.flatMap((a) =>
      a.authorId && a.authorId !== ctx.userId && !mentioned.includes(a.authorId) ? [a.authorId] : []
    );
    const allowed = watchers.length ? await baseAccessUsers(ctx, watchers) : [];
    for (const userId of allowed) {
      items.push({ userId, kind: 'reply', recordId: row.recordId, commentId: row.id });
    }
  }
  await createNotifications(
    ctx.tx,
    {
      workspaceId: ctx.workspaceId,
      baseId: ctx.table.baseId,
      tableId: ctx.table.id,
      actorId: ctx.userId,
    },
    items
  );
}

/** The opaque comment cursor: the oldest shown comment's creation time (microseconds) and id. */
function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify([at, id])).toString('base64url');
}

function decodeCursor(cursor: string): { at: string; id: string } {
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[];
    if (
      typeof at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(at) ||
      typeof id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
    ) {
      throw new Error('bad cursor');
    }
    return { at, id };
  } catch {
    throw new AppError('VALIDATION_FAILED', { detail: 'Invalid cursor.' });
  }
}

/**
 * A page of a record's live comments, oldest first: the newest `limit`, or the `limit`
 * before the cursor (keyset on creation time and id, so new comments never shift the pages).
 */
export async function listComments(
  ctx: CommentContext,
  recordId: string,
  query: { limit?: number; before?: string | undefined } = {}
): Promise<{ comments: Comment[]; previousCursor: string | null }> {
  // The route caps `limit` at COMMENTS_PAGE_MAX; the v1 API reads a whole thread.
  const limit = Math.min(query.limit ?? COMMENTS_PAGE_DEFAULT, MAX_COMMENTS_PER_RECORD);
  const before = query.before ? decodeCursor(query.before) : undefined;
  await assertLiveRecord(ctx, recordId);
  const rows = await ctx.tx
    .select({
      comment: recordComments,
      // Microseconds: a JS Date would round them away and skip or repeat comments.
      at: sql<string>`to_char(${recordComments.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(recordComments)
    .where(
      and(
        eq(recordComments.tableId, ctx.table.id),
        eq(recordComments.recordId, recordId),
        isNull(recordComments.deletedAt),
        before
          ? sql`(${recordComments.createdAt}, ${recordComments.id}) < (${before.at}::timestamptz, ${before.id}::uuid)`
          : undefined
      )
    )
    .orderBy(desc(recordComments.createdAt), desc(recordComments.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit).reverse();
  const oldest = page[0];
  return {
    comments: await toComments(
      ctx,
      page.map((r) => r.comment)
    ),
    previousCursor:
      rows.length > limit && oldest ? encodeCursor(oldest.at, oldest.comment.id) : null,
  };
}

export async function createComment(
  ctx: CommentContext,
  recordId: string,
  input: { body: string }
): Promise<Comment> {
  await assertLiveRecord(ctx, recordId);
  const { body, mentions } = await prepareBody(ctx, input.body);
  // One writer per record at a time, so the cap holds under concurrent posts.
  await ctx.tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`comments:${recordId}`}, 0))`
  );
  const [existing] = await ctx.tx
    .select({ n: count() })
    .from(recordComments)
    .where(
      and(
        eq(recordComments.tableId, ctx.table.id),
        eq(recordComments.recordId, recordId),
        isNull(recordComments.deletedAt)
      )
    );
  if ((existing?.n ?? 0) >= MAX_COMMENTS_PER_RECORD) {
    throw new AppError('CONFLICT', {
      detail: `A record holds up to ${MAX_COMMENTS_PER_RECORD.toLocaleString('en')} comments.`,
    });
  }
  const [row] = await ctx.tx
    .insert(recordComments)
    .values({
      workspaceId: ctx.workspaceId,
      baseId: ctx.table.baseId,
      tableId: ctx.table.id,
      recordId,
      authorId: ctx.userId,
      body,
      mentions,
    })
    .returning();
  if (!row) throw new Error('create comment: no row');
  const comment = await toComment(ctx, row);
  await emitMany(ctx.tx, [
    event(ctx, 'comment.created', { recordId, comment }),
    ...mentionEvent(ctx, row, []),
  ]);
  await notifyComment(ctx, row, [], true);
  return comment;
}

/** The live comment, locked for the rest of the transaction; 404 when it isn't there. */
async function lockComment(
  ctx: CommentContext,
  recordId: string,
  commentId: string
): Promise<CommentRow> {
  const [row] = await ctx.tx
    .select()
    .from(recordComments)
    .where(
      and(
        eq(recordComments.id, commentId),
        eq(recordComments.tableId, ctx.table.id),
        eq(recordComments.recordId, recordId),
        isNull(recordComments.deletedAt)
      )
    )
    .for('update');
  if (!row) throw new AppError('NOT_FOUND');
  return row;
}

/** Only the author edits a comment, whatever their role. */
export async function updateComment(
  ctx: CommentContext,
  recordId: string,
  commentId: string,
  input: { body: string }
): Promise<Comment> {
  await assertLiveRecord(ctx, recordId);
  const current = await lockComment(ctx, recordId, commentId);
  if (current.authorId !== ctx.userId) {
    throw new AppError('FORBIDDEN', { detail: 'Only the author can edit a comment.' });
  }
  const { body, mentions } = await prepareBody(ctx, input.body);
  const [row] = await ctx.tx
    .update(recordComments)
    .set({ body, mentions, editedAt: new Date() })
    .where(eq(recordComments.id, commentId))
    .returning();
  if (!row) throw new Error('update comment: no row');
  const comment = await toComment(ctx, row);
  await emitMany(ctx.tx, [
    event(ctx, 'comment.updated', { recordId, comment }),
    ...mentionEvent(ctx, row, current.mentions),
  ]);
  await notifyComment(ctx, row, current.mentions, false);
  return comment;
}

/** The author deletes their comment; creators and owners (`comment:moderate`) any comment. */
export async function deleteComment(
  ctx: CommentContext,
  recordId: string,
  commentId: string
): Promise<void> {
  await assertLiveRecord(ctx, recordId);
  const current = await lockComment(ctx, recordId, commentId);
  if (current.authorId !== ctx.userId && !roleAllows(ctx.role, 'comment:moderate')) {
    throw new AppError('FORBIDDEN', { detail: 'Only the author can delete this comment.' });
  }
  await ctx.tx
    .update(recordComments)
    .set({ deletedAt: new Date(), deletedBy: ctx.userId })
    .where(eq(recordComments.id, commentId));
  await emitMany(ctx.tx, [event(ctx, 'comment.deleted', { recordId, commentId })]);
}

/** Adds (`on`) or takes back the caller's reaction; idempotent either way. */
export async function setReaction(
  ctx: CommentContext,
  recordId: string,
  commentId: string,
  reaction: CommentReaction,
  on: boolean
): Promise<Comment> {
  await assertLiveRecord(ctx, recordId);
  const row = await lockComment(ctx, recordId, commentId);
  const mine = and(
    eq(recordCommentReactions.commentId, commentId),
    eq(recordCommentReactions.userId, ctx.userId),
    eq(recordCommentReactions.reaction, reaction)
  );
  const changed = on
    ? await ctx.tx
        .insert(recordCommentReactions)
        .values({ workspaceId: ctx.workspaceId, commentId, userId: ctx.userId, reaction })
        .onConflictDoNothing()
        .returning({ commentId: recordCommentReactions.commentId })
    : await ctx.tx
        .delete(recordCommentReactions)
        .where(mine)
        .returning({ commentId: recordCommentReactions.commentId });
  const comment = await toComment(ctx, row);
  if (changed.length > 0) {
    await emitMany(ctx.tx, [event(ctx, 'comment.updated', { recordId, comment })]);
  }
  return comment;
}

/** The most records `commentCounts` reports on. */
const MAX_COUNTED_RECORDS = 100_000;

/** Live comments per record of the table, for records with at least one. */
export async function commentCounts(ctx: CommentContext): Promise<Record<string, number>> {
  const rows = await ctx.tx
    .select({ recordId: recordComments.recordId, n: count() })
    .from(recordComments)
    .where(and(eq(recordComments.tableId, ctx.table.id), isNull(recordComments.deletedAt)))
    .groupBy(recordComments.recordId)
    .limit(MAX_COUNTED_RECORDS);
  return Object.fromEntries(rows.map((r) => [r.recordId, r.n]));
}
