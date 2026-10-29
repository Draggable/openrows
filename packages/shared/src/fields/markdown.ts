import { stripControlChars } from './util.js';

/**
 * Rich text (long text with `richText`) is Markdown, as in Airtable. The server sanitizes it
 * on write with an allow-list (`sanitizeMarkdown`, through the long text type's `coerce`), and
 * clients render it from `parseMarkdown`'s tree with plain elements, never as HTML.
 *
 * Allowed: paragraphs, headings (#–###), bullet, numbered and check lists, quotes, code blocks,
 * bold, italic, strikethrough, inline code and links to http(s) or mailto. Everything else is
 * text: HTML tags and comments are removed, images become their alt text and links to any other
 * scheme (`javascript:`, `data:`, `vbscript:`, ...) become their label.
 */

/** A link target a rich text may use: http(s) or mailto, spelled out (no entities, no `<`). */
export function isSafeLinkUrl(url: string): boolean {
  return /^(?:https?:\/\/[^\s<>"'`\\]+|mailto:[^\s<>"'`\\/:]+@[^\s<>"'`\\]+)$/i.test(url);
}

const TAG_RE = /<!--[\s\S]*?(?:-->|$)|<[!?][^<>]*>?|<\/?[A-Za-z][^<>]*>/g;
const AUTOLINK_RE = /^<([^<>\s]+)>$/;
// An escaped `\!` is text: what follows is a link (checked below), not an image.
const IMAGE_RE =
  /(?<!(?:^|[^\\])(?:\\\\)*\\)!\[([^[\]\n]*)\]\(([^()\n]*(?:\([^()\n]*\)[^()\n]*)*)\)/g;
// A label may hold backslash escapes (`\]`) and code spans, as the parser reads it; never a
// `[` (each scan stops at the next one, so `[[[[…` stays linear; `DEST_RE` covers the rest).
const LINK_RE =
  /\[((?:\\(?:[^\n]|$)|`[^`\n]+`|`(?![^`\n]+`)|[^[\]\\\n`])*)\]\(([^()\n]*(?:\([^()\n]*\)[^()\n]*)*)\)/g;
/**
 * Any `](destination)` whatever comes before it (nested brackets in a label), unless the
 * `]` is escaped (an odd run of backslashes before it), which no Markdown reads as a link.
 */
const DEST_RE = /(?<!(?:^|[^\\])(?:\\\\)*\\)\]\(([^()\n]*(?:\([^()\n]*\)[^()\n]*)*)\)/g;
const REF_DEF_RE = /^ {0,3}\[(?:\\[^\n]|[^\]\\\n])+\]:[ \t]*(\S+).*$/gm;

/** The destination of `(url "title")`: the url part. */
const destination = (inner: string) => inner.trim().split(/\s+/)[0] ?? '';

function sanitizeOnce(text: string): string {
  return (
    // Control characters (but tabs and new lines) have no business in text.
    stripControlChars(text)
      // Tags and comments go; autolinks to a safe URL stay.
      .replace(TAG_RE, (tag) => {
        const auto = AUTOLINK_RE.exec(tag);
        return auto?.[1] && isSafeLinkUrl(auto[1]) ? tag : '';
      })
      .replace(IMAGE_RE, (_m, alt: string) => alt)
      .replace(LINK_RE, (m, label: string, inner: string) =>
        isSafeLinkUrl(destination(inner)) ? m : label
      )
      // CommonMark also reads `[a [b] c](dest)` as a link: an unsafe destination goes wherever
      // it is, so no Markdown renderer ever sees one.
      .replace(DEST_RE, (m, inner: string) => (isSafeLinkUrl(destination(inner)) ? m : ']'))
      .replace(REF_DEF_RE, (m, url: string) => (isSafeLinkUrl(url) ? m : ''))
  );
}

/** Rich text with only allow-listed Markdown. Idempotent (repeats until nothing changes). */
export function sanitizeMarkdown(text: string): string {
  let current = text;
  for (let i = 0; i < 20; i++) {
    const next = sanitizeOnce(current);
    if (next === current) return next;
    current = next;
  }
  // A pathological input that keeps rebuilding tags: drop every `<`.
  return sanitizeOnce(current.replace(/</g, ''));
}

// ---- parsing for display ------------------------------------------------------------------

export type MarkdownInline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'bold' | 'italic' | 'strike'; children: MarkdownInline[] }
  | { kind: 'link'; href: string; children: MarkdownInline[] }
  /** An @mention in a comment (`parseComment`); rich text never has one. */
  | { kind: 'mention'; userId: string; label: string };

