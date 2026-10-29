import AxeBuilder from '@axe-core/playwright';
import { signInDevUser } from './helpers/stack.js';
import { expect, test } from './helpers/test.js';

// Personal access tokens against the whole Compose stack (E2E_STACK=1): create a token in
// Settings, call GET /api/workspaces with it (no cookie), revoke it, and get 401.
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

test('creates a token in Settings, calls the API with it, revokes it', async ({
  page,
  playwright,
}) => {
  await signInDevUser(page);
  const origin = new URL(page.url()).origin;
  const name = `Tokens ${Date.now()}`;
  const created = await page.request.post('/api/workspaces', {
    data: { name },
    headers: { origin },
  });
  expect(created.status()).toBe(201);
  const workspace = (await created.json()) as { id: string };

  await page.goto('/settings');
  const section = page.getByRole('region', { name: 'Developer: personal access tokens' });
  await section.getByRole('button', { name: 'Create token' }).click();
  const form = page.getByRole('dialog', { name: 'Create a personal access token' });
  await form.getByLabel('Name').fill('E2E token');
  await form.getByRole('checkbox', { name: /schema\.bases:read/ }).check();
  await form.getByRole('checkbox', { name: `All bases in ${name}` }).check();
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    axe.violations
      .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
      .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))
  ).toEqual([]);
  await form.getByRole('button', { name: 'Create token' }).click();

  const shown = page.getByRole('dialog', { name: 'Copy your new token' });
  const field = shown.getByLabel('Token');
  await expect(field).toHaveValue(/^or_pat_[a-z2-7]{12}_[A-Za-z0-9_-]{43}$/);
  const token = await field.inputValue();
  await shown.getByRole('button', { name: 'Done' }).click();

  // A fresh context: no session cookie, only the bearer token.
  const api = await playwright.request.newContext({ baseURL: origin });
  const auth = { authorization: `Bearer ${token}` };
  const listed = await api.get('/api/workspaces', { headers: auth });
  expect(listed.status()).toBe(200);
  const { workspaces } = (await listed.json()) as { workspaces: { id: string }[] };
  expect(workspaces.map((w) => w.id)).toEqual([workspace.id]);

  // The list shows when it was last used.
  await page.reload();
  const row = section.getByRole('listitem').filter({ hasText: 'E2E token' });
  await expect(row).toContainText('Last used');
  page.once('dialog', (d) => void d.accept());
  await row.getByRole('button', { name: 'Revoke E2E token' }).click();
  await expect(row).toHaveCount(0);

  const revoked = await api.get('/api/workspaces', { headers: auth });
  expect(revoked.status()).toBe(401);
  await api.dispose();
});
