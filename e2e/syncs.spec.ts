import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { IDS, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// Synced tables against the mocked API (e2e/fixtures/mockApi.ts): "Sync data" under the
// sidebar's tables creates a sync from a table the person can read; a synced table's header shows
// where it comes from, "Sync now" and the run's progress; synced cells and records can't be
// edited (a local field can); a paused sync says why and offers Resume.: a CSV URL or a
// Postgres source is previewed, its columns mapped (included, field type, key) and synced.:
// a sync connector (Google Sheets) is connected, browsed and synced the same way.

const GRID_URL = `/b/${IDS.base}/${IDS.table}/${IDS.view}`;
const grid = (page: Page) => page.getByRole('grid');
const cell = (page: Page, row: number, col: number) =>
  grid(page).locator(`[data-cell="${row}:${col}"]`);
const COL = { name: 0, estimate: 3 };
const SYNC_ID = '0b000000-0000-4000-8000-000000000001';

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

type Run = { status: string; created?: number; updated?: number; deleted?: number };

function syncOf(over: { status?: string; pauseReason?: string | null; runs?: Run[] } = {}) {
  const at = '2026-10-29T10:00:00.000Z';
  return {
    id: SYNC_ID,
    baseId: IDS.base,
    tableId: IDS.table,
    source: {
      kind: 'table',
      workspaceId: IDS.workspace,
      baseId: IDS.base,
      tableId: IDS.table,
      viewId: null,
      label: 'CRM / Tasks',
      connector: null,
    },
    keyFieldId: null,
    keyColumn: null,
    fields: [],
    sourceFieldId: IDS.notes,
    schedule: 'hourly',
    status: over.status ?? 'active',
    pauseReason: over.pauseReason ?? null,
    createdBy: null,
    lastSyncedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    nextRunAt: null,
    createdAt: at,
    runs: (over.runs ?? [{ status: 'succeeded', created: 3 }]).map((r, i) => ({
      id: `0b000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`,
      trigger: 'manual',
      created: 0,
      updated: 0,
      deleted: 0,
      unchanged: 0,
      skipped: 0,
      error: null,
      createdAt: at,
      startedAt: at,
      finishedAt: r.status === 'queued' ? null : at,
      ...r,
    })),
    canManage: true,
  };
}

/** GET /api/tables/:id/sync answers `current()`; POST .../sync/run queues a run. */
async function mockSync(page: Page, initial: ReturnType<typeof syncOf>) {
  let current = initial;
  const calls: string[] = [];
  await page.route(`**/api/tables/${IDS.table}/sync**`, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    calls.push(`${req.method()} ${path}`);
    const reply = (data: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (path.endsWith('/sync/run') && req.method() === 'POST') {
      current = syncOf({ runs: [{ status: 'queued' }, ...current.runs] });
      return reply(current);
    }
    if (req.method() === 'PATCH') {
      const body = JSON.parse(req.postData() ?? '{}');
      if (body.paused === false) current = syncOf({ runs: [{ status: 'queued' }] });
      return reply(current);
    }
    return reply(current);
  });
  return {
    calls,
    finish: () => {
      current = syncOf({ runs: [{ status: 'succeeded', created: 1, updated: 2 }] });
    },
  };
}

test('"Sync data" adds a table synced from a table you can read', async ({ page }) => {
  await mockApi(page, { rows: 3 });
  const bodies: unknown[] = [];
  await page.route(`**/api/bases/${IDS.base}/syncs`, async (route) => {
    bodies.push(JSON.parse(route.request().postData() ?? '{}'));
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(syncOf({ runs: [{ status: 'queued' }] })),
    });
  });
  await page.goto(GRID_URL);
  await page.getByRole('button', { name: 'Sync data' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sync data' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Table', { exact: true })).toHaveValue(IDS.table);
  await dialog.getByLabel('Sync', { exact: true }).selectOption({ label: 'Every day' });
  await expectNoSeriousA11yIssues(page, '[role="dialog"]');
  await dialog.getByRole('button', { name: 'Sync table' }).click();
  await expect(dialog).toBeHidden();
  expect(bodies).toEqual([
    { source: { baseId: IDS.base, tableId: IDS.table, viewId: null }, schedule: 'daily' },
  ]);
});

