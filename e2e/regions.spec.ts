import AxeBuilder from '@axe-core/playwright';
import type { Page, Route } from '@playwright/test';
import { mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// Data residency against the mocked API: an Enterprise owner picks the data region in the
// New workspace dialog and is sent to the workspace in that region's app; everyone else sees
// the dialog as before. Needs only the built client.

const EU_URL = 'http://localhost';
const US_URL = 'https://us.app.openrows.test';
const NEW_ID = '00000000-0000-7000-8000-0000000c1610';

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockRegions(page: Page, createElsewhere: boolean) {
  const created: unknown[] = [];
  await page.route('**/api/regions**', (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/api/regions') {
      return json(route, {
        current: 'eu',
        regions: [
          { id: 'eu', name: 'European Union', appUrl: EU_URL },
          { id: 'us', name: 'United States', appUrl: US_URL },
        ],
        createElsewhere,
      });
    }
    if (pathname === '/api/regions/us/workspaces' && route.request().method() === 'POST') {
      created.push(route.request().postDataJSON());
      return json(
        route,
        { id: NEW_ID, name: 'Acme US', region: 'us', url: `${US_URL}/w/${NEW_ID}` },
        201
      );
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  // The other region's app, as far as this browser goes.
  await page.route(`${US_URL}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>OpenRows US</title><main>US region</main>',
    })
  );
  return created;
}

async function openNewWorkspace(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /^Workspace: / }).click();
  await page.getByRole('menuitem', { name: 'New workspace' }).click();
  await expect(page.getByRole('dialog', { name: 'New workspace' })).toBeVisible();
}

test('an Enterprise owner creates a workspace in another region and opens it there', async ({
  page,
}) => {
  await mockApi(page, { rows: 1 });
  const created = await mockRegions(page, true);
  await openNewWorkspace(page);

  const dialog = page.getByRole('dialog', { name: 'New workspace' });
  const region = dialog.getByLabel('Data region');
  await expect(region).toHaveValue('eu');
  await expect(dialog.getByRole('button', { name: 'Create workspace' })).toBeVisible();

  await dialog.getByLabel('Name').fill('Acme US');
  await region.selectOption('us');
  await expect(
    dialog.getByText(/opens in the United States app \(us\.app\.openrows\.test\)/)
  ).toBeVisible();

  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    results.violations
      .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
      .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))
  ).toEqual([]);

  await dialog.getByRole('button', { name: 'Create in United States' }).click();
  await page.waitForURL(`${US_URL}/w/${NEW_ID}`);
  expect(created).toEqual([{ name: 'Acme US' }]);
});

test('without data residency the dialog has no region choice', async ({ page }) => {
  await mockApi(page, { rows: 1 });
  await mockRegions(page, false);
  const regions = page.waitForResponse('**/api/regions');
  await openNewWorkspace(page);
  await regions;
  const dialog = page.getByRole('dialog', { name: 'New workspace' });
  await expect(dialog.getByLabel('Name')).toBeVisible();
  await expect(dialog.getByLabel('Data region')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Create workspace' })).toBeVisible();
});
