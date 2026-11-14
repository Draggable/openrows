import {
  type AirtableCommentsReport,
  COMMENT_REACTIONS,
  type CommentReaction,
  commentMentions,
  MAX_COMMENT_LENGTH,
  MAX_COMMENT_MENTIONS,
  MAX_COMMENTS_PER_RECORD,
  mapMentionTokens,
  mentionToken,
  sanitizeComment,
} from '@openrows/shared';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { recordCommentReactions, recordComments, type Transaction } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import type { AirtableClient, AirtableComment } from './client.js';
import { capped } from './schema.js';

/**
 * Airtable's record comments → ours, for the importer's last pass. Airtable's Web API lists
 * comments per record only (`GET /v0/{base}/{table}/{record}/comments`, newest first, 100 a
 * page, scope `data.recordComments:read`), so the pass makes at least one request per record.
 *
 * - Authors are matched by email to workspace members; anyone else leaves the author empty
 *   (shown as a former member) and the body starts with their name and email.
 * - Airtable's mentions (`@[usr…]`, described by the comment's `mentioned` map) become mention
 *   tokens for members (by email), and the person's or group's plain name otherwise.
 * - Reactions come over when their emoji is one of ours (skin tones folded) and the person is a
 *   member. Replies are ordinary comments of the record's thread, in time order. Attachments
 *   aren't copied (comments here have no files) and their expiring URLs are never kept.
 * - Bodies are sanitized like any comment and cut to MAX_COMMENT_LENGTH; at most
 *   MAX_COMMENTS_PER_RECORD per record (the newest).
 *
 * Imported comments are written straight to `record_comments` with Airtable's times: no outbox
 * events and no notifications, since nobody is newly mentioned or replied to.
 */

export const AIRTABLE_COMMENTS_SCOPE = 'data.recordComments:read';

/** The report's line when the token can't list comments (Airtable's 403 on the first record). */
export const COMMENTS_SCOPE_MISSING =
  `Comments weren't imported: Airtable refused to list them. Give the token the scope ` +
  `${AIRTABLE_COMMENTS_SCOPE} (and access to the base), then import the base again to bring them.`;

/** The report's line when the token stopped working during the comments pass. */
export const COMMENTS_TOKEN_REJECTED =
  "Airtable rejected the token while comments were read: the remaining records' comments weren't imported.";

/** The report's line when Airtable kept failing during the comments pass. */
export const COMMENTS_STOPPED =
  "Airtable stopped returning comments: the remaining records' comments weren't imported.";

/** The report's line when an import nears the token's 24 hours (`jobs_sweep`). */
export const COMMENTS_OUT_OF_TIME =
  "The import ran for close to 24 hours, the most it can keep the token: the remaining records' comments weren't imported.";

/** Failures in a row (after some comments were read) that end the pass. */
export const MAX_COMMENT_FAILURES = 5;

/** Most pages read for one record: enough for MAX_COMMENTS_PER_RECORD. */
const MAX_COMMENT_PAGES = Math.ceil(MAX_COMMENTS_PER_RECORD / 100);

/** Skin tones and variation selectors: 👍🏽 is 👍 here. */
const EMOJI_NOISE = /[\u{1F3FB}-\u{1F3FF}︎️]/gu;
const CODEPOINTS = /^(?:u\+)?[0-9a-f]{2,6}(?:[-_ ](?:u\+)?[0-9a-f]{2,6})*$/i;

const REACTION_BY_EMOJI = new Map<string, CommentReaction>(
  (Object.entries(COMMENT_REACTIONS) as [CommentReaction, string][]).map(([key, emoji]) => [
    emoji.replace(EMOJI_NOISE, ''),
    key,
  ])
);

/**
 * Our reaction for Airtable's `unicodeCharacter`: the emoji itself, or its code points in hex
 * (`1f44d`, `U+1F44D`, `1f44d-1f3fd`). Null for any other emoji.
 */
export function reactionOf(unicodeCharacter: string): CommentReaction | null {
  let emoji = unicodeCharacter.trim();
  if (CODEPOINTS.test(emoji)) {
    const points = emoji
      .split(/[-_ ]/)
      .map((p) => Number.parseInt(p.replace(/^u\+/i, ''), 16))
      .filter((n) => n > 0 && n <= 0x10ffff);
    emoji = points.length ? String.fromCodePoint(...points) : emoji;
  }
  return REACTION_BY_EMOJI.get(emoji.replace(EMOJI_NOISE, '')) ?? null;
}

