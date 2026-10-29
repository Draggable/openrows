import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { GRID_URL, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// The sidebar's one "Create view" picker against a mocked API (e2e/fixtures/mockApi.ts
// keeps created views): every view type from the mouse and the keyboard, "Only me" for a
// personal view (listed apart, under My views), and "Create view…" in the command palette.

const views = (page: Page) => page.getByRole('navigation', { name: 'Views' });
const picker = (page: Page) => page.getByRole('menu', { name: 'Create view' });
const TYPES = [
  ['Grid', 'grid', 'Grid view'],
  ['Kanban', 'kanban', 'Kanban'],
  ['Calendar', 'calendar', 'Calendar'],
  ['Gallery', 'gallery', 'Gallery'],
  ['Timeline', 'timeline', 'Timeline'],
  ['List', 'list', 'List'],
  ['Form', 'form', 'Form'],
] as const;

async function open(page: Page) {
  const api = await mockApi(page, { rows: 5 });
  await page.goto(GRID_URL);
  await expect(views(page).getByRole('link', { name: 'All features' })).toBeVisible();
  return api;
}

test('creates every view type from the picker with the mouse; axe-clean', async ({ page }) => {
  const api = await open(page);
  await views(page).getByRole('button', { name: 'Create view' }).click();
  await expect(picker(page).getByRole('menuitem', { name: 'Form' })).toBeEnabled();
  const axe = await new AxeBuilder({ page })
    .include('[role="menu"]')
    .include('nav[aria-label="Views"]')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual(
    []
  );
  await page.keyboard.press('Escape');

  for (const [label, type, name] of TYPES) {
    await views(page).getByRole('button', { name: 'Create view' }).click();
    await picker(page).getByRole('menuitem', { name: label, exact: true }).click();
    await expect(views(page).getByRole('link', { name })).toHaveAttribute('aria-current', 'page');
    expect(api.viewCreates.at(-1)).toEqual({ name, type });
  }
  expect(api.viewCreates).toHaveLength(TYPES.length);
});

test('creates every view type with the keyboard, and a personal one under My views', async ({
  page,
}) => {
  const api = await open(page);
  for (const [index, [, type, name]] of TYPES.entries()) {
    await views(page).getByRole('button', { name: 'Create view' }).focus();
    await page.keyboard.press('Enter');
    // The menu opens on its first item; arrows move down the types.
    await expect(picker(page).getByRole('menuitem', { name: 'Grid', exact: true })).toBeFocused();
    for (let i = 0; i < index; i++) {
      await page.keyboard.press('ArrowDown');
      await expect(
        picker(page).getByRole('menuitem', { name: TYPES[i + 1]?.[0], exact: true })
      ).toBeFocused();
    }
    await page.keyboard.press('Enter');
    await expect(views(page).getByRole('link', { name })).toHaveAttribute('aria-current', 'page');
    expect(api.viewCreates.at(-1)).toEqual({ name, type });
  }

  // "Only me": End reaches it, Space ticks it and the menu stays open, then a type.
  await views(page).getByRole('button', { name: 'Create view' }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('End');
  const onlyMe = picker(page).getByRole('menuitemcheckbox', { name: /Only me/ });
  await expect(onlyMe).toBeFocused();
  await page.keyboard.press('Space');
  await expect(onlyMe).toHaveAttribute('aria-checked', 'true');
  // Radix moves the roving focus on Home in a timeout: wait for it, or Enter can land on
  // "Only me" and untick it on a busy runner.
  await page.keyboard.press('Home');
  await expect(picker(page).getByRole('menuitem', { name: 'Grid', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect
    .poll(() => api.viewCreates.at(-1))
    .toEqual({
      name: 'Grid view 2',
      type: 'grid',
      personal: true,
    });
  const mine = views(page).getByRole('group', { name: 'My views' });
  await expect(mine.getByRole('link', { name: /Grid view 2/ })).toHaveAttribute(
    'aria-current',
    'page'
  );
  // The collaborative views stay above, outside the group.
  await expect(mine.getByRole('link', { name: 'All features' })).toHaveCount(0);
});

test('"Create view…" in the command palette picks a type', async ({ page }) => {
  const api = await open(page);
  await page.keyboard.press('Control+k');
  const input = page.getByPlaceholder('Search bases, tables and commands…');
  await input.fill('Create view');
  await page.keyboard.press('Enter');
  await page.getByPlaceholder('Pick a view type…').fill('Timeline');
  await page.keyboard.press('Enter');
  await expect(views(page).getByRole('link', { name: 'Timeline' })).toHaveAttribute(
    'aria-current',
    'page'
  );
  expect(api.viewCreates).toEqual([{ name: 'Timeline', type: 'timeline' }]);
});