test('a synced table shows its source, syncs now and keeps synced cells read-only', async ({
  page,
}) => {
  await mockApi(page, { rows: 3, synced: true });
  const sync = await mockSync(page, syncOf());
  await page.goto(GRID_URL);
  const bar = page.getByTestId('sync-bar');
  await expect(bar).toContainText('Synced from CRM / Tasks');
  await expect(bar).toContainText('Last synced 5 min ago');
  await expectNoSeriousA11yIssues(page, '[data-testid="sync-bar"]');

  // Sync now: the bar says it's syncing until the run is done.
  await bar.getByRole('button', { name: 'Sync now' }).click();
  await expect(bar).toHaveAttribute('data-state', 'syncing');
  await expect(bar.getByRole('button', { name: 'Syncing…' })).toBeDisabled();
  sync.finish();
  await expect(bar).toHaveAttribute('data-state', 'idle', { timeout: 10_000 });
  await expect(bar).toContainText('1 added, 2 updated, 0 removed');
  expect(sync.calls).toContain(`POST /api/tables/${IDS.table}/sync/run`);

  // Synced cells don't open an editor; no new records by hand; the local field is editable.
  await expect(cell(page, 0, COL.name)).toHaveText('Record 1');
  await cell(page, 0, COL.name).click();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Name is synced from another table')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Edit Name' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add record' })).toHaveCount(0);
  await cell(page, 0, COL.estimate).click();
  await page.keyboard.press('Enter');
  await expect(
    page.locator('[data-cell="0:3"] input, [role="dialog"] input').first()
  ).toBeVisible();
});

test('a paused sync says why and resumes', async ({ page }) => {
  await mockApi(page, { rows: 2, synced: true });
  const sync = await mockSync(
    page,
    syncOf({ status: 'paused', pauseReason: 'access_lost', runs: [{ status: 'paused' }] })
  );
  await page.goto(GRID_URL);
  const bar = page.getByTestId('sync-bar');
  await expect(bar).toHaveAttribute('data-state', 'paused');
  await expect(bar).toContainText('can no longer read the source');
  await expect(bar.getByRole('button', { name: 'Sync now' })).toHaveCount(0);
  await bar.getByRole('button', { name: 'Resume' }).click();
  await expect(bar).toHaveAttribute('data-state', 'syncing');
  expect(sync.calls).toContain(`PATCH /api/tables/${IDS.table}/sync`);
});

