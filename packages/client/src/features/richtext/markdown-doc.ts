import {
  isSafeLinkUrl,
  type MarkdownBlock,
  type MarkdownInline,
  parseMarkdown,
} from '@openrows/shared';
import type { JSONContent } from '@tiptap/core';

/**
 * and
 * nothing else: `markdownToDoc` builds the editor's document from the shared parser's tree (what
 * the cells and the record view render), and `docToMarkdown` writes a document back as Markdown
 * that parser reads into the same document. Marks the subset lacks, unsafe links and blocks it
 * can't hold never make it out; the server sanitizes what it stores either way.
 */

type Mark = NonNullable<JSONContent['marks']>[number];

// ---- Markdown → document -------------------------------------------------------------------

function inlineToDoc(nodes: MarkdownInline[], marks: Mark[] = []): JSONContent[] {
  const withMark = (mark: Mark) => [...marks.filter((m) => m.type !== mark.type), mark];
  const text = (t: string, m: Mark[]): JSONContent[] =>
    t
      .split('\n')
      .flatMap((part, i): JSONContent[] => [
        ...(i > 0 ? [{ type: 'hardBreak' }] : []),
        ...(part
          ? [m.length ? { type: 'text', text: part, marks: m } : { type: 'text', text: part }]
          : []),
      ]);
  return nodes.flatMap((n): JSONContent[] => {
    switch (n.kind) {
      case 'text':
        return text(n.text, marks);
      case 'code':
        return text(n.text, withMark({ type: 'code' }));
      case 'bold':
      case 'italic':
      case 'strike':
        return inlineToDoc(n.children, withMark({ type: n.kind }));
      case 'link':
        return inlineToDoc(n.children, withMark({ type: 'link', attrs: { href: n.href } }));
      case 'mention':
        return text(`@${n.label}`, marks);
      default:
        return [];
    }
  });
}

const withContent = (node: JSONContent, content: JSONContent[]): JSONContent =>
  content.length ? { ...node, content } : node;

const paragraph = (children: MarkdownInline[]) =>
  withContent({ type: 'paragraph' }, inlineToDoc(children));

function blockToDoc(block: MarkdownBlock): JSONContent[] {
  switch (block.kind) {
    case 'heading':
      return [
        withContent(
          { type: 'heading', attrs: { level: block.level } },
          inlineToDoc(block.children)
        ),
      ];
    case 'quote':
      return [{ type: 'blockquote', content: [paragraph(block.children)] }];
    case 'code':
      return [
        withContent(
          { type: 'codeBlock', attrs: { language: null } },
          block.text ? [{ type: 'text', text: block.text }] : []
        ),
      ];
    case 'list': {
      // Consecutive items of one kind make one list: check items a task list, the rest a bulleted
      // or numbered list (a numbered checklist is a checklist).
      const lists: JSONContent[] = [];
      for (const item of block.items) {
        const task = item.checked !== null;
        const type = task ? 'taskList' : block.ordered ? 'orderedList' : 'bulletList';
        const entry: JSONContent = task
          ? {
              type: 'taskItem',
              attrs: { checked: item.checked },
              content: [paragraph(item.children)],
            }
          : { type: 'listItem', content: [paragraph(item.children)] };
        const last = lists[lists.length - 1];
        if (last?.type === type) last.content?.push(entry);
        else lists.push({ type, content: [entry] });
      }
      return lists;
    }
    default:
      return [paragraph(block.children)];
  }
}

