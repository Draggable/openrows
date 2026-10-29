import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { GRID_URL, IDS, mockApi, recordIdAt } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// The timeline view against a mocked API (e2e/fixtures/mockApi.ts with `timeline`: bars
// on Start – End as in the calendar mock, record i on March 1 + i % 28, 2026, every fourth one
// three days long; records i % 4 of 1 and 2 depend on the one before, through Depends on). The
// clock is fixed on March 18, 2026.

const bar = (page: Page, title: string) =>
  page.getByRole('button', { name: new RegExp(`^${title}, `) });
type Range = { from: string; to: string };
const lastRange = (queries: Record<string, unknown>[]) =>
  queries
    .flatMap((q) => {
      const r = (q['query'] as { dateRange?: Range } | undefined)?.dateRange;
      return r ? [r] : [];
    })
    .at(-1);

async function open(page: Page) {
  await page.setViewportSize({ width: 1400, height: 1100 });
  await page.clock.setFixedTime(new Date('2026-03-18T12:00:00'));
  const api = await mockApi(page, { rows: 20, timeline: true });
  await page.goto(GRID_URL);
  await expect(bar(page, 'Record 18')).toBeVisible();
  return api;
}

/** Drags `handle` by `dx` px with the mouse (pointer events). */
async function dragBy(page: Page, handle: ReturnType<Page['locator']>, dx: number) {
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  if (!box) throw new Error('no box');
  const x = box.x + Math.min(box.width / 2, 20);
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
}

test('fetches the visible window and draws dependencies', async ({ page }) => {
  const api = await open(page);
  // The week zoom shows 16 weeks from four weeks before this one.
  expect(lastRange(api.queries)).toEqual(
    expect.objectContaining({ from: '2026-02-15', to: '2026-06-06' })
  );
  await expect(bar(page, 'Record 17')).toHaveAccessibleName(
    'Record 17, Tuesday, March 17, 2026 to Thursday, March 19, 2026'
  );
  // Record 18 waits for Record 17 but starts before it ends; Record 19 waits for Record 18.
  const arrow = (from: number, to: number) =>
    page.locator(
      `[data-testid="dependency"][data-from="${recordIdAt(from)}"][data-to="${recordIdAt(to)}"]`
    );
  await expect(arrow(16, 17)).toHaveAttribute('data-conflict', 'true');
  await expect(arrow(17, 18)).toHaveAttribute('data-conflict', 'false');

  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual(
    []
  );
});

test('zoom, drag to move and resize persist across a reload', async ({ page }) => {
  const api = await open(page);
  await page.getByRole('button', { name: 'Day', exact: true }).click();
  await expect.poll(() => api.viewPatches).toContainEqual({ timeline: { scale: 'day' } });
  await expect.poll(() => lastRange(api.queries)?.from).toBe('2026-03-08');

  // A day is 44 px: Record 18 moves from March 18 to March 21.
  await dragBy(page, bar(page, 'Record 18'), 44 * 3);
  await expect.poll(() => api.fieldsAt(17)[IDS.start]).toBe('2026-03-21');
  expect(api.calls).toContain(`PATCH /api/tables/${IDS.table}/records/${recordIdAt(17)}`);

  // Record 17 (March 17 – 19) gets two more days by its end edge.
  await dragBy(page, bar(page, 'Record 17').locator('[data-resize="end"]'), 44 * 2);
  await expect.poll(() => api.fieldsAt(16)[IDS.end]).toBe('2026-03-21');
  expect(api.fieldsAt(16)[IDS.start]).toBe('2026-03-17');

  // Alt+Right moves Record 19 a day from the keyboard.
  await bar(page, 'Record 19').focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(() => api.fieldsAt(18)[IDS.start]).toBe('2026-03-20');

  await page.reload();
  await expect(page.getByRole('button', { name: 'Day', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(bar(page, 'Record 18')).toHaveAccessibleName('Record 18, Saturday, March 21, 2026');
  await expect(bar(page, 'Record 17')).toHaveAccessibleName(
    'Record 17, Tuesday, March 17, 2026 to Saturday, March 21, 2026'
  );
});

test('never draws a dependency over the label column, at any scroll (#83)', async ({ page }) => {
  await open(page);
  const canvas = page.getByRole('region', { name: 'Timeline' });
  const arrows = page.getByTestId('dependency');
  // Scrolls the canvas (when `left` is given) and measures what the next frame paints: in the
  // animation frame after the scroll event, which runs before the paint. The arrows must be
  // clipped by then, not a render later (CI caught them a frame behind, under the labels).
  const paint = (left: number | null) =>
    canvas.evaluate(
      (el, x) =>
        new Promise<{ scrollLeft: number; column: number; arrows: number[] }>((resolve) => {
          const measure = () =>
            requestAnimationFrame(() => {
              const label = el.querySelector('[role="listitem"] > button');
              resolve({
                scrollLeft: el.scrollLeft,
                column: label ? label.getBoundingClientRect().right : Number.NaN,
                arrows: Array.from(
                  el.querySelectorAll('[data-testid="dependency"]'),
                  (a) => a.getBoundingClientRect().left
                ),
              });
            });
          if (x === null) return measure();
          el.addEventListener('scroll', measure, { once: true });
          el.scrollLeft = x;
        }),
      left
    );
  const check = async (left: number | null) => {
    const frame = await paint(left);
    if (left !== null) expect(frame.scrollLeft).toBe(left);
    expect(frame.column).toBeGreaterThan(0);
    for (const x of frame.arrows) expect(x).toBeGreaterThanOrEqual(frame.column - 1);
    return frame;
  };
  // The week zoom opens three days before today: the arrows of earlier records are scrolled
  // under the labels and must not show there.
  await expect(arrows.first()).toBeAttached();
  await check(null);
  // Right and left, so the previous clip is wrong in both directions.
  for (const left of [200, 400, 600, 300]) await check(left);
  // Scrolled back to the start, every arrow is in view again.
  expect((await check(0)).arrows.length).toBeGreaterThan(2);
});

test('shows a short bar’s title to its right instead of truncating it (#83)', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Day', exact: true }).click();
  // Record 18 is a one-day bar (44 px): "Record 18" doesn't fit in it.
  const record18 = bar(page, 'Record 18');
  await expect(record18).toHaveText('');
  const outside = page.getByTestId('bar-title-outside').filter({ hasText: /^Record 18$/ });
  await expect(outside).toBeVisible();
  const [b, t] = [await record18.boundingBox(), await outside.boundingBox()];
  if (!b || !t) throw new Error('no boxes');
  expect(t.x).toBeGreaterThanOrEqual(b.x + b.width);
  // Record 17 spans three days (132 px): its title fits inside.
  await expect(bar(page, 'Record 17')).toHaveText('Record 17');
});
