import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { GRID_URL, IDS, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// The base page on a 1280 px laptop, against the mocked API (e2e/fixtures/mockApi.ts):
// the breadcrumb keeps the table and view names readable next to every top bar action (the
// secondary ones go icon-only, keeping their names), and with the extension panel open the view
// toolbar and the grid's footer fit the space beside it instead of running under it.

test.use({ viewport: { width: 1280, height: 720 } });

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

/** The grid with the assistant on (the most crowded top bar) and an empty extension panel. */
async function open(page: Page, { extensionsOpen = false } = {}) {
  await mockApi(page, { rows: 5 });
  await page.route(`**/api/workspaces/${IDS.workspace}/ai`, (route) =>
    route.fulfill(json({ workspaceId: IDS.workspace, available: true, source: 'instance' }))
  );
  await page.route(`**/api/bases/${IDS.base}/extensions**`, (route) =>
    route.fulfill(
      json({ extensions: [], canManage: true, canConfigure: true, canInstallCustom: true })
    )
  );
  if (extensionsOpen) {
    await page.addInitScript(() => localStorage.setItem('openrows-extensions-open', '1'));
  }
  await page.goto(GRID_URL);
  await expect(page.getByTestId('record-count')).toHaveText('5 records');
}

/** Whether an element's text is cut off (an ellipsis). */
const truncated = (locator: Locator) => locator.evaluate((el) => el.scrollWidth > el.clientWidth);

test('the breadcrumb stays readable beside every top bar action', async ({ page }) => {
  await open(page);
  const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' });
  const view = breadcrumb.getByRole('heading', { level: 1, name: 'All features' });
  await expect(view).toBeVisible();
  expect(await truncated(view)).toBe(false);
  const table = breadcrumb.getByText('Features', { exact: true });
  expect(await truncated(table)).toBe(false);
  expect(await truncated(breadcrumb.getByRole('link', { name: 'Product Roadmap' }))).toBe(false);

  // The secondary actions are icons now, under their own names.
  const banner = page.getByRole('banner');
  for (const name of ['Interfaces', 'Automations', 'Scripts']) {
    await expect(banner.getByRole('link', { name })).toBeVisible();
  }
  for (const name of ['Assistant', 'Extensions', 'Share']) {
    await expect(banner.getByRole('button', { name, exact: true })).toBeVisible();
  }
  const automations = banner.getByRole('link', { name: 'Automations' });
  expect((await automations.boundingBox())?.width).toBeLessThanOrEqual(36);
  // Their tooltip says what they are.
  await automations.hover();
  await expect(page.getByRole('tooltip', { name: 'Automations' })).toBeVisible();

  const axe = await new AxeBuilder({ page })
    .include('header')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  expect(axe.violations).toEqual([]);
});

test('with the extension panel open the toolbar and the footer fit beside it', async ({ page }) => {
  await open(page, { extensionsOpen: true });
  const panel = page.getByRole('complementary', { name: 'Extensions' });
  await expect(panel).toContainText('No extensions on this base yet.');
  const panelLeft = (await panel.boundingBox())?.x ?? 0;
  expect(panelLeft).toBeGreaterThan(0);

  const toolbar = page.getByRole('toolbar', { name: 'View' });
  const right = async (locator: Locator) => {
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    return (box?.x ?? 0) + (box?.width ?? 0);
  };
  // The find input and the record count are whole and left of the panel.
  const find = toolbar.getByRole('searchbox', { name: 'Find in view' });
  await expect(find).toBeInViewport({ ratio: 1 });
  expect(await right(find)).toBeLessThanOrEqual(panelLeft);
  const count = toolbar.getByTestId('record-count');
  await expect(count).toBeVisible();
  expect(await right(count)).toBeLessThanOrEqual(panelLeft);
  // Every control is reachable: none of them sits under the panel.
  for (const button of await toolbar.getByRole('button').all()) {
    expect(await right(button)).toBeLessThanOrEqual(panelLeft);
  }
  // The buttons keep their names with only their icons showing.
  await expect(toolbar.getByRole('button', { name: 'Hide fields' })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Row height' })).toBeVisible();
  await find.fill('Feature');
  await expect(find).toHaveValue('Feature');

  // The grid ends at the panel; its summary bar reaches the grid's edge.
  const grid = page.getByRole('grid');
  expect(await right(grid)).toBeLessThanOrEqual(panelLeft);
  const summary = page.getByTestId('summary-bar');
  expect(await right(summary)).toBeGreaterThanOrEqual((await right(grid)) - 16);

  const axe = await new AxeBuilder({ page })
    .include('[role="toolbar"]')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  expect(axe.violations).toEqual([]);
});
