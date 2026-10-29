import { parseMarkdown, sanitizeMarkdown } from '@openrows/shared';
import { Editor, type JSONContent } from '@tiptap/core';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { richTextExtensions } from './extensions';
import { docToMarkdown, markdownToDoc } from './markdown-doc';

// One headless editor with the real schema: a document goes through it as it would when the
// user opens the editor, so the schema's normalization is part of every round trip.
const editor = new Editor({ extensions: richTextExtensions(), element: null });
afterAll(() => editor.destroy());

/** The text of inline code and code blocks in a document. */
function codeTexts(node: JSONContent): string[] {
  const own =
    node.type === 'codeBlock' || node.marks?.some((m) => m.type === 'code')
      ? [node.text ?? '']
      : [];
  return [...own, ...(node.content ?? []).flatMap(codeTexts)];
}

/** Markdown → editor → Markdown. */
function throughEditor(markdown: string): string {
  editor.commands.setContent(markdownToDoc(markdown), { emitUpdate: false });
  return docToMarkdown(editor.getJSON());
}

// ---- generated documents in the subset -----------------------------------------------------

const CHARS = 'ab Z09#>-+.*_~`[]()<>\\:!/hpst@'.split('');
const text = fc
  .array(fc.constantFrom(...CHARS), { minLength: 1, maxLength: 8 })
  .map((a) => a.join(''));
const href = fc.constantFrom(
  'https://openrows.io',
  'https://x.io/a_(b)',
  'http://e.com/~u*v',
  'mailto:kevin@example.com'
);
const markSet = fc
  .record({
    bold: fc.boolean(),
    italic: fc.boolean(),
    strike: fc.boolean(),
    code: fc.boolean(),
    link: fc.option(href, { nil: undefined }),
  })
  .map((m) => {
    const marks: NonNullable<JSONContent['marks']> = [];
    if (m.link) marks.push({ type: 'link', attrs: { href: m.link } });
    if (m.code) return [...marks, { type: 'code' }];
    if (m.bold) marks.push({ type: 'bold' });
    if (m.italic) marks.push({ type: 'italic' });
    if (m.strike) marks.push({ type: 'strike' });
    return marks;
  });
const inline = fc.array(
  fc.oneof(
    {
      weight: 6,
      arbitrary: fc.record({ text, marks: markSet }).map((t) => ({ type: 'text', ...t })),
    },
    { weight: 1, arbitrary: fc.constant({ type: 'hardBreak' }) }
  ),
  { minLength: 1, maxLength: 6 }
);
const para = inline.map((content) => ({ type: 'paragraph', content }));
const block: fc.Arbitrary<JSONContent> = fc.oneof(
  para,
  fc
    .record({ level: fc.constantFrom(1, 2, 3), content: inline })
    .map(({ level, content }) => ({ type: 'heading', attrs: { level }, content })),
  fc
    .array(para, { minLength: 1, maxLength: 2 })
    .map((content) => ({ type: 'blockquote', content })),
  fc
    .array(fc.constantFrom('a', ' ', '`', '\n', '*', '```', '<b>'), { maxLength: 6 })
    .map((a) => a.join(''))
    .map((t) => ({
      type: 'codeBlock',
      attrs: { language: null },
      ...(t ? { content: [{ type: 'text', text: t }] } : {}),
    })),
  fc.constantFrom('bulletList', 'orderedList').chain((type) =>
    fc.array(para, { minLength: 1, maxLength: 3 }).map((ps) => ({
      type,
      content: ps.map((p) => ({ type: 'listItem', content: [p] })),
    }))
  ),
  fc.array(fc.tuple(fc.boolean(), para), { minLength: 1, maxLength: 3 }).map((items) => ({
    type: 'taskList',
    content: items.map(([checked, p]) => ({ type: 'taskItem', attrs: { checked }, content: [p] })),
  }))
);
const doc = fc
  .array(block, { minLength: 1, maxLength: 5 })
  .map((content) => ({ type: 'doc', content }));

describe('rich text Markdown through the editor', () => {
  it('is stable: Markdown → editor → Markdown gives the same Markdown', () => {
    fc.assert(
      fc.property(doc, (d) => {
        editor.commands.setContent(d, { emitUpdate: false });
        const markdown = docToMarkdown(editor.getJSON());
        expect(throughEditor(markdown)).toBe(markdown);
      }),
      { numRuns: 1000 }
    );
  });

  it('writes Markdown the server keeps as it is', () => {
    fc.assert(
      fc.property(doc, (d) => {
        editor.commands.setContent(d, { emitUpdate: false });
        const markdown = docToMarkdown(editor.getJSON());
        // The sanitizer doesn't know code: tag-shaped text (`<b>`), image syntax (`![`) and
        // unsafe link ends (`](x)`) go wherever they are.
        const code = codeTexts(editor.getJSON()).join('\n');
        fc.pre(!/[<!\]]/.test(code) && !/<[A-Za-z/!?]/.test(markdown));
        expect(sanitizeMarkdown(markdown)).toBe(markdown);
      }),
      { numRuns: 300 }
    );
  });

  it('settles any Markdown after one pass', () => {
    const md = fc
      .array(
        fc.constantFrom(...CHARS, '\n', '\n\n', '- ', '1. ', '> ', '## ', '- [x] ', '**', '```\n'),
        {
          maxLength: 30,
        }
      )
      .map((a) => a.join(''));
    fc.assert(
      fc.property(md, (source) => {
        const once = throughEditor(source);
        expect(throughEditor(once)).toBe(once);
      }),
      { numRuns: 1000 }
    );
  });

  it('reads and writes each construct of the subset', () => {
    const md = [
      '# Title',
      'Some **bold**, *italic*, ~~gone~~, `code` and [a link](https://openrows.io).',
      '**bold *and italic* inside** and ***both***',
      '- one\n- two',
      '1. first\n2. second',
      '- [ ] todo\n- [x] done',
      '> a quote\n> on two lines',
      '```\nconst a = 1;\n```',
    ].join('\n\n');
    expect(throughEditor(md)).toBe(md);
    const tree = parseMarkdown(throughEditor(md));
    expect(tree.map((b) => b.kind)).toEqual([
      'heading',
      'paragraph',
      'paragraph',
      'list',
      'list',
      'list',
      'quote',
      'code',
    ]);
  });

  it('escapes text that would read as Markdown', () => {
    const literal = '# not a heading, *not italic*, [no](link) and https://not.a/link';
    const markdown = docToMarkdown({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: literal }] }],
    });
    expect(markdown).toBe(
      '\\# not a heading, \\*not italic\\*, \\[no\\](link) and https\\://not.a/link'
    );
    expect(parseMarkdown(markdown)).toEqual([
      { kind: 'paragraph', children: [{ kind: 'text', text: literal }] },
    ]);
  });

  it('never writes an unsafe link', () => {
    const markdown = docToMarkdown({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'bad',
              marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
            },
            {
              type: 'text',
              text: ' good',
              marks: [{ type: 'link', attrs: { href: 'https://x.io' } }],
            },
          ],
        },
      ],
    });
    expect(markdown).toBe('bad [good](https://x.io)');
  });
});
