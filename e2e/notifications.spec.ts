import { execFileSync } from 'node:child_process';
import AxeBuilder from '@axe-core/playwright';
import { latestMessageTo } from './auth/mailpit.js';
import { signInDevUser, signUp } from './helpers/stack.js';
import { expect, test, watchCsp } from './helpers/test.js';

// Notifications against the whole Compose stack (E2E_STACK=1, Mailpit on :8025): the dev
// user mentions a collaborator in a comment; the collaborator's bell counts it live, the inbox
// deep link opens the record at the comment, and the mention email arrives in Mailpit. Digests
// : a collaborator on the daily digest is mentioned with a chip from the composer, and the
// digest (queued now with the worker's run CLI, as its 08:00 UTC cron would) arrives in Mailpit.
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

type Table = { id: string; fields: { id: string; name: string }[] };

test('a mention reaches the bell, deep-links to the comment and arrives by email', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const guest = {
    email: `notified-${stamp}@openrows.test`,
    firstName: 'Nora',
    lastName: 'Notified',
    password: 'notifications-spec-password-1',
  };
  await signInDevUser(page);
  const origin = new URL(page.url()).origin;
  const post = async <T>(path: string, data: unknown, request = page.request): Promise<T> => {
    const res = await request.post(path, { data, headers: { origin } });
    expect(res.status(), path).toBeLessThan(300);
    return (await res.json()) as T;
  };
  const ws = await post<{ id: string }>('/api/workspaces', { name: `Notify ${stamp}` });
  const base = await post<{ id: string }>(`/api/workspaces/${ws.id}/bases`, { name: 'Launch' });
  const table = await post<Table>(`/api/bases/${base.id}/tables`, { name: 'Tasks' });
  const name = table.fields.find((f) => f.name === 'Name')?.id ?? '';
  const {
    records: [record],
  } = await post<{ records: { id: string }[] }>(`/api/tables/${table.id}/records`, {
    records: [{ fields: { [name]: 'Launch plan' } }],
  });

  const context = await browser.newContext();
  const violations = await watchCsp(context, origin);
  const other = await context.newPage();
  try {
    await test.step('a collaborator signs up and joins the base', async () => {
      await signUp(other, guest);
      await post(`/api/bases/${base.id}/invitations`, { email: guest.email, role: 'commenter' });
      const mail = await latestMessageTo(guest.email, 15_000, 'invited you');
      const token = mail.match(/\/invite\/([A-Za-z0-9_-]{43})/)?.[1] ?? '';
      expect(token, 'invitation token in the email').toBeTruthy();
      await post(`/api/invitations/${token}/accept`, {}, other.request);
    });

    const me = (await (await other.request.get('/api/me')).json()) as { user: { id: string } };
    const bell = other.getByRole('button', { name: /^Notifications/ });

    await test.step('the mention shows on the bell, live', async () => {
      await other.goto(`/b/${base.id}/${table.id}`);
      await expect(other.getByRole('grid')).toBeVisible();
      await expect(other.getByTestId('connection-status')).toHaveAttribute('data-status', 'live');
      await expect(bell).toHaveAccessibleName('Notifications');
      const comment = await post<{ id: string }>(
        `/api/tables/${table.id}/records/${record?.id}/comments`,
        { body: `Can you review this, @[Nora](user:${me.user.id})?` }
      );
      await expect(bell).toHaveAccessibleName('Notifications, 1 unread', { timeout: 10_000 });
      await expect(other.getByTestId('notification-count')).toHaveText('1');

      await bell.click();
      const inbox = other.getByRole('region', { name: 'Notifications' });
      const item = inbox.getByRole('button', { name: /mentioned you on Launch plan/ });
      await expect(item).toContainText('Can you review this, @Nora?');
      const axe = await new AxeBuilder({ page: other })
        .include('[aria-label="Notifications"]')
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze();
      expect(
        axe.violations
          .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
          .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))
      ).toEqual([]);

      await item.click();
      await expect(other).toHaveURL(
        new RegExp(
          `/b/${base.id}/${table.id}/[0-9a-f-]+\\?record=${record?.id}&comment=${comment.id}`
        )
      );
      const linked = other.locator(`[data-testid="comment"][data-comment-id="${comment.id}"]`);
      await expect(linked).toBeVisible();
      await expect(linked).toHaveAttribute('aria-current', 'true');
      // Opened is read (the record modal hides the top bar from the accessibility tree).
      await expect
        .poll(
          async () => (await (await other.request.get('/api/notifications/unread')).json()).unread
        )
        .toBe(0);
    });

    await test.step('the mention email arrives in Mailpit with the deep link', async () => {
      const mail = await latestMessageTo(guest.email, 30_000, 'mentioned you on Launch plan');
      expect(mail).toContain('Can you review this, @Nora?');
      expect(mail).toContain(`/b/${base.id}/${table.id}?record=${record?.id}&comment=`);
      expect(mail).toMatch(/Unsubscribe: https?:\/\/\S+\/email\/unsubscribe\?token=/);
    });
    expect(violations, 'Content-Security-Policy violations').toEqual([]);
  } finally {
    await context.close();
  }
});