export type MarkdownBlock =
  | { kind: 'paragraph'; children: MarkdownInline[] }
  | { kind: 'heading'; level: 1 | 2 | 3; children: MarkdownInline[] }
  | { kind: 'quote'; children: MarkdownInline[] }
  | { kind: 'code'; text: string }
  | {
      kind: 'list';
      ordered: boolean;
      items: { checked: boolean | null; children: MarkdownInline[] }[];
    };

// The inline grammar, built from parts so marks nest the way the WYSIWYG editor writes them
// : `**a *b* c**`, `*a **b** c*`, `***both***`, marks inside links and links inside marks.
// Backslash escapes (`\*`, CommonMark's ASCII punctuation) are literal text everywhere.
const ESCAPE = String.raw`\\([!-\/:-@\[-\x60{-~])`;
// Every alternative below starts with a different character (a backslash, a backtick, a bracket,
// the delimiter, anything else), so a match that fails fails in linear time: no alternative
// can take what another one would, which is what makes nested quantifiers backtrack forever.
const CODE = String.raw`\x60[^\x60\n]+\x60`;
/** A backslash with something after it, or alone at the end. */
const SLASH = String.raw`\\(?:[^\n]|$)`;
/** A backtick that doesn't open a code span. */
const TICK = String.raw`\x60(?![^\x60\n]+\x60)`;
/** A link label; a bracket in one is escaped, so a scan for `](` stops at the next `[`. */
const LABEL = String.raw`(?:${SLASH}|${CODE}|${TICK}|[^[\]\\\n\x60])*`;
const DEST = String.raw`[^()\n]*(?:\([^()\n]*\)[^()\n]*)*`;
const LINK = String.raw`\[${LABEL}\]\(${DEST}\)`;
/** One escape, code span, link or lone bracket: units no delimiter can split. */
const UNIT = String.raw`${SLASH}|${CODE}|${TICK}|${LINK}|\[(?!${LABEL}\]\(${DEST}\))`;
/** Any other character but `stop`. */
const other = (stop: string) => String.raw`[^${stop}\\\n\x60\[]`;
const NO_STAR = `(?:${UNIT}|${other('*')})`;
const STAR_ITALIC = String.raw`\*${NO_STAR}+?\*`;
const STAR_BOLD = String.raw`\*\*${NO_STAR}+?\*\*`;
const INLINE_RE = new RegExp(
  [
    ESCAPE,
    String.raw`\x60([^\x60\n]+)\x60`,
    String.raw`\*\*((?:${UNIT}|${STAR_ITALIC}|${other('*')})+?)\*\*`,
    `__((?:${UNIT}|${other('_')})+?)__`,
    `~~((?:${UNIT}|${other('~')})+?)~~`,
    String.raw`\*((?:${UNIT}|${STAR_BOLD}|${other('*')})+?)\*(?!\*)`,
    String.raw`(?<![\p{L}\p{N}])_((?:${UNIT}|${other('_')})+?)_(?![\p{L}\p{N}])`,
    String.raw`\[(${LABEL})\]\((${DEST})\)`,
    String.raw`<((?:https?:\/\/|mailto:)[^<>\s]+)>`,
    String.raw`(https?:\/\/[^\s<>()\\]+[^\s<>().,;:!?'"\\])`,
  ].join('|'),
  'u'
);

