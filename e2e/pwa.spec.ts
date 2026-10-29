import { GRID_URL, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// The installable app and its offline read cache, against the built client and the
// mocked API. The service worker is allowed here (other specs block it), and the API is mocked
// on the context, which also answers the worker's own requests.

test.use({ serviceWorkers: 'allow' });

const ME = '00000007-0000-4000-8000-000000000001';

/** The Cache Storage names of the page's origin. */
const cacheNames = (page: import('@playwright/test').Page) =>
  page.evaluate(async () => (await caches.keys()).sort());

test('is installable: the manifest and the service worker pass Chrome’s checks', async ({
  page,
  context,
}) => {
  await mockApi(context, { rows: 5 });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Ada');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // What Lighthouse's "installable manifest" audit asked Chrome: no installability errors.
  const cdp = await context.newCDPSession(page);
  const manifest = await cdp.send('Page.getAppManifest');
  expect(manifest.errors).toEqual([]);
  expect(manifest.url).toMatch(/\/site\.webmanifest$/);
  const parsed = JSON.parse(manifest.data ?? '{}') as Record<string, unknown>;
  expect(parsed).toMatchObject({
    name: 'OpenRows',
    short_name: 'OpenRows',
    display: 'standalone',
    start_url: '/',
    theme_color: '#e22651',
  });
  await expect
    .poll(async () => (await cdp.send('Page.getInstallabilityErrors')).installabilityErrors)
    .toEqual([]);
  // The worker is served fresh on every load, so a deploy is picked up.
  const sw = await page.request.get('/sw.js');
  expect(sw.headers()['cache-control']).toBe('no-cache');
  expect(sw.headers()['content-type']).toMatch(/javascript/);
});

test('shows the last viewed pages offline, read-only, and signing out clears them', async ({
  page,
  context,
}) => {
  await mockApi(context, { rows: 30 });
  await page.goto(GRID_URL);
  const grid = page.getByTestId('grid');
  await expect(grid.locator('[data-cell="0:0"]')).toHaveText('Record 1');
  // Once the worker controls the page, a reload reads the view through it.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await page.reload();
  await expect(grid.locator('[data-cell="0:0"]')).toHaveText('Record 1');
  await expect.poll(() => cacheNames(page)).toContain(`openrows-data-${ME}`);
  await expect(page.getByRole('button', { name: 'Add record' })).toBeVisible();
  await expect(page.getByTestId('app-offline-banner')).toHaveCount(0);

  // Offline: the app shell and the view's records come from the cache, read-only. (Routes
  // would still answer the worker offline, so the mock goes too.)
  await context.setOffline(true);
  await context.unrouteAll({ behavior: 'ignoreErrors' });
  await page.reload();
  await expect(grid.locator('[data-cell="0:0"]')).toHaveText('Record 1');
  await expect(grid.locator('[data-cell="2:0"]')).toHaveText('Record 3');
  await expect(page.getByTestId('app-offline-banner')).toContainText('Offline, read-only.');
  await expect(page.getByRole('button', { name: 'Add record' })).toHaveCount(0);
  await grid.locator('[data-cell="1:0"]').dblclick();
  await expect(grid.getByRole('textbox')).toHaveCount(0);
  // Home was never opened: its bases weren't kept, but the page still loads (the shell).
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

  // Back online, the banner goes and editing comes back.
  await context.setOffline(false);
  await mockApi(context, { rows: 30 });
  await page.goto(GRID_URL);
  await expect(page.getByTestId('app-offline-banner')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add record' })).toBeVisible();

  // Signing out deletes the offline data before the form is sent (the shell stays).
  await context.route('**/auth/logout', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Signed out</title><p>Signed out</p>',
    })
  );
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/auth\/logout$/);
  const names = await cacheNames(page);
  expect(names.filter((n) => n.startsWith('openrows-data-'))).toEqual([]);
  expect(names.filter((n) => n.startsWith('openrows-shell-'))).toHaveLength(1);
});
