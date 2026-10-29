import type { BrowserContext } from '@playwright/test';
import { cookieInventory } from './helpers/cookies.js';
import { DEV_USER, signInDevUser } from './helpers/stack.js';
import { expect, test } from './helpers/test.js';

// The cookie inventory against the whole Compose stack (E2E_STACK=1): signing in through
// Keycloak, using the app and signing out may set only the cookies docs/legal/cookies.md lists,
// on the app and on Keycloak (both are on localhost in the stack, so names are checked against
// the whole inventory). An unknown cookie fails here until it is documented as strictly needed.
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

async function unknownCookies(context: BrowserContext) {
  const known = cookieInventory();
  return (await context.cookies()).map((c) => c.name).filter((name) => !known.has(name));
}

test('signing in, using the app and signing out set only the listed cookies', async ({
  page,
  context,
}) => {
  expect(cookieInventory()).toContain('openrows_session');

  await signInDevUser(page);
  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === 'openrows_session');
  expect(session, 'the sign-in cookie').toBeTruthy();
  expect(session).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
  expect(await unknownCookies(context)).toEqual([]);

  // The sign-in again (Keycloak skips the password: its SSO session), back to the app.
  await page.goto('/auth/login');
  await expect(page.getByTestId('current-user')).toContainText(DEV_USER.email);
  expect(await unknownCookies(context)).toEqual([]);

  // Signing out ends both sessions (RP-initiated logout) and leaves nothing unlisted.
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await context.cookies()).map((c) => c.name)).not.toContain('openrows_session');
  expect(await unknownCookies(context)).toEqual([]);
});
