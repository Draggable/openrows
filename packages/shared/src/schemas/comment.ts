import { z } from 'zod';
import { COMMENT_REACTION_KEYS, MAX_COMMENT_LENGTH } from '../comments.js';

/** A comment body as sent: Markdown with mention tokens, sanitized by the server. */
const commentBody = z
  .string()
  .max(MAX_COMMENT_LENGTH)
  .refine((s) => s.trim().length > 0, 'A comment needs some text.');

const clientOpId = z.string().min(1).max(100).optional();

/** `POST /api/tables/:tableId/records/:recordId/comments`. */
export const createCommentSchema = z.object({ body: commentBody, clientOpId }).strict();
export type CreateCommentInput = z.input<typeof createCommentSchema>;

/** `PATCH .../comments/:commentId`: the author's new text. */
export const updateCommentSchema = z.object({ body: commentBody, clientOpId }).strict();
export type UpdateCommentInput = z.input<typeof updateCommentSchema>;

export const commentReactionSchema = z.enum(COMMENT_REACTION_KEYS);

export const CommentSchema = z.object({
  id: z.uuid(),
  tableId: z.uuid(),
  recordId: z.uuid(),
  /** Null once the author's account is gone. */
  authorId: z.uuid().nullable(),
  /** Sanitized Markdown with mention tokens: render with `parseComment`. */
  body: z.string(),
  /** Who the body mentions. */
  mentions: z.array(z.uuid()),
  /** Each reaction someone gave, with who gave it, in the catalog's order. */
  reactions: z.array(z.object({ reaction: commentReactionSchema, userIds: z.array(z.uuid()) })),
  createdAt: z.iso.datetime({ offset: true }),
  editedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type Comment = z.infer<typeof CommentSchema>;

/** Comments per page of a thread: the default and the cap. */
export const COMMENTS_PAGE_DEFAULT = 50;
export const COMMENTS_PAGE_MAX = 100;

/** `GET .../comments`: the newest page, or the page before `before` ("Load earlier"). */
export const listCommentsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(COMMENTS_PAGE_MAX).default(COMMENTS_PAGE_DEFAULT),
  /** The opaque `previousCursor` of the page shown last. */
  before: z.string().max(200).optional(),
});
export type ListCommentsQuery = z.input<typeof listCommentsQuerySchema>;

/**
 * A page of a record's live comments, oldest first: the newest ones, or those before the cursor.
 * `previousCursor` loads the page before it; null when there are no earlier comments.
 */
export const CommentListSchema = z.object({
  comments: z.array(CommentSchema),
  previousCursor: z.string().nullable(),
});
export type CommentList = z.infer<typeof CommentListSchema>;

/** Live comments per record of a table, for records that have any (the row header badges). */
export const CommentCountsSchema = z.object({ counts: z.record(z.uuid(), z.int().min(1)) });
export type CommentCounts = z.infer<typeof CommentCountsSchema>;

/** The ids of everyone a comment on a table may mention (names come from the directory). */
export const MentionableUsersSchema = z.object({ userIds: z.array(z.uuid()) });
export type MentionableUsers = z.infer<typeof MentionableUsersSchema>;
