import { GRID_URL, IDS, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// CSV import and download from the view toolbar against the mocked API: the download link
// carries the view and its visible fields; the import dialog previews, maps and follows the job.

const JOB = '0190a000-0000-7000-8000-000000000777';

test('downloads the view as CSV and imports a CSV with a progress bar', async ({ page }) => {
  await mockApi(page, { rows: 5 });
  const posted: Record<string, unknown>[] = [];
  let polls = 0;
  const job = (status: string, processedRows: number) => ({
    id: JOB,
    tableId: IDS.table,
    status,
    totalRows: 2,
    processedRows,
    skippedCells: 0,
    createdFieldIds: [],
    error: null,
    createdAt: '2026-10-25T10:00:00.000Z',
    finishedAt: status === 'done' ? '2026-10-25T10:00:01.000Z' : null,
  });
  await page.route('**/api/tables/*/imports**', async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      posted.push(req.postDataJSON());
      return route.fulfill({ status: 201, json: job('running', 0) });
    }
    polls++;
    return route.fulfill({ json: polls > 2 ? job('done', 2) : job('running', 1) });
  });
  await page.goto(GRID_URL);
  await expect(page.getByTestId('record-count')).toHaveText('5 records');

  await page.getByRole('button', { name: 'More view actions' }).click();
  const download = page.getByRole('menuitem', { name: 'Download CSV' });
  const href = new URL((await download.getAttribute('href')) ?? '', 'http://x');
  expect(href.pathname).toBe(`/api/tables/${IDS.table}/export.csv`);
  expect(href.searchParams.get('viewId')).toBe(IDS.view);
  const query = JSON.parse(href.searchParams.get('query') ?? '{}');
  expect(query.fields[0]).toBe(IDS.name);

  await page.getByRole('menuitem', { name: 'Import CSV…' }).click();
  const dialog = page.getByRole('dialog', { name: /Import CSV/ });
  await dialog.getByLabel('Choose a CSV file').setInputFiles({
    name: 'tasks.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Name,Effort,Stage\nWrite spec,3,Todo\nShip,5.5,Done\n'),
  });
  await expect(dialog.getByText('tasks.csv')).toBeVisible();
  await expect(dialog.getByLabel('Import column Name into')).toHaveValue(IDS.name);
  await expect(dialog.getByLabel('Type of the new field for Effort')).toHaveValue('number');
  await page.screenshot({ path: 'test-results/import-dialog.png' });
  await dialog.getByRole('button', { name: 'Import 2 records' }).click();
  await expect(dialog.getByRole('progressbar')).toBeVisible();
  await expect(page.getByText('Imported 2 records.')).toBeVisible();
  await expect(dialog).toBeHidden();
  expect(posted[0]?.['columns']).toEqual([
    { index: 0, fieldId: IDS.name },
    { index: 1, newField: { name: 'Effort', type: 'number', options: { precision: 1 } } },
    { index: 2, newField: { name: 'Stage', type: 'singleLineText', options: {} } },
  ]);
});
