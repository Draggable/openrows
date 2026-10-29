import type { Page } from '@playwright/test';
import { GRID_URL, mockApi, REJECTED } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// Cell renderers and editors for every editable field type against the mocked API
// (e2e/fixtures/mockApi.ts keeps edits across reloads, like the server): edit each type, reload,
// and the values are still there; a refused save shows an inline error on the cell.

const grid = (page: Page) => page.getByRole('grid');
const cell = (page: Page, row: number, col: number) =>
  grid(page).locator(`[data-cell="${row}:${col}"]`);
const editor = (page: Page, field: string) => page.getByRole('dialog', { name: `Edit ${field}` });

const COL = {
  name: 0,
  notes: 1,
  done: 2,
  status: 4,
  tags: 5,
  due: 6,
  launch: 7,
  score: 8,
  site: 9,
  mail: 10,
  phone: 11,
  mockups: 12,
};

test.use({ viewport: { width: 2600, height: 720 } });

test('edit every field type, reload, and the values persist', async ({ page }) => {
  const api = await mockApi(page, { rows: 5, allTypes: true });
  await page.goto(GRID_URL);
  await expect(cell(page, 1, COL.name)).toHaveText('Record 2');
  const open = async (col: number) => {
    await cell(page, 1, col).click();
    await page.keyboard.press('Enter');
  };

  // Long text: an expanded editor, Enter adds a line, Ctrl+Enter saves.
  await open(COL.notes);
  const notes = editor(page, 'Notes').getByRole('textbox');
  await notes.fill('');
  await notes.pressSequentially('Line A');
  await page.keyboard.press('Enter');
  await notes.pressSequentially('Line B');
  await page.keyboard.press('Control+Enter');
  await expect(cell(page, 1, COL.notes)).toHaveText('Line A Line B');

  // Single select: search and Enter.
  await open(COL.status);
  await page.keyboard.type('ship');
  await page.keyboard.press('Enter');
  await expect(cell(page, 1, COL.status)).toHaveText('Shipped');

  // Multiple select: Enter toggles, Esc saves.
  await open(COL.tags);
  await page.keyboard.type('plan');
  await page.keyboard.press('Enter');
  await page.keyboard.type('prog');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(cell(page, 1, COL.tags)).toHaveText('PlannedIn progress');

  // Date and date-time pickers (date-time in the field's zone, Europe/Paris).
  await open(COL.due);
  await editor(page, 'Due').getByLabel('Due').fill('2026-12-10');
  await page.keyboard.press('Enter');
  await expect(cell(page, 1, COL.due)).toHaveText('2026-12-10');
  await open(COL.launch);
  await expect(editor(page, 'Launch').getByTestId('time-zone')).toHaveText(
    'Time zone: Europe/Paris'
  );
  await editor(page, 'Launch').getByLabel('Launch').fill('2026-11-12T09:30');
  await page.keyboard.press('Enter');
  await expect(cell(page, 1, COL.launch)).toHaveText('2026-11-12 09:30');

  // Rating: typing a digit rates.
  await cell(page, 1, COL.score).click({ position: { x: 100, y: 10 } });
  await page.keyboard.press('4');
  await expect(cell(page, 1, COL.score).getByRole('img', { name: '4 out of 5' })).toBeVisible();

  // URL, email and phone: typed text, shown as links.
  for (const [col, text] of [
    [COL.site, 'openrows.io'],
    [COL.mail, 'ada@example.test'],
    [COL.phone, '+1 555 010 2000'],
  ] as const) {
    await cell(page, 1, col).click();
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
  }
  await expect(cell(page, 1, COL.site).getByRole('link')).toHaveAttribute(
    'href',
    'https://openrows.io'
  );
  await expect(cell(page, 1, COL.mail).getByRole('link')).toHaveAttribute(
    'href',
    'mailto:ada@example.test'
  );

  // Checkbox: a click on the box toggles it (record 2 starts unchecked).
  await cell(page, 1, COL.done).getByRole('button', { name: 'Check' }).click();
  await expect(cell(page, 1, COL.done).getByLabel('Checked')).toHaveCount(1);

  // Attachments: record 1 has two files; remove one.
  await expect(cell(page, 0, COL.mockups).getByRole('img')).toHaveCount(2);
  await cell(page, 0, COL.mockups).click();
  await page.keyboard.press('Enter');
  await editor(page, 'Mockups').getByRole('button', { name: 'Remove grid.png' }).click();
  await editor(page, 'Mockups').getByRole('button', { name: 'Done' }).click();
  await expect(cell(page, 0, COL.mockups).getByRole('img')).toHaveCount(1);

  await expect
    .poll(() => api.calls.filter((c) => c.startsWith('PATCH /api/tables/')).length)
    .toBe(11);

  // Everything is still there after a reload.
  await page.reload();
  await expect(cell(page, 1, COL.notes)).toHaveText('Line A Line B');
  await expect(cell(page, 1, COL.status)).toHaveText('Shipped');
  await expect(cell(page, 1, COL.status).locator('[data-color]')).toHaveAttribute(
    'data-color',
    'green'
  );
  await expect(cell(page, 1, COL.tags)).toHaveText('PlannedIn progress');
  await expect(cell(page, 1, COL.due)).toHaveText('2026-12-10');
  await expect(cell(page, 1, COL.launch)).toHaveText('2026-11-12 09:30');
  await expect(cell(page, 1, COL.score).getByRole('img', { name: '4 out of 5' })).toBeVisible();
  await expect(cell(page, 1, COL.site)).toHaveText('https://openrows.io');
  await expect(cell(page, 1, COL.mail)).toHaveText('ada@example.test');
  await expect(cell(page, 1, COL.phone)).toHaveText(/555/);
  await expect(cell(page, 1, COL.done).getByLabel('Checked')).toHaveCount(1);
  await expect(cell(page, 0, COL.mockups).getByRole('img', { name: 'spec.pdf' })).toBeVisible();
  await expect(cell(page, 0, COL.mockups).getByRole('img')).toHaveCount(1);
});

test('a refused save rolls back and shows an inline error on the cell', async ({ page }) => {
  await mockApi(page, { rows: 3, allTypes: true });
  await page.goto(GRID_URL);
  await cell(page, 0, COL.name).click();
  await page.keyboard.press('Enter');
  await grid(page).getByRole('textbox', { name: 'Name' }).fill(REJECTED);
  await page.keyboard.press('Enter');
  const error = cell(page, 0, COL.name).getByRole('img', {
    name: "Couldn't save: That value was refused",
  });
  await expect(error).toBeVisible();
  await expect(cell(page, 0, COL.name)).toHaveText('Record 1');
  await expect(cell(page, 0, COL.name)).toHaveAttribute('aria-invalid', 'true');

  // A successful save clears it.
  await page.keyboard.press('Enter');
  await grid(page).getByRole('textbox', { name: 'Name' }).fill('Accepted');
  await page.keyboard.press('Enter');
  await expect(cell(page, 0, COL.name)).toHaveText('Accepted');
  await expect(error).toHaveCount(0);
});
