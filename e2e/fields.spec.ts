import type { Page } from '@playwright/test';
import { GRID_URL, IDS, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// Field management against a mocked API (e2e/fixtures/mockApi.ts): create, edit, rename,
// describe, change type with the conversion preview, select choices, duplicate, insert left and
// right, hide and show, delete with undo. Needs only the built client.

const grid = (page: Page) => page.getByRole('grid');
const header = (page: Page, name: string) =>
  grid(page).getByRole('columnheader', { name, exact: true });
const order = (page: Page) =>
  grid(page)
    .getByRole('columnheader')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')).filter(Boolean));
const menu = async (page: Page, field: string, item: string) => {
  await header(page, field).getByRole('button').click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
};
const editor = (page: Page) => page.getByRole('dialog').getByRole('form');

async function open(page: Page, allTypes = false) {
  const api = await mockApi(page, { rows: 30, allTypes });
  await page.goto(GRID_URL);
  await expect(page.getByTestId('record-count')).toHaveText('30 records');
  return api;
}

test('create a field from the + header with a type and options', async ({ page }) => {
  const api = await open(page);
  await page.getByRole('button', { name: 'Add field' }).click();
  await page.getByLabel('Field name').fill('Budget');
  await page.getByRole('combobox', { name: 'Search field types' }).fill('curr');
  await page.keyboard.press('Enter');
  await page.getByLabel('Currency code').fill('eur');
  await page.getByRole('button', { name: 'Create field' }).click();
  await expect(header(page, 'Budget')).toBeVisible();
  expect(api.fieldWrites.at(-1)).toEqual({
    call: `POST /api/tables/${IDS.table}/fields`,
    body: {
      name: 'Budget',
      type: 'currency',
      options: { precision: 2, allowNegative: true, currencyCode: 'EUR' },
    },
  });
});

test('rename a field and edit its description', async ({ page }) => {
  const api = await open(page);
  await menu(page, 'Notes', 'Rename field');
  await expect(page.getByLabel('Field name')).toBeFocused();
  await page.getByLabel('Field name').fill('Details');
  await page.keyboard.press('Enter');
  await expect(header(page, 'Details')).toBeVisible();
  expect(api.fieldWrites.at(-1)?.body).toEqual({ name: 'Details' });

  await menu(page, 'Details', 'Edit description');
  await expect(page.getByRole('textbox', { name: 'Description' })).toBeFocused();
  await page.keyboard.type('Longer notes');
  await page.keyboard.press('Control+Enter');
  await expect(editor(page)).toBeHidden();
  expect(api.fieldWrites.at(-1)?.body).toEqual({ description: 'Longer notes' });
  // The header shows it in a tooltip on its info icon.
  const hint = header(page, 'Details').getByTestId('field-description');
  await hint.hover();
  await expect(page.getByRole('tooltip')).toHaveText('Longer notes');
});

test('change a field type: the preview warns before data is lost', async ({ page }) => {
  const api = await open(page);
  await menu(page, 'Notes', 'Change field type');
  await page.keyboard.type('number');
  await page.keyboard.press('Enter');
  const warning = page.getByRole('alert');
  await expect(warning).toContainText('10 values will be cleared in 30 records');
  await expect(warning).toContainText("This can't be undone");
  await expect(page.getByRole('list', { name: 'Examples' })).toContainText('Note for 1');

  // A lossless target says so instead.
  await page.getByRole('button', { name: /^Field type:/ }).click();
  await page.getByRole('option', { name: 'Single line text' }).click();
  await expect(page.getByText('All 10 values in 30 records convert without loss.')).toBeVisible();
  await expect(warning).toBeHidden();

  await page.getByRole('button', { name: /^Field type:/ }).click();
  await page.getByRole('option', { name: 'Number', exact: true }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(editor(page)).toBeHidden();
  expect(api.fieldWrites.at(-1)).toEqual({
    call: `PATCH /api/fields/${IDS.notes}`,
    body: { type: 'number', options: { precision: 0, allowNegative: true } },
  });
});

test('edit select choices: add, rename, recolour, reorder', async ({ page }) => {
  const api = await open(page, true);
  await grid(page).evaluate((el) => {
    el.scrollLeft = 600;
  });
  await menu(page, 'Status', 'Edit field');
  const choices = page.getByRole('list', { name: 'Choices' });
  await expect(choices.getByRole('textbox')).toHaveCount(3);
  await page.getByRole('button', { name: 'Add choice' }).click();
  await page.keyboard.type('Blocked');
  await page.keyboard.press('Alt+ArrowUp');
  await choices.getByRole('textbox').first().fill('Backlog');
  await page.getByRole('button', { name: /^Color of Backlog/ }).click();
  await page.getByRole('menuitem', { name: 'Slate' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(editor(page)).toBeHidden();
  const body = api.fieldWrites.at(-1)?.body as {
    options: { choices: { name: string; color: string }[] };
  };
  expect(body.options.choices.map((c) => [c.name, c.color])).toEqual([
    ['Backlog', 'slate'],
    ['In progress', 'amber'],
    ['Blocked', 'red'],
    ['Shipped', 'green'],
  ]);
});

test('duplicate a field next to it', async ({ page }) => {
  const api = await open(page);
  await menu(page, 'Done', 'Duplicate field');
  await expect(page.getByLabel('Field name')).toHaveValue('Done copy');
  await page.getByRole('button', { name: 'Create field' }).click();
  await expect.poll(() => order(page)).toEqual(['Name', 'Notes', 'Done', 'Done copy', 'Estimate']);
  expect(api.fieldWrites.at(-1)?.body).toEqual({
    name: 'Done copy',
    type: 'checkbox',
    options: { icon: 'check', color: 'green' },
    position: 3.5,
  });
  expect(api.viewPatches.at(-1)?.['grid']).toMatchObject({
    fieldOrder: [IDS.name, IDS.notes, IDS.done, expect.any(String), IDS.estimate],
  });
});

test('insert a field left and right of another', async ({ page }) => {
  const api = await open(page);
  await menu(page, 'Done', 'Insert left');
  await page.getByLabel('Field name').fill('Before');
  await page.keyboard.press('Control+Enter');
  await expect.poll(() => order(page)).toEqual(['Name', 'Notes', 'Before', 'Done', 'Estimate']);
  expect(api.fieldWrites.at(-1)?.body).toMatchObject({ name: 'Before', position: 2.5 });

  await menu(page, 'Done', 'Insert right');
  await page.getByLabel('Field name').fill('After');
  await page.keyboard.press('Control+Enter');
  await expect
    .poll(() => order(page))
    .toEqual(['Name', 'Notes', 'Before', 'Done', 'After', 'Estimate']);
});

test('hide a field and show it again', async ({ page }) => {
  const api = await open(page);
  await menu(page, 'Notes', 'Hide field');
  await expect.poll(() => order(page)).toEqual(['Name', 'Done', 'Estimate']);
  expect(api.viewPatches.at(-1)).toEqual({ grid: { hiddenFields: [IDS.notes] } });

  await page.getByRole('button', { name: 'Hide fields (1)' }).click();
  await page.getByRole('checkbox', { name: 'Show Notes' }).check();
  await expect.poll(() => order(page)).toEqual(['Name', 'Notes', 'Done', 'Estimate']);
  expect(api.viewPatches.at(-1)).toEqual({ grid: { hiddenFields: [] } });
});

test('delete a field after confirming, then undo', async ({ page }) => {
  const api = await open(page);
  await menu(page, 'Done', 'Delete field');
  const dialog = page.getByRole('dialog', { name: 'Delete the field "Done"?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(header(page, 'Done')).toBeVisible();

  await menu(page, 'Done', 'Delete field');
  await page.getByRole('button', { name: 'Delete field' }).click();
  await expect(header(page, 'Done')).toBeHidden();
  expect(api.fieldWrites.at(-1)?.call).toBe(`DELETE /api/fields/${IDS.done}`);

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(header(page, 'Done')).toBeVisible();
  expect(api.fieldWrites.at(-1)?.call).toBe(
    `POST /api/tables/${IDS.table}/fields/${IDS.done}/restore`
  );
  await expect(page.getByText('Restored "Done"')).toBeVisible();
});

test('the primary field has no hide or delete', async ({ page }) => {
  await open(page);
  await header(page, 'Name').getByRole('button').click();
  await expect(page.getByRole('menuitem', { name: 'Edit field' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Hide field' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Delete field' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Insert left' })).toHaveCount(0);
});
