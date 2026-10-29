import AxeBuilder from '@axe-core/playwright';
import type { Page, Route } from '@playwright/test';
import { IDS, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// "Import from Airtable" on Home against the mocked API: paste a token, pick a
// base, start the import, watch its progress bar, see it finish (a toast too) and read its
// report; cancel a running one. The token goes only in request bodies, and is cleared from the
// dialog once the import starts.

const TOKEN = `patE2eFixture0001.${'ab12'.repeat(16)}`;
const NEW_BASE = '00000002-0000-4000-8000-0000000000a1';
const IMPORT_ID = '00000009-0000-4000-8000-0000000000a1';

const report = {
  tables: [{ name: 'Projects', tableId: IDS.table, fields: 12, records: 3 }],
  unsupportedFields: [
    { table: 'Projects', field: 'Tasks', type: 'multipleRecordLinks', message: 'Later.' },
  ],
  untranslatedFormulas: [
    {
      table: 'Projects',
      field: 'Code',
      type: 'formula',
      formula: 'AUTONUMBER()',
      message: 'Unknown function AUTONUMBER',
    },
  ],
  converted: [],
  skippedCells: 0,
  truncatedTables: [],
  failedAttachments: [
    { table: 'Projects', field: 'Files', filename: 'logo.png', message: 'Airtable answered 404.' },
  ],
  skippedLinks: 0,
  views: 2,
  unsupportedViews: [
    { table: 'Projects', view: 'Due dates', type: 'calendar', message: 'Not imported.' },
  ],
};

type Status = 'running' | 'done' | 'cancelled';

function job(status: Status) {
  const running = status === 'running';
  return {
    id: IMPORT_ID,
    baseId: NEW_BASE,
    airtableBaseId: 'appFixtureBase001',
    name: 'Product launch',
    status,
    phase: running ? 'records' : 'links',
    tables: 2,
    tablesDone: running ? 1 : 2,
    records: running ? 100 : 153,
    attachments: running ? 2 : 3,
    attachmentsFailed: running ? 0 : 1,
    linkedRecords: running ? 0 : 85,
    percent: status === 'done' ? 100 : 43,
    report: running
      ? { ...report, tables: [], unsupportedFields: [], untranslatedFormulas: [] }
      : report,
    error:
      status === 'cancelled' ? 'You cancelled the import. The base keeps what was imported.' : null,
    createdAt: '2026-10-27T10:00:00.000Z',
    startedAt: '2026-10-27T10:00:00.000Z',
    finishedAt: running ? null : '2026-10-27T10:00:05.000Z',
  };
}

async function mockAirtable(page: Page, opts: { finishAfter?: number } = {}) {
  const bodies: string[] = [];
  let started = false;
  let polls = 0;
  let cancelled = false;
  const finishAfter = opts.finishAfter ?? 4;
  const current = (): Status =>
    cancelled ? 'cancelled' : polls > finishAfter ? 'done' : 'running';
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(`**/api/workspaces/${IDS.workspace}/airtable/**`, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.postData()) bodies.push(req.postData() ?? '');
    if (req.method() === 'POST' && path.endsWith('/airtable/bases')) {
      return json(route, {
        bases: [
          { id: 'appFixtureBase001', name: 'Product launch', permissionLevel: 'create' },
          { id: 'appOtherBase00001', name: 'Hiring', permissionLevel: 'read' },
        ],
      });
    }
    if (req.method() === 'POST' && path.endsWith('/airtable/imports')) {
      started = true;
      return json(route, { imports: [job('running')] }, 201);
    }
    if (req.method() === 'GET' && path.endsWith('/airtable/imports')) {
      if (!started) return json(route, { imports: [] });
      polls++;
      return json(route, { imports: [job(current())] });
    }
    if (req.method() === 'GET' && path.endsWith(`/airtable/imports/${IMPORT_ID}`)) {
      return json(route, job(current()));
    }
    if (req.method() === 'POST' && path.endsWith(`/airtable/imports/${IMPORT_ID}/cancel`)) {
      cancelled = true;
      return json(route, job('cancelled'));
    }
    return route.fulfill({ status: 404 });
  });
  return { bodies };
}

