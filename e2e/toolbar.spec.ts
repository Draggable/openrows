import type { Page } from '@playwright/test';
import { GRID_URL, IDS, type MockApi, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// The view toolbar against a mocked API (e2e/fixtures/mockApi.ts, which runs a small
// ViewQuery engine): filter, sort, group, hide fields and find in view. Every control's query
// goes to the server with the record query (asserted on the request bodies) and is saved to
// the view. Row height is covered in grid.spec.ts. Needs only the built client.

const grid = (page: Page) => page.getByRole('grid');
const cell = (page: Page, row: number, col: number) =>
  grid(page).locator(`[data-cell="${row}:${col}"]`);
const count = (page: Page) => page.getByTestId('record-count');
const order = (page: Page) =>
  grid(page)
    .getByRole('columnheader')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')).filter(Boolean));
const lastQuery = (api: MockApi) => api.queries.at(-1)?.['query'] as Record<string, unknown>;

async function open(page: Page) {
  const api = await mockApi(page, { rows: 20 });
  await page.goto(GRID_URL);
  await expect(count(page)).toHaveText('20 records');
  return api;
}

test('filters run on the server: conditions, a nested group, saved to the view', async ({
  page,
}) => {
  const api = await open(page);
  await page.getByRole('button', { name: 'Filter' }).click();
  const popover = page.getByRole('dialog', { name: 'Filter' });
  await popover.getByRole('button', { name: 'Add condition', exact: true }).click();
  await popover.getByLabel('Field').selectOption({ label: 'Done' });
  // A checkbox condition starts as "is checked".
  await expect(count(page)).toHaveText('10 records');
  const done = { fieldId: IDS.done, operator: 'is', value: true };
  expect(lastQuery(api)['filter']).toEqual({ conjunction: 'and', conditions: [done] });

  await popover.getByRole('button', { name: 'Add condition group' }).click();
  const group = popover.getByRole('group', { name: 'Condition group' });
  await group.getByLabel('Field').selectOption({ label: 'Estimate' });
  await group.getByLabel('Operator').selectOption({ label: '>' });
  await group.getByLabel('Value of Estimate').fill('10');
  // Even records (done) with an estimate of 11 to 13: records 11 and 13.
  await expect(count(page)).toHaveText('2 records');
  await expect(cell(page, 0, 0)).toHaveText('Record 11');
  await expect(cell(page, 1, 0)).toHaveText('Record 13');
  const filter = {
    conjunction: 'and',
    conditions: [
      done,
      { conjunction: 'and', conditions: [{ fieldId: IDS.estimate, operator: '>', value: 10 }] },
    ],
  };
  // The records came filtered from the server: the request carried the filter tree.
  expect(lastQuery(api)['filter']).toEqual(filter);
  await expect.poll(() => api.viewPatches.at(-1)).toEqual({ query: { filter } });

  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Filter (2)' })).toBeVisible();

  // The saved filter comes back with the view.
  await page.reload();
  await expect(count(page)).toHaveText('2 records');
  await page.getByRole('button', { name: 'Filter (2)' }).click();
  await popover.getByRole('button', { name: 'Remove condition' }).first().click();
  await expect(count(page)).toHaveText('3 records');
});

test('multi-sort on the server, saved to the view', async ({ page }) => {
  const api = await open(page);
  await page.getByRole('button', { name: 'Sort' }).click();
  const popover = page.getByRole('dialog', { name: 'Sort' });
  await popover.getByRole('button', { name: 'Pick a field to sort by' }).click();
  await popover.getByLabel('Sort field 1').selectOption({ label: 'Estimate' });
  await popover.getByLabel('Sort direction 1').selectOption({ label: '9 → 1' });
  await expect(cell(page, 0, 0)).toHaveText('Record 13');
  await popover.getByRole('button', { name: 'Add sort' }).click();
  await popover.getByLabel('Sort field 2').selectOption({ label: 'Name' });
  await popover.getByLabel('Sort direction 2').selectOption({ label: 'Z → A' });
  const sorts = [
    { fieldId: IDS.estimate, direction: 'desc' },
    { fieldId: IDS.name, direction: 'desc' },
  ];
  await expect.poll(() => lastQuery(api)['sorts']).toEqual(sorts);
  // Estimate 12: records 12 and 25 (absent); 13: record 13 only. Then 12 → record 12.
  await expect(cell(page, 1, 0)).toHaveText('Record 12');
  await expect.poll(() => api.viewPatches.at(-1)).toEqual({ query: { sorts } });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Sort (2)' })).toBeVisible();
});

test('group by a field: header bands with counts, from the server', async ({ page }) => {
  const api = await open(page);
  await page.getByRole('button', { name: 'Group' }).click();
  const popover = page.getByRole('dialog', { name: 'Group' });
  await popover.getByRole('button', { name: 'Pick a field to group by' }).click();
  await popover.getByLabel('Group field 1').selectOption({ label: 'Done' });
  await page.keyboard.press('Escape');

  const headers = grid(page).getByTestId('group-header');
  await expect(headers).toHaveCount(2);
  await expect(headers.first()).toContainText('10 records');
  await expect(headers.last()).toContainText('10 records');
  // Unchecked first: record 2 leads.
  await expect(cell(page, 0, 0)).toHaveText('Record 2');
  expect(api.queries.at(-1)).toMatchObject({ groups: true });
  expect(lastQuery(api)['groupBy']).toEqual([{ fieldId: IDS.done, direction: 'asc' }]);
  await expect
    .poll(() => api.viewPatches.at(-1))
    .toEqual({ query: { groupBy: [{ fieldId: IDS.done, direction: 'asc' }] } });
  await expect(page.getByRole('button', { name: 'Group (1)' })).toBeVisible();
});

test('hide, show and reorder fields from the toolbar', async ({ page }) => {
  const api = await open(page);
  await page.getByRole('button', { name: 'Hide fields' }).click();
  const popover = page.getByRole('dialog', { name: 'Hide fields' });
  await popover.getByRole('checkbox', { name: 'Show Notes' }).uncheck();
  await expect.poll(() => order(page)).toEqual(['Name', 'Done', 'Estimate']);
  expect(api.viewPatches.at(-1)).toEqual({ grid: { hiddenFields: [IDS.notes] } });
  await expect(page.getByRole('button', { name: 'Hide fields (1)' })).toBeVisible();

  // Alt+↑ on a field moves it up; the buttons do the same.
  await popover.getByRole('checkbox', { name: 'Show Estimate' }).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => order(page)).toEqual(['Name', 'Estimate', 'Done']);
  expect(api.viewPatches.at(-1)).toEqual({
    grid: { fieldOrder: [IDS.name, IDS.notes, IDS.estimate, IDS.done] },
  });

  await popover.getByRole('button', { name: 'Show all' }).click();
  await expect.poll(() => order(page)).toEqual(['Name', 'Notes', 'Estimate', 'Done']);
  await popover.getByRole('button', { name: 'Hide all' }).click();
  await expect.poll(() => order(page)).toEqual(['Name']);
});