/** A name as plain comment text: no control characters, brackets or Markdown marks. */
function plainName(name: string | null | undefined): string | null {
  const clean = (name ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/[[\]()<>*_`~\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return clean || null;
}

const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@]+$/.test(s);

/** "Name (email)", "Name" or "email": an Airtable person who isn't a member. */
export function airtablePerson(p: { name?: string | null; email?: string | null }): string {
  const name = plainName(p.name);
  const email = p.email && looksLikeEmail(p.email.trim()) ? p.email.trim().slice(0, 320) : null;
  if (name && email) return `${name} (${email})`;
  return name ?? email ?? 'Someone on Airtable';
}

/** Airtable's mention syntax: `@[usr…]`, `@[ugp…]` (a group), or `@[email]`. */
const AIRTABLE_MENTION = /@\[([^[\]\n]{1,320})\]/g;

/** One comment, ready to insert. */
export interface ImportedComment {
  authorId: string | null;
  body: string;
  mentions: string[];
  createdAt: Date;
  editedAt: Date | null;
  reply: boolean;
  reactions: { userId: string; reaction: CommentReaction }[];
}

/** What translating a comment noticed, for the report. */
export interface CommentNotes {
  unmatchedAuthor: string | null;
  plainMentions: number;
  otherReactions: number;
  unmatchedReactions: number;
  attachments: string[];
  truncated: boolean;
}

const date = (raw: string | null | undefined): Date | null => {
  const t = raw ? Date.parse(raw) : Number.NaN;
  return Number.isNaN(t) ? null : new Date(t);
};

/** `body` cut to fit MAX_COMMENT_LENGTH with an ellipsis, never inside a mention token. */
function cut(body: string): string {
  let limit = MAX_COMMENT_LENGTH - 1;
  for (;;) {
    const head = body
      .slice(0, limit)
      .replace(/@\[[^\]\n]*(?:\]\([^)\n]*)?$/, '')
      .trimEnd();
    const out = sanitizeComment(`${head}…`);
    if (out.length <= MAX_COMMENT_LENGTH || limit <= 100) return out.slice(0, MAX_COMMENT_LENGTH);
    limit -= Math.max(100, out.length - MAX_COMMENT_LENGTH);
  }
}

/**
 * An Airtable comment as ours, or `comment: null` when nothing is left of its text. `people`
 * are workspace members by lower-cased email.
 */
export function translateComment(
  c: AirtableComment,
  people: ReadonlyMap<string, string>
): { comment: ImportedComment | null; notes: CommentNotes } {
  const member = (email: string | null | undefined) =>
    email ? people.get(email.trim().toLowerCase()) : undefined;
  const notes: CommentNotes = {
    unmatchedAuthor: null,
    plainMentions: 0,
    otherReactions: 0,
    unmatchedReactions: 0,
    attachments: (c.attachments ?? []).map((a) => a.filename),
    truncated: false,
  };
  const mentioned = Object.entries(c.mentioned ?? {});
  const used = new Set<string>();
  const text = c.text.replace(AIRTABLE_MENTION, (_m, key: string) => {
    const entry =
      c.mentioned?.[key] ?? mentioned.find(([, v]) => v.id === key || v.email === key)?.[1];
    const email = entry
      ? entry.type === 'user'
        ? entry.email
        : null
      : looksLikeEmail(key)
        ? key
        : null;
    const userId = member(email);
    const name = plainName(entry?.displayName ?? entry?.name) ?? plainName(email);
    if (userId && (used.has(userId) || used.size < MAX_COMMENT_MENTIONS)) {
      used.add(userId);
      return mentionToken(userId, name ?? 'user');
    }
    notes.plainMentions++;
    return `@${name ?? 'someone'}`;
  });
  const reactions: ImportedComment['reactions'] = [];
  const seen = new Set<string>();
  for (const r of c.reactions ?? []) {
    const reaction = reactionOf(r.emoji.unicodeCharacter);
    if (!reaction) {
      notes.otherReactions++;
      continue;
    }
    const userId = member(r.reactingUser.email);
    if (!userId) {
      notes.unmatchedReactions++;
      continue;
    }
    if (seen.has(`${userId}:${reaction}`)) continue;
    seen.add(`${userId}:${reaction}`);
    reactions.push({ userId, reaction });
  }
  if (!sanitizeComment(text)) return { comment: null, notes };
  const authorId = member(c.author.email) ?? null;
  if (!authorId) notes.unmatchedAuthor = airtablePerson(c.author);
  const prefix = authorId ? '' : `**${notes.unmatchedAuthor}**:\n\n`;
  let body = sanitizeComment(prefix + text);
  // Only the tokens written above: anything else that reads as one is plain text.
  const stray = commentMentions(body).filter((id) => !used.has(id));
  if (stray.length) {
    body = sanitizeComment(
      mapMentionTokens(body, (id, label) => (used.has(id) ? mentionToken(id, label) : `@${label}`))
    );
  }
  if (body.length > MAX_COMMENT_LENGTH) {
    body = cut(body);
    notes.truncated = true;
  }
  const createdAt = date(c.createdTime) ?? new Date();
  return {
    comment: {
      authorId,
      body,
      mentions: commentMentions(body).filter((id) => used.has(id)),
      createdAt,
      editedAt: date(c.lastUpdatedTime),
      reply: Boolean(c.parentCommentId),
      reactions,
    },
    notes,
  };
}

export type RecordCommentsRead =
  | { status: 'ok'; comments: AirtableComment[]; more: boolean }
  | { status: 'forbidden' | 'missing' };

/**
 * A record's comments, newest first, up to MAX_COMMENTS_PER_RECORD (`more` when Airtable has
 * others). Throws the client's errors (AppError) as they are.
 */
export async function readRecordComments(
  airtable: AirtableClient,
  baseId: string,
  tableId: string,
  recordId: string
): Promise<RecordCommentsRead> {
  const out: AirtableComment[] = [];
  const ids = new Set<string>();
  let offset: string | undefined;
  for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
    const res = await airtable.comments(baseId, tableId, recordId, offset);
    if (res.status !== 'ok') return res;
    for (const c of res.comments) {
      if (ids.has(c.id)) continue;
      ids.add(c.id);
      out.push(c);
    }
    if (!res.offset) return { status: 'ok', comments: out, more: false };
    offset = res.offset;
  }
  return { status: 'ok', comments: out, more: true };
}

/** What became of reading one record's comments, for the pass's bookkeeping. */
export type CommentReadOutcome = 'read' | 'forbidden' | 'missing' | 'failed' | 'rejected';

/** Sorts a client error from reading comments: 401 ends the pass, the rest skip a record. */
export function readFailure(err: unknown): CommentReadOutcome {
  if (!(err instanceof AppError)) throw err;
  // The client's 401: Airtable rejected the token.
  return err.code === 'VALIDATION_FAILED' ? 'rejected' : 'failed';
}

/**
 * Writes one record's Airtable comments (newest first, as read) into its thread, oldest first,
 * within what the record still holds, and adds to the report. No outbox events, no
 * notifications. Returns the number of comments written.
 */
export async function writeRecordComments(
  tx: Transaction,
  target: { workspaceId: string; baseId: string; tableId: string; recordId: string },
  table: string,
  read: { comments: AirtableComment[]; more: boolean },
  people: ReadonlyMap<string, string>,
  report: AirtableCommentsReport
): Promise<number> {
  if (!read.comments.length) return 0;
  // The record's writers take this lock too (createComment), so the cap holds.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`comments:${target.recordId}`}, 0))`
  );
  const [existing] = await tx
    .select({ n: count() })
    .from(recordComments)
    .where(
      and(
        eq(recordComments.tableId, target.tableId),
        eq(recordComments.recordId, target.recordId),
        isNull(recordComments.deletedAt)
      )
    );
  const room = Math.max(0, MAX_COMMENTS_PER_RECORD - (existing?.n ?? 0));
  if (read.more || read.comments.length > room) report.cappedRecords++;
  const kept: ImportedComment[] = [];
  for (const c of read.comments.slice(0, room)) {
    const { comment, notes } = translateComment(c, people);
    for (const filename of notes.attachments) capped(report.attachments, { table, filename });
    report.otherReactions += notes.otherReactions;
    report.unmatchedReactions += notes.unmatchedReactions;
    if (!comment) {
      report.emptyComments++;
      continue;
    }
    report.plainMentions += notes.plainMentions;
    if (notes.truncated) report.truncatedComments++;
    if (notes.unmatchedAuthor) {
      report.unmatchedAuthorComments++;
      if (!report.unmatchedAuthors.includes(notes.unmatchedAuthor)) {
        capped(report.unmatchedAuthors, notes.unmatchedAuthor);
      }
    }
    if (comment.reply) report.replies++;
    kept.push(comment);
  }
  if (!kept.length) return 0;
  kept.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  // Ids in time order, so comments with the same time keep their order.
  const ids = kept.map(() => uuidv7());
  await tx.insert(recordComments).values(
    kept.map((c, i) => ({
      id: ids[i],
      workspaceId: target.workspaceId,
      baseId: target.baseId,
      tableId: target.tableId,
      recordId: target.recordId,
      authorId: c.authorId,
      body: c.body,
      mentions: c.mentions,
      createdAt: c.createdAt,
      editedAt: c.editedAt,
    }))
  );
  const reactions = kept.flatMap((c, i) =>
    c.reactions.map((r) => ({
      workspaceId: target.workspaceId,
      commentId: ids[i] as string,
      userId: r.userId,
      reaction: r.reaction,
      createdAt: c.createdAt,
    }))
  );
  for (let i = 0; i < reactions.length; i += 1000) {
    await tx
      .insert(recordCommentReactions)
      .values(reactions.slice(i, i + 1000))
      .onConflictDoNothing();
  }
  report.imported += kept.length;
  report.reactions += reactions.length;
  return kept.length;
}
