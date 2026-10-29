import { GRID_URL, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// The template gallery against the mocked API (e2e/fixtures/mockApi.ts): Home's tiles and
// "Start from a template" dialog, categories, the preview's tables and records, "Use template",
// the ?template= link of openrows.io/templates, and the base menu's "Save as template".
// e2e/templates.spec.ts installs every built-in template on the real stack.

test('picks a template from the gallery and creates a base from it', async ({ page }) => {
  const api = await mockApi(page, { rows: 3 });
  await page.goto('/');
  const section = page.getByRole('region', { name: 'Templates' });
  await expect(section.getByRole('button', { name: /template$/ })).toHaveCount(4);

  await page.getByRole('button', { name: /Start from a template/ }).click();
  const gallery = page.getByRole('dialog', { name: 'Start from a template' });
  await expect(gallery.getByRole('button', { name: /template$/ })).toHaveCount(10);
  await gallery.getByRole('button', { name: 'Engineering', exact: true }).click();
  await expect(gallery.getByRole('button', { name: /template$/ })).toHaveCount(1);
  await gallery.getByRole('button', { name: 'Bug tracker template' }).click();

  const preview = page.getByRole('dialog', { name: 'Bug tracker' });
  await expect(
    preview.getByRole('cell', { name: 'Checkout fails with a 500 for EUR cards' })
  ).toBeVisible();
  await expect(preview.getByText('Includes 1 automation, off until you turn it on.')).toBeVisible();
  await preview.getByRole('tab', { name: 'Releases' }).click();
  await expect(preview.getByRole('cell', { name: '2.4.1' })).toBeVisible();
  await preview.getByRole('button', { name: 'Use template' }).click();
  await expect(page).toHaveURL(/\/b\/[0-9a-f-]{36}/);
  expect(api.templateInstalls).toEqual([{ slug: 'bug-tracker' }]);
});

test('a ?template= link opens that template, and Back shows them all', async ({ page }) => {
  await mockApi(page, { rows: 3 });
  await page.goto('/?template=okrs');
  const preview = page.getByRole('dialog', { name: 'OKRs' });
  await expect(preview.getByRole('tab', { name: 'Objectives' })).toBeVisible();
  await preview.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('dialog', { name: 'Start from a template' })).toBeVisible();
});

test('the base menu saves the base as a template for creators only', async ({ page }) => {
  await mockApi(page, { rows: 3 });
  await page.goto(GRID_URL);
  await page.getByRole('button', { name: 'Switch base' }).click();
  await expect(page.getByRole('menuitem', { name: 'Save as template' })).toHaveAttribute(
    'href',
    /\/api\/bases\/[0-9a-f-]{36}\/template\.json$/
  );
});

test('editors have no "Save as template"', async ({ page }) => {
  await mockApi(page, { rows: 3, role: 'editor' });
  await page.goto(GRID_URL);
  await page.getByRole('button', { name: 'Switch base' }).click();
  await expect(page.getByRole('menuitem', { name: 'Export base (ZIP)' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Save as template' })).toHaveCount(0);
});
