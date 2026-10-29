import type { NoticeList } from '@openrows/shared';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { legalNoticeDeliveries, legalNotices, users, workspaces } from '../../src/db/schema.js';
import { type EmailMessage, memoryTransport } from '../../src/email/transport.js';
import {
  createNotice,
  NoticeError,
  noticeStatus,
  sendNotice,
  withdrawNotice,
} from '../../src/notices/service.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, authedClient, createUser, createWorkspace } from '../helpers/factories.js';

const ORIGIN = 'http://localhost:5173';
const DAY = 86_400_000;
const APP_URL = 'https://app.openrows.test';

const terms = (days = 20, extra: Record<string, unknown> = {}) => ({
  kind: 'terms' as const,
  title: "We're updating our Terms of Service",
  summary: 'Clearer rules for public forms.\n\nAnd a new section on AI.',
  url: 'https://openrows.io/terms',
  effective: new Date(Date.now() + days * DAY),
  ...extra,
});

/**
 * Service notices: published by the operator's command (createNotice, as openrows_app
 * through legal_notice_create), emailed once per account with a per-run log, shown as a banner
 * to the accounts they concern until each dismisses it.
 */
describe('service notices', () => {
  const t = useTestDb();

  async function banner(client: Awaited<ReturnType<typeof authedClient>>) {
    const res = await client.request('/api/me/notices');
    expect(res.status).toBe(200);
    return ((await res.json()) as NoticeList).notices;
  }
  const dismiss = (client: Awaited<ReturnType<typeof authedClient>>, id: string) =>
    client.request(`/api/me/notices/${id}/dismiss`, {
      method: 'POST',
      headers: { origin: ORIGIN },
    });

  it('refuses less notice than the Terms promise, and bad input', async () => {
    await expect(createNotice(t.appDb, terms(13))).rejects.toThrow(/at least 14 days/);
    await expect(createNotice(t.appDb, { ...terms(25), kind: 'price' })).rejects.toThrow(
      /at least 30 days/
    );
    await expect(createNotice(t.appDb, { ...terms(10), kind: 'plan' })).rejects.toThrow(
      NoticeError
    );
    await expect(createNotice(t.appDb, { ...terms(), url: 'javascript:alert(1)' })).rejects.toThrow(
      /url/
    );
    await expect(createNotice(t.appDb, { ...terms(), title: 'x'.repeat(121) })).rejects.toThrow(
      /title/
    );
    await expect(
      createNotice(t.appDb, { ...terms(), kind: 'service', effective: new Date(Date.now() - DAY) })
    ).rejects.toThrow(/future/);
    // A service notice needs no minimum; a price notice goes to owners by default.
    expect((await createNotice(t.appDb, { ...terms(1), kind: 'service' })).audience).toBe(
      'everyone'
    );
    const price = await createNotice(t.appDb, { ...terms(31), kind: 'price' });
    expect(price.audience).toBe('owners');
    await withdrawNotice(t.appDb, price.id);
  });

  it('shows a notice to everyone it concerns until each dismisses it', async () => {
    const { workspace, owner } = await createWorkspace(t.db);
    const editor = await addMember(t.db, workspace.id, 'editor');
    const clients = { owner: await authedClient(t, owner), editor: await authedClient(t, editor) };
    const notice = await createNotice(t.appDb, terms());
    const price = await createNotice(t.appDb, { ...terms(40), kind: 'price', title: 'New prices' });

    const ownerSees = await banner(clients.owner);
    expect(ownerSees.map((n) => n.id)).toEqual(expect.arrayContaining([notice.id, price.id]));
    expect(ownerSees.find((n) => n.id === notice.id)).toMatchObject({
      kind: 'terms',
      title: "We're updating our Terms of Service",
      url: 'https://openrows.io/terms',
    });
    // The price notice is for owners only.
    const editorSees = (await banner(clients.editor)).map((n) => n.id);
    expect(editorSees).toContain(notice.id);
    expect(editorSees).not.toContain(price.id);
    expect((await dismiss(clients.editor, price.id)).status).toBe(404);

    // Dismissing is per user, and twice is fine.
    expect((await dismiss(clients.editor, notice.id)).status).toBe(204);
    expect((await dismiss(clients.editor, notice.id)).status).toBe(204);
    expect((await banner(clients.editor)).map((n) => n.id)).not.toContain(notice.id);
    expect((await banner(clients.owner)).map((n) => n.id)).toContain(notice.id);
    // An unknown notice is a 404.
    expect((await dismiss(clients.owner, '01900000-0000-7000-8000-00000000abcd')).status).toBe(404);

    // Withdrawn: gone for everyone.
    expect(await withdrawNotice(t.appDb, notice.id)).toBe(true);
    expect(await withdrawNotice(t.appDb, notice.id)).toBe(false);
    expect((await banner(clients.owner)).map((n) => n.id)).not.toContain(notice.id);
    await withdrawNotice(t.appDb, price.id);
  });

  it('dismisses a notice past the ten the banner shows', async () => {
    const client = await authedClient(t, await createUser(t.db));
    const many = [];
    for (let i = 0; i < 11; i++) many.push(await createNotice(t.appDb, terms(15 + i)));
    const last = many.at(-1)?.id ?? '';
    const shown = (await banner(client)).map((n) => n.id);
    expect(shown).toHaveLength(10);
    expect(shown).not.toContain(last);
    expect((await dismiss(client, last)).status).toBe(204);
    for (const n of many) await withdrawNotice(t.appDb, n.id);
  });

  it('drops the banner 30 days after the change took effect', async () => {
    const user = await createUser(t.db);
    const client = await authedClient(t, user);
    const recent = await createNotice(t.appDb, terms(15));
    // Back-date two notices (the owner connection; the command never back-dates).
    await t.db
      .update(legalNotices)
      .set({ effectiveAt: new Date(Date.now() - 10 * DAY) })
      .where(eq(legalNotices.id, recent.id));
    const old = await createNotice(t.appDb, terms(15));
    await t.db
      .update(legalNotices)
      .set({ effectiveAt: new Date(Date.now() - 31 * DAY) })
      .where(eq(legalNotices.id, old.id));
    const ids = (await banner(client)).map((n) => n.id);
    expect(ids).toContain(recent.id);
    expect(ids).not.toContain(old.id);
    await withdrawNotice(t.appDb, recent.id);
    await withdrawNotice(t.appDb, old.id);
  });

  it('emails every verified live account once, logs each run and resumes after failures', async () => {
    // Earlier tests' users are recipients too: count this test's own.
    const verified = await createUser(t.db, { email: 'verified@example.test' });
    const unverified = await createUser(t.db, { emailVerified: false });
    const deleted = await createUser(t.db, { deletedAt: new Date() });
    const notice = await createNotice(t.appDb, terms());
    const recipients = await t.db
      .select({ id: users.id })
      .from(users)
      .where(sql`${users.emailVerified} AND ${users.deletedAt} IS NULL`);

    const dry = await sendNotice(
      { db: t.appDb, email: memoryTransport(), appUrl: APP_URL },
      notice.id,
      { dryRun: true }
    );
    expect(dry).toMatchObject({ recipients: recipients.length, sent: 0, dryRun: true });

    // The first run fails for one address; the rest are sent and logged.
    const sent: EmailMessage[] = [];
    const flaky = {
      async send(m: EmailMessage) {
        if (m.to === 'verified@example.test') throw new Error('451 try again later');
        sent.push(m);
      },
    };
    const first = await sendNotice({ db: t.appDb, email: flaky, appUrl: APP_URL }, notice.id, {
      dryRun: false,
    });
    expect(first).toMatchObject({
      recipients: recipients.length,
      sent: recipients.length - 1,
      failed: 1,
      failedUserIds: [verified.id],
    });
    const to = sent.map((m) => m.to);
    expect(to).not.toContain(unverified.email);
    expect(to).not.toContain(deleted.email);
    expect(new Set(to).size).toBe(to.length);
    const [message] = sent;
    expect(message?.subject).toBe("We're updating our Terms of Service");
    expect(message?.text).toContain('Clearer rules for public forms.');
    expect(message?.text).toMatch(/This takes effect on \w+ \d+, \d{4}\./);
    expect(message?.text).toContain('Read the details: https://openrows.io/terms');
    expect(message?.text).toContain(APP_URL);
    expect(message?.html).toContain('href="https://openrows.io/terms"');
    expect(message?.headers?.['List-Unsubscribe']).toBeUndefined();

    // The next run sends only the one that failed, under its own run id.
    const retry = memoryTransport();
    const second = await sendNotice({ db: t.appDb, email: retry, appUrl: APP_URL }, notice.id, {
      dryRun: false,
    });
    expect(second).toMatchObject({ recipients: 1, sent: 1, failed: 0 });
    expect(retry.sent.map((m) => m.to)).toEqual(['verified@example.test']);
    const third = await sendNotice(
      { db: t.appDb, email: memoryTransport(), appUrl: APP_URL },
      notice.id,
      { dryRun: false }
    );
    expect(third.recipients).toBe(0);

    const status = (await noticeStatus(t.appDb)).find((n) => n.id === notice.id);
    expect(status?.runs.map((r) => [r.runId, r.sent])).toEqual([
      [first.runId, recipients.length - 1],
      [second.runId, 1],
    ]);
    await withdrawNotice(t.appDb, notice.id);
    await expect(
      sendNotice({ db: t.appDb, email: memoryTransport(), appUrl: APP_URL }, notice.id, {
        dryRun: false,
      })
    ).rejects.toThrow(/withdrawn/);
  });

  it('emails a price notice only to owners of live workspaces', async () => {
    const owner = (await createWorkspace(t.db)).owner;
    const { workspace } = await createWorkspace(t.db);
    const editor = await addMember(t.db, workspace.id, 'editor');
    const gone = await createWorkspace(t.db);
    await t.db
      .update(workspaces)
      .set({ deletedAt: new Date() })
      .where(eq(workspaces.id, gone.workspace.id));
    const notice = await createNotice(t.appDb, { ...terms(31), kind: 'price', title: 'Prices' });
    const email = memoryTransport();
    await sendNotice({ db: t.appDb, email, appUrl: APP_URL }, notice.id, { dryRun: false });
    const to = email.sent.map((m) => m.to);
    expect(to).toContain(owner.email);
    expect(to).not.toContain(editor.email);
    expect(to).not.toContain(gone.owner.email);
    expect(email.sent[0]?.text).toContain('Billing page');
    await withdrawNotice(t.appDb, notice.id);
  });

  it('refuses to send when too little notice is left or mail would not go out', async () => {
    const notice = await createNotice(t.appDb, terms(15));
    await expect(
      sendNotice({ db: t.appDb, email: memoryTransport(), appUrl: APP_URL }, notice.id, {
        dryRun: false,
        now: new Date(Date.now() + 2 * DAY),
      })
    ).rejects.toThrow(/at least 14 days/);
    await expect(
      sendNotice(
        { db: t.appDb, email: { delivers: false, send: async () => {} }, appUrl: APP_URL },
        notice.id,
        { dryRun: false }
      )
    ).rejects.toThrow(/SMTP_HOST/);
    await withdrawNotice(t.appDb, notice.id);
  });

  it("keeps the notice tables to their functions and each user's own rows (RLS)", async () => {
    const a = await createUser(t.db);
    const b = await createUser(t.db);
    const notice = await createNotice(t.appDb, terms());
    await sendNotice({ db: t.appDb, email: memoryTransport(), appUrl: APP_URL }, notice.id, {
      dryRun: false,
    });
    await dismiss(await authedClient(t, a), notice.id);
    await dismiss(await authedClient(t, b), notice.id);

    // The app role can't write a notice or a delivery itself.
    const denied = { cause: { message: expect.stringMatching(/permission denied/) } };
    await expect(
      t.appDb.execute(
        sql`INSERT INTO legal_notices (id, kind, audience, title, summary, url, effective_at)
            VALUES (gen_random_uuid(), 'terms', 'everyone', 'x', 'x', 'https://x.test', now())`
      )
    ).rejects.toMatchObject(denied);
    await expect(
      t.appDb.execute(sql`UPDATE legal_notices SET title = 'x' WHERE id = ${notice.id}::uuid`)
    ).rejects.toMatchObject(denied);
    await expect(
      t.appDb.execute(sql`DELETE FROM legal_notice_deliveries WHERE notice_id = ${notice.id}::uuid`)
    ).rejects.toMatchObject(denied);

    // Dismissals and deliveries: only your own, and none without a user scope.
    const scoped = async (userId: string, table: string) =>
      t.appDb.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
        const { rows } = await tx.execute<{ user_id: string }>(
          sql`SELECT user_id FROM ${sql.identifier(table)} WHERE notice_id = ${notice.id}::uuid`
        );
        return rows.map((r) => r.user_id);
      });
    expect(await scoped(a.id, 'legal_notice_dismissals')).toEqual([a.id]);
    expect(await scoped(b.id, 'legal_notice_deliveries')).toEqual([b.id]);
    expect(await scoped('', 'legal_notice_deliveries')).toEqual([]);
    await expect(
      t.appDb.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.user_id', ${a.id}, true)`);
        await tx.execute(
          sql`INSERT INTO legal_notice_dismissals (notice_id, user_id) VALUES (${notice.id}::uuid, ${b.id}::uuid) ON CONFLICT DO NOTHING`
        );
      })
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/row-level security/) },
    });
    // Deleting an account removes its dismissals and deliveries with it.
    await t.db.delete(users).where(eq(users.id, a.id));
    const left = await t.db
      .select()
      .from(legalNoticeDeliveries)
      .where(eq(legalNoticeDeliveries.userId, a.id));
    expect(left).toEqual([]);
    await withdrawNotice(t.appDb, notice.id);
  });
});
