import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { GRID_URL, IDS, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// Table and field edit permissions against the mocked API (e2e/fixtures/mockApi.ts, which
// refuses restricted writes with 403 as the server does): an editor sees a creators-only field
// locked and can't edit it by typing, Enter, paste or fill, while its other fields stay
// editable; a creator sets a field's and a table's permissions from their menus.

const grid = (page: Page) => page.getByRole('grid');
const header = (page: Page, name: string) =>
  grid(page).getByRole('columnheader', { name, exact: true });
const cell = (page: Page, row: number, col: number) =>
  grid(page).locator(`[data-cell="${row}:${col}"]`);
const COL = { name: 0, estimate: 3 };

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

test("an editor can't edit a creators-only field, and the column shows it locked", async ({
  page,
}) => {
  const api = await mockApi(page, {
    rows: 5,
    role: 'editor',
    fieldPermissions: { [IDS.estimate]: { edit: { level: 'creators' } } },
  });
  await page.goto(GRID_URL);
  await expect(cell(page, 0, COL.name)).toHaveText('Record 1');

  // The lock on the restricted column only.
  const lock = header(page, 'Estimate').getByTestId('field-lock');
  await expect(lock).toBeVisible();
  await expect(lock).toContainText("You don't have permission to edit this field.");
  await expect(header(page, 'Name').getByTestId('field-lock')).toHaveCount(0);

  // Enter and typing don't open the editor; a toast says why.
  const before = api.fieldsAt(0)[IDS.estimate];
  await cell(page, 0, COL.estimate).click();
  await page.keyboard.press('Enter');
  await expect(page.getByText("You don't have permission to edit Estimate")).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Edit Estimate' })).toHaveCount(0);
  await page.keyboard.type('9');
  await expect(page.getByRole('dialog', { name: 'Edit Estimate' })).toHaveCount(0);
  await expect(cell(page, 0, COL.estimate)).toHaveText(String(before));

  // Clearing the restricted cell (Delete) writes nothing.
  await page.keyboard.press('Delete');
  await expect(cell(page, 0, COL.estimate)).toHaveText(String(before));

  // The unrestricted Name is still editable.
  await cell(page, 1, COL.name).click();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Renamed');
  await page.keyboard.press('Enter');
  await expect(cell(page, 1, COL.name)).toHaveText('Renamed');
  expect(api.fieldsAt(1)[IDS.name]).toBe('Renamed');

  // The client never sent a restricted write; editors get no "Edit permissions" item.
  expect(api.restrictedWrites).toEqual([]);
  expect(api.fieldsAt(0)[IDS.estimate]).toBe(before);
  await header(page, 'Estimate').getByRole('button').click();
  await expect(page.getByRole('menuitem', { name: 'Edit permissions' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  // The locked header (the virtualized grid's own structure is covered by grid.spec.ts).
  await expectNoSeriousA11yIssues(page, `[role="columnheader"][data-field-id="${IDS.estimate}"]`);
});

test('a creator restricts a field and a table from their menus', async ({ page }) => {
  const api = await mockApi(page, { rows: 5, role: 'creator' });
  await page.goto(GRID_URL);
  await expect(cell(page, 0, COL.name)).toHaveText('Record 1');
  await expect(header(page, 'Estimate').getByTestId('field-lock')).toHaveCount(0);

  await header(page, 'Estimate').getByRole('button').click();
  await page.getByRole('menuitem', { name: 'Edit permissions', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Permissions for Estimate' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Who can edit this field').selectOption('creators');
  await expectNoSeriousA11yIssues(page, '[role="dialog"]');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  expect(api.fieldWrites.at(-1)).toEqual({
    call: `PATCH /api/fields/${IDS.estimate}`,
    body: { permissions: { edit: { level: 'creators' } } },
  });
  // Locked for everyone to see; the creator can still edit it.
  const lock = header(page, 'Estimate').getByTestId('field-lock');
  await expect(lock).toContainText('Editing this field is restricted. You can edit it.');

  // "Specific people" lists roles and collaborators.
  await header(page, 'Estimate').getByRole('button').click();
  await page.getByRole('menuitem', { name: 'Edit permissions', exact: true }).click();
  await dialog.getByLabel('Who can edit this field').selectOption('specific');
  await dialog.getByLabel('All owners').check();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  expect(api.fieldWrites.at(-1)?.body).toEqual({
    permissions: { edit: { level: 'specific', userIds: [], roles: ['owner'] } },
  });

  // A locked field can still be filled through public forms; the switch shows only
  // while editors can't edit the field.
  await header(page, 'Estimate').getByRole('button').click();
  await page.getByRole('menuitem', { name: 'Edit permissions', exact: true }).click();
  const viaForms = dialog.getByLabel(/Allow this field to be filled through forms/);
  await dialog.getByLabel('Who can edit this field').selectOption('editors');
  await expect(viaForms).toHaveCount(0);
  await dialog.getByLabel('Who can edit this field').selectOption('nobody');
  await viaForms.check();
  await expectNoSeriousA11yIssues(page, '[role="dialog"]');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  expect(api.fieldWrites.at(-1)?.body).toEqual({
    permissions: { edit: { level: 'nobody' }, allowForms: true },
  });

  // The table menu: who can add, delete and edit records.
  const tableRequests: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().endsWith(`/api/tables/${IDS.table}`)) {
      tableRequests.push(r.postData() ?? '');
    }
  });
  await page.getByRole('button', { name: 'Features options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit permissions', exact: true }).click();
  const tableDialog = page.getByRole('dialog', { name: 'Permissions for Features' });
  await tableDialog.getByLabel('Who can delete records').selectOption('creators');
  await tableDialog.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => tableRequests.length).toBe(1);
  expect(JSON.parse(tableRequests[0] ?? '{}')).toEqual({
    permissions: {
      addRecords: { level: 'editors' },
      deleteRecords: { level: 'creators' },
      editRecords: { level: 'editors' },
    },
  });
});
