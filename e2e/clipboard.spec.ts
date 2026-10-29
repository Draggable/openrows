import type { Page } from '@playwright/test';
import { GRID_URL, IDS, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// Copy/paste, fill and undo/redo in the grid against the mocked API
// (e2e/fixtures/mockApi.ts). Needs only the built client.

const grid = (page: Page) => page.getByRole('grid');
const cell = (page: Page, row: number, col: number) =>
  grid(page).locator(`[data-cell="${row}:${col}"]`);
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Pastes `text` (and optional HTML) into the focused cell, as Ctrl/⌘ V would. */
const paste = (page: Page, text: string, html?: string) =>
  page.evaluate(
    ([t, h]) => {
      const data = new DataTransfer();
      data.setData('text/plain', t ?? '');
      if (h) data.setData('text/html', h);
      document.activeElement?.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
      );
    },
    [text, html]
  );

/** Copies the selection, answering what went on the clipboard. */
const copy = (page: Page) =>
  page.evaluate(() => {
    const data = new DataTransfer();
    document.activeElement?.dispatchEvent(
      new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true })
    );
    return { text: data.getData('text/plain'), html: data.getData('text/html') };
  });

// Ten columns of every editable kind: Name, Notes, Done, Estimate, Status, Tags, Due, Launch,
// Score, Site.
const FIELDS = [
  IDS.name,
  IDS.notes,
  IDS.done,
  IDS.estimate,
  IDS.status,
  IDS.tags,
  IDS.due,
  IDS.launch,
  IDS.score,
  IDS.site,
];
const line = (r: number) =>
  [
    `Pasted ${r + 1}`,
    `"Line one\nline ""two"""`,
    r % 2 === 0 ? '' : 'checked',
    String(r * 2),
    'Shipped',
    'Planned, In progress',
    '2026-02-03',
    '2026-02-03 09:30',
    '4',
    `https://example.com/${r}`,
  ].join('\t');

test('pastes a 500 × 10 range from TSV, and undo restores the exact prior values', async ({
  page,
}) => {
  const api = await mockApi(page, { rows: 500, allTypes: true });
  await page.goto(GRID_URL);
  await expect(page.getByTestId('record-count')).toHaveText('500 records');
  const before = Array.from({ length: 500 }, (_, i) => structuredClone(api.fieldsAt(i)));

  await cell(page, 0, 0).click();
  const text = `${Array.from({ length: 500 }, (_, r) => line(r)).join('\r\n')}\r\n`;
  await paste(page, text);

  await expect(cell(page, 0, 0)).toHaveText('Pasted 1');
  await expect(cell(page, 0, 4)).toHaveText('Shipped');
  await expect(cell(page, 1, 9)).toHaveAttribute('aria-selected', 'true');
  // One transaction of 500 patches (the server takes up to 1,000 per call).
  expect(api.bulkPatches).toEqual([500]);
  const pasted = api.fieldsAt(499);
  expect(pasted[IDS.name]).toBe('Pasted 500');
  expect(pasted[IDS.notes]).toBe('Line one\nline "two"');
  expect(pasted[IDS.done]).toBe(true);
  expect(pasted[IDS.estimate]).toBe(998);
  expect(pasted[IDS.status]).toBe('shipped');
  expect(pasted[IDS.tags]).toEqual(['planned', 'progress']);
  expect(pasted[IDS.due]).toBe('2026-02-03');
  expect(pasted[IDS.score]).toBe(4);
  expect(pasted[IDS.site]).toBe('https://example.com/499');
  expect(api.fieldsAt(0)[IDS.done]).toBe(false);

  // Undo puts back exactly what every cell held; redo writes the paste again.
  await page.keyboard.press(`${mod}+z`);
  await expect(cell(page, 0, 0)).toHaveText('Record 1');
  await expect.poll(() => api.bulkPatches.length).toBe(2);
  for (let i = 0; i < 500; i++) {
    const now = api.fieldsAt(i);
    for (const f of FIELDS) expect(now[f] ?? null, `row ${i}`).toEqual(before[i]?.[f] ?? null);
  }
  await page.keyboard.press(`${mod}+Shift+z`);
  await expect(cell(page, 0, 0)).toHaveText('Pasted 1');
  await expect.poll(() => api.fieldsAt(499)[IDS.name]).toBe('Pasted 500');
});

