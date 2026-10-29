import type { Page } from '@playwright/test';
import { GRID_URL, IDS, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// Attachments against the mocked API: drop an image on an attachment cell, the client
// announces it, PUTs it to the presigned URL, confirms it and writes it into the cell, and the
// cell shows the thumbnail the API redirects to.

const grid = (page: Page) => page.getByRole('grid');
const cell = (page: Page, row: number, col: number) =>
  grid(page).locator(`[data-cell="${row}:${col}"]`);
const MOCKUPS = 12;

// A 2x2 green PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMQyQkVyQllgFAAFlYDVQR7wFAAAAAASUVORK5CYII=',
  'base64'
);
const FILE_ID = '0190a000-0000-7000-8000-0000000000f1';

test.use({ viewport: { width: 2600, height: 720 } });

test('drag and drop an image into a cell, and its thumbnail shows', async ({ page }) => {
  const api = await mockApi(page, { rows: 5, allTypes: true });
  const value = { id: FILE_ID, filename: 'photo.png', size: PNG.byteLength, type: 'image/png' };
  const steps: string[] = [];
  let patched: unknown;

  // Registered after mockApi, so these win for their URLs.
  await page.route(`**/api/tables/${IDS.table}/attachments`, async (route) => {
    const body = route.request().postDataJSON();
    steps.push(`announce ${body.filename} ${body.type} ${body.size}`);
    expect(body.fieldId).toBe(IDS.mockups);
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        attachment: value,
        upload: {
          method: 'PUT',
          url: `${new URL(page.url()).origin}/storage.test/ws/${IDS.workspace}/${FILE_ID}?X-Amz-Signature=x`,
          headers: { 'content-type': 'image/png' },
          expiresAt: '2026-10-25T10:15:00.000Z',
        },
      }),
    });
  });
  await page.route('**/storage.test/**', async (route) => {
    const req = route.request();
    steps.push(`${req.method()} ${req.headers()['content-type']} ${req.postDataBuffer()?.length}`);
    await route.fulfill({ status: 200 });
  });
  await page.route(`**/api/tables/${IDS.table}/attachments/${FILE_ID}/confirm`, async (route) => {
    steps.push('confirm');
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
  });
  await page.route(`**/api/tables/${IDS.table}/attachments/${FILE_ID}/thumbnail`, (route) =>
    route.fulfill({ contentType: 'image/png', body: PNG })
  );
  page.on('request', (req) => {
    if (req.method() === 'PATCH' && req.url().includes('/records/')) {
      patched = req.postDataJSON();
    }
  });

  await page.goto(GRID_URL);
  const target = cell(page, 1, MOCKUPS);
  await expect(target).toBeVisible();
  await expect(target.getByRole('img')).toHaveCount(0);

  const dataTransfer = await page.evaluateHandle((base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'photo.png', { type: 'image/png' }));
    return dt;
  }, PNG.toString('base64'));
  await target.dispatchEvent('dragenter', { dataTransfer });
  await target.dispatchEvent('dragover', { dataTransfer });
  await expect(target).toHaveClass(/outline-dashed/);
  await target.dispatchEvent('drop', { dataTransfer });

  const thumb = target.getByRole('img', { name: 'photo.png' });
  await expect(thumb).toBeVisible();
  await expect.poll(() => thumb.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(2);
  expect(steps).toEqual([
    `announce photo.png image/png ${PNG.byteLength}`,
    `PUT image/png ${PNG.byteLength}`,
    'confirm',
  ]);
  expect(patched).toMatchObject({ fields: { [IDS.mockups]: [value] } });
  expect(api.fieldsAt(1)[IDS.mockups]).toEqual([value]);

  // Dropping files on a cell of another type does nothing (and doesn't navigate away).
  await cell(page, 1, 0).dispatchEvent('drop', { dataTransfer });
  await expect(page).toHaveURL(new RegExp(`${GRID_URL}$`));
});
