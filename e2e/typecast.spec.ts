import type { Page } from '@playwright/test';
import { GRID_URL, IDS, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// Select typecast against the mocked API (e2e/fixtures/mockApi.ts creates the options a
// `typecast` write names): an owner pastes unknown option names and they become chips, adds an
// option from the cell editor, and imports a CSV with "Add missing options".

const grid = (page: Page) => page.getByRole('grid');
const cell = (page: Page, row: number, col: number) =>
  grid(page).locator(`[data-cell="${row}:${col}"]`);
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const STATUS = 4;
const TAGS = 5;

const paste = (page: Page, text: string) =>
  page.evaluate((t) => {
    const data = new DataTransfer();
    data.setData('text/plain', t);
    document.activeElement?.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    );
  }, text);

test('pasting unknown select values creates them as new chips, and undo/redo', async ({ page }) => {
  const api = await mockApi(page, { rows: 3, allTypes: true });
  await page.goto(GRID_URL);
  await expect(page.getByTestId('record-count')).toHaveText('3 records');

  await cell(page, 0, STATUS).click();
  await paste(page, 'Blocked\tUrgent, Planned\r\nPlanned\tUrgent\r\nWaiting\tlater\r\n');

  await expect(cell(page, 0, STATUS)).toHaveText('Blocked');
  await expect(cell(page, 1, STATUS)).toHaveText('Planned');
  await expect(cell(page, 2, STATUS)).toHaveText('Waiting');
  await expect(cell(page, 0, TAGS)).toHaveText(/Urgent.*Planned/);
  await expect(cell(page, 2, TAGS)).toHaveText('later');
  await expect(cell(page, 0, STATUS).locator('[data-color]')).toHaveCount(1);
  expect(api.typecasts).toEqual(['Blocked', 'Urgent', 'Waiting', 'later']);
  expect(api.fieldsAt(1)[IDS.status]).toBe('planned');

  await page.keyboard.press(`${mod}+z`);
  await expect(cell(page, 0, STATUS)).toHaveText('');
  await page.keyboard.press(`${mod}+Shift+z`);
  await expect(cell(page, 0, STATUS)).toHaveText('Blocked');
  // Redo writes the stored option ids: nothing is created twice.
  expect(api.typecasts).toHaveLength(4);
});

test('the select editor adds an option with "+ Add option"', async ({ page }) => {
  const api = await mockApi(page, { rows: 3, allTypes: true });
  await page.goto(GRID_URL);
  await cell(page, 1, STATUS).click();
  await page.keyboard.press('Enter');
  const search = page.getByRole('combobox', { name: 'Find an option for Status' });
  await search.fill('Review');
  const add = page.getByRole('option', { name: 'Add option "Review"' });
  await expect(add).toBeVisible();
  await page.screenshot({ path: 'test-results/select-add-option.png' });
  await add.click();
  await expect(cell(page, 1, STATUS)).toHaveText('Review');
  expect(api.typecasts).toEqual(['Review']);
});

test('the import dialog asks the server to add missing options', async ({ page }) => {
  await mockApi(page, { rows: 2, allTypes: true });
  const posted: Record<string, unknown>[] = [];
  await page.route('**/api/tables/*/imports**', async (route) => {
    const req = route.request();
    const job = {
      id: '0190a000-0000-7000-8000-000000000778',
      tableId: IDS.table,
      status: req.method() === 'POST' ? 'running' : 'done',
      totalRows: 2,
      processedRows: req.method() === 'POST' ? 0 : 2,
      skippedCells: 0,
      createdFieldIds: [],
      error: null,
      createdAt: '2026-10-25T10:00:00.000Z',
      finishedAt: req.method() === 'POST' ? null : '2026-10-25T10:00:01.000Z',
    };
    if (req.method() === 'POST') posted.push(req.postDataJSON());
    return route.fulfill({ status: req.method() === 'POST' ? 201 : 200, json: job });
  });
  await page.goto(GRID_URL);
  await page.getByRole('button', { name: 'More view actions' }).click();
  await page.getByRole('menuitem', { name: 'Import CSV…' }).click();
  const dialog = page.getByRole('dialog', { name: /Import CSV/ });
  await dialog.getByLabel('Choose a CSV file').setInputFiles({
    name: 'stages.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Name,Status\nWrite spec,Blocked\nShip,Planned\n'),
  });
  await dialog.getByLabel('Import column Status into').selectOption(IDS.status);
  await expect(dialog.getByLabel('Add missing options to select fields')).toBeChecked();
  await dialog.getByRole('button', { name: 'Import 2 records' }).click();
  await expect(page.getByText('Imported 2 records.')).toBeVisible();
  expect(posted[0]).toMatchObject({
    typecast: true,
    columns: [
      { index: 0, fieldId: IDS.name },
      { index: 1, fieldId: IDS.status },
    ],
  });
});
