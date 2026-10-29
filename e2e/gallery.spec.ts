import AxeBuilder from '@axe-core/playwright';
import { GRID_URL, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// The gallery view against a mocked API (e2e/fixtures/mockApi.ts with `gallery`: every
// record has an image in Mockups, the view's cover field).

test('virtualizes 5,000 cards with covers and keeps the card size across a reload', async ({
  page,
}) => {
  const api = await mockApi(page, { rows: 5000, gallery: true });
  await page.goto(GRID_URL);
  const cards = page.getByRole('list', { name: 'Cards' }).getByRole('listitem');
  await expect(cards.first()).toBeVisible();
  await expect(page.getByTestId('record-count')).toHaveText('5,000 records');
  await expect(page.getByRole('img', { name: 'cover-1.png' })).toBeAttached();
  // Only the rows on screen render.
  expect(await cards.count()).toBeLessThan(120);
  await expect(cards.first()).toHaveAttribute('aria-setsize', '5000');

  // Scrolling to the end loads the last window.
  await page.getByRole('region', { name: 'Gallery' }).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.getByRole('article', { name: 'Record 5000', exact: true })).toBeVisible();
  expect(Math.max(...api.windows)).toBeGreaterThan(4000);

  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual(
    []
  );

  await page.getByRole('button', { name: 'Customize cards' }).click();
  await page.getByRole('button', { name: 'Large' }).click();
  await page.getByRole('checkbox', { name: 'Show Done' }).uncheck();
  await expect.poll(() => api.viewPatches).toContainEqual({ gallery: { cardSize: 'large' } });
  await page.keyboard.press('Escape');

  await page.reload();
  await expect(page.getByRole('listitem').first()).toBeVisible();
  await page.getByRole('button', { name: 'Customize cards' }).click();
  await expect(page.getByRole('button', { name: 'Large' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('checkbox', { name: 'Show Done' })).not.toBeChecked();
});

test('arrow keys move between cards and Enter opens the record', async ({ page }) => {
  await mockApi(page, { rows: 40, gallery: true });
  await page.goto(GRID_URL);
  const first = page.locator('[data-card-index="0"]');
  await first.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-card-index="1"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page).toHaveURL(/record=/);
});