test('imports an Airtable base and shows the report', async ({ page }) => {
  await mockApi(page, { rows: 1 });
  const airtable = await mockAirtable(page);
  await page.goto('/');
  await page.getByRole('button', { name: /Import from Airtable/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Import from Airtable' });
  await expect(dialog).toBeVisible();

  const find = dialog.getByRole('button', { name: 'Find bases' });
  await expect(find).toBeDisabled();
  await dialog.getByLabel('Airtable personal access token').fill(TOKEN);
  await find.click();

  await dialog.getByRole('checkbox', { name: 'Product launch' }).check();
  const results = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  expect(
    results.violations
      .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
      .map((v) => v.id)
  ).toEqual([]);
  await dialog.getByRole('button', { name: 'Import 1 base' }).click();
  await expect(page.getByText('Importing 1 base')).toBeVisible();

  // While it runs: the progress bar, counts and Cancel.
  const item = dialog
    .getByRole('region', { name: 'Your Airtable imports' })
    .getByRole('listitem')
    .filter({ hasText: 'Product launch' });
  await expect(item.getByRole('progressbar', { name: 'Product launch' })).toHaveAttribute(
    'aria-valuenow',
    '43'
  );
  await expect(item).toContainText('1 of 2 tables');
  await expect(item).toContainText('2 files');
  await expect(item.getByRole('button', { name: 'Cancel' })).toBeVisible();

  await expect(item).toContainText('Done: 2 tables, 153 records');
  await expect(item.getByRole('progressbar')).toHaveCount(0);
  await expect(item).toContainText('2 views imported');
  await expect(item).toContainText('1 field left out');
  await expect(item).toContainText('1 formula kept as text');
  await expect(item).toContainText('1 file not copied');
  await item.getByText('Import report').click();
  await expect(item).toContainText('Projects › Code (formula): Unknown function AUTONUMBER');
  await expect(item).toContainText('Projects › Files (logo.png): Airtable answered 404.');
  await expect(item).toContainText('Projects › Due dates (calendar): Not imported.');
  // The toast says it's done (the watcher), with a way to the base.
  await expect(page.getByText('Airtable import done: Product launch')).toBeVisible({
    timeout: 15_000,
  });
  await expect(item.getByRole('link', { name: 'Open base' })).toHaveAttribute(
    'href',
    `/b/${NEW_BASE}`
  );

  // Back to the token step, emptied: the token isn't kept in the page.
  await expect(dialog.getByLabel('Airtable personal access token')).toHaveValue('');
  const sent = airtable.bodies.map((b) => JSON.parse(b) as { token?: string; baseIds?: string[] });
  expect(sent).toEqual([{ token: TOKEN }, { token: TOKEN, baseIds: ['appFixtureBase001'] }]);
});

test('cancels a running import', async ({ page }) => {
  await mockApi(page, { rows: 1 });
  await mockAirtable(page, { finishAfter: 1_000_000 });
  await page.goto('/');
  await page.getByRole('button', { name: /Import from Airtable/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Import from Airtable' });
  await dialog.getByLabel('Airtable personal access token').fill(TOKEN);
  await dialog.getByRole('button', { name: 'Find bases' }).click();
  await dialog.getByRole('checkbox', { name: 'Product launch' }).check();
  await dialog.getByRole('button', { name: 'Import 1 base' }).click();
  const item = dialog
    .getByRole('region', { name: 'Your Airtable imports' })
    .getByRole('listitem')
    .filter({ hasText: 'Product launch' });
  await item.getByRole('button', { name: 'Cancel' }).click();
  await expect(item).toContainText('Cancelled after 153 records');
  await expect(item).toContainText('The base keeps what was imported');
  await expect(item.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  await expect(item.getByRole('link', { name: 'Open base' })).toBeVisible();
});