test('"Sync data" previews a CSV URL, maps its columns and syncs it', async ({ page }) => {
  await mockApi(page, { rows: 3 });
  const previews: unknown[] = [];
  const bodies: unknown[] = [];
  await page.route(`**/api/bases/${IDS.base}/syncs/preview`, async (route) => {
    previews.push(JSON.parse(route.request().postData() ?? '{}'));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        label: 'data.example.com/people.csv',
        columns: [
          { name: 'Name', type: 'singleLineText', options: {} },
          { name: 'id', type: 'number', options: { precision: 0 } },
          { name: 'Notes', type: 'longText', options: {} },
        ],
        rows: [['Ada', '1', 'First']],
      }),
    });
  });
  await page.route(`**/api/bases/${IDS.base}/syncs`, async (route) => {
    bodies.push(JSON.parse(route.request().postData() ?? '{}'));
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(syncOf({ runs: [{ status: 'queued' }] })),
    });
  });
  await page.goto(GRID_URL);
  await page.getByRole('button', { name: 'Sync data' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sync data' });
  await dialog.getByLabel('Source').selectOption({ label: 'A CSV file at a URL' });
  await expect(dialog.getByRole('button', { name: 'Sync table' })).toBeDisabled();
  await dialog.getByLabel('CSV URL').fill('https://data.example.com/people.csv?token=abc');
  await dialog.getByRole('button', { name: 'Preview' }).click();
  await expect(dialog.getByText('data.example.com/people.csv')).toBeVisible();
  await expect(dialog.getByLabel('Match rows by')).toHaveValue('id');
  // Leave Notes out, sync Name as long text.
  await dialog.getByRole('checkbox', { name: 'Notes' }).uncheck();
  await dialog.getByLabel('Name field type').selectOption({ label: 'Long text' });
  await expectNoSeriousA11yIssues(page, '[role="dialog"]');
  await dialog.getByRole('button', { name: 'Sync table' }).click();
  await expect(dialog).toBeHidden();
  expect(previews).toEqual([
    { source: { kind: 'csv', url: 'https://data.example.com/people.csv?token=abc' } },
  ]);
  expect(bodies).toEqual([
    {
      source: { kind: 'csv', url: 'https://data.example.com/people.csv?token=abc' },
      columns: [
        { name: 'Name', type: 'longText', options: {} },
        { name: 'id', type: 'number', options: { precision: 0 } },
      ],
      keyColumn: 'id',
      schedule: 'hourly',
    },
  ]);
});

