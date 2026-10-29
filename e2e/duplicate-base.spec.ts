import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { GRID_URL, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// Duplicate a base against the mocked API (e2e/fixtures/mockApi.ts): the base menu's
// "Duplicate base" dialog names the copy, offers the workspaces where one may add bases and the
// records option, shows the worker's progress and opens the copy. Editors don't see it.

const TEAM = '00000001-0000-4000-8000-000000000077';
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Duplicate base' });

async function openDuplicate(page: Page) {
  await page.getByRole('button', { name: 'Switch base' }).click();
  await page.getByRole('menuitem', { name: 'Duplicate base' }).click();
  await expect(dialog(page)).toBeVisible();
}

test('duplicates a base with its records into another workspace and opens the copy', async ({
  page,
}) => {
  const api = await mockApi(page, {
    rows: 3,
    workspaces: [
      { id: TEAM, name: 'Team', role: 'creator' },
      { id: '00000001-0000-4000-8000-000000000078', name: 'Readers', role: 'read_only' },
    ],
  });
  await page.goto(GRID_URL);
  await openDuplicate(page);
  await expect(dialog(page).getByLabel('Name')).toHaveValue('Product Roadmap copy');
  const workspace = dialog(page).getByLabel('Workspace');
  await expect(workspace).toHaveValue(/00000001/);
  // Only workspaces where one may add bases.
  await expect(workspace.getByRole('option')).toHaveText(['Ada', 'Team']);
  await expect(dialog(page).getByLabel('Copy records, links and attachments')).toBeChecked();

  const results = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  expect(
    results.violations
      .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
      .map((v) => v.id)
  ).toEqual([]);

  await dialog(page).getByLabel('Name').fill('Roadmap for Team');
  await workspace.selectOption({ label: 'Team' });
  await dialog(page).getByRole('button', { name: 'Duplicate base' }).click();
  await expect(page.getByText('Duplicated to "Roadmap for Team"')).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/b\/00000002-0000-4000-8000-00000000000a/);
  expect(api.duplicateBodies).toEqual([
    { name: 'Roadmap for Team', workspaceId: TEAM, withRecords: true },
  ]);
});

test('duplicates only the structure when records are left out', async ({ page }) => {
  const api = await mockApi(page, { rows: 2 });
  await page.goto(GRID_URL);
  await openDuplicate(page);
  await dialog(page).getByLabel('Copy records, links and attachments').uncheck();
  await dialog(page).getByRole('button', { name: 'Duplicate base' }).click();
  await expect(page.getByText('Duplicated to "Product Roadmap copy"')).toBeVisible();
  expect(api.duplicateBodies).toEqual([
    {
      name: 'Product Roadmap copy',
      workspaceId: '00000001-0000-4000-8000-000000000001',
      withRecords: false,
    },
  ]);
});

test('editors cannot duplicate a base', async ({ page }) => {
  await mockApi(page, { rows: 1, role: 'editor' });
  await page.goto(GRID_URL);
  await page.getByRole('button', { name: 'Switch base' }).click();
  await expect(page.getByRole('menuitem', { name: 'Trash' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Duplicate base' })).toHaveCount(0);
});
