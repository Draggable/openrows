import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { GRID_URL, IDS, mockApi, recordIdAt } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// The calendar view against a mocked API (e2e/fixtures/mockApi.ts with `calendar`: a view
// on Start – End; record i sits on March 1 + i % 28, 2026, every fourth one spans three days and
// every seventh has no date). The clock is fixed on March 18, 2026, so the month is March.

const event = (page: Page, title: string) =>
  page.getByRole('button', { name: new RegExp(`^${title}, `) });
const day = (page: Page, iso: string) => page.locator(`[data-day="${iso}"]`);
type Range = { from: string; to: string; fields: unknown[] };
const ranges = (queries: Record<string, unknown>[]) =>
  queries.flatMap((q) => {
    const range = (q['query'] as { dateRange?: Range } | undefined)?.dateRange;
    return range ? [range] : [];
  });

async function open(page: Page, rows = 20, role?: string) {
  await page.clock.setFixedTime(new Date('2026-03-18T12:00:00'));
  const api = await mockApi(page, { rows, calendar: true, ...(role ? { role } : {}) });
  await page.goto(GRID_URL);
  await expect(page.getByRole('heading', { name: 'March 2026' })).toBeVisible();
  await expect(event(page, 'Record 2')).toBeVisible();
  return api;
}

test('fetches only the visible window and lays out ranges and undated records', async ({
  page,
}) => {
  const api = await open(page);
  expect(ranges(api.queries).at(-1)).toEqual({
    from: '2026-03-01',
    to: '2026-04-04',
    fields: [{ startFieldId: IDS.start, endFieldId: IDS.end }],
  });
  // Record 1 spans March 1 – 3; Record 7 has no date.
  await expect(event(page, 'Record 1')).toHaveAccessibleName(
    'Record 1, Sunday, March 1, 2026 to Tuesday, March 3, 2026'
  );
  await expect(event(page, 'Record 7')).toHaveCount(0);
  await expect(page.getByTestId('record-count')).toHaveText('18 records');

  await page.getByRole('button', { name: 'Undated (2)' }).click();
  const panel = page.getByRole('complementary', { name: 'Undated records' });
  await expect(panel.getByRole('button', { name: 'Record 7', exact: true })).toBeVisible();

  // The week layout asks for its seven days only.
  await page.getByRole('button', { name: 'Week', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mar 15 – 21, 2026' })).toBeVisible();
  await expect.poll(() => ranges(api.queries).at(-1)?.from).toBe('2026-03-15');
  expect(api.viewPatches.at(-1)).toEqual({ calendar: { mode: 'week' } });
});

test('reschedule by drag persists, and a range keeps its length', async ({ page }) => {
  const api = await open(page);
  // Record 2 is on March 2; drop it on March 10.
  await event(page, 'Record 2').dragTo(day(page, '2026-03-10'), {
    targetPosition: { x: 40, y: 110 },
  });
  await expect.poll(() => api.fieldsAt(1)[IDS.start]).toBe('2026-03-10');
  expect(api.calls).toContain(`PATCH /api/tables/${IDS.table}/records/${recordIdAt(1)}`);
  await expect(event(page, 'Record 2')).toHaveAccessibleName('Record 2, Tuesday, March 10, 2026');

  // Record 5 spans March 5 – 7: grabbed by its first day and dropped on March 12.
  const bar = event(page, 'Record 5');
  const box = await bar.boundingBox();
  if (!box) throw new Error('no event box');
  await bar.dragTo(day(page, '2026-03-12'), {
    sourcePosition: { x: 10, y: box.height / 2 },
    targetPosition: { x: 20, y: 110 },
  });
  await expect.poll(() => api.fieldsAt(4)[IDS.start]).toBe('2026-03-12');
  expect(api.fieldsAt(4)[IDS.end]).toBe('2026-03-14');

  await page.reload();
  await expect(event(page, 'Record 2')).toHaveAccessibleName('Record 2, Tuesday, March 10, 2026');
  await expect(event(page, 'Record 5')).toHaveAccessibleName(
    'Record 5, Thursday, March 12, 2026 to Saturday, March 14, 2026'
  );
});

test('keyboard: Alt+arrows move an event, Alt+Shift resizes; axe-clean', async ({ page }) => {
  const api = await open(page);
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual(
    []
  );

  await event(page, 'Record 3').focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(() => api.fieldsAt(2)[IDS.start]).toBe('2026-03-04');
  await expect(event(page, 'Record 3')).toBeFocused();
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => api.fieldsAt(2)[IDS.start]).toBe('2026-03-11');
  // Into the next week's row: focus follows.
  await expect(event(page, 'Record 3')).toBeFocused();

  // Record 9 spans March 9 – 11: one day longer.
  await event(page, 'Record 9').focus();
  await page.keyboard.press('Alt+Shift+ArrowRight');
  await expect.poll(() => api.fieldsAt(8)[IDS.end]).toBe('2026-03-12');
  expect(api.fieldsAt(8)[IDS.start]).toBe('2026-03-09');

  // Enter opens the record.
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`record=${recordIdAt(8)}`));
});

test('resize a range by dragging its end', async ({ page }) => {
  const api = await open(page);
  // Record 13 spans March 13 – 15 (two rows: Friday to Sunday).
  const bar = event(page, 'Record 13').last();
  const handle = bar.locator('[data-resize-handle]');
  const from = await handle.boundingBox();
  const to = await day(page, '2026-03-14').boundingBox();
  if (!from || !to) throw new Error('no boxes');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + 50, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => api.fieldsAt(12)[IDS.end]).toBe('2026-03-14');
});

test('a day click creates a record there; read-only users only look', async ({ page }) => {
  const api = await open(page);
  await day(page, '2026-03-25').hover();
  await page.getByRole('button', { name: 'New record on Wednesday, March 25, 2026' }).click();
  await expect.poll(() => api.liveCount()).toBe(21);
  expect(api.fieldsAt(20)[IDS.start]).toBe('2026-03-25');
  await expect(page).toHaveURL(new RegExp(`record=${recordIdAt(20)}`));
});

test('read-only: events open but do not move', async ({ page }) => {
  const api = await open(page, 20, 'read_only');
  await expect(page.getByRole('button', { name: /^New record on/ })).toHaveCount(0);
  await event(page, 'Record 3').focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect(event(page, 'Record 3')).toHaveAttribute('draggable', 'false');
  expect(api.fieldsAt(2)[IDS.start]).toBe('2026-03-03');
});