/** Inline Markdown as a tree. Links are only ever safe URLs (`isSafeLinkUrl`). */
export function parseInline(text: string, depth = 0): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  let rest = text;
  const pushText = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last?.kind === 'text') last.text += t;
    else out.push({ kind: 'text', text: t });
  };
  while (rest) {
    const m = depth > 8 ? null : INLINE_RE.exec(rest);
    if (!m) {
      pushText(rest);
      break;
    }
    pushText(rest.slice(0, m.index));
    rest = rest.slice(m.index + m[0].length);
    const inner = (s: string) => parseInline(s, depth + 1);
    if (m[1] !== undefined) pushText(m[1]);
    else if (m[2] !== undefined) out.push({ kind: 'code', text: m[2] });
    else if (m[3] !== undefined || m[4] !== undefined)
      out.push({ kind: 'bold', children: inner(m[3] ?? m[4] ?? '') });
    else if (m[5] !== undefined) out.push({ kind: 'strike', children: inner(m[5]) });
    else if (m[6] !== undefined || m[7] !== undefined)
      out.push({ kind: 'italic', children: inner(m[6] ?? m[7] ?? '') });
    else if (m[8] !== undefined) {
      const href = destination(m[9] ?? '');
      if (isSafeLinkUrl(href)) out.push({ kind: 'link', href, children: inner(m[8]) });
      else for (const n of inner(m[8])) n.kind === 'text' ? pushText(n.text) : out.push(n);
    } else {
      const href = m[10] ?? m[11] ?? '';
      if (isSafeLinkUrl(href))
        out.push({ kind: 'link', href, children: [{ kind: 'text', text: href }] });
      else pushText(href);
    }
  }
  return out;
}

const LIST_RE = /^\s{0,3}(?:([-*+])|(\d{1,9})[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;

/** Block Markdown as a tree, for display. */
export function parseMarkdown(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length)
      blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join('\n')) });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s{0,3}```/.test(line)) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s{0,3}```/.test(lines[i] ?? '')) code.push(lines[i++] ?? '');
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    // A closing run of `#` needs a space before it (CommonMark): `## C#` is about C#.
    const heading = /^\s{0,3}(#{1,3})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (heading) {
      flush();
      const level = (heading[1]?.length ?? 1) as 1 | 2 | 3;
      blocks.push({ kind: 'heading', level, children: parseInline(heading[2] ?? '') });
      continue;
    }
    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      const prev = blocks[blocks.length - 1];
      const children = parseInline(quote[1] ?? '');
      if (prev?.kind === 'quote') prev.children.push({ kind: 'text', text: '\n' }, ...children);
      else blocks.push({ kind: 'quote', children });
      continue;
    }
    const item = LIST_RE.exec(line);
    if (item) {
      flush();
      const ordered = item[2] !== undefined;
      const checked = item[3] === undefined ? null : item[3] !== ' ';
      const entry = { checked, children: parseInline(item[4] ?? '') };
      const prev = blocks[blocks.length - 1];
      if (prev?.kind === 'list' && prev.ordered === ordered) prev.items.push(entry);
      else blocks.push({ kind: 'list', ordered, items: [entry] });
      continue;
    }
    if (line.trim() === '') flush();
    else paragraph.push(line);
  }
  flush();
  return blocks;
}

/** Rich text as plain text (search snippets, single-line cells): the Markdown marks removed. */
export function markdownToPlain(text: string): string {
  const inline = (nodes: MarkdownInline[]): string =>
    nodes
      .map((n) =>
        'children' in n ? inline(n.children) : n.kind === 'mention' ? `@${n.label}` : n.text
      )
      .join('');
  return parseMarkdown(text)
    .map((b) => {
      if (b.kind === 'code') return b.text;
      if (b.kind === 'list')
        return b.items
          .map(
            (it) => `${it.checked === null ? '' : it.checked ? '☑ ' : '☐ '}${inline(it.children)}`
          )
          .join('\n');
      return inline(b.children);
    })
    .join('\n');
}
