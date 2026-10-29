import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { GRID_URL, IDS, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// The trash against the mocked API (e2e/fixtures/mockApi.ts): a base's Trash dialog from
// the base menu lists deleted records, fields and tables with who deleted them and when, and
// restores or deletes them permanently; items past 30 days say "Will be purged". Editors restore
// records but don't delete permanently; the workspace's trash on Home restores a base.

const grid = (page: Page) => page.getByRole('grid');
const cell = (page: Page, row: number, col: number) =>
  grid(page).locator(`[data-cell="${row}:${col}"]`);
const trash = (page: Page) => page.getByRole('dialog', { name: 'Trash' });

async function expectNoSeriousA11yIssues(page: Page, selector: string) {
  const results = await new AxeBuilder({ page })
    .include(selector)
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  const serious = results.violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? '')
  );
  expect(serious.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))).toEqual([]);
}

async function deleteRecord(page: Page, row: number) {
  await cell(page, row, 0).hover();
  await page.getByRole('button', { name: `Expand record ${row + 1}` }).click();
  await page.getByRole('button', { name: 'More record actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete record' }).click();
  await expect(page.getByRole('dialog', { name: `Record ${row + 1}` })).toHaveCount(0);
}

async function openTrash(page: Page) {
  await page.getByRole('button', { name: 'Switch base' }).click();
  await page.getByRole('menuitem', { name: 'Trash' }).click();
  await expect(trash(page)).toBeVisible();
}

test('restore a record, delete a field permanently and restore an old table', async ({ page }) => {
  const api = await mockApi(page, { rows: 5, trashedTable: true });
  await page.goto(GRID_URL);
  await expect(cell(page, 0, 0)).toHaveText('Record 1');
  await deleteRecord(page, 1);
  await expect(page.getByTestId('record-count')).toHaveText('4 records');
  // A field to the trash, through its header menu.
  await grid(page)
    .getByRole('columnheader', { name: 'Done', exact: true })
    .getByRole('button')
    .click();
  await page.getByRole('menuitem', { name: 'Delete field' }).click();
  await page.getByRole('button', { name: 'Delete field' }).click();

  await openTrash(page);
  const dialog = trash(page);
  await expect(dialog.getByRole('tab', { name: 'Records' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  const records = dialog.getByRole('list', { name: 'Deleted records of Features' });
  const item = records.getByRole('listitem').filter({ hasText: 'Record 2' });
  await expect(item).toContainText('Deleted just now');
  await expect(item).toContainText('Ada Lovelace');
  await expect(item).toContainText('30 days left');
  await expectNoSeriousA11yIssues(page, '[role="dialog"]');

  await item.getByRole('button', { name: 'Restore Record 2' }).click();
  await expect(page.getByText('Restored "Record 2"')).toBeVisible();
  await expect(dialog.getByText('No deleted records in Features.')).toBeVisible();
  await expect(page.getByTestId('record-count')).toHaveText('5 records');

  // Fields: "Done" goes for good after the confirmation.
  await dialog.getByRole('tab', { name: /Fields/ }).click();
  const field = dialog.getByRole('listitem').filter({ hasText: 'Done' });
  await expect(field).toContainText('in Features');
  page.once('dialog', (d) => d.accept());
  await field.getByRole('button', { name: 'Delete Done permanently' }).click();
  await expect(dialog.getByText('No deleted fields.')).toBeVisible();
  expect(api.trashCalls).toContain(`DELETE /api/tables/${IDS.table}/trash/fields/${IDS.done}`);

  // Tables: the Archive was deleted 40 days ago, so it's due for purging but still restorable.
  await dialog.getByRole('tab', { name: /Tables/ }).click();
  const archive = dialog.getByRole('listitem').filter({ hasText: 'Archive' });
  await expect(archive).toContainText('Will be purged');
  await archive.getByRole('button', { name: 'Restore Archive' }).click();
  await expect(dialog.getByText('No deleted tables.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(trash(page)).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Tables' }).getByText('Archive')).toBeVisible();
});

test('an editor restores records but deletes nothing permanently', async ({ page }) => {
  const api = await mockApi(page, { rows: 3, role: 'editor' });
  await page.goto(GRID_URL);
  await expect(cell(page, 0, 0)).toHaveText('Record 1');
  await deleteRecord(page, 2);
  await page.getByRole('button', { name: 'Switch base' }).click();
  // Deleting the base is for creators and owners.
  await expect(page.getByRole('menuitem', { name: 'Delete base' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Trash' }).click();
  const dialog = trash(page);
  const item = dialog.getByRole('listitem').filter({ hasText: 'Record 3' });
  await expect(item.getByRole('button', { name: 'Restore Record 3' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /permanently/ })).toHaveCount(0);
  await item.getByRole('button', { name: 'Restore Record 3' }).click();
  await expect(dialog.getByText('No deleted records in Features.')).toBeVisible();
  expect(api.liveCount()).toBe(3);
});

test("the workspace's trash on Home restores a base", async ({ page }) => {
  const api = await mockApi(page, { rows: 1 });
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('button', { name: 'Trash' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Trash of Ada' });
  const item = dialog.getByRole('listitem').filter({ hasText: 'Old roadmap' });
  await expect(item).toContainText('Deleted 3 days ago');
  await expect(item).toContainText('27 days left');
  await expectNoSeriousA11yIssues(page, '[role="dialog"]');
  await item.getByRole('button', { name: 'Restore Old roadmap' }).click();
  await expect(dialog.getByText('No deleted bases.')).toBeVisible();
  expect(api.trashCalls).toContain(
    `POST /api/workspaces/${IDS.workspace}/trash/bases/00000002-0000-4000-8000-000000000002/restore`
  );
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('navigation', { name: 'Bases' }).getByText('Old roadmap')
  ).toBeVisible();
});
