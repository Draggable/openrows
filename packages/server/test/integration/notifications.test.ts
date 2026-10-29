import {
  FieldSchema,
  mentionToken,
  NotificationListSchema,
  NotificationPreferencesSchema,
  RecordsSchema,
  TableSchema,
  UnreadNotificationsSchema,
} from '@openrows/shared';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { baseMembers, notifications, users, workspaceMembers } from '../../src/db/index.js';
import { memoryTransport } from '../../src/email/transport.js';
import { builtinQueues, startWorker } from '../../src/jobs/runtime.js';
import { createLogger } from '../../src/lib/logger.js';
import { NotificationMailer } from '../../src/notifications/mailer.js';
import { unsubscribeToken } from '../../src/notifications/unsubscribe.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import {
  addMember,
  authedClient,
  createBase,
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

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const body = r.status === 204 ? null : await r.json();
  expect(r.status, JSON.stringify(body)).toBe(status);
  return body as T;
}

describe('notifications (#93)', () => {
  const t = useTestDb();

  async function world() {
    // Tests share the database: earlier tests' notifications are not this test's mail.
    await t.db.update(notifications).set({ emailState: 'skipped' });
    const { workspace, owner } = await createWorkspace(t.db, { name: 'Acme' });
    await t.db.update(users).set({ name: 'Olive Owner' }).where(eq(users.id, owner.id));
    const editor = await addMember(t.db, workspace.id, 'editor');
    const commenter = await addMember(t.db, workspace.id, 'commenter');
    const base = await createBase(t.db, workspace.id, { name: 'Roadmap' });
    const guest = await createUser(t.db, { name: 'Gus Guest' });
    await t.db
      .insert(baseMembers)
      .values({ workspaceId: workspace.id, baseId: base.id, userId: guest.id, role: 'commenter' });
    const { table } = await createTableWithFields(t.db, owner, base);
    const other = await createWorkspace(t.db);
    const clients = {
      owner: await authedClient(t, owner),
      editor: await authedClient(t, editor),
      commenter: await authedClient(t, commenter),
      guest: await authedClient(t, guest),
      stranger: await authedClient(t, other.owner),
    };
    const fieldList = TableSchema.parse(
      await json(clients.owner.request(`/api/tables/${table.id}`))
    ).fields;
    const name = fieldList.find((f) => f.isPrimary);
    const notes = fieldList.find((f) => f.name === 'Notes');
    if (!name || !notes) throw new Error('no Name or Notes field');
    const [record] = RecordsSchema.parse(
      await json(
        clients.owner.request(
          `/api/tables/${table.id}/records`,
          send({
            records: [{ fields: { [name.id]: 'Launch <plan>', [notes.id]: 'TOP SECRET notes' } }],
          })
        ),
        201
      )
    ).records;
    if (!record) throw new Error('no record');
    const mailbox = memoryTransport();
    const mailer = new NotificationMailer({
      db: t.appDb,
      email: mailbox,
      appUrl: 'http://localhost:5173',
      secret: testApp().config.encryptionKey,
      logger: createLogger({ level: 'silent' }),
    });
    const commentsUrl = `/api/tables/${table.id}/records/${record.id}/comments`;
    return {
      workspace,
      base,
      table,
      record,
      owner,
      editor,
      commenter,
      guest,
      stranger: other.owner,
      clients,
      mailbox,
      mailer,
      commentsUrl,
      name,
    };
  }
  type World = Awaited<ReturnType<typeof world>>;
  type Who = keyof World['clients'];

  const comment = (w: World, as: Who, body: string) =>
    json<{ id: string }>(w.clients[as].request(w.commentsUrl, send({ body })), 201);
  const inbox = async (w: World, as: Who, query = '') =>
    NotificationListSchema.parse(await json(w.clients[as].request(`/api/notifications${query}`)));
  const unread = async (w: World, as: Who) =>
    UnreadNotificationsSchema.parse(await json(w.clients[as].request('/api/notifications/unread')))
      .unread;
  /** Moves every email sent so far out of the throttle window. */
  const ageEmails = () =>
    t.db
      .update(notifications)
      .set({ emailedAt: sql`emailed_at - interval '11 minutes'` })
      .where(sql`emailed_at IS NOT NULL`);

  it('notifies mentioned people with the excerpt, record and deep-link ids, never the author', async () => {
    const w = await world();
    const c = await comment(
      w,
      'commenter',
      `Hey ${mentionToken(w.editor.id, 'Ed')} and ${mentionToken(w.guest.id, 'Gus')}, **look**`
    );
    const mine = await inbox(w, 'editor');
    expect(mine.unread).toBe(1);
    expect(mine.notifications).toEqual([
      expect.objectContaining({
        kind: 'mention',
        actorId: w.commenter.id,
        workspaceId: w.workspace.id,
        baseId: w.base.id,
        tableId: w.table.id,
        recordId: w.record.id,
        commentId: c.id,
        baseName: 'Roadmap',
        tableName: 'Tasks',
        recordName: 'Launch <plan>',
        excerpt: 'Hey @Ed and @Gus, look',
        readAt: null,
      }),
    ]);
    // A base-only collaborator gets theirs too; the author and the unmentioned get nothing.
    expect((await inbox(w, 'guest')).notifications).toHaveLength(1);
    expect(await unread(w, 'commenter')).toBe(0);
    expect(await unread(w, 'owner')).toBe(0);
    expect((await inbox(w, 'stranger')).notifications).toEqual([]);

    // An edit notifies only the people it newly mentions.
    await json(
      w.clients.commenter.request(
        `${w.commentsUrl}/${c.id}`,
        send(
          { body: `${mentionToken(w.editor.id, 'Ed')} ${mentionToken(w.owner.id, 'Olive')}` },
          'PATCH'
        )
      )
    );
    expect(await unread(w, 'editor')).toBe(1);
    expect(await unread(w, 'owner')).toBe(1);
  });

  it('notifies earlier commenters of replies (thread watch), not the author or the mentioned', async () => {
    const w = await world();
    await comment(w, 'editor', 'First');
    await comment(w, 'guest', 'Second');
    await comment(w, 'commenter', `Third, ${mentionToken(w.guest.id, 'Gus')}`);
    const editor = await inbox(w, 'editor');
    expect(editor.notifications.map((n) => n.kind)).toEqual(['reply', 'reply']);
    const guest = await inbox(w, 'guest');
    // The guest was mentioned in the third: one mention, no extra reply for it.
    expect(guest.notifications.map((n) => n.kind)).toEqual(['mention']);
    expect(await unread(w, 'commenter')).toBe(0);
    expect(await unread(w, 'owner')).toBe(0);
  });

  it('notifies people added to a user field with notify on, once', async () => {
    const w = await world();
    const field = async (options: Record<string, unknown>, name: string) =>
      FieldSchema.parse(
        await json(
          w.clients.owner.request(
            `/api/tables/${w.table.id}/fields`,
            send({ name, type: 'user', options })
          ),
          201
        )
      );
    const assignee = await field({ multiple: true, notify: true }, 'Assignee');
    const silent = await field({ multiple: true }, 'Watchers');
    const patch = (fields: Record<string, unknown>, as: Who = 'owner') =>
      json(
        w.clients[as].request(
          `/api/tables/${w.table.id}/records/${w.record.id}`,
          send({ fields }, 'PATCH')
        )
      );
    await patch({ [assignee.id]: [w.editor.id, w.owner.id], [silent.id]: [w.commenter.id] });
    const editor = await inbox(w, 'editor');
    expect(editor.notifications).toEqual([
      expect.objectContaining({
        kind: 'assigned',
        fieldId: assignee.id,
        fieldName: 'Assignee',
        actorId: w.owner.id,
        actorName: 'Olive Owner',
        excerpt: null,
      }),
    ]);
    // Not the writer, not a field without notify, not someone already in the cell.
    expect(await unread(w, 'owner')).toBe(0);
    expect(await unread(w, 'commenter')).toBe(0);
    await patch({ [assignee.id]: [w.editor.id, w.guest.id] });
    expect(await unread(w, 'editor')).toBe(1);
    expect(await unread(w, 'guest')).toBe(1);
    // New records too.
    await json(
      w.clients.owner.request(
        `/api/tables/${w.table.id}/records`,
        send({ records: [{ fields: { [assignee.id]: [w.commenter.id] } }] })
      ),
      201
    );
    expect(await unread(w, 'commenter')).toBe(1);
  });

  it('marks one or all read, only your own, and pages the inbox', async () => {
    const w = await world();
    for (const text of ['one', 'two', 'three']) {
      await comment(w, 'commenter', `${text} ${mentionToken(w.editor.id, 'Ed')}`);
    }
    const page1 = await inbox(w, 'editor', '?limit=2');
    expect(page1.notifications.map((n) => n.excerpt)).toEqual(['three @Ed', 'two @Ed']);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await inbox(
      w,
      'editor',
      `?limit=2&cursor=${encodeURIComponent(page1.nextCursor ?? '')}`
    );
    expect(page2.notifications.map((n) => n.excerpt)).toEqual(['one @Ed']);
    expect(page2.nextCursor).toBeNull();
    await json(w.clients.editor.request('/api/notifications?cursor=junk'), 422);

    const first = page1.notifications[0];
    if (!first) throw new Error('no notification');
    // Someone else's id is a 404 and changes nothing (RLS: recipients only).
    await json(
      w.clients.guest.request(`/api/notifications/${first.id}/read`, send(undefined)),
      404
    );
    await json(
      w.clients.stranger.request(`/api/notifications/${first.id}/read`, send(undefined)),
      404
    );
    expect(
      await json(w.clients.editor.request(`/api/notifications/${first.id}/read`, send(undefined)))
    ).toEqual({ unread: 2 });
    expect((await inbox(w, 'editor', '?unread=true')).notifications).toHaveLength(2);
    expect(
      await json(w.clients.editor.request('/api/notifications/read', send(undefined)))
    ).toEqual({ unread: 0 });
    const all = await inbox(w, 'editor');
    expect(all.notifications.every((n) => n.readAt !== null)).toBe(true);
  });

  it('emails a mention with only the record name and excerpt, and an unsubscribe link', async () => {
    const w = await world();
    await comment(w, 'owner', `Please review ${mentionToken(w.editor.id, 'Ed')} <b>now</b>`);
    expect(await w.mailer.run()).toEqual({ sent: 1, skipped: 0 });
    expect(w.mailbox.sent).toHaveLength(1);
    const mail = w.mailbox.sent[0];
    if (!mail) throw new Error('no mail');
    expect(mail.to).toBe(w.editor.email);
    expect(mail.subject).toBe('Olive Owner mentioned you on Launch <plan>');
    expect(mail.html).toContain('Launch &lt;plan&gt;');
    expect(mail.html).not.toContain('<b>now</b>');
    expect(mail.text).toContain('Please review @Ed');
    // Nothing else from the record (the Notes cell), never.
    expect(mail.html).not.toContain('TOP SECRET');
    expect(mail.text).not.toContain('TOP SECRET');
    expect(mail.text).toContain(
      `http://localhost:5173/b/${w.base.id}/${w.table.id}?record=${w.record.id}&comment=`
    );
    expect(mail.headers?.['List-Unsubscribe']).toMatch(
      /^<http:\/\/localhost:5173\/email\/unsubscribe\?token=/
    );
    expect(mail.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    // Sent once.
    expect(await w.mailer.run()).toEqual({ sent: 0, skipped: 0 });
  });

  it('sends at most one email per recipient and record per 10 minutes, coalescing the rest', async () => {
    const w = await world();
    await comment(w, 'owner', `a ${mentionToken(w.editor.id, 'Ed')}`);
    await w.mailer.run();
    await comment(w, 'owner', `b ${mentionToken(w.editor.id, 'Ed')}`);
    await comment(w, 'owner', `c ${mentionToken(w.editor.id, 'Ed')}`);
    // Within the window: nothing goes out.
    expect(await w.mailer.run()).toEqual({ sent: 0, skipped: 0 });
    expect(w.mailbox.sent).toHaveLength(1);
    await ageEmails();
    expect(await w.mailer.run()).toEqual({ sent: 1, skipped: 0 });
    expect(w.mailbox.sent).toHaveLength(2);
    const coalesced = w.mailbox.sent[1];
    expect(coalesced?.subject).toBe('2 new notifications on Launch <plan>');
    expect(coalesced?.text).toContain('b @Ed');
    expect(coalesced?.text).toContain('c @Ed');
  });

  it('re-checks access at send time: removed members and collaborators get nothing', async () => {
    const w = await world();
    await comment(
      w,
      'owner',
      `${mentionToken(w.editor.id, 'Ed')} ${mentionToken(w.guest.id, 'Gus')} ${mentionToken(w.commenter.id, 'Cy')}`
    );
    // The editor leaves the workspace, the guest loses the base, before the mailer runs.
    await t.db
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, w.workspace.id),
          eq(workspaceMembers.userId, w.editor.id)
        )
      );
    await t.db
      .delete(baseMembers)
      .where(and(eq(baseMembers.baseId, w.base.id), eq(baseMembers.userId, w.guest.id)));
    expect(await w.mailer.run()).toEqual({ sent: 1, skipped: 2 });
    expect(w.mailbox.sent.map((m) => m.to)).toEqual([w.commenter.email]);
    const states = await t.db
      .select({ userId: notifications.userId, state: notifications.emailState })
      .from(notifications);
    expect(states).toEqual(
      expect.arrayContaining([
        { userId: w.editor.id, state: 'skipped' },
        { userId: w.guest.id, state: 'skipped' },
        { userId: w.commenter.id, state: 'sent' },
      ])
    );
    // Their inbox doesn't show it either (and the bell stops counting it).
    expect((await inbox(w, 'editor')).notifications).toEqual([]);
    expect(await unread(w, 'editor')).toBe(0);
    expect((await inbox(w, 'guest')).notifications).toEqual([]);
  });

  it('sends nothing about a record that was deleted before the send', async () => {
    const w = await world();
    await comment(w, 'owner', `${mentionToken(w.editor.id, 'Ed')} look`);
    await json(
      w.clients.owner.request(`/api/tables/${w.table.id}/records/${w.record.id}`, {
        method: 'DELETE',
        headers: { origin: ORIGIN },
      }),
      204
    );
    expect(await w.mailer.run()).toEqual({ sent: 0, skipped: 1 });
    expect(w.mailbox.sent).toEqual([]);
    expect((await inbox(w, 'editor')).notifications).toEqual([]);
  });

  it('respects the email preference: all, mentions only, none', async () => {
    const w = await world();
    expect(await json(w.clients.editor.request('/api/me/notification-preferences'))).toEqual({
      email: 'all',
      frequency: 'immediately',
    });
    await json(
      w.clients.editor.request('/api/me/notification-preferences', send({ email: 'loud' }, 'PUT')),
      422
    );
    expect(
      NotificationPreferencesSchema.parse(
        await json(
          w.clients.editor.request(
            '/api/me/notification-preferences',
            send({ email: 'mentions' }, 'PUT')
          )
        )
      )
    ).toEqual({ email: 'mentions', frequency: 'immediately' });
    await json(
      w.clients.guest.request('/api/me/notification-preferences', send({ email: 'none' }, 'PUT'))
    );
    await comment(w, 'editor', 'I start the thread');
    await comment(w, 'guest', 'Me too');
    // A reply to the editor (mentions only: no email) and a mention of the guest (none: no email).
    await comment(w, 'owner', `Reply ${mentionToken(w.guest.id, 'Gus')}`);
    expect(await w.mailer.run()).toEqual({ sent: 0, skipped: 2 });
    // The in-app inbox still has them (the editor: replies to the guest's and the owner's).
    expect(await unread(w, 'editor')).toBe(2);
    expect(await unread(w, 'guest')).toBe(1);
    // A mention (emailed) for the editor, a reply (not: none) for the guest.
    await comment(w, 'owner', `Now a mention ${mentionToken(w.editor.id, 'Ed')}`);
    expect(await w.mailer.run()).toEqual({ sent: 1, skipped: 1 });
    expect(w.mailbox.sent.map((m) => m.to)).toEqual([w.editor.email]);
  });

  describe('digests (#122)', () => {
    const setFrequency = (w: World, as: Who, frequency: string, status = 200) =>
      json(
        w.clients[as].request('/api/me/notification-preferences', send({ frequency }, 'PUT')),
        status
      );
    const newRecord = async (w: World, name: string) => {
      const [record] = RecordsSchema.parse(
        await json(
          w.clients.owner.request(
            `/api/tables/${w.table.id}/records`,
            send({ records: [{ fields: { [w.name.id]: name } }] })
          ),
          201
        )
      ).records;
      if (!record) throw new Error('no record');
      return record;
    };
    const commentOn = (w: World, as: Who, recordId: string, body: string) =>
      json<{ id: string }>(
        w.clients[as].request(
          `/api/tables/${w.table.id}/records/${recordId}/comments`,
          send({ body })
        ),
        201
      );
    const mailerFor = (w: World, email = memoryTransport()) =>
      Object.assign(
        new NotificationMailer({
          db: t.appDb,
          email,
          appUrl: 'http://localhost:5173',
          secret: testApp().config.encryptionKey,
          logger: createLogger({ level: 'silent' }),
        }),
        { mailbox: email, world: w }
      );

    it('keeps the frequency in the preferences: immediately, hourly or daily', async () => {
      const w = await world();
      expect(await setFrequency(w, 'editor', 'daily')).toEqual({
        email: 'all',
        frequency: 'daily',
      });
      await setFrequency(w, 'editor', 'weekly', 422);
      await json(
        w.clients.editor.request('/api/me/notification-preferences', send({}, 'PUT')),
        422
      );
      expect(
        await json(
          w.clients.editor.request(
            '/api/me/notification-preferences',
            send({ email: 'mentions' }, 'PUT')
          )
        )
      ).toEqual({ email: 'mentions', frequency: 'daily' });
    });

    it('groups a daily digest by record and sends it once, with two workers at the same time', async () => {
      const w = await world();
      await setFrequency(w, 'editor', 'daily');
      const second = await newRecord(w, 'Second <record>');
      await comment(w, 'owner', `First ${mentionToken(w.editor.id, 'Ed')} <b>bold</b>`);
      await comment(w, 'owner', `Again ${mentionToken(w.editor.id, 'Ed')}`);
      await commentOn(w, 'editor', second.id, 'I start this thread');
      await commentOn(w, 'commenter', second.id, 'A reply for Ed');
      // The immediate mailer leaves digest recipients alone (the commenter is immediate).
      expect(await w.mailer.run()).toEqual({ sent: 0, skipped: 0 });

      // Two worker processes run the daily digest at the same moment.
      const a = mailerFor(w);
      const b = mailerFor(w);
      const results = await Promise.all([a.runDigest('daily'), b.runDigest('daily')]);
      const mails = [...a.mailbox.sent, ...b.mailbox.sent];
      expect(results.reduce((n, r) => n + r.sent, 0)).toBe(1);
      expect(mails).toHaveLength(1);
      const mail = mails[0];
      if (!mail) throw new Error('no mail');
      expect(mail.to).toBe(w.editor.email);
      expect(mail.subject).toBe('Your daily OpenRows digest: 3 new notifications');
      // Grouped by record, the latest activity first; names escaped, excerpts only.
      expect(mail.html.indexOf('Second &lt;record&gt;')).toBeLessThan(
        mail.html.indexOf('Launch &lt;plan&gt;')
      );
      expect(mail.html).not.toContain('<b>bold</b>');
      expect(mail.html).not.toContain('TOP SECRET');
      expect(mail.text).toContain('Olive Owner mentioned you: "First @Ed');
      expect(mail.text).toContain('replied: "A reply for Ed"');
      expect(mail.text).toContain(
        `http://localhost:5173/b/${w.base.id}/${w.table.id}?record=${second.id}&comment=`
      );
      expect(mail.headers?.['List-Unsubscribe']).toMatch(
        /^<http:\/\/localhost:5173\/email\/unsubscribe\?token=/
      );
      expect(mail.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
      const states = await t.db
        .select({ state: notifications.emailState })
        .from(notifications)
        .where(eq(notifications.userId, w.editor.id));
      expect(states.map((r) => r.state)).toEqual(['sent', 'sent', 'sent']);
      // Nothing left: a retry or the next day's run sends nothing more.
      expect(await a.runDigest('daily')).toEqual({ sent: 0, skipped: 0 });
      // The hourly digest isn't the daily one's.
      expect(await a.runDigest('hourly')).toEqual({ sent: 0, skipped: 0 });
      expect([...a.mailbox.sent, ...b.mailbox.sent]).toHaveLength(1);
    });

    it('runs the digest as a pg-boss job once across two workers', async () => {
      const w = await world();
      await setFrequency(w, 'editor', 'hourly');
      await comment(w, 'owner', `One ${mentionToken(w.editor.id, 'Ed')}`);
      await comment(w, 'owner', `Two ${mentionToken(w.editor.id, 'Ed')}`);
      const mailbox = memoryTransport();
      const deps = {
        db: t.appDb,
        logger: createLogger({ level: 'silent' }),
        revisionDays: 365,
        notifications: {
          email: mailbox,
          appUrl: 'http://localhost:5173',
          secret: testApp().config.encryptionKey,
        },
      };
      const only = () => {
        const q = builtinQueues(deps)['notifications.digest.hourly'];
        if (!q) throw new Error('no digest queue');
        return { 'notifications.digest.hourly': q };
      };
      const workers = await Promise.all(
        ['one', 'two'].map((name) =>
          startWorker(deps, {
            connectionString: t.appUrl,
            instanceName: name,
            queues: only(),
            pollingIntervalSeconds: 0.5,
            maxConnections: 3,
          })
        )
      );
      try {
        await Promise.all(workers.map((wk) => wk.boss.send('notifications.digest.hourly', null)));
        const deadline = Date.now() + 20_000;
        for (;;) {
          const q = await workers[0]?.boss.getQueue('notifications.digest.hourly');
          if (mailbox.sent.length > 0 && q && q.queuedCount + q.activeCount === 0) break;
          if (Date.now() > deadline) throw new Error('the digest job did not run');
          await new Promise((r) => setTimeout(r, 200));
        }
      } finally {
        await Promise.all(workers.map((wk) => wk.stop(2_000)));
      }
      expect(mailbox.sent).toHaveLength(1);
      expect(mailbox.sent[0]?.subject).toBe('Your hourly OpenRows digest: 2 new notifications');
    });

    it('re-checks access and the preference at digest time, and puts back a failed send', async () => {
      const w = await world();
      await setFrequency(w, 'editor', 'daily');
      await setFrequency(w, 'guest', 'daily');
      await setFrequency(w, 'commenter', 'daily');
      await json(
        w.clients.commenter.request(
          '/api/me/notification-preferences',
          send({ email: 'none' }, 'PUT')
        )
      );
      await comment(
        w,
        'owner',
        `${mentionToken(w.editor.id, 'Ed')} ${mentionToken(w.guest.id, 'Gus')} ${mentionToken(w.commenter.id, 'Cy')}`
      );
      // The guest loses the base before the digest.
      await t.db
        .delete(baseMembers)
        .where(and(eq(baseMembers.baseId, w.base.id), eq(baseMembers.userId, w.guest.id)));
      // The relay is down for the first send.
      let failNext = true;
      const flaky = memoryTransport();
      const transport = {
        sent: flaky.sent,
        async send(m: Parameters<typeof flaky.send>[0]) {
          if (failNext) {
            failNext = false;
            throw new Error('connection refused');
          }
          await flaky.send(m);
        },
      };
      const m = mailerFor(w, transport);
      await expect(m.runDigest('daily')).rejects.toThrow('connection refused');
      const editorState = async () =>
        (
          await t.db
            .select({ state: notifications.emailState })
            .from(notifications)
            .where(eq(notifications.userId, w.editor.id))
        ).map((r) => r.state);
      expect(await editorState()).toEqual(['pending']);
      // pg-boss's retry: now it goes out, once.
      expect(await m.runDigest('daily')).toEqual({ sent: 1, skipped: 0 });
      expect(flaky.sent.map((x) => x.to)).toEqual([w.editor.email]);
      expect(await editorState()).toEqual(['sent']);
      const others = await t.db
        .select({ userId: notifications.userId, state: notifications.emailState })
        .from(notifications)
        .where(sql`${notifications.userId} IN (${w.guest.id}, ${w.commenter.id})`);
      expect(others).toEqual(
        expect.arrayContaining([
          { userId: w.guest.id, state: 'skipped' },
          { userId: w.commenter.id, state: 'skipped' },
        ])
      );
    });

    it('offers a daily digest on the unsubscribe page', async () => {
      const w = await world();
      const { app, config } = testApp({ db: t.appDb });
      const token = unsubscribeToken(config.encryptionKey, w.editor.id);
      const url = `/email/unsubscribe?token=${encodeURIComponent(token)}`;
      expect(await (await app.request(url)).text()).toContain('One daily digest instead');
      const res = await app.request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'email=daily',
      });
      expect(res.status).toBe(200);
      const [row] = await t.db.select().from(users).where(eq(users.id, w.editor.id));
      expect(row?.notificationFrequency).toBe('daily');
      expect(row?.notificationEmail).toBe('all');
    });
  });

  it('unsubscribes with the signed link: GET shows a page, POST (and one-click) lowers it', async () => {
    const w = await world();
    const { app, config } = testApp({ db: t.appDb });
    const token = unsubscribeToken(config.encryptionKey, w.editor.id);
    const url = `/email/unsubscribe?token=${encodeURIComponent(token)}`;
    const pref = async () =>
      (await t.db.select().from(users).where(eq(users.id, w.editor.id)))[0]?.notificationEmail;

    const page = await app.request(url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Unsubscribe from all');
    expect(await pref()).toBe('all');
    // Tampered tokens, another user's id with this signature, garbage: 400 and nothing changes.
    const forged = `${w.guest.id}.${token.split('.')[1]}`;
    for (const bad of [`${token}x`, forged, 'junk', '']) {
      const res = await app.request(`/email/unsubscribe?token=${encodeURIComponent(bad)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'email=none',
      });
      expect(res.status, bad).toBe(400);
    }
    expect(await pref()).toBe('all');

    const form = (body: string) =>
      app.request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
        body,
      });
    expect((await form('email=mentions')).status).toBe(200);
    expect(await pref()).toBe('mentions');
    // RFC 8058 one-click from a mail provider: no Origin, no cookie.
    const oneClick = await app.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(oneClick.status).toBe(200);
    expect(await pref()).toBe('none');
    // The link never raises the preference again.
    await form('email=mentions');
    expect(await pref()).toBe('none');
  });

  it('needs a session for every inbox route', async () => {
    const { app } = testApp({ db: t.appDb });
    for (const [method, path] of [
      ['GET', '/api/notifications'],
      ['GET', '/api/notifications/unread'],
      ['POST', '/api/notifications/read'],
      ['GET', '/api/me/notification-preferences'],
    ] as const) {
      const res = await app.request(path, { method, headers: { origin: ORIGIN } });
      expect(res.status, path).toBe(401);
    }
  });
});
