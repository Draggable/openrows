import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { GRID_URL, IDS, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// Base snapshots against the mocked API (e2e/fixtures/mockApi.ts): the base menu's
// Snapshots dialog lists the daily automatic snapshot, "Snapshot now" adds one, a snapshot is
// restored to a new base (the app opens it) or deleted, and owners set the retention. Editors
// don't see snapshots.

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Snapshots' });

async function openSnapshots(page: Page) {
  await page.getByRole('button', { name: 'Switch base' }).click();
  await page.getByRole('menuitem', { name: 'Snapshots' }).click();
  await expect(dialog(page)).toBeVisible();
}

test('snapshot now, restore to a new base and delete a snapshot', async ({ page }) => {
  const api = await mockApi(page, { rows: 3 });
  await page.goto(GRID_URL);
  await openSnapshots(page);
  const list = dialog(page).getByRole('list', { name: 'Snapshots' });
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list.getByRole('listitem').first()).toContainText('Automatic');
  await expect(list.getByRole('listitem').first()).toContainText('3 records in 1 table · 1.2 MB');
  await expect(dialog(page)).toContainText('kept for 30 days');

  const results = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  expect(
    results.violations
      .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
      .map((v) => v.id)
  ).toEqual([]);

  await dialog(page).getByRole('button', { name: 'Snapshot now' }).click();
  await expect(page.getByText('Snapshot taken')).toBeVisible();
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list.getByRole('listitem').first()).toContainText('Manual');

  // The automatic one goes.
  page.once('dialog', (d) => d.accept());
  await list
    .getByRole('listitem')
    .filter({ hasText: 'Automatic' })
    .getByRole('button', { name: /^Delete the snapshot of/ })
    .click();
  await expect(page.getByText('Snapshot deleted')).toBeVisible();
  await expect(list.getByRole('listitem')).toHaveCount(1);

  // Owners keep them longer.
  const keep = dialog(page).getByLabel('Keep for');
  await keep.fill('60');
  await keep.press('Enter');
  await expect(page.getByText('Snapshots are kept for 60 days')).toBeVisible();
  expect(api.snapshotCalls).toContain(`PATCH /api/workspaces/${IDS.workspace}/snapshot-settings`);

  await list.getByRole('button', { name: /to a new base$/ }).click();
  await expect(page.getByText('Restored to "Product Roadmap (restored)"')).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/b\/00000002-0000-4000-8000-000000000009/);
  expect(api.snapshotCalls.filter((c) => c.endsWith('/restore'))).toHaveLength(1);
});

test('editors see no snapshots', async ({ page }) => {
  await mockApi(page, { rows: 1, role: 'editor' });
  await page.goto(GRID_URL);
  await page.getByRole('button', { name: 'Switch base' }).click();
  await expect(page.getByRole('menuitem', { name: 'Trash' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Snapshots' })).toHaveCount(0);
});
