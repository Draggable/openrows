import { expect, test } from './helpers/test.js';

// No sign-in provider and no session here: the guard sends visitors to /login. The real
// sign-up and sign-in flow is e2e/auth (npm run e2e:auth, needs the dev Keycloak).
test('signed-out visitors land on the sign-in page', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in to OpenRows' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/auth/login');
  await expect(page.getByRole('link', { name: 'Create account' })).toHaveAttribute(
    'href',
    '/auth/signup'
  );
});

// /health names the edition: `oss` for the built core (no E2E_BASE_URL), `cloud` in CI's
// stack, which runs the image's cloud target like prod (docker/ci.yml sets E2E_EDITION=cloud).
// Against another E2E_BASE_URL (the dev stack, prod) either, unless E2E_EDITION says which.
const EDITION = process.env['E2E_EDITION'] ?? (process.env['E2E_BASE_URL'] ? undefined : 'oss');

test('the API is reachable through the client origin', async ({ request }) => {
  const res = await request.get('/health');
  expect(res.ok()).toBe(true);
  expect(await res.json()).toMatchObject({
    status: 'ok',
    edition: EDITION ?? expect.stringMatching(/^(oss|cloud)$/),
  });
  expect((await request.get('/api/me')).status()).toBe(401);
});
