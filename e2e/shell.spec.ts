import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './helpers/test.js';

// The app shell against the whole Compose stack (E2E_STACK=1, like stack.spec.ts): the
// seeded dev user creates a base, adds a table, adds and switches views, and uses Ctrl K.
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

async function signIn(page: Page) {
  await page.goto('/auth/login');
  await page.locator('#username').fill('dev@openrows.test');
  await page.locator('#password').fill('openrows-dev-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page.getByTestId('current-user')).toContainText('dev@openrows.test');
}

const tables = (page: Page) => page.getByRole('navigation', { name: 'Tables' });
const views = (page: Page) => page.getByRole('navigation', { name: 'Views' });
const crumb = (page: Page) => page.getByRole('navigation', { name: 'Breadcrumb' });

test('home has no serious accessibility violations', async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Good');
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const serious = results.violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? '')
  );
  expect(
    serious.flatMap((v) =>
      v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}: ${n.failureSummary}`)
    )
  ).toEqual([]);
});

test('the help menu links to the docs site and the API reference', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Help' }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Documentation' })).toHaveAttribute(
    'href',
    'https://openrows.io/docs'
  );
  await expect(menu.getByRole('menuitem', { name: 'Moving from Airtable' })).toHaveAttribute(
    'href',
    'https://openrows.io/docs/airtable-migration'
  );
  await menu.getByRole('menuitem', { name: 'API reference' }).click();
  await expect(page).toHaveURL(/\/docs\/api$/);
});

// The stack sets STATUS_PAGE_URL as prod does (docker/dev.yml).
test('the help menu, the command palette and the sign-in page link the status page', async ({
  page,
}) => {
  const status = 'https://status.openrows.io/';
  await page.goto('/login');
  await expect(page.getByRole('link', { name: 'Status' })).toHaveAttribute('href', status);
  await signIn(page);
  await page.getByRole('button', { name: 'Help' }).click();
  const item = page.getByRole('menu').getByRole('menuitem', { name: 'System status' });
  await expect(item).toHaveAttribute('href', status);
  await expect(item).toHaveAttribute('target', '_blank');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('Search bases, tables and commands…').fill('status');
  await expect(page.getByRole('option', { name: 'Open the status page' })).toBeVisible();
});

test('create a base, add a table, add and switch views', async ({ page }) => {
  await signIn(page);
  const name = `E2E base ${Date.now()}`;

  await page.getByRole('button', { name: 'New base' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Create a base' });
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Create base' }).click();

  // The new base opens on its first table and view.
  await expect(page).toHaveURL(/\/b\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
  await expect(crumb(page)).toContainText(name);
  await expect(tables(page).getByRole('link', { name: 'Table 1' })).toHaveAttribute(
    'aria-current',
    'page'
  );
  await expect(page.getByRole('columnheader', { name: 'Name' })).toBeVisible();

  await tables(page).getByRole('button', { name: 'Add table' }).click();
  await expect(tables(page).getByRole('link', { name: 'Table 2' })).toHaveAttribute(
    'aria-current',
    'page'
  );
  await expect(crumb(page)).toContainText('Table 2');

  await views(page).getByRole('button', { name: 'Create view' }).click();
  await page
    .getByRole('menu', { name: 'Create view' })
    .getByRole('menuitem', { name: 'Grid' })
    .click();
  await expect(views(page).getByRole('link', { name: 'Grid view 2' })).toHaveAttribute(
    'aria-current',
    'page'
  );
  const view2 = page.url();

  await views(page).getByRole('link', { name: 'Grid view', exact: true }).click();
  await expect(crumb(page).getByRole('heading')).toHaveText('Grid view');
  expect(page.url()).not.toBe(view2);

  // Back to the first table through the command palette.
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('Search bases, tables and commands…').fill('Table 1');
  await page.keyboard.press('Enter');
  await expect(crumb(page)).toContainText('Table 1');

  // The base is listed on home.
  await page.goto('/');
  await expect(page.getByRole('link', { name: new RegExp(name) }).first()).toBeVisible();
});
