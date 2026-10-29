import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { GRID_URL, IDS, mockApi, recordIdAt } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// The kanban view against a mocked API (e2e/fixtures/mockApi.ts with `kanban`: a view
// stacked by Stage, records cycling To do / Doing / Done, every fifth one without a stage, and a
// manual card order). Needs only the built client.

const stack = (page: Page, name: string) => page.getByRole('list', { name, exact: true });
const card = (page: Page, name: string) =>
  page.getByRole('listitem').filter({ has: page.getByRole('article', { name, exact: true }) });
const titles = (page: Page, name: string) =>
  stack(page, name)
    .getByRole('article')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));

async function open(page: Page, rows = 20, role?: string) {
  const api = await mockApi(page, { rows, kanban: true, ...(role ? { role } : {}) });
  await page.goto(GRID_URL);
  await expect(page.getByTestId('record-count')).toHaveText(`${rows.toLocaleString()} records`);
  await expect(stack(page, 'To do').getByRole('article').first()).toBeVisible();
  return api;
}

test('drag a card into another stack: a record update and its place, kept on reload', async ({
  page,
}) => {
  const api = await open(page);
  // Records 1, 4, 7… are to do; 2, 8, 11… doing (5, 10… have no stage).
  expect((await titles(page, 'Doing')).slice(0, 2)).toEqual(['Record 2', 'Record 8']);
  await card(page, 'Record 1').dragTo(stack(page, 'Doing'), { targetPosition: { x: 120, y: 4 } });

  await expect.poll(() => api.moves.at(-1)).toEqual({ recordId: recordIdAt(0), afterId: null });
  expect(api.calls).toContain(`PATCH /api/tables/${IDS.table}/records/${recordIdAt(0)}`);
  expect(api.fieldsAt(0)[IDS.stage]).toBe('doing');
  await expect
    .poll(() => titles(page, 'Doing').then((t) => t.slice(0, 2)))
    .toEqual(['Record 1', 'Record 2']);

  await page.reload();
  await expect
    .poll(() => titles(page, 'Doing').then((t) => t.slice(0, 3)))
    .toEqual(['Record 1', 'Record 2', 'Record 8']);
  expect((await titles(page, 'To do'))[0]).toBe('Record 4');
});

test('keyboard: arrows move focus, Alt+arrows move the card; axe-clean', async ({ page }) => {
  const api = await open(page);
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual(
    []
  );

  await card(page, 'Record 1').focus();
  await page.keyboard.press('ArrowDown');
  await expect(card(page, 'Record 4')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(card(page, 'Record 1')).toBeFocused();

  // Down one place in its stack: after Record 4.
  await page.keyboard.press('Alt+ArrowDown');
  await expect
    .poll(() => api.moves.at(-1))
    .toEqual({
      recordId: recordIdAt(0),
      afterId: recordIdAt(3),
    });
  await expect
    .poll(() => titles(page, 'To do').then((t) => t.slice(0, 2)))
    .toEqual(['Record 4', 'Record 1']);
  await expect(card(page, 'Record 1')).toBeFocused();

  // Into the next stack, at the top.
  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(() => api.fieldsAt(0)[IDS.stage]).toBe('doing');
  await expect.poll(() => api.moves.at(-1)).toEqual({ recordId: recordIdAt(0), afterId: null });
  await expect(card(page, 'Record 1')).toBeFocused();

  await page.reload();
  await expect.poll(() => titles(page, 'Doing').then((t) => t[0])).toBe('Record 1');
  await expect.poll(() => titles(page, 'To do').then((t) => t[0])).toBe('Record 4');

  // Enter opens the record.
  await card(page, 'Record 4').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('5,000 cards: stacks are virtualized and scroll to the last card', async ({ page }) => {
  await open(page, 5000);
  const todo = page.getByRole('region', { name: /^To do, / });
  // i % 3 == 0 and i % 5 != 4 among 0…4999.
  await expect(todo.getByTestId('stack-count')).toHaveText('1,334');
  expect(await page.getByRole('listitem').count()).toBeLessThan(120);
  await stack(page, 'To do').evaluate((el) => {
    const scroller = el.parentElement as HTMLElement;
    scroller.scrollTop = scroller.scrollHeight;
  });
  await expect(card(page, 'Record 4999')).toBeVisible();
  expect(await page.getByRole('listitem').count()).toBeLessThan(120);
});

test('add a card in a stack and a stack; lower roles get neither', async ({ page }) => {
  const api = await open(page);
  await page.getByRole('button', { name: 'New record in Doing' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(api.fieldsAt(20)[IDS.stage]).toBe('doing');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Add stack' }).click();
  await page.getByLabel('Stack name').fill('Blocked');
  await page.keyboard.press('Enter');
  await expect
    .poll(() => JSON.stringify(api.fieldWrites.at(-1)?.body ?? {}))
    .toContain('"name":"Blocked"');
  await expect(stack(page, 'Blocked')).toBeAttached();
});

test('a commenter sees the board without move, add-card or add-stack controls', async ({
  page,
}) => {
  await open(page, 20, 'commenter');
  await expect(page.getByRole('button', { name: 'Add stack' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^New record in / })).toHaveCount(0);
  await expect(card(page, 'Record 1')).toHaveAttribute('draggable', 'false');
});
