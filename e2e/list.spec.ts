import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { GRID_URL, IDS, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// The list view against a mocked API (e2e/fixtures/mockApi.ts with `list`: records 1–3
// are top-level, then every record has a Parent: records 4–6 sit under Record 1, 7–9 under
// Record 2, 13–15 under Record 4, and so on).

const item = (page: Page, title: string) =>
  page.getByRole('treeitem', { name: title, exact: true });

test('nests records by their parent link, collapses branches and keeps the nesting', async ({
  page,
}) => {
  const api = await mockApi(page, { rows: 30, list: true });
  await page.goto(GRID_URL);
  await expect(item(page, 'Record 1')).toHaveAttribute('aria-level', '1');
  await expect(item(page, 'Record 4')).toHaveAttribute('aria-level', '2');
  await expect(item(page, 'Record 13')).toHaveAttribute('aria-level', '3');
  await expect(item(page, 'Record 1')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('record-count')).toHaveText('30 records');

  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual(
    []
  );

  // The keyboard follows the tree: Left collapses, Right expands, Down goes to the child.
  await item(page, 'Record 1').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(item(page, 'Record 1')).toHaveAttribute('aria-expanded', 'false');
  await expect(item(page, 'Record 4')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(item(page, 'Record 4')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(item(page, 'Record 4')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');

  // Not nested: every record is top-level, after a reload too.
  await page.getByRole('button', { name: 'Nested by: Parent' }).click();
  await page.getByLabel('Nest under').selectOption({ label: "Don't nest" });
  await expect.poll(() => api.viewPatches).toContainEqual({ list: { parentFieldId: null } });
  await page.keyboard.press('Escape');
  await expect(item(page, 'Record 4')).toHaveAttribute('aria-level', '1');
  await page.reload();
  await expect(item(page, 'Record 4')).toHaveAttribute('aria-level', '1');

  await page.getByRole('button', { name: 'Customize list' }).click();
  await page.getByLabel('Nest under').selectOption({ label: 'Parent' });
  await expect.poll(() => api.viewPatches.at(-1)).toEqual({ list: { parentFieldId: IDS.parent } });
  await page.reload();
  await expect(item(page, 'Record 13')).toHaveAttribute('aria-level', '3');
});
