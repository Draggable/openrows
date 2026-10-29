import { describe, expect, it } from 'vitest';
import {
  isSafeLinkUrl,
  type MarkdownBlock,
  type MarkdownInline,
  markdownToPlain,
  parseMarkdown,
  sanitizeMarkdown,
} from './markdown.js';

/** Every link target in a parsed tree. */
function hrefs(blocks: MarkdownBlock[]): string[] {
  const out: string[] = [];
  const walk = (nodes: MarkdownInline[]) => {
    for (const n of nodes) {
      if (n.kind === 'link') out.push(n.href);
      if ('children' in n) walk(n.children);
    }
  };
  for (const b of blocks) {
    if (b.kind === 'list') for (const it of b.items) walk(it.children);
    else if (b.kind !== 'code') walk(b.children);
  }
  return out;
}

/** XSS payloads (OWASP filter-evasion cheat sheet and Markdown-specific vectors). */
const XSS_CORPUS = [
  '<script>alert(1)</script>',
  '<SCRIPT SRC=http://xss.rocks/xss.js></SCRIPT>',
  '<scr<script>ipt>alert(1)</scr</script>ipt>',
  '<img src=x onerror=alert(1)>',
  '<IMG SRC="javascript:alert(\'XSS\');">',
  '<svg/onload=alert(1)>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<a href="javascript:alert(1)">x</a>',
  '<body onload=alert(1)>',
  '<div style="background:url(javascript:alert(1))">',
  '<!--<script>alert(1)</script>-->',
  '<!-- unterminated <script>alert(1)',
  '<math><mi xlink:href="data:x,<script>alert(1)</script>">',
  '[click](javascript:alert(1))',
  '[click](JAVASCRIPT:alert(1))',
  '[click]( javascript:alert(1))',
  '[click](javascript&#58;alert(1))',
  '[click](jav&#x09;ascript:alert(1))',
  '[click](<javascript:alert(1)>)',
  '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '[click](vbscript:msgbox(1))',
  '[click](//evil.example)',
  '[click](javascript:alert(1) "title")',
  '![x](javascript:alert(1))',
  '![x](https://evil.example/pixel.gif)',
  '[ref]: javascript:alert(1)\n[click][ref]',
  '<javascript:alert(1)>',
  '<data:text/html,<script>alert(1)</script>>',
  '[a](https://ok.example)<style>*{display:none}</style>',
  'text\u0000<scr\u0000ipt>alert(1)</script>',
  '<form action=https://evil.example><input name=x></form>',
  '<object data="javascript:alert(1)">',
  '<embed src="data:image/svg+xml,<svg onload=alert(1)>">',
  '<details open ontoggle=alert(1)>',
  // CommonMark reads brackets inside a label, and an escaped bang doesn't hide a link.
  '[a [b] c](javascript:alert(1))',
  '[a\\](javascript:alert(1))',
  '\\![x](javascript:alert(1))',
  '[`]`](javascript:alert(1))',
  '[x]: javascript:alert(1)\n[\\]: javascript:alert(1)',
];

describe('sanitizeMarkdown', () => {
  it.each(XSS_CORPUS)('neutralizes %j', (payload) => {
    const clean = sanitizeMarkdown(payload);
    // No HTML tag survives, and no link points anywhere but http(s)/mailto.
    expect(clean).not.toMatch(/<\/?[a-z][^>]*>/i);
    // (An escaped `\]` closes nothing, so it is no link end.)
    expect(clean).not.toMatch(/(?<!\\)\]\(\s*(?!https?:\/\/|mailto:)[^)]/i);
    expect(clean).not.toMatch(/^\s*\[(?:\\.|[^\]\\])+\]:\s*(?!https?:\/\/|mailto:)/im);
    expect(clean.includes(String.fromCharCode(0))).toBe(false);
    for (const href of hrefs(parseMarkdown(clean))) expect(isSafeLinkUrl(href)).toBe(true);
    // Idempotent: sanitizing again changes nothing.
    expect(sanitizeMarkdown(clean)).toBe(clean);
  });

  it('keeps allow-listed Markdown as written', () => {
    const md = [
      '# Title',
      '## Sub',
      '**bold** *italic* _also_ ~~gone~~ `a < b` [site](https://openrows.io/a_(b)) <https://x.io>',
      '- one',
      '- [x] done',
      '1. first',
      '> quote',
      '```',
      'code',
      '```',
      '[mail](mailto:kevin@example.com)',
      '2 < 3 and 5 > 4',
    ].join('\n');
    expect(sanitizeMarkdown(md)).toBe(md);
  });

  it('turns unsafe links into their label and images into their alt text', () => {
    expect(sanitizeMarkdown('see [this](javascript:alert(1)) now')).toBe('see this now');
    expect(sanitizeMarkdown('![logo](https://x.io/a.png)')).toBe('logo');
  });
});

