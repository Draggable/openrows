import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { signInDevUser } from './helpers/stack.js';
import { expect, test } from './helpers/test.js';

// Record revision history against the whole Compose stack (E2E_STACK=1): an edit made
// through the API shows in the record's Activity tab with its value before and after; "Restore
// this value" puts the old value back in the grid and adds a "restored" entry.
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

type Table = { id: string; fields: { id: string; name: string }[] };

const gridCell = (page: Page, row: number, col: number) =>
  // A CSS locator: the grid stays behind the open record modal, hidden from the a11y tree.
  page.locator(`[role="grid"] [data-cell="${row}:${col}"]`);

test('the Activity tab lists a change and restores the old value', async ({ page }) => {
  await signInDevUser(page);
  const origin = new URL(page.url()).origin;
  const call = async <T>(method: 'post' | 'patch', path: string, data: unknown, status = 201) => {
    const res = await page.request[method](path, { data, headers: { origin } });
    expect(res.status(), path).toBe(status);
    return (await res.json()) as T;
  };
  const ws = await call<{ id: string }>('post', '/api/workspaces', {
    name: `Activity ${Date.now()}`,
  });
  const base = await call<{ id: string }>('post', `/api/workspaces/${ws.id}/bases`, {
    name: 'Launch',
  });
  const table = await call<Table>('post', `/api/bases/${base.id}/tables`, { name: 'Tasks' });
  const name = table.fields.find((f) => f.name === 'Name')?.id ?? '';
  const record = await call<{ id: string }>('post', `/api/tables/${table.id}/records`, {
    fields: { [name]: 'Launch plan' },
  });
  await call(
    'patch',
    `/api/tables/${table.id}/records/${record.id}`,
    { fields: { [name]: 'Launch plan v2' } },
    200
  );

  await page.goto(`/b/${base.id}/${table.id}`);
  await expect(gridCell(page, 0, 0)).toHaveText('Launch plan v2');
  await gridCell(page, 0, 0).click();
  await page.keyboard.press('Space');
  const dialog = page.getByTestId('record-expand');
  await dialog.getByRole('tab', { name: 'Activity' }).click();
  const panel = page.getByTestId('activity-panel');
  const entries = panel.getByTestId('activity-entry');
  await expect(entries).toHaveCount(2);
  await expect(entries.first()).toContainText('created this record');
  const change = entries.nth(1);
  await expect(change).toContainText('changed Name');
  await expect(change.getByTestId('activity-before')).toContainText('Launch plan');
  await expect(change.getByTestId('activity-after')).toContainText('Launch plan v2');

  const axe = await new AxeBuilder({ page })
    .include('[data-testid="activity-panel"]')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  expect(
    axe.violations
      .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
      .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))
  ).toEqual([]);

  // The value right after the creation: Name back to "Launch plan", as a new entry.
  await entries.first().getByRole('button', { name: 'Restore record to this point' }).click();
  await expect(gridCell(page, 0, 0)).toHaveText('Launch plan');
  await expect(entries).toHaveCount(3);
  await expect(entries.nth(2)).toContainText('restored Name');
  // And forward again, one cell at a time.
  await entries.nth(1).getByRole('button', { name: 'Restore this value of Name' }).click();
  await expect(gridCell(page, 0, 0)).toHaveText('Launch plan v2');
  await expect(entries).toHaveCount(4);
});
