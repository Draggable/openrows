import type { APIRequestContext, Page } from '@playwright/test';
import { signInDevUser } from './helpers/stack.js';
import { expect, test } from './helpers/test.js';

// Linked records against the whole Compose stack (E2E_STACK=1): a link field made in the
// field editor gets its inverse in the linked table; linking a record from the picker shows the
// chip on both sides, and unlinking from the other side clears both.
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

type Table = { id: string; baseId: string; fields: { id: string; name: string }[] };

const grid = (page: Page) => page.getByRole('grid');
const cell = (page: Page, row: number, col: number) =>
  grid(page).locator(`[data-cell="${row}:${col}"]`);

async function post<T>(request: APIRequestContext, origin: string, path: string, data: unknown) {
  const res = await request.post(path, { data, headers: { origin } });
  expect(res.ok(), `${path}: ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

test('link two records, see the chip on both sides, unlink', async ({ page }) => {
  await signInDevUser(page);
  const origin = new URL(page.url()).origin;
  const api = <T>(path: string, data: unknown) => post<T>(page.request, origin, path, data);
  const workspace = await api<{ id: string }>('/api/workspaces', {
    name: `Links ${Date.now()}`,
  });
  const base = await api<{ id: string }>(`/api/workspaces/${workspace.id}/bases`, {
    name: 'Roadmap',
  });
  const projects = await api<Table>(`/api/bases/${base.id}/tables`, { name: 'Projects' });
  const tasks = await api<Table>(`/api/bases/${base.id}/tables`, { name: 'Tasks' });
  const nameOf = (t: Table) => t.fields.find((f) => f.name === 'Name')?.id ?? '';
  await api(`/api/tables/${projects.id}/records`, {
    records: [
      { fields: { [nameOf(projects)]: 'Alpha' } },
      { fields: { [nameOf(projects)]: 'Beta' } },
    ],
  });
  await api(`/api/tables/${tasks.id}/records`, {
    fields: { [nameOf(tasks)]: 'Write spec' },
  });

  await test.step('create a link field in the field editor', async () => {
    await page.goto(`/b/${base.id}/${tasks.id}`);
    await expect(cell(page, 0, 0)).toHaveText('Write spec');
    await page.getByRole('button', { name: 'Add field' }).click();
    await page.getByLabel('Field name').fill('Project');
    await page.getByRole('combobox', { name: 'Search field types' }).fill('Link');
    await page.getByRole('option', { name: 'Link to another record', exact: true }).click();
    await page.getByLabel('Link to table').selectOption({ label: 'Projects' });
    await page.getByRole('button', { name: 'Create field' }).click();
    await expect(page.getByRole('columnheader', { name: 'Project' })).toBeVisible();
  });

  await test.step('link a record from the picker', async () => {
    // Name, Notes, Status, then Project.
    await cell(page, 0, 3).click();
    await page.keyboard.press('Enter');
    const picker = page.getByRole('dialog', { name: 'Edit Project' });
    await picker.getByRole('combobox', { name: 'Find a record for Project' }).fill('alp');
    await picker.getByRole('option', { name: 'Alpha' }).click();
    await expect(picker.getByRole('button', { name: 'Unlink Alpha' })).toBeVisible();
    const saved = page.waitForResponse(
      (r) => r.request().method() === 'PATCH' && r.url().includes(`/api/tables/${tasks.id}/records`)
    );
    await page.keyboard.press('Escape');
    await expect(cell(page, 0, 3)).toHaveText('Alpha');
    expect((await saved).ok()).toBe(true);
    await page.reload();
    await expect(cell(page, 0, 3)).toHaveText('Alpha');
  });

  await test.step('the inverse field shows the chip in the linked table', async () => {
    await page.goto(`/b/${base.id}/${projects.id}`);
    await expect(page.getByRole('columnheader', { name: 'Tasks' })).toBeVisible();
    await expect(cell(page, 0, 0)).toHaveText('Alpha');
    await expect(cell(page, 0, 3)).toHaveText('Write spec');
    await expect(cell(page, 1, 3)).toHaveText('');
  });

  await test.step('unlink from the other side', async () => {
    await cell(page, 0, 3).click();
    await page.keyboard.press('Enter');
    const picker = page.getByRole('dialog', { name: 'Edit Tasks' });
    await picker.getByRole('button', { name: 'Unlink Write spec' }).click();
    const saved = page.waitForResponse(
      (r) =>
        r.request().method() === 'PATCH' && r.url().includes(`/api/tables/${projects.id}/records`)
    );
    await page.keyboard.press('Escape');
    await expect(cell(page, 0, 3)).toHaveText('');
    expect((await saved).ok()).toBe(true);
    await page.goto(`/b/${base.id}/${tasks.id}`);
    await expect(cell(page, 0, 0)).toHaveText('Write spec');
    await expect(cell(page, 0, 3)).toHaveText('');
  });
});
