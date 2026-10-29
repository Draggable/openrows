import type { Page } from '@playwright/test';
import { GRID_URL, IDS, mockApi, PEOPLE, recordIdAt } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// The record expand view against the mocked API: open it from the grid (Space or the
// expand icon), edit fields, step through records, deep-link one, switch to the side panel,
// delete with undo.

// The modal hides the page behind it from assistive tech, so the grid is found by test id.
const cell = (page: Page, row: number, col: number) =>
  page.getByTestId('grid').locator(`[data-cell="${row}:${col}"]`);
const expanded = (page: Page) => page.getByTestId('record-expand');

test('open with Space, edit fields, step with the arrows, close with Esc', async ({ page }) => {
  const api = await mockApi(page, { rows: 20 });
  await page.goto(GRID_URL);
  await cell(page, 1, 1).click();
  await page.keyboard.press(' ');

  await expect(page.getByRole('dialog', { name: 'Record 2' })).toBeVisible();
  const dialog = expanded(page);
  await expect(dialog.getByTestId('record-position')).toHaveText('Record 2 of 20');
  await expect(page).toHaveURL(new RegExp(`\\?record=${recordIdAt(1)}$`));

  // A text field: click, type, Enter saves; the grid shows it too.
  await dialog.getByRole('button', { name: 'Name' }).click();
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Expanded and edited');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Expanded and edited' })).toBeVisible();
  await expect(cell(page, 1, 0)).toHaveText('Expanded and edited');

  // Long text in the expanded editor; the full text with its line breaks shows.
  await dialog.getByRole('button', { name: 'Notes' }).click();
  const notes = page.getByRole('dialog', { name: 'Edit Notes' }).getByRole('textbox');
  await notes.fill('First line\nSecond line');
  await page.keyboard.press('Control+Enter');
  await expect(dialog.getByRole('button', { name: 'Notes' })).toHaveText('First line\nSecond line');

  // Checkbox and number.
  await dialog.getByRole('checkbox', { name: 'Done' }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Done' })).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await dialog.getByRole('button', { name: 'Estimate' }).click();
  await dialog.getByRole('textbox', { name: 'Estimate' }).fill('42');
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('button', { name: 'Estimate' })).toHaveText('42');
  const patch = `PATCH /api/tables/${IDS.table}/records/${recordIdAt(1)}`;
  expect(api.calls.filter((c) => c === patch)).toHaveLength(4);

  // Down and up step through the view; the URL follows.
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('dialog', { name: 'Record 3' })).toBeVisible();
  await expect(expanded(page).getByTestId('record-position')).toHaveText('Record 3 of 20');
  await expect(page).toHaveURL(new RegExp(`\\?record=${recordIdAt(2)}$`));
  await page.getByRole('button', { name: 'Previous record' }).click();
  await page.getByRole('button', { name: 'Previous record' }).click();
  await expect(page.getByRole('dialog', { name: 'Record 1' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous record' })).toBeDisabled();

  // Esc closes and drops the record from the URL (move away so no tooltip is open).
  await page.mouse.move(0, 0);
  await page.keyboard.press('Escape');
  await expect(expanded(page)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`${GRID_URL}$`));
});

