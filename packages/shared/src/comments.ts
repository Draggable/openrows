import {
  type MarkdownBlock,
  type MarkdownInline,
  parseMarkdown,
  sanitizeMarkdown,
} from './fields/markdown.js';
import { stripControlChars } from './fields/util.js';

/**
 * Record comment bodies: rich text Markdown (the same allow-list as rich text fields,
 * `sanitizeMarkdown`) plus mention tokens `@[name](user:<id>)`. The server sanitizes a body on
 * write and checks that every mentioned user can read the base; clients render `parseComment`'s
 * tree with plain elements, never as HTML, and show a mention by the directory's name for the id.
 */

/** The longest comment body, in characters. */
export const MAX_COMMENT_LENGTH = 10_000;
/** The most people one comment can mention. */
export const MAX_COMMENT_MENTIONS = 50;
/** The most live comments one record holds. */
export const MAX_COMMENTS_PER_RECORD = 1_000;
/** The longest label of a mention token. */
const MAX_MENTION_LABEL = 100;

/** The reactions a comment takes, by stable key, with the emoji each one shows. */
export const COMMENT_REACTIONS = {
  thumbsUp: '👍',
  heart: '❤️',
  laugh: '😄',
  tada: '🎉',
  eyes: '👀',
  check: '✅',
} as const;

export type CommentReaction = keyof typeof COMMENT_REACTIONS;

export const COMMENT_REACTION_KEYS = Object.keys(COMMENT_REACTIONS) as [
  CommentReaction,
  ...CommentReaction[],
];

const MENTION_RE =
  /@\[([^[\]\n]{1,100})\]\(user:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)/g;
/** Private-use characters that stand in for mention tokens while the Markdown is processed. */
const SENTINEL_RE = /[]/g;
const PLACEHOLDER_RE = /(\d+)/g;

interface MentionToken {
  userId: string;
  label: string;
}

/** A mention's label as plain text: no brackets, parentheses, angle brackets or line breaks. */
function cleanLabel(label: string): string {
  const clean = stripControlChars(label)
    .replace(/[[\]()<>\n\r\t]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MENTION_LABEL);
  return clean || 'user';
}

/** The token for a mention of `userId`, shown as `label` until the directory names them. */
export function mentionToken(userId: string, label: string): string {
  return `@[${cleanLabel(label)}](user:${userId.toLowerCase()})`;
}

/** The body with each mention token swapped for a placeholder the Markdown code leaves alone. */
function protect(body: string): { text: string; tokens: MentionToken[] } {
  const tokens: MentionToken[] = [];
  const text = body
    .replace(SENTINEL_RE, '')
    .replace(MENTION_RE, (_m, label: string, id: string) => {
      tokens.push({ userId: id.toLowerCase(), label: cleanLabel(label) });
      return `${tokens.length - 1}`;
    });
  return { text, tokens };
}

function restore(text: string, tokens: readonly MentionToken[]): string {
  return text.replace(PLACEHOLDER_RE, (_m, i: string) => {
    const token = tokens[Number(i)];
    return token ? mentionToken(token.userId, token.label) : '';
  });
}

/**
 * A comment body as stored: allow-listed Markdown (`sanitizeMarkdown`: no HTML, only safe
 * links), mention tokens kept with clean labels, trimmed. Idempotent.
 */
export function sanitizeComment(body: string): string {
  const { text, tokens } = protect(body);
  return restore(sanitizeMarkdown(text), tokens).trim();
}

/** Text with its placeholders as mention nodes. */
function splitMentions(text: string, tokens: readonly MentionToken[]): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  let last = 0;
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    const token = tokens[Number(m[1])];
    if (token) out.push({ kind: 'mention', userId: token.userId, label: token.label });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/**
 * A comment body as a tree for display: `parseMarkdown`'s blocks, with `mention` nodes for the
 * mention tokens outside code (in code they stay literal text).
 */
export function parseComment(body: string): MarkdownBlock[] {
  const { text, tokens } = protect(body);
  const inline = (nodes: MarkdownInline[]): MarkdownInline[] =>
    nodes.flatMap((n): MarkdownInline[] => {
      switch (n.kind) {
        case 'text':
          return splitMentions(n.text, tokens);
        case 'code':
          return [{ kind: 'code', text: restore(n.text, tokens) }];
        case 'link':
          return [{ kind: 'link', href: restore(n.href, tokens), children: inline(n.children) }];
        case 'bold':
        case 'italic':
        case 'strike':
          return [{ kind: n.kind, children: inline(n.children) }];
        default:
          return [n];
      }
    });
  return parseMarkdown(text).map((b): MarkdownBlock => {
    switch (b.kind) {
      case 'code':
        return { kind: 'code', text: restore(b.text, tokens) };
      case 'list':
        return {
          ...b,
          items: b.items.map((it) => ({ ...it, children: inline(it.children) })),
        };
      default:
        return { ...b, children: inline(b.children) };
    }
  });
}

/** The user ids a body mentions (outside code), in order of first mention, without repeats. */
export function commentMentions(body: string): string[] {
  const ids = new Set<string>();
  const walk = (nodes: MarkdownInline[]) => {
    for (const n of nodes) {
      if (n.kind === 'mention') ids.add(n.userId);
      else if ('children' in n) walk(n.children);
    }
  };
  for (const b of parseComment(body)) {
    if (b.kind === 'list') for (const it of b.items) walk(it.children);
    else if (b.kind !== 'code') walk(b.children);
  }
  return [...ids];
}

/** The body with each mention token replaced by `fn`'s text (the editor shows `@Name`). */
export function mapMentionTokens(body: string, fn: (userId: string, label: string) => string) {
  return body.replace(MENTION_RE, (_m, label: string, id: string) =>
    fn(id.toLowerCase(), cleanLabel(label))
  );
}

/** The longest comment excerpt notifications show. */
export const COMMENT_EXCERPT_LENGTH = 200;

/**
 * A comment body as one line of plain text, for notifications: no Markdown, mentions as
 * `@Name`, whitespace collapsed, cut to `max` characters with an ellipsis.
 */
export function commentExcerpt(body: string, max = COMMENT_EXCERPT_LENGTH): string {
  const inline = (nodes: MarkdownInline[]): string =>
    nodes
      .map((n) => {
        if (n.kind === 'mention') return `@${n.label}`;
        if ('children' in n) return inline(n.children);
        return n.text;
      })
      .join('');
  const text = parseComment(body)
    .map((b) => {
      if (b.kind === 'code') return b.text;
      if (b.kind === 'list') return b.items.map((it) => inline(it.children)).join(' ');
      return inline(b.children);
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
