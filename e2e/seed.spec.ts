import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { DEV_USER, signInDevUser } from './helpers/stack.js';
import { expect, test } from './helpers/test.js';

// The Product Roadmap demo seed against the whole Compose stack (E2E_STACK=1): the dev user
// signs in (so their user row exists), the seed CLI from packages/server/dist gives them the demo
// workspace (5 tables, 31 fields, 2,000 records) in the stack's Postgres, and the grid shows,
// groups and switches between the seeded tables. Needs `npm run build` (CI builds the server).
// The CLI connects as openrows_app with DATABASE_URL, by default the dev stack's
// localhost:5432, which is also where the CI stack's Postgres is inside its namespace.
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

const count = (page: Page) => page.getByTestId('record-count');
const tables = (page: Page) => page.getByRole('navigation', { name: 'Tables' });

interface SeedOutput {
  workspaceId: string;
  baseId: string;
  tables: { name: string; fields: number; records: number }[];
}

function seed(): SeedOutput {
  const out = execFileSync(
    'node',
    ['packages/server/dist/seed/cli.js', '--email', DEV_USER.email],
    {
      encoding: 'utf8',
      timeout: 120_000,
    }
  );
  const last = out.trim().split('\n').at(-1) ?? '{}';
  return JSON.parse(last) as SeedOutput;
}

test('the seeded Product Roadmap opens in the grid with 2,000 records', async ({ page }) => {
  test.setTimeout(180_000);
  await signInDevUser(page);
  const demo = seed();
  expect(demo.tables.map((t) => t.name)).toEqual([
    'Features',
    'Epics',
    'Releases',
    'Customer feedback',
    'Team',
  ]);
  // Seeding again leaves it as it is.
  expect(seed().workspaceId).toBe(demo.workspaceId);

  await page.goto(`/b/${demo.baseId}`);
  await expect(tables(page).getByRole('link', { name: 'Features' })).toHaveAttribute(
    'aria-current',
    'page'
  );
  await expect(count(page)).toHaveText(/^1,?000 records$/);
  await expect(page.getByRole('columnheader', { name: 'Priority' })).toBeVisible();

  // Group 1,000 features by status on the server, in a new view (the seed outlives a run
  // against a local stack, and a view keeps its grouping).
  await page
    .getByRole('navigation', { name: 'Views' })
    .getByRole('button', { name: 'Create view' })
    .click();
  await page
    .getByRole('menu', { name: 'Create view' })
    .getByRole('menuitem', { name: 'Grid' })
    .click();
  await expect(count(page)).toHaveText(/^1,?000 records$/);
  await page.getByRole('button', { name: 'Group' }).click();
  const group = page.getByRole('dialog', { name: 'Group' });
  await group.getByRole('button', { name: 'Pick a field to group by' }).click();
  await group.getByLabel('Group field 1').selectOption({ label: 'Status' });
  // Bands are virtualized like rows: the first status, Todo, leads with its count.
  const first = page.getByRole('grid').getByTestId('group-header').first();
  await expect(first).toContainText('Todo');
  await expect(first).toContainText(/\d+ records/);
  await page.keyboard.press('Escape');

  await tables(page).getByRole('link', { name: 'Customer feedback' }).click();
  await expect(count(page)).toHaveText('600 records');
  await tables(page).getByRole('link', { name: 'Team' }).click();
  await expect(count(page)).toHaveText('100 records');

  // Created by names the seeding user from the collaborator directory, and filters by
  // them with "me". The condition is removed again, since the seed outlives a local run.
  await expect(page.getByRole('columnheader', { name: 'Created by' })).toBeVisible();
  await expect(page.getByRole('grid').locator('[data-cell="0:4"]')).toContainText('Dev User');
  await page.getByRole('button', { name: 'Filter' }).click();
  const filter = page.getByRole('dialog', { name: 'Filter' });
  await filter.getByRole('button', { name: 'Add condition', exact: true }).click();
  await filter.getByLabel('Field').selectOption({ label: 'Created by' });
  await filter.getByLabel('Value of Created by').selectOption({ label: 'Me (Dev User)' });
  await expect(page.getByRole('button', { name: 'Filter (1)' })).toBeVisible();
  await expect(count(page)).toHaveText('100 records');
  await filter.getByLabel('Operator').selectOption({ label: 'is not' });
  await expect(count(page)).toHaveText('0 records');
  await filter.getByRole('button', { name: 'Remove condition' }).click();
  await expect(count(page)).toHaveText('100 records');
});
