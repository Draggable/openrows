import { expect, test } from '../helpers/test.js';
import { APP_URL, KEYCLOAK_URL } from './env.js';
import { latestMessageTo } from './mailpit.js';

// A new user signs up through the Keycloak registration form, verifies their email from the
// message Mailpit caught, sets a password and lands on the signed-in home page. Then they sign
// out and back in.
test('sign up, verify the email, land on home; sign out and sign in again', async ({ page }) => {
  const email = `e2e-${Date.now()}@openrows.test`;
  const password = 'correct-horse-battery-staple';

  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole('link', { name: 'Create account' }).click();

  // Keycloak's registration page (prompt=create). Keycloak 26.7 asks for the password only
  // after the address is verified, so the form has email and names.
  await expect(page).toHaveURL(new RegExp(`^${KEYCLOAK_URL}/realms/openrows/`));
  await page.locator('#email').fill(email);
  await page.locator('#firstName').fill('Erin');
  await page.locator('#lastName').fill('Tester');
  await page.getByRole('button', { name: 'Register' }).click();

  // verifyEmail is on: Keycloak holds the sign-in until the address is confirmed.
  await expect(page.getByText(/verify your email/i).first()).toBeVisible();
  const text = await latestMessageTo(email);
  const link = text.match(/https?:\/\/\S+action-token\S+/)?.[0];
  expect(link, 'verification link in the email').toBeTruthy();
  await page.goto(link ?? '');

  // Now the password, then Keycloak finishes the authorization request back to the app.
  await expect(page.getByRole('heading', { name: 'Update password' })).toBeVisible();
  await page.getByRole('textbox', { name: 'New Password' }).fill(password);
  await page.getByRole('textbox', { name: 'Confirm password' }).fill(password);
  await page.getByRole('button', { name: 'Submit' }).click();

  // Back in the app, signed in.
  await expect(page).toHaveURL(`${APP_URL}/`);
  await expect(page.getByTestId('current-user')).toContainText('Erin Tester');
  await expect(page.getByTestId('current-user')).toContainText(email);
  const me = await page.request.get('/api/me');
  expect(me.status()).toBe(200);
  expect(await me.json()).toMatchObject({ user: { email, name: 'Erin Tester' } });

  // Sign out: the app session ends and Keycloak's session too (RP-initiated logout).
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get('/api/me')).status()).toBe(401);

  // Sign in again with the password: Keycloak asks for credentials, so its session is gone.
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`^${KEYCLOAK_URL}/realms/openrows/`));
  await page.locator('#username').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(`${APP_URL}/`);
  await expect(page.getByTestId('current-user')).toContainText('Erin Tester');
});

test('the seeded dev user can sign in', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await page.locator('#username').fill('dev@openrows.test');
  await page.locator('#password').fill('openrows-dev-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(`${APP_URL}/`);
  await expect(page.getByTestId('current-user')).toContainText('dev@openrows.test');
});
