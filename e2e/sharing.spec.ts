import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { latestMessageTo } from './auth/mailpit.js';
import { signInDevUser, signUp } from './helpers/stack.js';
import { expect, test, watchCsp } from './helpers/test.js';

// Sharing a base against the whole Compose stack (E2E_STACK=1): the dev user shares one
// base of a new workspace from the base's Share dialog; the invitee signs up through Keycloak,
// accepts the emailed link and sees just that base: on Home, in the sidebar, and a deep link to
// the workspace's other base is the not-found page.
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

async function expectNoSeriousAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const serious = results.violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? '')
  );
  expect(
    serious.flatMap((v) =>
      v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}: ${n.failureSummary}`)
    )
  ).toEqual([]);
}

test('invite a base-only collaborator, who signs in and sees just that base', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const guest = {
    email: `guest-${stamp}@openrows.test`,
    firstName: 'Gina',
    lastName: 'Guest',
    password: 'sharing-spec-password-1',
  };
  const names = { workspace: `Shared ${stamp}`, shared: 'Shared roadmap', other: 'Private budget' };

  await signInDevUser(page);
  const origin = new URL(page.url()).origin;
  const post = async <T>(path: string, data: unknown): Promise<T> => {
    const res = await page.request.post(path, { data, headers: { origin } });
    expect(res.status(), path).toBe(201);
    return (await res.json()) as T;
  };
  const ws = await post<{ id: string }>('/api/workspaces', { name: names.workspace });
  const shared = await post<{ id: string }>(`/api/workspaces/${ws.id}/bases`, {
    name: names.shared,
  });
  const other = await post<{ id: string }>(`/api/workspaces/${ws.id}/bases`, {
    name: names.other,
  });
  await post(`/api/bases/${shared.id}/tables`, { name: 'Features' });
  await post(`/api/bases/${other.id}/tables`, { name: 'Costs' });

  let inviteLink = '';
  await test.step('share the base from its Share dialog', async () => {
    await page.goto(`/b/${shared.id}`);
    await expect(page.getByRole('columnheader', { name: 'Name' })).toBeVisible();
    await page.getByRole('button', { name: 'Share' }).click();
    const dialog = page.getByRole('dialog', { name: `Share ${names.shared}` });
    await expect(dialog.getByRole('list', { name: 'People with access' })).toContainText('(you)');
    await dialog.getByLabel('Email', { exact: true }).fill(guest.email);
    await dialog.getByLabel('Role on this base').selectOption('editor');
    await dialog.getByRole('button', { name: 'Invite' }).click();
    await expect(
      dialog.getByRole('list', { name: 'Pending base invitations' }).getByText(guest.email)
    ).toBeVisible();
    await expectNoSeriousAxeViolations(page);
    const mail = await latestMessageTo(guest.email);
    expect(mail).toContain(names.shared);
    inviteLink = mail.match(/https?:\/\/\S+\/invite\/[A-Za-z0-9_-]+/)?.[0] ?? '';
    expect(inviteLink, 'invitation link in the email').toBeTruthy();
  });

  await test.step('the invitee signs up, accepts and sees just that base', async () => {
    const context = await browser.newContext();
    const violations = await watchCsp(context, origin);
    const guestPage = await context.newPage();
    try {
      await signUp(guestPage, guest);
      await guestPage.goto(new URL(inviteLink).pathname);
      await expect(guestPage.getByRole('heading', { name: `Join ${names.shared}` })).toBeVisible();
      await guestPage.getByRole('button', { name: 'Accept invitation' }).click();
      await expect(guestPage).toHaveURL(new RegExp(`/b/${shared.id}/`));
      await expect(guestPage.getByRole('columnheader', { name: 'Name' })).toBeVisible();
      // An editor doesn't manage the base's people.
      await expect(guestPage.getByRole('button', { name: 'Share' })).toHaveCount(0);

      await guestPage.goto(`/w/${ws.id}`);
      const section = guestPage.getByRole('region', { name: names.workspace });
      await expect(section.getByText('Bases shared with you')).toBeVisible();
      await expect(section.getByRole('link', { name: new RegExp(names.shared) })).toBeVisible();
      await expect(section.getByRole('link', { name: new RegExp(names.other) })).toHaveCount(0);
      const sidebar = guestPage.getByRole('navigation', { name: 'Bases' });
      await expect(sidebar.getByRole('link', { name: names.shared })).toBeVisible();
      await expect(sidebar.getByRole('link', { name: names.other })).toHaveCount(0);
      await expect(
        guestPage.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Members' })
      ).toHaveCount(0);
      await expectNoSeriousAxeViolations(guestPage);

      // A deep link to the other base is a 404.
      await guestPage.goto(`/b/${other.id}`);
      await expect(
        guestPage.getByRole('heading', { name: "This page doesn't exist or you don't have access" })
      ).toBeVisible();
      expect((await guestPage.request.get(`/api/bases/${other.id}`)).status()).toBe(404);
      expect(violations, 'Content-Security-Policy violations').toEqual([]);
    } finally {
      await context.close();
    }
  });

  await test.step('the owner sees the guest with their base role', async () => {
    await page.reload();
    await page.getByRole('button', { name: 'Share' }).click();
    const people = page
      .getByRole('dialog', { name: `Share ${names.shared}` })
      .getByRole('list', { name: 'People with access' });
    await expect(people).toContainText('Gina Guest');
    await expect(people).toContainText('Base only');
    await expect(page.getByLabel('Role of Gina Guest on this base')).toHaveValue('editor');
  });
});
