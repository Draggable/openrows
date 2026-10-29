import type { Page } from '@playwright/test';
import { GRID_URL, IDS, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// The grid against a mocked API (e2e/fixtures/mockApi.ts): keyboard navigation, range
// selection, editing and column operations. Needs only the built client.

const grid = (page: Page) => page.getByRole('grid');
const cell = (page: Page, row: number, col: number) =>
  grid(page).locator(`[data-cell="${row}:${col}"]`);
const focused = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute('data-cell') ?? null);

test('keyboard navigation moves the focused cell', async ({ page }) => {
  await mockApi(page, { rows: 500 });
  await page.goto(GRID_URL);
  await expect(page.getByTestId('record-count')).toHaveText('500 records');
  await cell(page, 0, 0).click();
  await expect.poll(() => focused(page)).toBe('0:0');

  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => focused(page)).toBe('1:1');
  await page.keyboard.press('Tab');
  await expect.poll(() => focused(page)).toBe('1:2');
  await page.keyboard.press('Shift+Tab');
  await expect.poll(() => focused(page)).toBe('1:1');
  await page.keyboard.press('End');
  await expect.poll(() => focused(page)).toBe('1:3');
  await page.keyboard.press('Tab');
  await expect.poll(() => focused(page)).toBe('2:0');
  await page.keyboard.press('Home');
  await expect.poll(() => focused(page)).toBe('2:0');

  // Page Down moves by a screen and loads the rows it reaches.
  await page.keyboard.press('PageDown');
  const afterPage = Number((await focused(page))?.split(':')[0]);
  expect(afterPage).toBeGreaterThan(5);

  // Ctrl+End jumps to the last record, past the first window (100 rows).
  await page.keyboard.press('Control+End');
  await expect.poll(() => focused(page)).toBe('499:3');
  await expect(cell(page, 499, 0)).toHaveText('Record 500');
  await page.keyboard.press('Control+Home');
  await expect.poll(() => focused(page)).toBe('0:0');
  await expect(cell(page, 0, 0)).toHaveText('Record 1');
});

test('shift extends a range; Esc collapses it', async ({ page }) => {
  await mockApi(page, { rows: 50 });
  await page.goto(GRID_URL);
  await cell(page, 1, 0).click();
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowRight');
  for (const [r, c] of [
    [1, 0],
    [1, 1],
    [2, 0],
    [2, 1],
  ] as const) {
    await expect(cell(page, r, c)).toHaveAttribute('aria-selected', 'true');
  }
  await expect(cell(page, 3, 0)).toHaveAttribute('aria-selected', 'false');
  // Esc keeps only the cell the range was extended to.
  await page.keyboard.press('Escape');
  await expect(cell(page, 2, 1)).toHaveAttribute('aria-selected', 'true');
  await expect(cell(page, 1, 0)).toHaveAttribute('aria-selected', 'false');
});

test('Enter edits a cell, Enter saves, Esc cancels; Space toggles a checkbox', async ({ page }) => {
  const api = await mockApi(page, { rows: 20 });
  await page.goto(GRID_URL);
  await cell(page, 0, 0).click();
  await page.keyboard.press('Enter');
  const editor = grid(page).getByRole('textbox', { name: 'Name' });
  await editor.fill('Keyboard-first grid');
  await page.keyboard.press('Enter');
  await expect(cell(page, 0, 0)).toHaveText('Keyboard-first grid');
  await expect.poll(() => focused(page)).toBe('0:0');

  // Typing starts an edit with the typed character; Esc throws it away.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('X');
  await expect(grid(page).getByRole('textbox', { name: 'Name' })).toHaveValue('X');
  await page.keyboard.press('Escape');
  await expect(cell(page, 1, 0)).toHaveText('Record 2');

  // Done (column 2) of record 2 is unchecked; Space checks it.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(cell(page, 1, 2).getByLabel('Checked')).toHaveCount(0);
  await page.keyboard.press(' ');
  await expect(cell(page, 1, 2).getByLabel('Checked')).toHaveCount(1);
  expect(api.calls.filter((c) => c.startsWith('PATCH /api/tables/'))).toHaveLength(2);
});

test('columns resize, reorder and freeze, saved to the view', async ({ page }) => {
  const api = await mockApi(page, { rows: 20 });
  await page.goto(GRID_URL);
  const header = (name: string) => grid(page).getByRole('columnheader', { name });
  await expect(header('Notes')).toBeVisible();

  // Resize with the keyboard on the column edge.
  const notesWidth = (await header('Notes').boundingBox())?.width ?? 0;
  await page.getByRole('separator', { name: 'Resize Notes' }).focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await header('Notes').boundingBox())?.width).toBe(notesWidth + 32);
  expect(api.viewPatches.at(-1)).toEqual({
    grid: { columnWidths: { [IDS.notes]: notesWidth + 32 } },
  });

  // Resize by dragging the edge.
  const edge = await page.getByRole('separator', { name: 'Resize Done' }).boundingBox();
  if (!edge) throw new Error('no edge');
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x + 60, edge.y + edge.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await header('Done').boundingBox())?.width).toBeGreaterThan(120);

  // Reorder through the column menu: Estimate moves left of Done.
  await header('Estimate').getByRole('button').click();
  await page.getByRole('menuitem', { name: 'Move left' }).click();
  const order = async () =>
    grid(page)
      .getByRole('columnheader')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')).filter(Boolean));
  await expect.poll(order).toEqual(['Name', 'Notes', 'Estimate', 'Done']);
  expect(api.viewPatches.at(-1)).toEqual({
    grid: { fieldOrder: [IDS.name, IDS.notes, IDS.estimate, IDS.done] },
  });

  // Reorder by dragging a header: Done before Notes.
  await header('Done').dragTo(header('Notes'));
  await expect.poll(order).toEqual(['Name', 'Done', 'Notes', 'Estimate']);

  // Freeze up to Done: it stays put while the grid scrolls sideways.
  await header('Done').getByRole('button').click();
  await page.getByRole('menuitem', { name: 'Freeze up to this field' }).click();
  expect(api.viewPatches.at(-1)).toEqual({ grid: { frozenCount: 1 } });
  // Narrow enough to scroll sideways, still above the phone layout (< 768 px).
  await page.setViewportSize({ width: 800, height: 600 });
  const before = (await header('Done').boundingBox())?.x;
  await grid(page).evaluate((el) => {
    el.scrollLeft = 400;
  });
  await expect.poll(async () => (await header('Done').boundingBox())?.x).toBe(before);

  // The layout survives a reload (it is the view's).
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.reload();
  await expect.poll(order).toEqual(['Name', 'Done', 'Notes', 'Estimate']);
});

test('row height, the + row and the + column', async ({ page }) => {
  const api = await mockApi(page, { rows: 3 });
  await page.goto(GRID_URL);
  await expect(cell(page, 0, 0)).toHaveText('Record 1');
  expect((await cell(page, 0, 0).boundingBox())?.height).toBe(34);
  await page.getByRole('button', { name: 'Row height' }).click();
  await page.getByRole('menuitem', { name: 'Tall', exact: true }).click();
  await expect.poll(async () => (await cell(page, 0, 0).boundingBox())?.height).toBe(56);
  expect(api.viewPatches.at(-1)).toEqual({ grid: { rowHeight: 'medium' } });

  await page.getByRole('button', { name: 'Add record' }).click();
  await expect(page.getByTestId('record-count')).toHaveText('4 records');

  await page.getByRole('button', { name: 'Add field' }).click();
  await expect(page.getByLabel('Field name')).toBeFocused();
  await expect(page.getByRole('button', { name: 'Create field' })).toBeDisabled();
});