test('a deep link opens the record; reload keeps it open', async ({ page }) => {
  await mockApi(page, { rows: 20 });
  await page.goto(`${GRID_URL}?record=${recordIdAt(4)}`);
  const dialog = page.getByRole('dialog', { name: 'Record 5' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('record-position')).toHaveText('Record 5 of 20');
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Record 5' })).toBeVisible();
  // The keys work straight away (the view has focus, not a button).
  await page.keyboard.press('j');
  await expect(page.getByRole('dialog', { name: 'Record 6' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`\\?record=${recordIdAt(5)}$`));

  // A link to a record that doesn't exist says so.
  await page.goto(`${GRID_URL}?record=${recordIdAt(400)}`);
  await expect(page.getByRole('dialog', { name: 'Record not found' })).toBeVisible();
});

test('the expand icon, the side panel and delete with undo', async ({ page }) => {
  await mockApi(page, { rows: 5 });
  await page.goto(GRID_URL);
  await expect(cell(page, 2, 0)).toHaveText('Record 3');
  await cell(page, 2, 0).hover();
  await page.getByRole('button', { name: 'Expand record 3' }).click();
  await expect(page.getByRole('dialog', { name: 'Record 3' })).toBeVisible();

  // The side panel leaves the grid usable and is remembered.
  await page.getByRole('button', { name: 'Show as a side panel' }).click();
  await expect(expanded(page)).toHaveAttribute('data-layout', 'panel');
  await cell(page, 0, 0).click();
  await expect(expanded(page)).toBeVisible();
  await page.keyboard.press(' ');
  await expect(page.getByRole('dialog', { name: 'Record 1' })).toBeVisible();
  await expect(expanded(page)).toHaveAttribute('data-layout', 'panel');
  await page.getByRole('button', { name: 'Show as a modal' }).click();
  await expect(expanded(page)).toHaveAttribute('data-layout', 'modal');

  await page.getByRole('button', { name: 'More record actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete record' }).click();
  await expect(expanded(page)).toHaveCount(0);
  await expect(page.getByTestId('record-count')).toHaveText('4 records');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByTestId('record-count')).toHaveText('5 records');
  await expect(cell(page, 0, 0)).toHaveText('Record 1');
});

test('the Activity tab fits its column: actor and verb wrap, long values truncate (#119)', async ({
  page,
}, testInfo) => {
  await mockApi(page, { rows: 5 });
  const long = 'Launch plan for the October release, second draft with the agency notes';
  const revision = (n: number, kind: string, at: string, changes: unknown[]) => ({
    id: `0190a000-0000-7000-8000-${String(900 + n).padStart(12, '0')}`,
    recordId: recordIdAt(0),
    kind,
    actorId: PEOPLE.ada,
    at,
    changes,
    restoredFrom: null,
    via: null,
  });
  // Registered after mockApi, so these answer first.
  await page.route('**/api/tables/*/records/*/revisions*', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        revisions: [
          revision(2, 'updated', '2026-10-26T09:05:00.000Z', [
            { fieldId: IDS.name, type: 'singleLineText', before: long, after: 'Record 1' },
            { fieldId: IDS.notes, type: 'longText', before: null, after: 'Short' },
          ]),
          revision(1, 'created', '2026-10-26T09:00:00.000Z', []),
        ],
        nextCursor: null,
      }),
    })
  );
  await page.route('**/api/tables/*/records/*/comments*', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ comments: [], previousCursor: null }),
    })
  );

  const check = async (shot: string) => {
    const panel = page.getByTestId('activity-panel');
    const entries = panel.getByTestId('activity-entry');
    await expect(entries).toHaveCount(2);
    await expect(entries.first()).toContainText('Ada Lovelace created this record');
    await expect(entries.nth(1)).toContainText('Ada Lovelace changed');
    // No heading is cut off: each fits its line(s).
    for (const heading of await panel.locator('[data-testid="activity-entry"] p').all()) {
      const { scroll, client } = await heading.evaluate((el) => ({
        scroll: el.scrollWidth,
        client: el.clientWidth,
      }));
      expect(scroll).toBeLessThanOrEqual(client);
    }
    await page.mouse.move(0, 0);
    await testInfo.attach(shot, {
      body: await panel.screenshot({ path: testInfo.outputPath(`${shot}.png`) }),
      contentType: 'image/png',
    });
    // The long value is cut off, its whole text on hover.
    await entries.nth(1).getByTestId('activity-before').hover();
    await expect(page.getByRole('tooltip')).toHaveText(long);
    await page.mouse.move(0, 0);
  };

  // The wide modal's side column.
  await page.goto(`${GRID_URL}?record=${recordIdAt(0)}`);
  const dialog = expanded(page);
  await dialog.getByRole('tab', { name: 'Activity' }).click();
  await check('activity-modal-column');

  // The side panel, at its default width.
  await page.getByRole('button', { name: 'Show as a side panel' }).click();
  await expect(dialog).toHaveAttribute('data-layout', 'panel');
  await dialog.getByRole('tab', { name: 'Activity' }).click();
  await check('activity-side-panel');
});
