import AxeBuilder from '@axe-core/playwright';
import { latestMessageTo } from './auth/mailpit.js';
import { signInDevUser, signUp, stackApi } from './helpers/stack.js';
import { expect, test, watchCsp } from './helpers/test.js';

// Interface-only collaborators against the whole Compose stack (E2E_STACK=1): the dev user
// installs the Bug tracker template, whose sample interface "Bug desk" comes published, and
// invites someone to that interface only. They sign up, accept, land on the interface, report a
// bug through its form page, see the board, and get a 404 from the base's API.
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

type List = { interfaces: { id: string; name: string; pages: { id: string; name: string }[] }[] };

test('an interface-only collaborator uses the sample interface and nothing else', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  await signInDevUser(page);
  const api = stackApi(page);
  const workspace = await api.post<{ id: string }>('/api/workspaces', {
    name: `Bug desk ${stamp}`,
  });
  const base = await api.post<{ id: string }>(`/api/workspaces/${workspace.id}/templates`, {
    slug: 'bug-tracker',
  });
  const list = await api.get<List>(`/api/bases/${base.id}/interfaces`);
  const desk = list.interfaces.find((i) => i.name === 'Bug desk');
  expect(desk?.pages.map((p) => p.name)).toEqual([
    'Report a bug',
    'Triage board',
    'Open bugs',
    'Overview',
  ]);

  const guest = {
    email: `interface-guest-${stamp}@openrows.test`,
    firstName: 'Gus',
    lastName: 'Guest',
    password: 'interface-guest-password',
  };
  await api.post(`/api/interfaces/${desk?.id}/collaborators`, {
    email: guest.email,
    role: 'editor',
  });
  const link = (await latestMessageTo(guest.email)).match(
    /https?:\/\/\S+\/invite\/[A-Za-z0-9_-]+/
  )?.[0];
  expect(link, 'invitation link in the email').toBeTruthy();

  const context = await browser.newContext({ baseURL });
  const violations = await watchCsp(context, new URL(baseURL ?? 'http://localhost').origin);
  try {
    const b = await context.newPage();
    await signUp(b, guest);
    await b.goto(new URL(link ?? '').pathname);
    await expect(b.getByText(/the interface/)).toBeVisible();
    await b.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(b).toHaveURL(new RegExp(`/i/${desk?.id}`));

    await test.step('the form page adds a bug', async () => {
      await expect(b.getByRole('heading', { name: 'Report a bug', level: 1 })).toBeVisible();
      await b.getByLabel('What went wrong?').fill(`Guest report ${stamp}`);
      await b.getByLabel('Severity').selectOption({ label: 'Minor' });
      await b.getByRole('button', { name: 'Report bug' }).click();
      await expect(b.getByText('Thanks! The bug is in the triage queue.')).toBeVisible();
    });

    await test.step('the board shows the bugs in stacks', async () => {
      await b
        .getByRole('navigation', { name: 'Pages' })
        .getByRole('link', { name: 'Triage board' })
        .click();
      await expect(b.getByText(`Guest report ${stamp}`)).toBeVisible();
      const axe = await new AxeBuilder({ page: b })
        .include('main')
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze();
      expect(
        axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
      ).toEqual([]);
    });

    await test.step('the base and its grid stay out of reach', async () => {
      expect((await b.request.get(`/api/bases/${base.id}`)).status()).toBe(404);
      expect((await b.request.get(`/api/bases/${base.id}/interfaces`)).status()).toBe(404);
      await b.goto('/');
      await expect(
        b.getByRole('region', { name: 'Interfaces shared with you' }).getByRole('link', {
          name: /Bug desk/,
        })
      ).toBeVisible();
    });
  } finally {
    await context.close();
  }
  expect(violations).toEqual([]);
});
