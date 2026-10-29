import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { IDS, mockApi } from './fixtures/mockApi.js';
import { mockInterfaces, type MockPage as Page_, PREFIX } from './fixtures/mockInterfaces.js';
import { expect, test } from './helpers/test.js';

// The interface designer against the mocked API (e2e/fixtures/mockApi.ts, its records
// query), with the interface routes kept in memory here: a creator builds a record review page
// (text, a Stage filter, an editable field, a dragged button), publishes it and uses it; a
// read-only viewer sees only published pages, without the designer. e2e/interfaces.spec.ts runs
// the same against the whole stack.

const canvas = (page: Page) => page.getByTestId('interface-canvas');
const panel = (page: Page) => page.getByRole('complementary', { name: 'Page settings' });
const records = (page: Page) => page.getByRole('region', { name: 'Features records' });
const draftSaved = (page: Page) =>
  page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes(PREFIX));

async function seriousViolations(page: Page) {
  const axe = await new AxeBuilder({ page })
    .include('main')
    .include('nav[aria-label="Interfaces"]')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  return axe.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
}

test('a creator builds, arranges and publishes a record review page', async ({ page }) => {
  await mockApi(page, { rows: 6, stage: true });
  const state = await mockInterfaces(page, true);
  await page.goto(`/b/${IDS.base}/interfaces`);
  await page.getByRole('main').getByRole('button', { name: 'New interface' }).click();
  const dialog = page.getByRole('dialog', { name: 'New interface' });
  await dialog.getByLabel('Page name').fill('Review');
  await dialog.getByRole('button', { name: 'Create page' }).click();
  await expect(page).toHaveURL(/edit=true/);
  await expect(page.getByRole('status').filter({ hasText: 'Not published' })).toBeVisible();

  const add = (label: string) =>
    panel(page)
      .getByRole('button', { name: `Add ${label.toLowerCase()}` })
      .click();
  await add('Text');
  let saved = draftSaved(page);
  await panel(page).getByLabel('Text (Markdown)').fill('## Feature review');
  await saved;
  await panel(page).getByRole('button', { name: 'Done' }).click();
  await add('Filter');
  saved = draftSaved(page);
  await panel(page).getByLabel('Field', { exact: true }).selectOption({ label: 'Stage' });
  await saved;
  await panel(page).getByRole('button', { name: 'Done' }).click();
  await add('Field');
  saved = draftSaved(page);
  await panel(page).getByLabel('Field', { exact: true }).selectOption({ label: 'Stage' });
  await panel(page).getByLabel('Editable (by editors and up)').check();
  await saved;
  await panel(page).getByRole('button', { name: 'Done' }).click();
  await add('Button');
  saved = draftSaved(page);
  await panel(page).getByLabel('Label', { exact: true }).fill('Docs');
  await saved;
  await panel(page).getByRole('button', { name: 'Done' }).click();

  // A half-typed URL isn't saved; the panel says why.
  await canvas(page).getByRole('button', { name: 'Button element' }).click();
  await panel(page).getByLabel('URL').fill('javascript:alert(1)');
  await expect(panel(page).getByRole('alert')).toContainText('http(s) URL');
  saved = draftSaved(page);
  await panel(page).getByLabel('URL').fill('https://openrows.io/docs');
  await saved;
  await panel(page).getByRole('button', { name: 'Done' }).click();

  // Drag the button two columns right, then the field one more from the keyboard.
  const button = canvas(page).getByRole('button', { name: 'Button element' });
  const grid = await canvas(page).boundingBox();
  const box = await button.boundingBox();
  if (!grid || !box) throw new Error('no canvas');
  const column = (grid.width - 16) / 12;
  saved = draftSaved(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + column, box.y + box.height / 2, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2 + column * 2, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await saved;
  await canvas(page).getByRole('button', { name: 'Field element' }).focus();
  saved = draftSaved(page);
  await page.keyboard.press('Alt+ArrowRight');
  await saved;
  expect(state.interfaces[0]?.pages[0]?.draft?.elements.map((e) => [e.type, e.x])).toEqual([
    ['text', 0],
    ['filter', 0],
    ['field', 1],
    ['button', 2],
  ]);
  expect(await seriousViolations(page)).toEqual([]);

  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Published$/ })).toBeVisible();
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByRole('heading', { name: 'Feature review' })).toBeVisible();
  await expect(records(page).getByRole('button')).toHaveCount(6);
  await page.getByRole('combobox', { name: 'Stage' }).selectOption({ label: 'Done' });
  await expect(records(page).getByRole('button')).toHaveCount(2);
  await records(page).getByRole('button').first().click();
  const selected = page.getByRole('region', { name: 'Selected record' });
  await expect(selected.getByRole('heading', { name: 'Record 3' })).toBeVisible();
  await expect(selected).toContainText('Done');
  await expect(selected.getByRole('link', { name: 'Docs' })).toHaveAttribute(
    'href',
    'https://openrows.io/docs'
  );
  expect(await seriousViolations(page)).toEqual([]);
});

test('a viewer sees published pages only, without the designer', async ({ page }) => {
  await mockApi(page, { rows: 3, stage: true, role: 'read_only' });
  const config = {
    layout: 'recordList',
    tableId: IDS.table,
    sorts: [],
    fields: [IDS.stage],
    elements: [{ id: 'text-1', type: 'text', x: 0, y: 0, w: 12, h: 1, content: 'Hello' }],
  };
  const pages = (published: boolean, name: string, n: number) => ({
    id: `0190f000-0000-7000-8000-00000000000${n}`,
    interfaceId: '0190f000-0000-7000-8000-000000000000',
    name,
    position: n,
    draft: config,
    published: published ? config : null,
    publishedAt: published ? '2026-10-28T00:00:00.000Z' : null,
    hasChanges: false,
  });
  await mockInterfaces(page, false, [
    {
      id: '0190f000-0000-7000-8000-000000000000',
      baseId: IDS.base,
      name: 'Team',
      position: 1,
      pages: [pages(true, 'Everything', 1), pages(false, 'Secret draft', 2)] as Page_[],
    },
  ]);
  await page.goto(`/b/${IDS.base}/interfaces`);
  const nav = page.getByRole('navigation', { name: 'Interfaces' });
  await expect(nav.getByRole('link', { name: 'Everything' })).toHaveAttribute(
    'aria-current',
    'page'
  );
  await expect(nav.getByRole('link', { name: /Secret draft/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Publish' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New interface' })).toHaveCount(0);
  await expect(page.getByRole('main')).toContainText('Hello');
  const table = page.getByRole('table', { name: 'Features records' });
  await expect(table.getByRole('columnheader')).toHaveText(['Name', 'Stage']);
  await expect(table.getByRole('row')).toHaveCount(4);
  expect(await seriousViolations(page)).toEqual([]);
});
