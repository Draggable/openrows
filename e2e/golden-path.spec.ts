import type { Page } from '@playwright/test';
import { latestMessageTo } from './auth/mailpit.js';
import { gridIds, signUp } from './helpers/stack.js';
import { expect, test, watchCsp } from './helpers/test.js';

// The golden path against the whole Compose stack (E2E_STACK=1; CI's smoke job): a new
// user signs up through Keycloak, creates a base, creates a field of every type, enters data,
// filters, sorts and groups, imports a CSV, downloads the view as CSV and invites a
// collaborator, who signs up and accepts. Nothing is mocked: Postgres, Keycloak, Mailpit, S3.
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');
test.use({ viewport: { width: 2600, height: 900 } });

/** Every field type, by its picker label, with the name the test gives it (in grid order). */
const FIELDS = [
  ['Effort', 'Number'],
  ['Approved', 'Checkbox'],
  ['Owner', 'Single line text'],
  ['Details', 'Long text'],
  ['Priority', 'Single select'],
  ['Tags', 'Multiple select'],
  ['Due', 'Date'],
  ['Kickoff', 'Date and time'],
  ['Budget', 'Currency'],
  ['Progress', 'Percent'],
  ['Time spent', 'Duration'],
  ['Confidence', 'Rating'],
  ['Contact', 'Email'],
  ['Spec', 'URL'],
  ['Phone', 'Phone number'],
  ['Files', 'Attachment'],
  ['Ref', 'Autonumber'],
  ['Created', 'Created time'],
  ['Modified', 'Last modified time'],
  ['Author', 'Created by'],
  ['Changed by', 'Last modified by'],
] as const;

// Name, Notes and Status come with every new table; the fields above follow.
const COL = { name: 0, status: 2, effort: 3 };

const grid = (page: Page) => page.getByRole('grid');
const cell = (page: Page, row: number, col: number) =>
  grid(page).locator(`[data-cell="${row}:${col}"]`);
const count = (page: Page) => page.getByTestId('record-count');
const records = (n: number) => new RegExp(`^${n} records?$`);

