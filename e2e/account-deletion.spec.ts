import AxeBuilder from '@axe-core/playwright';
import { KEYCLOAK_URL, signUp } from './helpers/stack.js';
import { expect, test } from './helpers/test.js';

// Deleting an account end to end against the Compose stack (E2E_STACK=1): a new user signs
// up, opens Settings → Delete account, enters their password again at Keycloak, types their
// email and deletes the account; the worker's purge deletes their Keycloak user within seconds,
// so the same credentials no longer sign in.
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

test('a user deletes their account; the purge removes them from Keycloak too', async ({
  page,
  playwright,
}) => {
  test.setTimeout(120_000);
  const user = {
    email: `deleted-${Date.now()}@openrows.test`,
    firstName: 'Dee',
    lastName: 'Leted',
    password: 'delete-me-password-1',
  };
  await signUp(page, user);

  await page.goto('/settings');
  await page.getByRole('button', { name: 'Delete account…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete your account?' });
  // Their personal workspace goes with them.
  await expect(dialog.getByText('Deleted with your account, with all its bases.')).toBeVisible();
  const confirm = dialog.getByRole('textbox');
  // They signed in a moment ago (a fresh auth_time): no password prompt needed yet.
  await expect(confirm).toBeVisible();

  // "Confirm it's you" (shown after 10 minutes) goes here: Keycloak asks for the password again
  // despite its session (prompt=login), then sends them back to the open dialog.
  await page.goto('/auth/login?reauth=1&returnTo=%2Fsettings%3Fdelete-account%3D1');
  // Keycloak's re-authentication form may show the username as text, not as a field.
  await expect(page.locator('#password')).toBeVisible();
  const username = page.locator('#username');
  if ((await username.count()) > 0 && (await username.isEditable())) {
    await username.fill(user.email);
  }
  await page.locator('#password').fill(user.password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(confirm).toBeVisible();
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(axe.violations).toEqual([]);

  const remove = dialog.getByRole('button', { name: 'Delete my account' });
  await expect(remove).toBeDisabled();
  await confirm.fill(user.email.toUpperCase());
  await remove.click();
  await expect(page).toHaveURL(/\/login\?error=account_deleted$/);
  await expect(page.getByRole('status')).toContainText('Your account has been deleted');
  expect((await page.request.get('/api/me')).status()).toBe(401);

  // The worker's purge.deleted job (sent by the request) deletes the Keycloak user.
  const admin = await playwright.request.newContext({ baseURL: KEYCLOAK_URL });
  const token = await admin.post('/realms/master/protocol/openid-connect/token', {
    form: { grant_type: 'password', client_id: 'admin-cli', username: 'admin', password: 'admin' },
  });
  expect(token.ok()).toBe(true);
  const { access_token: accessToken } = (await token.json()) as { access_token: string };
  await expect
    .poll(
      async () => {
        const res = await admin.get(
          `/admin/realms/openrows/users?exact=true&email=${encodeURIComponent(user.email)}`,
          { headers: { authorization: `Bearer ${accessToken}` } }
        );
        return ((await res.json()) as unknown[]).length;
      },
      { timeout: 60_000, intervals: [1_000] }
    )
    .toBe(0);
  await admin.dispose();

  // Signing in with the old credentials fails at Keycloak.
  await page.goto('/auth/login');
  await page.locator('#username').fill(user.email);
  await page.locator('#password').fill(user.password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page.getByText(/Invalid username or password/i)).toBeVisible();
});
