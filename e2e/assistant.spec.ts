import AxeBuilder from '@axe-core/playwright';
import type { Page, Route } from '@playwright/test';
import { GRID_URL, IDS, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// The AI assistant against the mocked API: the base's "Assistant" drafts a plan, shows it
// as a list of additions (an operation with a problem unticked) and applies nothing until the
// user confirms, then only the ticked operations; Home's "Describe it" creates a new base the
// same way. Neither shows without an AI provider. The server's side is ai-assistant.test.ts.

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const field = (name: string, type: string, extra: Record<string, unknown> = {}) => ({
  name,
  type,
  description: null,
  choices: null,
  formula: null,
  linkedTable: null,
  ...extra,
});

const basePlan = {
  summary: 'Adds a Customers table, an order total and a board by status.',
  baseName: null,
  operations: [
    {
      op: 'createTable',
      name: 'Customers',
      description: null,
      fields: [
        field('Company', 'singleLineText'),
        field('Tier', 'singleSelect', { choices: ['Gold', 'Silver'] }),
      ],
    },
    {
      op: 'createField',
      table: 'Tasks',
      field: field('Total', 'formula', { formula: '{Estimate} * {Rate}' }),
    },
    { op: 'createView', table: 'Tasks', name: 'Board', type: 'kanban', field: 'Status' },
  ],
};

async function mockAssistant(page: Page, available = true) {
  const calls = { plans: [] as unknown[], applies: [] as unknown[] };
  await page.route(`**/api/workspaces/${IDS.workspace}/ai`, (route) =>
    json(route, { workspaceId: IDS.workspace, available, source: available ? 'instance' : null })
  );
  await page.route(`**/api/bases/${IDS.base}/assistant/plan`, (route) => {
    calls.plans.push(route.request().postDataJSON());
    return json(route, {
      plan: basePlan,
      problems: [
        {
          operation: 1,
          field: 'Total',
          kind: 'formula',
          message: '"Total": Unknown field {Rate}.',
        },
      ],
      attempts: 2,
    });
  });
  await page.route(`**/api/bases/${IDS.base}/assistant/apply`, (route) => {
    calls.applies.push(route.request().postDataJSON());
    return json(route, {
      baseId: IDS.base,
      tables: 1,
      fields: 2,
      views: 0,
      automations: 0,
      firstTableId: IDS.table,
    });
  });
  await page.route(`**/api/workspaces/${IDS.workspace}/assistant/plan`, (route) => {
    calls.plans.push(route.request().postDataJSON());
    return json(route, {
      plan: {
        summary: 'A small CRM.',
        baseName: 'Agency CRM',
        operations: [
          {
            op: 'createTable',
            name: 'Contacts',
            description: null,
            fields: [field('Name', 'singleLineText'), field('Email', 'email')],
          },
          { op: 'createView', table: 'Contacts', name: 'Everyone', type: 'gallery', field: null },
        ],
      },
      problems: [],
      attempts: 1,
    });
  });
  await page.route(`**/api/workspaces/${IDS.workspace}/assistant/apply`, (route) => {
    calls.applies.push(route.request().postDataJSON());
    return json(
      route,
      { baseId: IDS.base, tables: 1, fields: 2, views: 1, automations: 0, firstTableId: IDS.table },
      201
    );
  });
  return calls;
}

test('the base assistant applies nothing until the plan is confirmed', async ({ page }) => {
  await mockApi(page, { rows: 3 });
  const calls = await mockAssistant(page);
  await page.goto(GRID_URL);
  await page.getByRole('button', { name: 'Assistant' }).click();
  const dialog = page.getByRole('dialog', { name: 'Assistant' });
  const records = dialog.getByRole('checkbox', { name: 'Include a few records from each table' });
  await expect(records).not.toBeChecked();
  await dialog.getByLabel('What should change?').fill('Track customers and an order total');
  await dialog.getByRole('button', { name: 'Draft plan' }).click();

  const changes = dialog.getByRole('region', { name: 'Proposed changes' });
  await expect(changes.getByText('Adds a Customers table')).toBeVisible();
  await expect(changes.getByRole('checkbox', { name: /Table Customers/ })).toBeChecked();
  await expect(changes.getByText('Tier: Single select (Gold, Silver)')).toBeVisible();
  // The formula that didn't type-check is shown with its problem, unticked.
  await expect(changes.getByRole('checkbox', { name: /Field Total in Tasks/ })).not.toBeChecked();
  await expect(changes.getByText('"Total": Unknown field {Rate}.')).toBeVisible();
  expect(calls.plans).toEqual([
    { prompt: 'Track customers and an order total', includeRecords: false },
  ]);
  expect(calls.applies).toEqual([]);

  const axe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))).toEqual(
    []
  );

  // Discarding drops the plan; nothing was applied.
  await dialog.getByRole('button', { name: 'Discard' }).click();
  await expect(changes).toBeHidden();
  expect(calls.applies).toEqual([]);

  // Records only with the box ticked; then apply only what stays ticked.
  await records.check();
  await dialog.getByRole('button', { name: 'Draft plan' }).click();
  await changes.getByRole('checkbox', { name: /Kanban view Board/ }).uncheck();
  expect(calls.plans.at(-1)).toEqual({
    prompt: 'Track customers and an order total',
    includeRecords: true,
  });
  expect(calls.applies).toEqual([]);
  await dialog.getByRole('button', { name: 'Apply 1 change' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Applied 1 change')).toBeVisible();
  expect(calls.applies).toEqual([{ plan: { ...basePlan, operations: [basePlan.operations[0]] } }]);
});

test('Home "Describe it" drafts a new base and creates it on confirm', async ({ page }) => {
  await mockApi(page, { rows: 3 });
  const calls = await mockAssistant(page);
  await page.goto('/');
  await page.getByRole('button', { name: /Describe it/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Describe a new base' });
  await dialog.getByLabel('What do you want to track?').fill('A CRM for a small agency');
  await dialog.getByRole('button', { name: 'Draft plan' }).click();
  await expect(dialog.getByRole('checkbox', { name: /Table Contacts/ })).toBeChecked();
  await expect(dialog.getByLabel('Base name')).toHaveValue('Agency CRM');

  // Closing the panel drops the plan without creating anything.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(calls.applies).toEqual([]);

  await page.getByRole('button', { name: /Describe it/ }).click();
  await dialog.getByLabel('What do you want to track?').fill('A CRM for a small agency');
  await dialog.getByRole('button', { name: 'Draft plan' }).click();
  await dialog.getByLabel('Base name').fill('Clients');
  await dialog.getByRole('button', { name: 'Create base with 2 changes' }).click();
  await expect(page).toHaveURL(new RegExp(`/b/${IDS.base}`));
  expect(calls.applies).toHaveLength(1);
  expect(calls.applies[0]).toMatchObject({ name: 'Clients', plan: { baseName: 'Agency CRM' } });
});

test('without an AI provider there is no assistant', async ({ page }) => {
  await mockApi(page, { rows: 3 });
  await mockAssistant(page, false);
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Start from scratch/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Describe it/ })).toHaveCount(0);
  await page.goto(GRID_URL);
  await expect(page.getByRole('grid')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Assistant' })).toHaveCount(0);
});
