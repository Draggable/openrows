import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { signInDevUser } from './helpers/stack.js';
import { expect, test } from './helpers/test.js';

// Home against the whole Compose stack (E2E_STACK=1): "Import a file" makes a new base
// from a CSV and lands on its grid with the records; the sidebar lists only the selected
// workspace's bases, and switching workspaces updates it, the URL and the Members link.
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

const sidebarBases = (page: Page) => page.getByRole('navigation', { name: 'Bases' });
const switcher = (page: Page) => page.getByRole('button', { name: /^Workspace: / });

async function expectNoSeriousAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const serious = results.violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? '')
  );
  expect(
    serious.flatMap((v) =>
      v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}: ${n.failureSummary}`)
    )
  ).toEqual([]);
}

/** A new workspace of the dev user (through the API: a first run has no switcher yet), opened. */
async function createWorkspace(page: Page, name: string): Promise<string> {
  const origin = new URL(page.url()).origin;
  const res = await page.request.post('/api/workspaces', { data: { name }, headers: { origin } });
  expect(res.status()).toBe(201);
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/w/${id}`);
  await expect(switcher(page)).toHaveAccessibleName(`Workspace: ${name}`);
  return id;
}

test('imports a CSV from Home into a new base and lands on its grid', async ({ page }) => {
  await signInDevUser(page);
  const name = `E2E import ${Date.now()}`;
  await expect(page.getByText('Excel is coming soon')).toBeVisible();

  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Import a file/ }).click();
  await (await chooser).setFiles({
    name: `${name}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from('Title,Points,Stage\nWrite spec,3,Todo\nBuild it,8,Doing\nShip,5,Done\n'),
  });

  // The new base opens on its table with the import dialog on the file.
  const dialog = page.getByRole('dialog', { name: `Import CSV into ${name}` });
  await expect(dialog.getByText(`${name}.csv`)).toBeVisible();
  await expect(dialog.getByLabel('Type of the new field for Points')).toHaveValue('number');
  await dialog.getByRole('button', { name: 'Import 3 records' }).click();
  await expect(page.getByText('Imported 3 records.')).toBeVisible();
  await expect(dialog).toBeHidden();

  await expect(page).toHaveURL(/\/b\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(name);
  await expect(page.getByTestId('record-count')).toHaveText('3 records');
  for (const header of ['Title', 'Points', 'Stage']) {
    await expect(page.getByRole('columnheader', { name: header })).toBeVisible();
  }
  const grid = page.getByRole('grid');
  for (const text of ['Write spec', 'Build it', 'Ship']) {
    await expect(grid.getByText(text, { exact: true })).toBeVisible();
  }
});

test('the sidebar lists only the selected workspace bases', async ({ page }) => {
  await signInDevUser(page);
  const stamp = Date.now();
  const baseA = `Only in A ${stamp}`;

  const a = await createWorkspace(page, `E2E A ${stamp}`);
  // "New base" on a workspace page creates the base there.
  await page.getByRole('button', { name: 'New base' }).first().click();
  const create = page.getByRole('dialog', { name: 'Create a base' });
  await create.getByLabel('Name').fill(baseA);
  await create.getByRole('button', { name: 'Create base' }).click();
  await expect(page).toHaveURL(/\/b\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);

  const b = await createWorkspace(page, `E2E B ${stamp}`);
  await expect(sidebarBases(page)).toContainText('No bases in this workspace yet');
  await expect(sidebarBases(page).getByRole('link', { name: baseA })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Members' })).toHaveAttribute(
    'href',
    `/w/${b}/members`
  );

  // Switching workspaces updates the list, the URL and the Members link.
  await switcher(page).click();
  await page.getByRole('menuitem', { name: `E2E A ${stamp}` }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${a}$`));
  await expect(sidebarBases(page).getByRole('link', { name: baseA })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Members' })).toHaveAttribute(
    'href',
    `/w/${a}/members`
  );
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expectNoSeriousAxeViolations(page);

  // Home keeps the selected workspace.
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(switcher(page)).toHaveAccessibleName(`Workspace: E2E A ${stamp}`);
  await expect(sidebarBases(page).getByRole('link', { name: baseA })).toBeVisible();
  await expectNoSeriousAxeViolations(page);
});