test("a Postgres source's problem shows in the dialog, and editing it needs a new preview", async ({
  page,
}) => {
  await mockApi(page, { rows: 3 });
  let refuse = true;
  await page.route(`**/api/bases/${IDS.base}/syncs/preview`, async (route) => {
    if (refuse) {
      await route.fulfill({
        status: 422,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'about:blank',
          title: 'Validation failed',
          status: 422,
          code: 'VALIDATION_FAILED',
          detail: "Couldn't connect to the database: 10.0.0.5 is a private or reserved address.",
          requestId: 'req-1',
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        label: 'db.example.com/crm · public.people',
        columns: [{ name: 'name', type: 'singleLineText', options: {} }],
        rows: [['Ada']],
      }),
    });
  });
  await page.goto(GRID_URL);
  await page.getByRole('button', { name: 'Sync data' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sync data' });
  await dialog.getByLabel('Source').selectOption({ label: 'A Postgres database' });
  const conn = dialog.getByLabel('Connection string');
  await expect(conn).toHaveAttribute('type', 'password');
  await conn.fill('postgres://reader:secret@db.example.com/crm');
  await dialog.getByLabel('Table', { exact: true }).fill('public.people');
  await dialog.getByRole('button', { name: 'Preview' }).click();
  await expect(dialog.getByRole('alert')).toContainText('private or reserved address');
  refuse = false;
  await dialog.getByRole('button', { name: 'Preview' }).click();
  await expect(dialog.getByText('db.example.com/crm · public.people')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Sync table' })).toBeEnabled();
  await expectNoSeriousA11yIssues(page, '[role="dialog"]');
  // A changed source drops the preview.
  await dialog.getByLabel('Table', { exact: true }).fill('public.other');
  await expect(dialog.getByRole('button', { name: 'Sync table' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Preview' })).toBeVisible();
});

// a sync connector (the hosted Google Sheets, mocked here like the rest of the API): connect
// your account, come back to the dialog, pick a spreadsheet and a sheet, preview, sync.
test('"Sync data" connects Google Sheets, picks a sheet and syncs it', async ({ page }) => {
  await mockApi(page, { rows: 3 });
  let account: { label: string; connectedAt: string } | null = null;
  await page.route('**/api/me/sync-connectors', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        connectors: [
          {
            id: 'google-sheets',
            name: 'Google Sheets',
            description: 'A sheet of a Google spreadsheet you can open.',
            levels: ['Spreadsheet', 'Sheet'],
            account,
          },
        ],
      }),
    })
  );
  const browsed: unknown[] = [];
  await page.route(`**/api/bases/${IDS.base}/syncs/browse`, async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}');
    browsed.push(body);
    const items =
      body.path.length === 0
        ? [{ id: 'sheet-id-1', name: 'Budget 2026', detail: 'Modified 2026-10-01', leaf: false }]
        : [
            { id: '0', name: 'Expenses', detail: '1,000 rows', leaf: true },
            { id: '7', name: 'Income', detail: '1,000 rows', leaf: true },
          ];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items }),
    });
  });
  const previews: unknown[] = [];
  await page.route(`**/api/bases/${IDS.base}/syncs/preview`, async (route) => {
    previews.push(JSON.parse(route.request().postData() ?? '{}'));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        label: 'Budget 2026 / Expenses',
        columns: [
          { name: 'Item', type: 'singleLineText', options: {} },
          { name: 'Amount', type: 'number', options: { precision: 2 } },
        ],
        rows: [['Rent', '1,200.00']],
      }),
    });
  });
  const bodies: unknown[] = [];
  await page.route(`**/api/bases/${IDS.base}/syncs`, async (route) => {
    bodies.push(JSON.parse(route.request().postData() ?? '{}'));
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(syncOf({ runs: [{ status: 'queued' }] })),
    });
  });

  // Not connected yet: the dialog offers the provider's consent page, then back here.
  await page.goto(GRID_URL);
  await page.getByRole('button', { name: 'Sync data' }).click();
  let dialog = page.getByRole('dialog', { name: 'Sync data' });
  await dialog.getByLabel('Source').selectOption({ label: 'Google Sheets' });
  const connect = dialog.getByRole('link', { name: 'Connect Google Sheets' });
  await expect(connect).toHaveAttribute(
    'href',
    `/api/me/sync-connectors/google-sheets/connect?returnTo=${encodeURIComponent(GRID_URL)}`
  );
  await expectNoSeriousA11yIssues(page, '[role="dialog"]');

  // Back from Google (the callback's redirect): the dialog opens again on Google Sheets.
  account = { label: 'ada@example.com', connectedAt: '2026-10-29T10:00:00.000Z' };
  await page.goto(`${GRID_URL}?syncConnector=google-sheets&connected=1`);
  dialog = page.getByRole('dialog', { name: 'Sync data' });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${GRID_URL}$`));
  await expect(dialog.getByLabel('Source')).toHaveValue('connector:google-sheets');
  await expect(dialog.getByText('ada@example.com')).toBeVisible();
  await dialog.getByRole('option', { name: /Budget 2026/ }).click();
  await dialog.getByRole('option', { name: /Expenses/ }).click();
  await expect(dialog.getByRole('option', { name: /Expenses/ })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await dialog.getByLabel('Column names are in row').fill('2');
  await dialog.getByRole('button', { name: 'Preview' }).click();
  await expect(dialog.getByText('Budget 2026 / Expenses')).toBeVisible();
  await dialog.getByLabel('Match rows by').selectOption({ label: 'Item' });
  await expectNoSeriousA11yIssues(page, '[role="dialog"]');
  await dialog.getByRole('button', { name: 'Sync table' }).click();
  await expect(dialog).toBeHidden();
  expect(browsed).toEqual([
    { connector: 'google-sheets', path: [] },
    { connector: 'google-sheets', path: ['sheet-id-1'] },
  ]);
  const source = {
    kind: 'connector',
    connector: 'google-sheets',
    path: ['sheet-id-1', '0'],
    headerRow: 2,
  };
  expect(previews).toEqual([{ source }]);
  expect(bodies).toEqual([
    {
      source,
      columns: [
        { name: 'Item', type: 'singleLineText', options: {} },
        { name: 'Amount', type: 'number', options: { precision: 2 } },
      ],
      keyColumn: 'Item',
      schedule: 'hourly',
    },
  ]);
});