describe('sanitizeMarkdown and the WYSIWYG editor (#85)', () => {
  it('keeps escaped Markdown and escaped link ends as they are', () => {
    const md = '\\[no\\](link) \\*not italic\\* https\\://x.io \\![alt](https://x.io)';
    expect(sanitizeMarkdown(md)).toBe(md);
  });

  it('stays linear on pathological input', () => {
    const n = 100_000;
    for (const text of [
      '['.repeat(n),
      `**${'['.repeat(n)}`,
      `**${'`a'.repeat(n / 2)}`,
      `~~${'[`\\*_'.repeat(n / 5)}`,
      `__${'*a'.repeat(n / 2)}`,
      '![!['.repeat(n / 4),
      `${'\\'.repeat(n)}](javascript:x)`,
    ]) {
      const start = performance.now();
      parseMarkdown(text);
      sanitizeMarkdown(text);
      expect(performance.now() - start).toBeLessThan(1000);
    }
  });
});

describe('parseMarkdown', () => {
  it('reads backslash escapes as text', () => {
    expect(parseMarkdown('\\*a\\* \\[b\\](x) \\` \\\\ \\q')).toEqual([
      { kind: 'paragraph', children: [{ kind: 'text', text: '*a* [b](x) ` \\ \\q' }] },
    ]);
    expect(parseMarkdown('\\# a\n\\- b\n1\\. c').map((b) => b.kind)).toEqual(['paragraph']);
  });

  it('nests marks the way the editor writes them', () => {
    const [p] = parseMarkdown(
      '**a *b* c** *d **e** f* ***g*** [**h**](https://x.io) **[i](https://x.io)**'
    );
    const kinds = (nodes: MarkdownInline[]): unknown[] =>
      nodes.map((n) =>
        'children' in n ? { [n.kind]: kinds(n.children) } : n.kind === 'text' ? n.text : n.kind
      );
    expect(p && 'children' in p ? kinds(p.children) : null).toEqual([
      { bold: ['a ', { italic: ['b'] }, ' c'] },
      ' ',
      { italic: ['d ', { bold: ['e'] }, ' f'] },
      ' ',
      { bold: [{ italic: ['g'] }] },
      ' ',
      { link: [{ bold: ['h'] }] },
      ' ',
      { bold: [{ link: ['i'] }] },
    ]);
  });

  it('closes a heading only at a spaced run of #', () => {
    expect(parseMarkdown('## C#\n## Done ##')).toEqual([
      { kind: 'heading', level: 2, children: [{ kind: 'text', text: 'C#' }] },
      { kind: 'heading', level: 2, children: [{ kind: 'text', text: 'Done' }] },
    ]);
  });

  it('parses blocks and inline marks', () => {
    const tree = parseMarkdown(
      '# Hi\nSome **bold** and [a link](https://openrows.io).\n\n- [ ] todo\n- [x] done\n1. one'
    );
    expect(tree.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'list', 'list']);
    expect(tree[1]).toEqual({
      kind: 'paragraph',
      children: [
        { kind: 'text', text: 'Some ' },
        { kind: 'bold', children: [{ kind: 'text', text: 'bold' }] },
        { kind: 'text', text: ' and ' },
        { kind: 'link', href: 'https://openrows.io', children: [{ kind: 'text', text: 'a link' }] },
        { kind: 'text', text: '.' },
      ],
    });
    expect(tree[2]).toMatchObject({
      ordered: false,
      items: [{ checked: false }, { checked: true }],
    });
  });

  it('never yields an unsafe link, even from unsanitized text', () => {
    for (const payload of XSS_CORPUS) {
      for (const href of hrefs(parseMarkdown(payload))) expect(isSafeLinkUrl(href)).toBe(true);
    }
  });

  it('renders plain text for search and single-line display', () => {
    expect(markdownToPlain('# Hi\n**a** [b](https://x.io)\n- [x] c')).toBe('Hi\na b\n☑ c');
  });
});