test('find in view: Ctrl+F, server-side matches, Enter steps through them, Esc clears', async ({
  page,
}) => {
  const api = await open(page);
  await cell(page, 3, 1).click();
  await page.keyboard.press('Control+f');
  const input = page.getByRole('searchbox', { name: 'Find in view' });
  await expect(input).toBeFocused();
  await input.fill('record 1');
  // Record 1 and records 10 to 19.
  await expect(count(page)).toHaveText('11 records');
  expect(lastQuery(api)['search']).toBe('record 1');
  await expect(page.getByTestId('find-position')).toHaveText('11 found');
  await expect(grid(page).locator('[data-match]').first()).toBeVisible();

  await page.keyboard.press('Enter');
  await expect(page.getByTestId('find-position')).toHaveText('1 of 11');
  await expect(cell(page, 0, 0)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('find-position')).toHaveText('2 of 11');
  await expect(cell(page, 1, 0)).toHaveAttribute('aria-selected', 'true');
  await expect(input).toBeFocused();
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.press('Shift+Enter');
  await expect(page.getByTestId('find-position')).toHaveText('11 of 11');

  await page.keyboard.press('Escape');
  await expect(input).toHaveValue('');
  await expect(count(page)).toHaveText('20 records');
  // Find isn't saved to the view.
  expect(api.viewPatches).toEqual([]);
});
