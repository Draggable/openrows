import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { GRID_URL, IDS, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// View polish against a mocked API (e2e/fixtures/mockApi.ts): row colours by a single
// select (worked out in the client) and by conditions (answered by the server's record query,
// `rowColors`), saved to the view; a locked view keeps an editor's colours to the page. Needs
// only the built client.

const row = (page: Page, index: number) =>
  page.getByRole('grid').locator(`[role="row"][aria-rowindex="${index + 2}"]`);
const count = (page: Page) => page.getByTestId('record-count');

async function openColors(page: Page) {
  await page.getByRole('button', { name: 'Color' }).click();
  return page.getByRole('dialog', { name: 'Row colors' });
}

test('colours rows by a single select, saved to the view; axe-clean', async ({ page }) => {
  const api = await mockApi(page, { rows: 20, stage: true });
  await page.goto(GRID_URL);
  await expect(count(page)).toHaveText('20 records');
  await expect(row(page, 0)).not.toHaveAttribute('data-row-color');

  const menu = await openColors(page);
  await menu.getByRole('radio', { name: 'By select field' }).check();
  await expect(menu.getByLabel('Color by field')).toHaveValue(IDS.stage);
  // Stages cycle To do (blue), Doing (amber), Done (green); every fifth record has none.
  await expect(row(page, 0)).toHaveAttribute('data-row-color', 'blue');
  await expect(row(page, 1)).toHaveAttribute('data-row-color', 'amber');
  await expect(row(page, 2)).toHaveAttribute('data-row-color', 'green');
  await expect(row(page, 4)).not.toHaveAttribute('data-row-color');
  await expect
    .poll(() => api.viewPatches.at(-1))
    .toEqual({ rowColor: { mode: 'select', fieldId: IDS.stage } });
  // The menu, the toolbar and the tinted row headers (their numbers keep 4.5:1).
  const axe = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .include('[role="toolbar"]')
    .include('[role="rowheader"]')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  expect(axe.violations).toEqual([]);
  if (process.env['E2E_SCREENSHOTS']) {
    await page.screenshot({ path: `${process.env['E2E_SCREENSHOTS']}/row-colors.png` });
  }

  await menu.getByRole('radio', { name: 'None' }).check();
  await expect(row(page, 0)).not.toHaveAttribute('data-row-color');
  await expect.poll(() => api.viewPatches.at(-1)).toEqual({ rowColor: null });
});

test('colours rows by conditions the server matches, first match wins', async ({ page }) => {
  const api = await mockApi(page, { rows: 20 });
  await page.goto(GRID_URL);
  await expect(count(page)).toHaveText('20 records');

  const menu = await openColors(page);
  await menu.getByRole('radio', { name: 'By conditions' }).check();
  const first = menu.getByTestId('row-color-condition').first();
  await first.getByLabel('Color of condition 1').selectOption({ label: 'Red' });
  await first.getByLabel('Field').selectOption({ label: 'Estimate' });
  await first.getByLabel('Operator').selectOption({ label: '>' });
  await first.getByLabel('Value of Estimate').fill('10');
  // Estimates run 1–13: records 11, 12 and 13 are over 10.
  await expect(row(page, 10)).toHaveAttribute('data-row-color', 'red');
  await expect(row(page, 12)).toHaveAttribute('data-row-color', 'red');
  await expect(row(page, 9)).not.toHaveAttribute('data-row-color');

  // A second condition: done records amber, unless the first already matched.
  await menu.getByRole('button', { name: 'Add color condition' }).click();
  const second = menu.getByTestId('row-color-condition').nth(1);
  await second.getByLabel('Color of condition 2').selectOption({ label: 'Amber' });
  await second.getByLabel('Field').selectOption({ label: 'Done' });
  await expect(row(page, 0)).toHaveAttribute('data-row-color', 'amber');
  await expect(row(page, 1)).not.toHaveAttribute('data-row-color');
  await expect(row(page, 10)).toHaveAttribute('data-row-color', 'red');

  const conditions = [
    {
      color: 'red',
      filter: {
        conjunction: 'and',
        conditions: [{ fieldId: IDS.estimate, operator: '>', value: 10 }],
      },
    },
    {
      color: 'amber',
      filter: {
        conjunction: 'and',
        conditions: [{ fieldId: IDS.done, operator: 'is', value: true }],
      },
    },
  ];
  // The record query carried the conditions, and the view saved them.
  expect(api.queries.at(-1)?.['rowColors']).toEqual(conditions);
  await expect
    .poll(() => api.viewPatches.at(-1))
    .toEqual({ rowColor: { mode: 'conditions', conditions } });
});

test("a locked view keeps an editor's colours to the page", async ({ page }) => {
  const api = await mockApi(page, { rows: 10, stage: true, locked: true, role: 'editor' });
  await page.clock.install();
  await page.goto(GRID_URL);
  await expect(count(page)).toHaveText('10 records');
  await expect(page.getByRole('link', { name: /All features/ })).toContainText('All features');
  await expect(page.getByLabel('Locked view')).toBeVisible();

  const menu = await openColors(page);
  await menu.getByRole('radio', { name: 'By select field' }).check();
  await expect(row(page, 0)).toHaveAttribute('data-row-color', 'blue');
  await page.keyboard.press('Escape');
  await expect(row(page, 1)).toHaveAttribute('data-row-color', 'amber');
  // Run the clock past the save's debounce (400 ms), then make one round trip: a save would have
  // reached the mocked API before it.
  await page.clock.runFor(2000);
  await page.evaluate(() => fetch('/health').then((r) => r.ok));
  expect(api.viewPatches).toEqual([]);
});
