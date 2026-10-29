import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { GRID_URL, IDS, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// Background recomputes against the mocked API: a computed field the worker is still
// recomputing shows an "updating" hint on its column header (aria-busy), the others don't. The
// worker itself is covered by test/integration/computed-jobs.test.ts and e2e/computed.spec.ts.

const grid = (page: Page) => page.getByRole('grid');
const header = (page: Page, name: string) =>
  grid(page).getByRole('columnheader', { name, exact: true });

test('a field the worker is recomputing shows an updating hint on its header', async ({ page }) => {
  await mockApi(page, { rows: 5, recomputing: [IDS.estimate] });
  await page.goto(GRID_URL);
  await expect(grid(page).locator('[data-cell="0:0"]')).toHaveText('Record 1');

  const hint = header(page, 'Estimate').getByTestId('field-recomputing');
  await expect(hint).toBeVisible();
  await expect(hint).toContainText('Updating values. Some may be out of date for a moment.');
  await expect(header(page, 'Estimate')).toHaveAttribute('aria-busy', 'true');
  await expect(header(page, 'Name').getByTestId('field-recomputing')).toHaveCount(0);
  await expect(header(page, 'Name')).not.toHaveAttribute('aria-busy', /.*/);

  const results = await new AxeBuilder({ page })
    .include(`[role="columnheader"][data-field-id="${IDS.estimate}"]`)
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  const serious = results.violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? '')
  );
  expect(serious.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))).toEqual([]);
});
