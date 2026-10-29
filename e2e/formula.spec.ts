import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { GRID_URL, IDS, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// The formula editor against a mocked API (e2e/fixtures/mockApi.ts, which computes formula
// cells with the shared evaluator, as the server does): keyboard-only authoring with field and
// function completion, signature help, inline errors that block saving, the first record's
// preview, and the values in the grid.

const grid = (page: Page) => page.getByRole('grid');
const header = (page: Page, name: string) =>
  grid(page).getByRole('columnheader', { name, exact: true });
const formula = (page: Page) => page.getByRole('textbox', { name: 'Formula' });
/** The editor's completion list (the type picker above is a listbox too). */
const completions = (page: Page) => page.getByTestId('formula-editor').getByRole('listbox');

async function newFormulaField(page: Page, name: string) {
  const api = await mockApi(page, { rows: 30 });
  await page.goto(GRID_URL);
  await expect(page.getByTestId('record-count')).toHaveText('30 records');
  await page.getByRole('button', { name: 'Add field' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Field name')).toBeFocused();
  await page.keyboard.type(name);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('combobox', { name: 'Search field types' })).toBeFocused();
  await page.keyboard.type('formula');
  await page.keyboard.press('Enter');
  // The editor's chunk loads with the first formula field.
  await expect(formula(page)).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(formula(page)).toBeFocused();
  return api;
}

async function expectNoSeriousA11yIssues(page: Page) {
  const results = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  const serious = results.violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? '')
  );
  expect(serious.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))).toEqual([]);
}

test('create a formula field with the keyboard and see its values', async ({ page }) => {
  const api = await newFormulaField(page, 'Points');

  // Fields complete inside braces and are inserted by name.
  await page.keyboard.type('{Est');
  await expect(completions(page).getByRole('option', { name: /Estimate/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(formula(page)).toHaveText('{Estimate}');

  // Functions complete with their signature; signature help follows the cursor.
  await page.keyboard.type(' * ROUN');
  await expect(
    completions(page).getByRole('option', { name: 'ROUND(number, [number])' })
  ).toContainText('(number, [number])');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Rounds to a number of decimals')).toContainText(
    'ROUND(number, [number])'
  );
  await page.keyboard.type('10.4');
  await page.keyboard.press('End');
  await expect(formula(page)).toHaveText('{Estimate} * ROUND(10.4)');

  // The result type and the first record's value, before saving.
  const preview = page.getByLabel('Formula preview');
  await expect(preview).toContainText('Number');
  await expect(page.getByTestId('formula-preview')).toHaveText('10');
  await expectNoSeriousA11yIssues(page);

  await page.keyboard.press('Control+Enter');
  await expect(header(page, 'Points')).toBeVisible();
  expect(api.fieldWrites.at(-1)).toMatchObject({
    call: `POST /api/tables/${IDS.table}/fields`,
    body: {
      name: 'Points',
      type: 'formula',
      options: { formula: `{${IDS.estimate}} * ROUND(10.4)` },
    },
  });
  // Estimates are 1, 2, 3… for the first records.
  // Name, Notes, Done, Estimate, Points.
  const col = 4;
  const cell = (row: number) => grid(page).locator(`[data-cell="${row}:${col}"]`);
  await expect(cell(0)).toHaveText('10');
  await expect(cell(1)).toHaveText('20');
  await expect(cell(2)).toHaveText('30');
});

test('inline errors point at the range and block saving until fixed', async ({ page }) => {
  const api = await newFormulaField(page, 'Shout');
  await page.keyboard.type('{Name} * 2');
  const errors = page.getByRole('list', { name: 'Formula errors' });
  await expect(errors).toContainText('“{Name}”');
  await expect(page.locator('.cm-lintRange-error')).toHaveText('{Name}');
  await expect(page.getByRole('button', { name: 'Create field' })).toBeDisabled();
  await page.keyboard.press('Control+Enter');
  await expect(errors).toBeVisible();
  await expectNoSeriousA11yIssues(page);

  // Escape closes the completion list, not the editor.
  await page.keyboard.press('Control+a');
  await page.keyboard.type('UPP');
  await expect(completions(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(completions(page)).toBeHidden();
  await expect(formula(page)).toBeVisible();

  await page.keyboard.type('ER({Name})');
  await expect(errors).toBeHidden();
  await expect(page.getByTestId('formula-preview')).toHaveText('RECORD 1');
  await page.getByRole('button', { name: 'Create field' }).click();
  await expect(header(page, 'Shout')).toBeVisible();
  expect(api.fieldWrites.at(-1)?.body).toMatchObject({
    options: { formula: `UPPER({${IDS.name}})` },
  });
});
