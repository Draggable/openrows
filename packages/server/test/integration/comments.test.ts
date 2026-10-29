import {
  type Comment,
  CommentCountsSchema,
  CommentListSchema,
  CommentSchema,
  EventListSchema,
  MAX_COMMENT_LENGTH,
  MentionableUsersSchema,
  mentionToken,
} from '@openrows/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { baseMembers, outbox, recordComments } from '../../src/db/index.js';
import { useTestDb } from '../helpers/db.js';
import {
  addMember,
  authedClient,
  createBase,
  createRecordsIn,
  createTableWithFields,
  createUser,
  createWorkspace,
} from '../helpers/factories.js';

const ORIGIN = 'http://localhost:5173';
const send = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { origin: ORIGIN, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const bare = (method: string): RequestInit => ({ method, headers: { origin: ORIGIN } });

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const body = r.status === 204 ? null : await r.json();
  expect(r.status, JSON.stringify(body)).toBe(status);
  return body as T;
}

describe('record comments (#92)', () => {
  const t = useTestDb();

  async function world() {
    const { workspace, owner } = await createWorkspace(t.db, { name: 'Acme' });
    const commenter = await addMember(t.db, workspace.id, 'commenter');
    const editor = await addMember(t.db, workspace.id, 'editor');
    const reader = await addMember(t.db, workspace.id, 'read_only');
    const base = await createBase(t.db, workspace.id);
    const sibling = await createBase(t.db, workspace.id, { name: 'Sibling' });
    const guest = await createUser(t.db, { name: 'Gus Guest' });
    const siblingGuest = await createUser(t.db);
    await t.db.insert(baseMembers).values([
      { workspaceId: workspace.id, baseId: base.id, userId: guest.id, role: 'commenter' },
      { workspaceId: workspace.id, baseId: sibling.id, userId: siblingGuest.id, role: 'editor' },
    ]);
    const { table } = await createTableWithFields(t.db, owner, base);
    const { record, deletedRecord } = await createRecordsIn(t.db, owner, table);
    const other = await createWorkspace(t.db);
    const clients = {
      owner: await authedClient(t, owner),
      commenter: await authedClient(t, commenter),
      editor: await authedClient(t, editor),
      reader: await authedClient(t, reader),
      guest: await authedClient(t, guest),
      stranger: await authedClient(t, other.owner),
    };
    const url = `/api/tables/${table.id}/records/${record.id}/comments`;
    return {
      workspace,
      owner,
      commenter,
      editor,
      reader,
      guest,
      siblingGuest,
      stranger: other.owner,
      table,
      record,
      deletedRecord,
      clients,
      url,
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const post = (w: World, as: keyof World['clients'], body: string, status = 201) =>
    json<Comment>(w.clients[as].request(w.url, send({ body })), status);

  const list = async (w: World, as: keyof World['clients'] = 'owner') =>
    CommentListSchema.parse(await json(w.clients[as].request(w.url))).comments;

  it('posts, lists, edits and deletes comments by the rules of each role', async () => {
    const w = await world();
    const mine = CommentSchema.parse(await post(w, 'commenter', 'First **draft**'));
    expect(mine).toMatchObject({
      authorId: w.commenter.id,
      body: 'First **draft**',
      editedAt: null,
    });
    // read_only reads but can't write.
    expect(await list(w, 'reader')).toEqual([mine]);
    await post(w, 'reader', 'Me too', 403);

    // Only the author edits, whatever the role.
    await json(w.clients.owner.request(`${w.url}/${mine.id}`, send({ body: 'X' }, 'PATCH')), 403);
    await json(w.clients.editor.request(`${w.url}/${mine.id}`, send({ body: 'X' }, 'PATCH')), 403);
    const edited = CommentSchema.parse(
      await json(
        w.clients.commenter.request(`${w.url}/${mine.id}`, send({ body: 'Final' }, 'PATCH'))
      )
    );
    expect(edited.body).toBe('Final');
    expect(edited.editedAt).not.toBeNull();

    // An editor can't delete someone else's comment; an owner (or creator) can.
    await json(w.clients.editor.request(`${w.url}/${mine.id}`, bare('DELETE')), 403);
    await json(w.clients.owner.request(`${w.url}/${mine.id}`, bare('DELETE')), 204);
    expect(await list(w)).toEqual([]);
    // Soft: the row stays, marked deleted by the owner.
    const [row] = await t.db.select().from(recordComments).where(eq(recordComments.id, mine.id));
    expect(row?.deletedBy).toBe(w.owner.id);
    expect(row?.deletedAt).not.toBeNull();
    // A deleted comment is gone for edits too.
    await json(
      w.clients.commenter.request(`${w.url}/${mine.id}`, send({ body: 'Back' }, 'PATCH')),
      404
    );

    // Authors delete their own.
    const own = await post(w, 'editor', 'Mine to remove');
    await json(w.clients.editor.request(`${w.url}/${own.id}`, bare('DELETE')), 204);
  });

  it('sanitizes bodies: no HTML, no script links, only safe Markdown (XSS)', async () => {
    const w = await world();
    const attacks = [
      '<script>alert(1)</script>hello',
      '<img src=x onerror=alert(1)>',
      '[click](javascript:alert(1))',
      '[x](data:text/html;base64,PHNjcmlwdD4=)',
      '<a href="javascript:alert(1)">a</a>',
      '<scr<script>ipt>alert(1)</scr</script>ipt>',
      '<svg/onload=alert(1)>',
      '![img](https://example.test/x.png" onerror="alert(1))',
      '@[<b>Boss</b>](user:00000000-0000-7000-8000-000000000000',
      '<iframe src="https://evil.test"></iframe>',
    ];
    for (const attack of attacks) {
      const res = await w.clients.commenter.request(w.url, send({ body: `${attack} ok` }));
      const body = (await res.json()) as { body?: string };
      expect([201, 422], attack).toContain(res.status);
      if (res.status === 201) {
        const text = body.body ?? '';
        expect(text, attack).not.toMatch(/<\s*\/?\s*(script|img|svg|iframe|a|b)\b/i);
        expect(text, attack).not.toMatch(/\]\((javascript|data):/i);
        expect(text, attack).not.toMatch(/onerror|onload/i);
      }
    }
    // A body that is nothing but markup is empty once sanitized.
    await post(w, 'commenter', '<script></script>', 422);
    // Safe Markdown survives.
    const safe = await post(w, 'commenter', '**bold** _it_ [docs](https://openrows.io) `a < b`');
    expect(safe.body).toBe('**bold** _it_ [docs](https://openrows.io) `a < b`');
  });

  it('caps the body at 10,000 characters', async () => {
    const w = await world();
    await post(w, 'commenter', 'a'.repeat(MAX_COMMENT_LENGTH));
    await post(w, 'commenter', 'a'.repeat(MAX_COMMENT_LENGTH + 1), 422);
  });

  it('stores mentions as user ids and only of people with access to the base', async () => {
    const w = await world();
    const body = `Hey ${mentionToken(w.editor.id, 'Ed')} and ${mentionToken(w.guest.id, 'Gus')}`;
    const comment = await post(w, 'commenter', body);
    expect(comment.mentions).toEqual([w.editor.id, w.guest.id]);
    expect(comment.body).toBe(body);

    // Someone of another tenant, a sibling base's collaborator or an unknown id: refused.
    for (const id of [w.stranger.id, w.siblingGuest.id, '01900000-0000-7000-8000-000000000001']) {
      const res = await w.clients.commenter.request(
        w.url,
        send({ body: `Hi ${mentionToken(id, 'Who')}` })
      );
      expect(res.status).toBe(422);
    }
    expect(await list(w)).toHaveLength(1);

    // An edit can't add one either.
    await json(
      w.clients.commenter.request(
        `${w.url}/${comment.id}`,
        send({ body: `Hi ${mentionToken(w.stranger.id, 'S')}` }, 'PATCH')
      ),
      422
    );

    // The autocomplete lists exactly the people with access to the base.
    const { userIds } = MentionableUsersSchema.parse(
      await json(w.clients.commenter.request(`/api/tables/${w.table.id}/mentionable-users`))
    );
    expect(new Set(userIds)).toEqual(
      new Set([w.owner.id, w.commenter.id, w.editor.id, w.reader.id, w.guest.id])
    );

    // A mention inside code is just text.
    const code = await post(w, 'commenter', `\`${mentionToken(w.stranger.id, 'S')}\``);
    expect(code.mentions).toEqual([]);
  });

  it('emits outbox events, with an internal mention event the projection drops', async () => {
    const w = await world();
    const res = await w.clients.commenter.request(
      w.url,
      send({ body: `cc ${mentionToken(w.editor.id, 'Ed')}`, clientOpId: 'op-1' })
    );
    const comment = CommentSchema.parse(await json(res, 201));
    const rows = await t.db
      .select()
      .from(outbox)
      .where(and(eq(outbox.workspaceId, w.workspace.id), eq(outbox.tableId, w.table.id)));
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toContain('comment.created');
    const mention = rows.find((r) => r.kind === 'comment.mentioned');
    expect(mention?.payload).toEqual({
      commentId: comment.id,
      recordId: w.record.id,
      authorId: w.commenter.id,
      userIds: [w.editor.id],
    });
    expect(rows.find((r) => r.kind === 'comment.created')?.clientOpId).toBe('op-1');

    // Re-saving the same mention isn't a new one; a self-mention never is.
    await json(
      w.clients.commenter.request(
        `${w.url}/${comment.id}`,
        send(
          { body: `cc ${mentionToken(w.editor.id, 'Ed')} ${mentionToken(w.commenter.id, 'me')}` },
          'PATCH'
        )
      )
    );
    const mentions = await t.db
      .select()
      .from(outbox)
      .where(and(eq(outbox.workspaceId, w.workspace.id), eq(outbox.kind, 'comment.mentioned')));
    expect(mentions).toHaveLength(1);

    // A read-only member's catch-up has the comment, not the mention event.
    const events = EventListSchema.parse(
      await json(w.clients.reader.request(`/api/bases/${w.table.baseId}/events?since=0`))
    );
    const seen = events.events.map((e) => e.kind);
    expect(seen).toContain('comment.created');
    expect(seen).toContain('comment.updated');
    expect(seen).not.toContain('comment.mentioned');
  });

  it('adds and takes back reactions, idempotently', async () => {
    const w = await world();
    const comment = await post(w, 'commenter', 'React to me');
    const react = (as: keyof World['clients'], method: 'PUT' | 'DELETE', reaction = 'thumbsUp') =>
      w.clients[as].request(`${w.url}/${comment.id}/reactions/${reaction}`, bare(method));
    await json(react('owner', 'PUT'));
    await json(react('owner', 'PUT'));
    await json(react('guest', 'PUT'));
    const after = CommentSchema.parse(await json(react('editor', 'PUT', 'tada')));
    expect(after.reactions).toEqual([
      { reaction: 'thumbsUp', userIds: [w.owner.id, w.guest.id] },
      { reaction: 'tada', userIds: [w.editor.id] },
    ]);
    await json(react('reader', 'PUT'), 403);
    const back = CommentSchema.parse(await json(react('owner', 'DELETE')));
    expect(back.reactions[0]).toEqual({ reaction: 'thumbsUp', userIds: [w.guest.id] });
    await json(react('owner', 'DELETE'));
  });

  it('answers 404 for deleted records, other records and other tenants', async () => {
    const w = await world();
    const comment = await post(w, 'commenter', 'Hello');
    // The deleted record takes no comments and shows none.
    const deletedUrl = `/api/tables/${w.table.id}/records/${w.deletedRecord.id}/comments`;
    await json(w.clients.owner.request(deletedUrl), 404);
    await json(w.clients.owner.request(deletedUrl, send({ body: 'x' })), 404);
    // The comment id under another record of the table is no comment.
    const { record: second } = await createRecordsIn(t.db, w.owner, w.table);
    const elsewhere = `/api/tables/${w.table.id}/records/${second.id}/comments/${comment.id}`;
    await json(w.clients.commenter.request(elsewhere, send({ body: 'x' }, 'PATCH')), 404);
    await json(w.clients.owner.request(elsewhere, bare('DELETE')), 404);
    // Another tenant sees nothing at all.
    await json(w.clients.stranger.request(w.url), 404);
    await json(w.clients.stranger.request(`${w.url}/${comment.id}`, bare('DELETE')), 404);
    // An unknown reaction is no route.
    await json(w.clients.owner.request(`${w.url}/${comment.id}/reactions/skull`, bare('PUT')), 404);
  });

  it('counts live comments per record', async () => {
    const w = await world();
    await post(w, 'commenter', 'One');
    const two = await post(w, 'owner', 'Two');
    await post(w, 'guest', 'Three');
    await json(w.clients.owner.request(`${w.url}/${two.id}`, bare('DELETE')), 204);
    const { counts } = CommentCountsSchema.parse(
      await json(w.clients.reader.request(`/api/tables/${w.table.id}/comment-counts`))
    );
    expect(counts).toEqual({ [w.record.id]: 2 });
  });

  it('pages a thread newest last, with "load earlier" by keyset (#122)', async () => {
    const w = await world();
    const ids: string[] = [];
    for (const n of [1, 2, 3, 4, 5, 6, 7]) ids.push((await post(w, 'commenter', `C${n}`)).id);
    // Comments 3 to 5 share one timestamp down to the microsecond (the id breaks the tie), and
    // 2 is one microsecond earlier: a millisecond cursor would skip or repeat them.
    await t.db
      .update(recordComments)
      .set({ createdAt: sql`'2030-01-01 00:00:00.123457+00'::timestamptz` })
      .where(inArray(recordComments.id, ids.slice(2, 5)));
    await t.db
      .update(recordComments)
      .set({ createdAt: sql`'2030-01-01 00:00:00.123456+00'::timestamptz` })
      .where(eq(recordComments.id, ids[1] ?? ''));
    await t.db
      .update(recordComments)
      .set({ createdAt: sql`'2030-01-01 00:00:00.000001+00'::timestamptz` })
      .where(eq(recordComments.id, ids[0] ?? ''));
    await t.db
      .update(recordComments)
      .set({ createdAt: sql`'2030-01-02 00:00:00+00'::timestamptz` })
      .where(inArray(recordComments.id, ids.slice(5)));
    const page = async (query: string) =>
      CommentListSchema.parse(await json(w.clients.reader.request(`${w.url}?${query}`)));
    const newest = await page('limit=2');
    expect(newest.comments.map((c) => c.id)).toEqual(ids.slice(5));
    const seen = [...newest.comments.map((c) => c.id)];
    let cursor = newest.previousCursor;
    while (cursor) {
      const earlier = await page(`limit=2&before=${encodeURIComponent(cursor)}`);
      seen.unshift(...earlier.comments.map((c) => c.id));
      cursor = earlier.previousCursor;
    }
    expect(seen).toEqual(ids);
    // The default page holds them all; the last page says there is nothing earlier.
    const all = await page('');
    expect(all.comments.map((c) => c.id)).toEqual(ids);
    expect(all.previousCursor).toBeNull();
    for (const bad of ['limit=0', 'limit=101', 'before=junk', `before=${'x'.repeat(201)}`]) {
      await json(w.clients.reader.request(`${w.url}?${bad}`), 422);
    }
  });
});