test('sign up, build a base, work with data, import, export and invite', async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  const owner = {
    email: `golden-${stamp}@openrows.test`,
    firstName: 'Gwen',
    lastName: 'Golden',
    password: 'golden-path-password-1',
  };
  const invitee = {
    email: `invitee-${stamp}@openrows.test`,
    firstName: 'Ivan',
    lastName: 'Invitee',
    password: 'golden-path-password-2',
  };

  await test.step('the app is served with its security headers (#69)', async () => {
    const res = await page.goto('/login');
    const headers = res?.headers() ?? {};
    // Enforced, not report-only: every page of this test runs under it, and the auto fixture
    // in helpers/test.ts fails the test on any violation.
    expect(headers['content-security-policy']).toContain("script-src 'self';");
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['x-content-type-options']).toBe('nosniff');
    // /login is on an OAuth app's popup path, so it keeps its opener (unsafe-none); other pages
    // are same-origin (security-headers.test.ts).
    expect(headers['cross-origin-opener-policy']).toBe('unsafe-none');
  });

  await test.step('sign up', async () => {
    await signUp(page, owner);
    await expect(page.getByTestId('current-user')).toContainText('Gwen Golden');
  });

  await test.step('create a base', async () => {
    await page.getByRole('button', { name: 'New base' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Create a base' });
    await dialog.getByLabel('Name').fill('Launch plan');
    await dialog.getByRole('button', { name: 'Create base' }).click();
    await expect(page).toHaveURL(/\/b\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('columnheader', { name: 'Name' })).toBeVisible();
    await expect(count(page)).toHaveText(records(0));
  });
  const { baseId, tableId, viewId } = gridIds(page.url());

  await test.step('create a field of every type', async () => {
    for (const [name, label] of FIELDS) {
      await page.getByRole('button', { name: 'Add field' }).click();
      await page.getByLabel('Field name').fill(name);
      await page.getByRole('combobox', { name: 'Search field types' }).fill(label);
      await page.getByRole('option', { name: label, exact: true }).click();
      await page.getByRole('button', { name: 'Create field' }).click();
      await expect(page.getByRole('button', { name: 'Create field' })).toBeHidden();
    }
    const res = await page.request.get(`/api/tables/${tableId}`);
    const { fields } = (await res.json()) as { fields: { name: string; type: string }[] };
    expect(fields.map((f) => f.name)).toEqual([
      'Name',
      'Notes',
      'Status',
      ...FIELDS.map((f) => f[0]),
    ]);
    // Every registered type is there (the defaults repeat three of them).
    expect(new Set(fields.map((f) => f.type)).size).toBe(FIELDS.length);
    // Adding fields scrolled the grid to the right; start the data entry from the left.
    await page.reload();
    await expect(page.getByRole('columnheader', { name: 'Effort' })).toBeVisible();
  });

  const rows = [
    ['Write the spec', '3', 'Done'],
    ['Build the grid', '8', 'In progress'],
    ['Ship it', '5', 'Todo'],
  ] as const;

  await test.step('enter data', async () => {
    for (const [i, [name, effort, status]] of rows.entries()) {
      await page.getByRole('button', { name: 'Add record' }).click();
      await expect(count(page)).toHaveText(records(i + 1));
      await cell(page, i, COL.name).click();
      await page.keyboard.type(name);
      await page.keyboard.press('Enter');
      await expect(cell(page, i, COL.name)).toHaveText(name);
      await cell(page, i, COL.effort).click();
      await page.keyboard.type(effort);
      await page.keyboard.press('Enter');
      await expect(cell(page, i, COL.effort)).toHaveText(effort);
      await cell(page, i, COL.status).click();
      await page.keyboard.press('Enter');
      await page.keyboard.type(status);
      await page.keyboard.press('Enter');
      await expect(cell(page, i, COL.status)).toHaveText(status);
    }
    // Saved on the server: the values come back after a reload.
    await page.reload();
    await expect(count(page)).toHaveText(records(3));
    await expect(cell(page, 1, COL.name)).toHaveText('Build the grid');
    await expect(cell(page, 1, COL.effort)).toHaveText('8');
    await expect(cell(page, 1, COL.status)).toHaveText('In progress');
  });

  await test.step('filter, sort and group', async () => {
    await page.getByRole('button', { name: 'Filter' }).click();
    const filter = page.getByRole('dialog', { name: 'Filter' });
    await filter.getByRole('button', { name: 'Add condition', exact: true }).click();
    await filter.getByLabel('Field').selectOption({ label: 'Effort' });
    await filter.getByLabel('Operator').selectOption({ label: '>' });
    await filter.getByLabel('Value of Effort').fill('4');
    await expect(count(page)).toHaveText(records(2));
    await filter.getByRole('button', { name: 'Remove condition' }).click();
    await expect(count(page)).toHaveText(records(3));
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Sort' }).click();
    const sort = page.getByRole('dialog', { name: 'Sort' });
    await sort.getByRole('button', { name: 'Pick a field to sort by' }).click();
    await sort.getByLabel('Sort field 1').selectOption({ label: 'Effort' });
    await sort.getByLabel('Sort direction 1').selectOption({ label: '9 → 1' });
    await expect(cell(page, 0, COL.name)).toHaveText('Build the grid');
    await expect(cell(page, 2, COL.name)).toHaveText('Write the spec');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Group' }).click();
    const group = page.getByRole('dialog', { name: 'Group' });
    await group.getByRole('button', { name: 'Pick a field to group by' }).click();
    await group.getByLabel('Group field 1').selectOption({ label: 'Status' });
    await expect(grid(page).getByTestId('group-header')).toHaveCount(3);
    await group.getByRole('button', { name: 'Remove group 1' }).click();
    await expect(grid(page).getByTestId('group-header')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // The sort is saved with the view (the save is debounced, so wait for it).
    await expect
      .poll(async () => {
        const view = (await (await page.request.get(`/api/views/${viewId}`)).json()) as {
          config: { sorts?: unknown[] };
        };
        return view.config.sorts?.length ?? 0;
      })
      .toBe(1);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Sort (1)' })).toBeVisible();
    await expect(cell(page, 0, COL.name)).toHaveText('Build the grid');
  });

  await test.step('import a CSV', async () => {
    await page.getByRole('button', { name: 'More view actions' }).click();
    await page.getByRole('menuitem', { name: 'Import CSV…' }).click();
    const dialog = page.getByRole('dialog', { name: /Import CSV/ });
    await dialog.getByLabel('Choose a CSV file').setInputFiles({
      name: 'more-tasks.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Name,Effort,Status\nWrite docs,2,Todo\nLoad test,13,In progress\n'),
    });
    await expect(dialog.getByText('more-tasks.csv')).toBeVisible();
    await dialog.getByRole('button', { name: 'Import 2 records' }).click();
    await expect(page.getByText('Imported 2 records.')).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(count(page)).toHaveText(records(5));
    // Sorted by effort, descending: the imported 13 leads.
    await expect(cell(page, 0, COL.name)).toHaveText('Load test');
    await expect(cell(page, 0, COL.status)).toHaveText('In progress');
  });

  await test.step('download the view as CSV', async () => {
    await page.getByRole('button', { name: 'More view actions' }).click();
    const href = await page.getByRole('menuitem', { name: 'Download CSV' }).getAttribute('href');
    await page.keyboard.press('Escape');
    const res = await page.request.get(href ?? '');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/csv');
    const lines = (await res.text()).replace(/^﻿/, '').trim().split(/\r?\n/);
    expect(lines[0]).toMatch(/^Name,Notes,Status,Effort,/);
    // The view's sort applies: effort 13, 8, 5, 3, 2.
    expect(lines.slice(1).map((l) => l.split(',')[0])).toEqual([
      'Load test',
      'Build the grid',
      'Ship it',
      'Write the spec',
      'Write docs',
    ]);
  });

  let inviteLink = '';
  let workspaceId = '';
  await test.step('invite a collaborator', async () => {
    const base = (await (await page.request.get(`/api/bases/${baseId}`)).json()) as {
      workspaceId: string;
    };
    workspaceId = base.workspaceId;
    await page.goto(`/w/${workspaceId}/members`);
    await page.getByLabel('Email', { exact: true }).fill(invitee.email);
    await page.getByLabel('Role', { exact: true }).selectOption('editor');
    await page.getByRole('button', { name: 'Invite' }).click();
    await expect(
      page.getByRole('list', { name: 'Pending invitations' }).getByText(invitee.email)
    ).toBeVisible();
    const mail = await latestMessageTo(invitee.email);
    inviteLink = mail.match(/https?:\/\/\S+\/invite\/[A-Za-z0-9_-]+/)?.[0] ?? '';
    expect(inviteLink, 'invitation link in the email').toBeTruthy();
  });

  await test.step('the collaborator signs up and accepts', async () => {
    const context = await browser.newContext();
    const violations = await watchCsp(context, new URL(page.url()).origin);
    const other = await context.newPage();
    try {
      await signUp(other, invitee);
      await other.goto(new URL(inviteLink).pathname);
      await other.getByRole('button', { name: 'Accept invitation' }).click();
      await expect
        .poll(async () => {
          const res = await other.request.get('/api/workspaces');
          const { workspaces } = (await res.json()) as {
            workspaces: { id: string; role: string }[];
          };
          return workspaces.find((w) => w.id === workspaceId)?.role;
        })
        .toBe('editor');
      // They see the base and its records.
      const res = await other.request.get(`/api/tables/${tableId}/records`);
      expect(res.status()).toBe(200);
      expect(((await res.json()) as { records: unknown[] }).records).toHaveLength(5);
      expect(violations, 'Content-Security-Policy violations').toEqual([]);
    } finally {
      await context.close();
    }
  });
});
