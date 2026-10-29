import type { Page } from '@playwright/test';
import { GRID_URL, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// Plan limits against the mocked API: a base at its plan's records per base refuses new
// records with the server's message (problem type quota-exceeded), while every record stays
// listed and editable. Needs only the built client.

const grid = (page: Page) => page.getByRole('grid');
const cell = (page: Page, row: number, col: number) =>
  grid(page).locator(`[data-cell="${row}:${col}"]`);

test('at the records limit: no new record, the reason shown, editing still works', async ({
  page,
}) => {
  const api = await mockApi(page, { rows: 3, recordsPerBase: 3 });
  await page.goto(GRID_URL);
  await expect(page.getByTestId('record-count')).toHaveText('3 records');

  await page.getByRole('button', { name: 'Add record' }).click();
  await expect(page.getByText('This base has 3 of the 3 records its plan allows.')).toBeVisible();
  await expect(page.getByTestId('record-count')).toHaveText('3 records');
  await expect(cell(page, 2, 0)).toHaveText('Record 3');

  // Read and edit: an existing record still saves.
  await cell(page, 0, 0).click();
  await page.keyboard.press('Enter');
  await grid(page).getByRole('textbox', { name: 'Name' }).fill('Still editable');
  await page.keyboard.press('Enter');
  await expect(cell(page, 0, 0)).toHaveText('Still editable');
  expect(api.calls.filter((c) => c.startsWith('PATCH /api/tables/'))).toHaveLength(1);
});
