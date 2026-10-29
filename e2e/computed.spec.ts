import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Page } from '@playwright/test';
import { setPlanOverrides, signInDevUser } from './helpers/stack.js';
import { expect, test } from './helpers/test.js';

// Lookup, rollup and count fields made from the field editor, and link filters by record,
// against the whole Compose stack (E2E_STACK=1): the server computes the values.
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

test.use({ viewport: { width: 1800, height: 800 } });

type Field = { id: string; name: string };
type Table = { id: string; baseId: string; fields: Field[] };

const grid = (page: Page) => page.getByRole('grid');
const cell = (page: Page, row: number, col: number) =>
  grid(page).locator(`[data-cell="${row}:${col}"]`);

async function post<T>(request: APIRequestContext, origin: string, path: string, data: unknown) {
  const res = await request.post(path, { data, headers: { origin } });
  expect(res.ok(), `${path}: ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

async function expectNoSeriousA11yIssues(page: Page, selector: string) {
  const results = await new AxeBuilder({ page })
    .include(selector)
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  const serious = results.violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? '')
  );
  expect(serious.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))).toEqual([]);
}

/** Opens "Add field", names the field and picks a type from the Computed group. */
async function newField(page: Page, name: string, type: string) {
  await page.getByRole('button', { name: 'Add field' }).click();
  await page.getByLabel('Field name').fill(name);
  await page.getByRole('combobox', { name: 'Search field types' }).fill(type);
  await page
    .getByRole('group', { name: 'Computed' })
    .getByRole('option', { name: type, exact: true })
    .click();
}

test('lookup, rollup and count from the field editor; filter and group by linked records', async ({
  page,
}) => {
  await signInDevUser(page);
  const origin = new URL(page.url()).origin;
  const api = <T>(path: string, data: unknown) => post<T>(page.request, origin, path, data);
  const workspace = await api<{ id: string }>('/api/workspaces', {
    name: `Computed ${Date.now()}`,
  });
  const base = await api<{ id: string }>(`/api/workspaces/${workspace.id}/bases`, {
    name: 'Portfolio',
  });
  const projects = await api<Table>(`/api/bases/${base.id}/tables`, { name: 'Projects' });
  const tasks = await api<Table>(`/api/bases/${base.id}/tables`, { name: 'Tasks' });
  const nameOf = (t: Table) => t.fields.find((f) => f.name === 'Name')?.id ?? '';
  const budget = await api<Field>(`/api/tables/${projects.id}/fields`, {
    name: 'Budget',
    type: 'number',
  });
  const link = await api<Field>(`/api/tables/${tasks.id}/fields`, {
    name: 'Project',
    type: 'link',
    options: { linkedTableId: projects.id },
  });
  const created = await api<{ records: { id: string }[] }>(`/api/tables/${projects.id}/records`, {
    records: [
      { fields: { [nameOf(projects)]: 'Alpha', [budget.id]: 100 } },
      { fields: { [nameOf(projects)]: 'Beta', [budget.id]: 250 } },
      { fields: { [nameOf(projects)]: 'Gamma', [budget.id]: 50 } },
    ],
  });
  const [alpha, beta, gamma] = created.records.map((r) => r.id);
  await api(`/api/tables/${tasks.id}/records`, {
    records: [
      { fields: { [nameOf(tasks)]: 'Write spec', [link.id]: [alpha, beta] } },
      { fields: { [nameOf(tasks)]: 'Ship', [link.id]: [gamma] } },
      { fields: { [nameOf(tasks)]: 'Idle' } },
    ],
  });
  // Name, Notes, Status, Project, then the fields made here.
  const COL = { name: 0, project: 3, lookup: 4, rollup: 5, count: 6 };

  await page.goto(`/b/${base.id}/${tasks.id}`);
  await expect(cell(page, 0, COL.name)).toHaveText('Write spec');

  await test.step('a lookup of the projects’ names', async () => {
    await newField(page, 'Project names', 'Lookup');
    await page.getByLabel('Linked record field').selectOption({ label: 'Project' });
    await page.getByLabel('Field to look up').selectOption({ label: 'Name' });
    await page.getByRole('button', { name: 'Create field' }).click();
    await expect(page.getByRole('columnheader', { name: 'Project names' })).toBeVisible();
    await expect(cell(page, 0, COL.lookup)).toHaveText('Alpha, Beta');
    await expect(cell(page, 1, COL.lookup)).toHaveText('Gamma');
    await expect(cell(page, 2, COL.lookup)).toHaveText('');
  });

  await test.step('a rollup summing their budgets', async () => {
    await newField(page, 'Total budget', 'Rollup');
    await page.getByLabel('Linked record field').selectOption({ label: 'Project' });
    await page.getByLabel('Field to roll up').selectOption({ label: 'Budget' });
    await page.getByLabel('Aggregation').selectOption('SUM');
    await expectNoSeriousA11yIssues(page, 'form[aria-label="New field"]');
    await page.getByRole('button', { name: 'Create field' }).click();
    await expect(page.getByRole('columnheader', { name: 'Total budget' })).toBeVisible();
    await expect(cell(page, 0, COL.rollup)).toHaveText('350');
    await expect(cell(page, 1, COL.rollup)).toHaveText('50');
  });

  await test.step('a count of the linked projects', async () => {
    await newField(page, 'Projects linked', 'Count');
    await page.getByLabel('Linked record field').selectOption({ label: 'Project' });
    await page.getByRole('button', { name: 'Create field' }).click();
    await expect(page.getByRole('columnheader', { name: 'Projects linked' })).toBeVisible();
    await expect(cell(page, 0, COL.count)).toHaveText('2');
    await expect(cell(page, 1, COL.count)).toHaveText('1');
    await expect(cell(page, 2, COL.count)).toHaveText('0');
  });

  await test.step('the values follow a change of the linked records', async () => {
    const res = await page.request.patch(`/api/tables/${projects.id}/records`, {
      data: { records: [{ id: gamma, fields: { [budget.id]: 75 } }] },
      headers: { origin },
    });
    expect(res.ok()).toBe(true);
    await page.reload();
    await expect(cell(page, 1, COL.rollup)).toHaveText('75');
  });

  await test.step('filter by specific linked records, axe-clean', async () => {
    await page.getByRole('button', { name: 'Filter' }).click();
    const popover = page.getByRole('dialog', { name: 'Filter' });
    await popover.getByRole('button', { name: 'Add condition', exact: true }).click();
    await popover.getByLabel('Field').selectOption({ label: 'Project' });
    await popover.getByLabel('Operator').selectOption({ label: 'has any of' });
    await popover.getByRole('button', { name: 'Pick records' }).click();
    const picker = page.getByRole('dialog', { name: 'Pick Project records' });
    await picker.getByRole('combobox', { name: 'Find a record for Project' }).fill('gam');
    await picker.getByRole('option', { name: 'Gamma' }).click();
    await expect(picker.getByRole('option', { name: 'Gamma' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expectNoSeriousA11yIssues(page, '[role="dialog"]');
    await page.keyboard.press('Escape');
    await expect(popover.getByRole('button', { name: 'Remove Gamma' })).toBeVisible();
    await expect(cell(page, 0, COL.name)).toHaveText('Ship');
    await expect(cell(page, 1, COL.name)).toHaveCount(0);
    await expectNoSeriousA11yIssues(page, '[role="dialog"]');

    // The picked records stay with "has none of".
    await popover.getByLabel('Operator').selectOption({ label: 'has none of' });
    await expect(cell(page, 0, COL.name)).toHaveText('Write spec');
    await expect(cell(page, 1, COL.name)).toHaveText('Idle');
    await popover.getByRole('button', { name: 'Pick records' }).click();
    await picker.getByRole('option', { name: 'Alpha' }).click();
    await page.keyboard.press('Escape');
    await expect(cell(page, 0, COL.name)).toHaveText('Idle');
    await expect(cell(page, 1, COL.name)).toHaveCount(0);
    await popover.getByRole('button', { name: 'Remove condition' }).click();
    await page.keyboard.press('Escape');
    await expect(cell(page, 2, COL.name)).toHaveText('Idle');
  });

  await test.step('group by the linked records', async () => {
    await page.getByRole('button', { name: 'Group' }).click();
    const group = page.getByRole('dialog', { name: 'Group' });
    await group.getByRole('button', { name: 'Pick a field to group by' }).click();
    await group.getByLabel('Group field 1').selectOption({ label: 'Project' });
    // (empty), "Alpha, Beta", "Gamma".
    const headers = grid(page).getByTestId('group-header');
    await expect(headers).toHaveCount(3);
    await expect(headers.nth(1)).toContainText('Alpha');
    await expect(headers.nth(1)).toContainText('Beta');
    await expect(headers.nth(2)).toContainText('Gamma');
    await page.keyboard.press('Escape');
  });
});

test('a formula over more records than the sync limit fills in from the worker (#86)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signInDevUser(page);
  const origin = new URL(page.url()).origin;
  const api = <T>(path: string, data: unknown) => post<T>(page.request, origin, path, data);
  const workspace = await api<{ id: string }>('/api/workspaces', {
    name: `Recompute ${Date.now()}`,
  });
  const base = await api<{ id: string }>(`/api/workspaces/${workspace.id}/bases`, {
    name: 'Big',
  });
  // CI's stack runs the hosted edition, whose Free plan stops at 1,000 records per base.
  await setPlanOverrides(page, workspace.id, { limits: { recordsPerBase: null } });
  const table = await api<Table>(`/api/bases/${base.id}/tables`, { name: 'Items' });
  const name = table.fields.find((f) => f.name === 'Name')?.id ?? '';
  // 5,001 records: one more than the default sync limit (COMPUTED_SYNC_LIMIT).
  for (let i = 0; i < 5001; i += 1000) {
    const n = Math.min(1000, 5001 - i);
    await api(`/api/tables/${table.id}/records`, {
      records: Array.from({ length: n }, (_, j) => ({
        fields: { [name]: `Item ${String(i + j).padStart(4, '0')}` },
      })),
    });
  }
  await page.goto(`/b/${base.id}/${table.id}`);
  await expect(cell(page, 0, 0)).toHaveText('Item 0000');

  // The request returns at once with the field flagged; the worker computes it, and the open
  // grid refetches on its `field.recomputed` event, without a reload.
  const formula = await api<Field & { recomputing?: boolean }>(`/api/tables/${table.id}/fields`, {
    name: 'Shout',
    type: 'formula',
    options: { formula: `UPPER({Name}) & "!"` },
  });
  expect(formula.recomputing).toBe(true);
  const column = grid(page).getByRole('columnheader', { name: 'Shout', exact: true });
  await expect(column).toBeVisible();
  // The header's aria-colindex counts the row number column (1-based), cells don't.
  const col = Number(await column.getAttribute('aria-colindex')) - 2;
  await expect(cell(page, 0, col)).toHaveText('ITEM 0000!', { timeout: 60_000 });
  await expect(column.getByTestId('field-recomputing')).toHaveCount(0, { timeout: 60_000 });
});