/** The editor document for rich text Markdown. */
export function markdownToDoc(markdown: string): JSONContent {
  const content = parseMarkdown(markdown).flatMap(blockToDoc);
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

// ---- document → Markdown -------------------------------------------------------------------

/** Marks from the outside in; code is innermost because it holds no other mark. */
const MARK_ORDER = ['link', 'bold', 'italic', 'strike', 'code'] as const;
type MarkType = (typeof MARK_ORDER)[number];

interface OpenMark {
  type: MarkType;
  href?: string;
  /** The delimiter the mark was opened with (bold is `__` right after an italic closes). */
  delimiter: string;
}

type Segment = { text: string; marks: OpenMark[] } | { break: true };

const sameMark = (a: OpenMark, b: OpenMark) => a.type === b.type && a.href === b.href;

/** A text node's marks the subset has, outside in; unsafe links and impossible code dropped. */
function marksOf(node: JSONContent): OpenMark[] {
  const marks: OpenMark[] = [];
  for (const type of MARK_ORDER) {
    const mark = node.marks?.find((m) => m.type === type);
    if (!mark) continue;
    if (type === 'link') {
      const href = mark.attrs?.['href'];
      if (typeof href === 'string' && isSafeLinkUrl(href))
        marks.push({ type, href, delimiter: '[' });
    } else if (type !== 'code' || !node.text?.includes('`')) marks.push({ type, delimiter: '' });
  }
  return marks;
}

const intersect = (a: OpenMark[], b: OpenMark[]) => a.filter((m) => b.some((n) => sameMark(m, n)));

/**
 * Inline nodes as segments, with whitespace at the edges of a mark moved outside it (`** a**`
 * isn't bold in the parser, and `* a*` at a line start would be a list item). Code keeps its
 * spaces.
 */
function segments(nodes: JSONContent[]): Segment[] {
  let segs: Segment[] = nodes.flatMap((n): Segment[] => {
    if (n.type === 'hardBreak') return [{ break: true }];
    if (n.type === 'text' && n.text) return [{ text: n.text, marks: marksOf(n) }];
    return [];
  });
  // Moving whitespace changes the neighbours' edges, so it repeats until nothing moves.
  for (let round = 0; round < 8; round++) {
    const next = merge(expel(segs));
    if (JSON.stringify(next) === JSON.stringify(segs)) break;
    segs = next;
  }
  return segs;
}

/** One pass of moving the whitespace at a mark's edges outside it. */
function expel(segs: Segment[]): Segment[] {
  const marksAt = (i: number) => {
    const s = segs[i];
    return s && 'text' in s ? s.marks : [];
  };
  return segs.flatMap((seg, i): Segment[] => {
    if (!('text' in seg) || seg.marks.some((m) => m.type === 'code')) return [seg];
    const lead = /^\s*/.exec(seg.text)?.[0] ?? '';
    const core = seg.text.slice(lead.length).trimEnd();
    const trail = seg.text.slice(lead.length + core.length);
    const before = intersect(seg.marks, marksAt(i - 1));
    const after = intersect(seg.marks, marksAt(i + 1));
    if (!core) return [{ text: seg.text, marks: intersect(before, after) }];
    return [
      ...(lead ? [{ text: lead, marks: before }] : []),
      { text: core, marks: seg.marks },
      ...(trail ? [{ text: trail, marks: after }] : []),
    ];
  });
}

/** Neighbouring text with the same marks as one segment. */
function merge(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const seg of segs) {
    const last = out[out.length - 1];
    if (
      last &&
      'text' in last &&
      'text' in seg &&
      last.marks.length === seg.marks.length &&
      last.marks.every((m, i) => {
        const other = seg.marks[i];
        return other !== undefined && sameMark(m, other);
      })
    )
      out[out.length - 1] = { text: last.text + seg.text, marks: last.marks };
    else out.push(seg);
  }
  return out;
}

/**
 * Text with everything the inline parser would read as Markdown escaped (`!` too: `![` is an
 * image to the sanitizer). `<` is escaped only before `mailto:` (an autolink; `http` ones are
 * broken by the escaped colon): tag-shaped text is removed by the server's sanitizer whatever
 * precedes it, as raw HTML never stays.
 */
const escapeText = (text: string) =>
  text
    .replace(/[\\`*_~[\]!]/g, '\\$&')
    .replace(/<(?=mailto:)/g, '\\<')
    .replace(/(https?):(?=\/\/)/g, '$1\\:');

const encodeHref = (href: string) => href.replace(/\(/g, '%28').replace(/\)/g, '%29');

/** Inline content as Markdown lines (hard breaks split lines; marks never span one). */
function inlineToLines(nodes: JSONContent[]): string[] {
  const lines: string[] = [];
  let line = '';
  let stack: OpenMark[] = [];
  let justClosedItalic = false;
  const close = (mark: OpenMark) => {
    line += mark.type === 'link' ? `](${encodeHref(mark.href ?? '')})` : mark.delimiter;
    justClosedItalic = mark.type === 'italic';
  };
  const closeFrom = (keep: number) => {
    for (const mark of stack.slice(keep).reverse()) close(mark);
    stack = stack.slice(0, keep);
  };
  const open = (mark: OpenMark) => {
    const delimiter =
      mark.type === 'link'
        ? '['
        : mark.type === 'bold'
          ? justClosedItalic
            ? '__'
            : '**'
          : mark.type === 'italic'
            ? '*'
            : mark.type === 'strike'
              ? '~~'
              : '`';
    line += delimiter;
    justClosedItalic = false;
    stack.push({ ...mark, delimiter });
  };
  for (const seg of segments(nodes)) {
    if (!('text' in seg)) {
      closeFrom(0);
      lines.push(line);
      line = '';
      justClosedItalic = false;
      continue;
    }
    let keep = 0;
    while (keep < stack.length && keep < seg.marks.length) {
      const a = stack[keep];
      const b = seg.marks[keep];
      if (!a || !b || !sameMark(a, b)) break;
      keep++;
    }
    closeFrom(keep);
    for (const mark of seg.marks.slice(keep)) open(mark);
    line += seg.marks.some((m) => m.type === 'code') ? seg.text : escapeText(seg.text);
    justClosedItalic = false;
  }
  closeFrom(0);
  lines.push(line);
  return lines;
}

