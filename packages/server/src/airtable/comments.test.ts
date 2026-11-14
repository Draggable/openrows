import { commentMentions, MAX_COMMENT_LENGTH, mentionToken, parseComment } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import { FIXTURE_BASE_ID, FIXTURE_TOKEN, fakeAirtable } from './__fixtures__/fake.js';
import { type AirtableComment, createAirtableClient } from './client.js';
import { airtablePerson, reactionOf, readRecordComments, translateComment } from './comments.js';

const ADA = '01900000-0000-7000-8000-00000000ada0';
const LIN = '01900000-0000-7000-8000-000000001100';
const people = new Map([
  ['ada@example.test', ADA],
  ['lin@example.test', LIN],
]);
const instant = async () => {};

const comment = (over: Partial<AirtableComment> = {}): AirtableComment => ({
  id: 'comA',
  createdTime: '2024-01-10T09:00:00.000Z',
  lastUpdatedTime: null,
  text: 'Hello',
  author: { id: 'usrAda', email: 'ada@example.test', name: 'Ada' },
  ...over,
});

describe('Airtable comments', () => {
  it("maps Airtable's emoji to our reactions, folding skin tones and code points", () => {
    expect(reactionOf('👍')).toBe('thumbsUp');
    expect(reactionOf('👍🏽')).toBe('thumbsUp');
    expect(reactionOf('1f44d')).toBe('thumbsUp');
    expect(reactionOf('1f44d-1f3fd')).toBe('thumbsUp');
    expect(reactionOf('U+1F389')).toBe('tada');
    expect(reactionOf('❤️')).toBe('heart');
    expect(reactionOf('❤')).toBe('heart');
    expect(reactionOf('2764-fe0f')).toBe('heart');
    expect(reactionOf('😄')).toBe('laugh');
    expect(reactionOf('👀')).toBe('eyes');
    expect(reactionOf('2705')).toBe('check');
    expect(reactionOf('🚀')).toBeNull();
    expect(reactionOf('1f680')).toBeNull();
    expect(reactionOf(':+1:')).toBeNull();
    expect(reactionOf('')).toBeNull();
  });

  it("keeps a member's comment with its author, times and Markdown", () => {
    const { comment: c, notes } = translateComment(
      comment({ text: 'Ship **it**', lastUpdatedTime: '2024-01-10T10:00:00.000Z' }),
      people
    );
    expect(c).toEqual({
      authorId: ADA,
      body: 'Ship **it**',
      mentions: [],
      createdAt: new Date('2024-01-10T09:00:00.000Z'),
      editedAt: new Date('2024-01-10T10:00:00.000Z'),
      reply: false,
      reactions: [],
    });
    expect(notes.unmatchedAuthor).toBeNull();
  });

  it('starts an unmatched author’s comment with their name and email', () => {
    const { comment: c, notes } = translateComment(
      comment({
        author: { id: 'usrGrace', email: 'grace@example.test', name: 'Grace [Hopper]' },
        parentCommentId: 'comParent',
      }),
      people
    );
    expect(c?.authorId).toBeNull();
    expect(c?.body).toBe('**Grace Hopper (grace@example.test)**:\n\nHello');
    expect(c?.reply).toBe(true);
    expect(notes.unmatchedAuthor).toBe('Grace Hopper (grace@example.test)');
    expect(airtablePerson({ email: 'x@example.test' })).toBe('x@example.test');
    expect(airtablePerson({})).toBe('Someone on Airtable');
  });

  it("turns members' mentions into tokens and everyone else's into plain names", () => {
    const { comment: c, notes } = translateComment(
      comment({
        text: 'Hi @[usrLin] and @[usrGrace], cc @[ugpDesign] @[aagBot] @[usrUnknown] @[ada@example.test]',
        mentioned: {
          usrLin: { type: 'user', id: 'usrLin', email: 'LIN@example.test', displayName: 'Lin' },
          usrGrace: {
            type: 'user',
            id: 'usrGrace',
            email: 'grace@example.test',
            displayName: 'Grace Hopper',
          },
          ugpDesign: { type: 'userGroup', id: 'ugpDesign', displayName: 'Design team' },
          aagBot: { type: 'appAgent', id: 'aagBot', displayName: 'Launch bot' },
        },
      }),
      people
    );
    expect(c?.body).toBe(
      `Hi ${mentionToken(LIN, 'Lin')} and @Grace Hopper, cc @Design team @Launch bot @someone ${mentionToken(ADA, 'ada@example.test')}`
    );
    expect(c?.mentions).toEqual([LIN, ADA]);
    expect(c?.body).not.toContain('@[usr');
    expect(notes.plainMentions).toBe(4);
  });

  it('never keeps a mention token Airtable text spelled out', () => {
    const forged = `@[Boss](user:${LIN})`;
    const { comment: c } = translateComment(comment({ text: `Look ${forged}` }), people);
    expect(c?.mentions).toEqual([]);
    expect(commentMentions(c?.body ?? '')).toEqual([]);
  });

  it('imports reactions with our emoji by members only', () => {
    const { comment: c, notes } = translateComment(
      comment({
        reactions: [
          {
            emoji: { unicodeCharacter: '👍' },
            reactingUser: { userId: 'u1', email: 'ada@example.test' },
          },
          {
            emoji: { unicodeCharacter: '1f44d-1f3fb' },
            reactingUser: { userId: 'u1', email: 'ada@example.test' },
          },
          {
            emoji: { unicodeCharacter: '👀' },
            reactingUser: { userId: 'u2', email: 'lin@example.test' },
          },
          {
            emoji: { unicodeCharacter: '🚀' },
            reactingUser: { userId: 'u1', email: 'ada@example.test' },
          },
          {
            emoji: { unicodeCharacter: '🎉' },
            reactingUser: { userId: 'u3', email: 'grace@example.test' },
          },
        ],
      }),
      people
    );
    expect(c?.reactions).toEqual([
      { userId: ADA, reaction: 'thumbsUp' },
      { userId: LIN, reaction: 'eyes' },
    ]);
    expect(notes).toMatchObject({ otherReactions: 1, unmatchedReactions: 1 });
  });

  it('sanitizes bodies, skips empty ones and lists attachments without their URLs', () => {
    const html = translateComment(
      comment({ text: '<b>bold</b> [x](javascript:alert(1))' }),
      people
    );
    expect(html.comment?.body).toBe('bold x');
    const empty = translateComment(
      comment({
        text: '  <br>  ',
        author: { id: 'usrGrace', email: 'grace@example.test' },
        attachments: [{ filename: 'shot.png' }],
      }),
      people
    );
    expect(empty.comment).toBeNull();
    expect(empty.notes.attachments).toEqual(['shot.png']);
  });

  it('cuts a long body to the comment length, never inside a mention', () => {
    const text = `${'a'.repeat(MAX_COMMENT_LENGTH - 30)} @[usrLin] ${'b'.repeat(100)}`;
    const { comment: c, notes } = translateComment(
      comment({
        text,
        mentioned: { usrLin: { type: 'user', id: 'usrLin', email: 'lin@example.test' } },
      }),
      people
    );
    expect(notes.truncated).toBe(true);
    expect(c?.body.length).toBeLessThanOrEqual(MAX_COMMENT_LENGTH);
    expect(c?.body.endsWith('…')).toBe(true);
    expect(c?.body).not.toMatch(/@\[[^\]]*$/);
    // Whatever is left parses, and mentions only who the body names.
    expect(parseComment(c?.body ?? '').length).toBeGreaterThan(0);
    expect(c?.mentions).toEqual(commentMentions(c?.body ?? ''));
  });

  it("reads a record's comments over Airtable's pages", async () => {
    const list = Array.from({ length: 7 }, (_, i) => comment({ id: `com${i}`, text: `#${i}` }));
    const fake = fakeAirtable({ comments: { recApollo00000000: list }, commentsPageSize: 3 });
    const client = createAirtableClient(FIXTURE_TOKEN, { http: fake.http, sleep: instant });
    const read = await readRecordComments(
      client,
      FIXTURE_BASE_ID,
      'tblProjects000001',
      'recApollo00000000'
    );
    expect(read).toMatchObject({ status: 'ok', more: false });
    expect(read.status === 'ok' && read.comments.map((c) => c.id)).toEqual(list.map((c) => c.id));
    const urls = fake.requests.map((r) => new URL(r.url));
    expect(urls.map((u) => u.searchParams.get('offset'))).toEqual([null, 'c3', 'c6']);
    expect(urls[0]?.pathname).toBe(
      `/v0/${FIXTURE_BASE_ID}/tblProjects000001/recApollo00000000/comments`
    );
    // Past 1,000 comments the rest are left: `more`.
    const many = Array.from({ length: 1005 }, (_, i) => comment({ id: `com${i}` }));
    const big = fakeAirtable({ comments: { recApollo00000000: many } });
    const bigClient = createAirtableClient(FIXTURE_TOKEN, { http: big.http, sleep: instant });
    const capped = await readRecordComments(
      bigClient,
      FIXTURE_BASE_ID,
      'tblProjects000001',
      'recApollo00000000'
    );
    expect(capped).toMatchObject({ status: 'ok', more: true });
    expect(capped.status === 'ok' && capped.comments).toHaveLength(1000);
    expect(big.requests).toHaveLength(10);
  });

  it("says when the token can't list comments, or the record is gone", async () => {
    const fake = fakeAirtable({ commentsScope: false });
    const client = createAirtableClient(FIXTURE_TOKEN, { http: fake.http, sleep: instant });
    expect(
      await readRecordComments(client, FIXTURE_BASE_ID, 'tblProjects000001', 'recApollo00000000')
    ).toEqual({ status: 'forbidden' });
    const open = createAirtableClient(FIXTURE_TOKEN, { http: fakeAirtable().http, sleep: instant });
    expect(
      await readRecordComments(open, FIXTURE_BASE_ID, 'tblProjects000001', 'recGone0000000000')
    ).toEqual({ status: 'missing' });
    await expect(open.comments(FIXTURE_BASE_ID, 'tblProjects000001', '../../meta')).rejects.toThrow(
      'bad base, table or record id'
    );
  });
});