test('copy then paste moves exact values; pasting past the last row asks first', async ({
  page,
}) => {
  const api = await mockApi(page, { rows: 3 });
  await page.goto(GRID_URL);
  await expect(page.getByTestId('record-count')).toHaveText('3 records');

  await cell(page, 0, 0).click();
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  const clip = await copy(page);
  expect(clip.text).toBe(
    'Record 1\tNote for 1\t✓\t1\nRecord 2\t\t\t2'.replace('✓', clip.text.split('\t')[2] ?? '')
  );
  expect(clip.html).toContain('data-openrows');

  await cell(page, 2, 0).click();
  await paste(page, clip.text, clip.html);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Add 1 record?');
  await dialog.getByRole('button', { name: 'Add records' }).click();
  await expect(page.getByTestId('record-count')).toHaveText('4 records');
  expect(api.fieldsAt(2)[IDS.name]).toBe('Record 1');
  expect(api.fieldsAt(2)[IDS.done]).toBe(true);
  expect(api.fieldsAt(3)).toMatchObject({ [IDS.name]: 'Record 2', [IDS.estimate]: 2 });

  // Undo trashes the new record and puts row 3 back.
  await cell(page, 0, 0).click();
  await page.keyboard.press(`${mod}+z`);
  await expect(page.getByTestId('record-count')).toHaveText('3 records');
  await expect.poll(() => api.fieldsAt(2)[IDS.name]).toBe('Record 3');
});

test('the fill handle and Ctrl/Cmd D repeat values down; Delete clears a range', async ({
  page,
}) => {
  const api = await mockApi(page, { rows: 10 });
  await page.goto(GRID_URL);
  await cell(page, 0, 3).click();
  const handle = page.getByTestId('fill-handle');
  await handle.hover();
  await page.mouse.down();
  await cell(page, 3, 3).hover();
  await page.mouse.up();
  await expect.poll(() => [1, 2, 3].map((i) => api.fieldsAt(i)[IDS.estimate])).toEqual([1, 1, 1]);

  await cell(page, 4, 0).click();
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press(`${mod}+d`);
  await expect.poll(() => api.fieldsAt(5)[IDS.name]).toBe('Record 5');

  await page.keyboard.press('Delete');
  await expect.poll(() => api.fieldsAt(4)[IDS.name]).toBeNull();
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(() => api.fieldsAt(4)[IDS.name]).toBe('Record 5');
});

test('the context menu duplicates and deletes records, with undo', async ({ page }) => {
  const api = await mockApi(page, { rows: 5 });
  await page.goto(GRID_URL);
  await cell(page, 0, 0).click();
  await page.keyboard.press('Shift+ArrowDown');
  await cell(page, 1, 0).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Duplicate 2 records' }).click();
  await expect(page.getByTestId('record-count')).toHaveText('7 records');
  expect(api.fieldsAt(5)[IDS.name]).toBe('Record 1');

  await expect(cell(page, 6, 0)).toHaveText('Record 2');
  await cell(page, 5, 0).click();
  await page.keyboard.press('Shift+ArrowDown');
  await expect(cell(page, 6, 0)).toHaveAttribute('aria-selected', 'true');
  await cell(page, 5, 0).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete 2 records' }).click();
  await expect(page.getByTestId('record-count')).toHaveText('5 records');
  await cell(page, 0, 0).click();
  await page.keyboard.press(`${mod}+z`);
  await expect(page.getByTestId('record-count')).toHaveText('7 records');
  expect(api.liveCount()).toBe(7);
});
