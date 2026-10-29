import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { GRID_URL, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// The rose design refresh against a mocked API (e2e/fixtures/mockApi.ts), in both themes:
// the brand mark and icons, the rose on the primary button, focus and the active nav item only,
// and WCAG AA contrast (axe) on the grid and the kanban. E2E_BRAND_SHOTS=<dir> also saves
// screenshots there, to look at by hand.

const ROSE = 'rgb(226, 38, 81)';

async function expectNoContrastViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
  expect(
    results.violations.flatMap((v) =>
      v.nodes.map((n) => `${n.target.join(' ')}: ${n.failureSummary ?? ''}`)
    ),
    'contrast below WCAG AA'
  ).toEqual([]);
}

async function shot(page: Page, name: string) {
  const dir = process.env['E2E_BRAND_SHOTS'];
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('the grid: the rose mark, the active nav item, contrast', async ({ page }) => {
      await mockApi(page, { rows: 30, stage: true });
      await page.goto(GRID_URL);
      await expect(page.getByTestId('record-count')).toHaveText('30 records');
      await expect(page.locator('html')).toHaveClass(
        colorScheme === 'dark' ? /dark/ : /^(?!.*dark)/
      );

      // The rose mark in the sidebar, the rose favicon set in the head.
      const mark = page.locator('svg path[d^="M32.03 0.04"]').first();
      await expect(mark).toBeVisible();
      expect(await mark.evaluate((p) => getComputedStyle(p).fill)).toBe(ROSE);
      await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute(
        'href',
        '/favicon.svg'
      );
      await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
        'href',
        '/apple-touch-icon.png'
      );
      expect((await page.request.get('/favicon.svg')).ok()).toBe(true);
      expect((await page.request.get('/og-image.png')).ok()).toBe(true);

      // The active nav item: a rose bar on its left edge (the only left accent, DESIGN.md §7).
      const active = page.locator('a[aria-current="page"]').first();
      await expect(active).toBeVisible();
      expect(await active.evaluate((a) => getComputedStyle(a, '::before').backgroundColor)).toBe(
        ROSE
      );

      // Focus is rose.
      await page.getByRole('button', { name: /^Filter/ }).focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      const ring = await page.evaluate(
        () => getComputedStyle(document.activeElement as Element).boxShadow
      );
      expect(ring).toContain(ROSE);

      await shot(page, `grid-${colorScheme}`);
      await expectNoContrastViolations(page);
    });

    test('the kanban: contrast of cards and chips', async ({ page }) => {
      await mockApi(page, { rows: 24, kanban: true });
      await page.goto(GRID_URL);
      await expect(page.getByTestId('record-count')).toHaveText('24 records');
      await expect(page.getByRole('article').first()).toBeVisible();
      await shot(page, `kanban-${colorScheme}`);
      await expectNoContrastViolations(page);
    });
  });
}