/** A paragraph line the block parser would read as a heading, quote or list item, escaped. */
const escapeLineStart = (line: string) =>
  line
    .replace(/^(\s{0,3})(#{1,3}\s|>|[-+]\s)/, '$1\\$2')
    .replace(/^(\s{0,3}\d{1,9})([.)]\s)/, '$1\\$2');

/** Inline content on one line (headings and list items): breaks become spaces. */
const oneLine = (nodes: JSONContent[] | undefined) =>
  inlineToLines(nodes ?? [])
    .join(' ')
    .trim();

const inlineOf = (node: JSONContent | undefined) =>
  (node?.content ?? []).flatMap((c) => (c.type === 'paragraph' ? (c.content ?? []) : []));

/** One block as Markdown, or null when it would be empty (an empty paragraph or heading). */
function blockToMarkdown(node: JSONContent): string | null {
  switch (node.type) {
    case 'heading': {
      const level = Math.min(3, Math.max(1, Number(node.attrs?.['level']) || 1));
      // A trailing run of `#` after a space would read as the closing sequence.
      const text = oneLine(node.content).replace(/(\s)(#+)$/, '$1\\$2');
      return text ? `${'#'.repeat(level)} ${text}` : null;
    }
    case 'blockquote': {
      const paragraphs = (node.content ?? []).map((p) =>
        p.type === 'paragraph' ? inlineToLines(p.content ?? []) : [oneLine(inlineOf(p))]
      );
      const lines = paragraphs.flatMap((p, i) => (i > 0 ? ['', ...p] : p));
      return lines.map((l) => `> ${l}`).join('\n');
    }
    case 'codeBlock': {
      const text = (node.content ?? []).map((c) => c.text ?? '').join('');
      // A line that would close the fence is indented out of reach.
      const body = text
        .split('\n')
        .map((l) => (/^\s{0,3}```/.test(l) ? `    ${l.trimStart()}` : l))
        .join('\n');
      return `\`\`\`\n${body}\n\`\`\``;
    }
    case 'bulletList':
    case 'orderedList':
    case 'taskList': {
      const items = (node.content ?? []).map((item, i) => {
        const marker =
          node.type === 'orderedList'
            ? `${i + 1}.`
            : node.type === 'taskList'
              ? `- [${item.attrs?.['checked'] ? 'x' : ' '}]`
              : '-';
        return `${marker} ${oneLine(inlineOf(item))}`;
      });
      return items.length ? items.join('\n') : null;
    }
    default: {
      // A paragraph; a line of only spaces would end it, so it splits there.
      const groups: string[][] = [[]];
      for (const l of inlineToLines(node.content ?? [])) {
        if (l.trim() === '') groups.push([]);
        else groups[groups.length - 1]?.push(escapeLineStart(l));
      }
      const text = groups
        .filter((g) => g.length)
        .map((g) => g.join('\n'))
        .join('\n\n');
      return text || null;
    }
  }
}

/** Lists the parser would join into one (both unordered, or both numbered) and quotes. */
function joinsWith(a: string | undefined, b: string | undefined): boolean {
  const unordered = (t?: string) => t === 'bulletList' || t === 'taskList';
  if (unordered(a) && unordered(b)) return true;
  return (a === 'orderedList' && b === 'orderedList') || (a === 'blockquote' && b === 'blockquote');
}

/** An editor document as rich text Markdown, in the subset `markdownToDoc` reads back. */
export function docToMarkdown(doc: JSONContent): string {
  // Numbered lists side by side are one list to the parser, so they are numbered as one.
  const blocks: JSONContent[] = [];
  // Empty blocks are left out first: what was on either side of one ends up side by side.
  for (const node of (doc.content ?? []).filter((n) => blockToMarkdown(n) !== null)) {
    const last = blocks[blocks.length - 1];
    if (node.type === 'orderedList' && last?.type === 'orderedList')
      blocks[blocks.length - 1] = {
        ...last,
        content: [...(last.content ?? []), ...(node.content ?? [])],
      };
    else blocks.push(node);
  }
  let out = '';
  let prev: string | undefined;
  for (const node of blocks) {
    const md = blockToMarkdown(node);
    if (md === null) continue;
    if (out)
      out += joinsWith(prev, node.type) ? (node.type === 'blockquote' ? '\n> \n' : '\n') : '\n\n';
    out += md;
    prev = node.type;
  }
  return out;
}