test('a mention picked as a chip arrives in the daily digest', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const guest = {
    email: `digest-${stamp}@openrows.test`,
    firstName: 'Dora',
    lastName: 'Digest',
    password: 'digest-spec-password-1',
  };
  await signInDevUser(page);
  const origin = new URL(page.url()).origin;
  const post = async <T>(path: string, data: unknown, request = page.request): Promise<T> => {
    const res = await request.post(path, { data, headers: { origin } });
    expect(res.status(), path).toBeLessThan(300);
    return (await res.json()) as T;
  };
  const ws = await post<{ id: string }>('/api/workspaces', { name: `Digest ${stamp}` });
  const base = await post<{ id: string }>(`/api/workspaces/${ws.id}/bases`, { name: 'Ops' });
  const table = await post<Table>(`/api/bases/${base.id}/tables`, { name: 'Tasks' });
  const name = table.fields.find((f) => f.name === 'Name')?.id ?? '';
  const {
    records: [record],
  } = await post<{ records: { id: string }[] }>(`/api/tables/${table.id}/records`, {
    records: [{ fields: { [name]: 'Quarterly review' } }],
  });

  const context = await browser.newContext();
  const violations = await watchCsp(context, origin);
  const other = await context.newPage();
  try {
    await test.step('a collaborator joins the base and picks the daily digest', async () => {
      await signUp(other, guest);
      await post(`/api/bases/${base.id}/invitations`, { email: guest.email, role: 'commenter' });
      const mail = await latestMessageTo(guest.email, 15_000, 'invited you');
      const token = mail.match(/\/invite\/([A-Za-z0-9_-]{43})/)?.[1] ?? '';
      expect(token, 'invitation token in the email').toBeTruthy();
      await post(`/api/invitations/${token}/accept`, {}, other.request);
      await other.goto('/settings');
      const daily = other.getByRole('button', { name: 'Daily digest' });
      await daily.click();
      await expect(daily).toHaveAttribute('aria-pressed', 'true');
      await other.reload();
      await expect(other.getByRole('button', { name: 'Daily digest' })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
    });

    await test.step('the dev user mentions them with a chip', async () => {
      await page.goto(`/b/${base.id}/${table.id}?record=${record?.id}`);
      const panel = page.getByTestId('comments-panel');
      await expect(panel.getByText('No comments yet.')).toBeVisible();
      const box = panel.getByRole('combobox', { name: 'Write a comment' });
      await box.click();
      await box.pressSequentially('Numbers for @Dor');
      const option = page
        .getByRole('listbox', { name: 'People to mention' })
        .getByRole('option', { name: /Dora Digest/ });
      await expect(option).toBeVisible();
      await page.keyboard.press('Enter');
      const chip = box.getByTestId('mention-chip');
      await expect(chip).toHaveText('@Dora Digest');
      await box.pressSequentially('by Friday');
      await page.keyboard.press('ControlOrMeta+Enter');
      const comment = panel.getByTestId('comment');
      await expect(comment).toHaveCount(1);
      await expect(comment.getByTestId('mention')).toHaveText('@Dora Digest');
      await expect(box).toHaveText('');
      const axe = await new AxeBuilder({ page })
        .include('[data-testid="comments-panel"]')
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze();
      expect(
        axe.violations
          .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
          .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))
      ).toEqual([]);
    });

    await test.step('the daily digest arrives in Mailpit', async () => {
      // What the 08:00 UTC cron does: one digest run, by the stack's worker.
      execFileSync('node', ['packages/server/dist/jobs/run-cli.js', 'notifications.digest.daily'], {
        encoding: 'utf8',
        timeout: 60_000,
      });
      const mail = await latestMessageTo(guest.email, 30_000, 'daily OpenRows digest');
      expect(mail).toContain('Quarterly review');
      expect(mail).toContain('mentioned you: "Numbers for @Dora Digest by Friday"');
      expect(mail).toContain(`/b/${base.id}/${table.id}?record=${record?.id}&comment=`);
      expect(mail).toMatch(/Unsubscribe: https?:\/\/\S+\/email\/unsubscribe\?token=/);
    });
    expect(violations, 'Content-Security-Policy violations').toEqual([]);
  } finally {
    await context.close();
  }
});
