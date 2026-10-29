import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  commentExcerpt,
  commentMentions,
  MAX_COMMENT_LENGTH,
  mentionToken,
  parseComment,
  sanitizeComment,
} from './comments.js';
import type { MarkdownBlock, MarkdownInline } from './fields/markdown.js';

const ADA = '01900000-0000-7000-8000-00000000000a';
const BOB = '01900000-0000-7000-8000-00000000000b';

/** Every link target and text of a tree, to check what a renderer would put in the page. */
function flatten(blocks: MarkdownBlock[]): { hrefs: string[]; text: string } {
  const hrefs: string[] = [];
  let text = '';
  const walk = (nodes: MarkdownInline[]) => {
    for (const n of nodes) {
      if (n.kind === 'link') hrefs.push(n.href);
      if ('children' in n) walk(n.children);
      else if (n.kind === 'mention') text += `@${n.label}`;
      else text += n.text;
    }
  };
  for (const b of blocks) {
    if (b.kind === 'code') text += b.text;
    else if (b.kind === 'list') for (const it of b.items) walk(it.children);
    else walk(b.children);
  }
  return { hrefs, text };
}

describe('comment bodies (#92)', () => {
  it('keeps mention tokens with clean labels', () => {
    const body = `Hi ${mentionToken(ADA, 'Ada')}, see **this**`;
    expect(sanitizeComment(body)).toBe(body);
    expect(mentionToken(ADA.toUpperCase(), 'A [b] (c) <d>\nE')).toBe(`@[A b c dE](user:${ADA})`);
    expect(sanitizeComment(`@[<script>x</script>](user:${ADA})`)).toBe(
      `@[scriptx/script](user:${ADA})`
    );
  });

  it('removes HTML, script links and images (XSS)', () => {
    const attacks = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '[x](javascript:alert(1))',
      '[x](JaVaScRiPt:alert(1))',
      '[x](data:text/html,<script>alert(1)</script>)',
      '<scr<script>ipt>alert(1)</script>',
      `[${mentionToken(ADA, 'a')}](javascript:alert(1))`,
      `<a href="${mentionToken(ADA, 'a')}">x</a>`,
      `<b ${mentionToken(ADA, 'a')}>`,
      '0 ',
    ];
    for (const attack of attacks) {
      const clean = sanitizeComment(attack);
      expect(clean, attack).not.toMatch(/<[a-z/!]/i);
      expect(clean, attack).not.toMatch(/javascript:|data:/i);
      expect(clean, attack).not.toMatch(/[]/);
      for (const href of flatten(parseComment(clean)).hrefs) {
        expect(href, attack).toMatch(/^(https?:|mailto:)/);
      }
    }
  });

  it('parses mentions as nodes, but not inside code', () => {
    const body = `**${mentionToken(ADA, 'Ada')}** and \`${mentionToken(BOB, 'Bob')}\``;
    const [block] = parseComment(body);
    expect(block).toEqual({
      kind: 'paragraph',
      children: [
        { kind: 'bold', children: [{ kind: 'mention', userId: ADA, label: 'Ada' }] },
        { kind: 'text', text: ' and ' },
        { kind: 'code', text: mentionToken(BOB, 'Bob') },
      ],
    });
    expect(commentMentions(body)).toEqual([ADA]);
    expect(
      commentMentions(
        `${mentionToken(BOB, 'b')} ${mentionToken(ADA, 'a')} ${mentionToken(BOB, 'B')}`
      )
    ).toEqual([BOB, ADA]);
    expect(
      commentMentions(`- ${mentionToken(ADA, 'a')}\n\n\`\`\`\n${mentionToken(BOB, 'b')}\n\`\`\``)
    ).toEqual([ADA]);
  });

  it('is idempotent, and never grows past the cap on arbitrary text', () => {
    const piece = fc.oneof(
      fc.string({ maxLength: 20 }),
      fc.constantFrom('<', '>', '[', ']', '(', ')', '@', '`', '*', '\n', '', ''),
      fc.constant(mentionToken(ADA, 'Ada')),
      fc.constant('[x](javascript:alert(1))'),
      fc.constant('<script>')
    );
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 30 }), (pieces) => {
        const input = pieces.join('');
        const once = sanitizeComment(input);
        expect(sanitizeComment(once)).toBe(once);
        expect(once.length).toBeLessThanOrEqual(Math.max(input.length, MAX_COMMENT_LENGTH));
        // An unclosed `<A` is text (as in rich text); no complete tag survives.
        expect(once).not.toMatch(/<\/?[A-Za-z][^<>]*>/);
        for (const id of commentMentions(once)) expect(id).toBe(ADA);
      })
    );
  });
});

describe('commentExcerpt (#93)', () => {
  it('is one line of plain text with mentions as @Name', () => {
    const body = `Hi ${mentionToken('01900000-0000-7000-8000-000000000001', 'Ada')}, **look** at [this](https://x.test)\n\n- one\n- \`two\``;
    expect(commentExcerpt(body)).toBe('Hi @Ada, look at this one two');
  });

  it('cuts long text with an ellipsis', () => {
    const out = commentExcerpt('word '.repeat(100), 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith('…')).toBe(true);
  });
});
