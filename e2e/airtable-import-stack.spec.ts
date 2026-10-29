import AxeBuilder from '@axe-core/playwright';
import { signInDevUser, stackApi } from './helpers/stack.js';
import { expect, test } from './helpers/test.js';

// The Airtable importer against the whole Compose stack (E2E_STACK=1): the dev user
// imports the recorded fixture base through Home's dialog from the stack's fake Airtable
// (docker/airtable-fake.mjs, the allowlisted AIRTABLE_API_URL and attachment host in dev.yml);
// the worker fills the base with its records, links, files and views, and the report lists
// what didn't come over.
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

const TOKEN = `patFixture0000001.${'a1b2c3d4'.repeat(8)}`;

interface Field {
  id: string;
  name: string;
  type: string;
}

test('imports the fixture base through the UI, with links, files and views', async ({ page }) => {
  test.setTimeout(180_000);
  await signInDevUser(page);
  const api = stackApi(page);
  const ws = await api.post<{ id: string }>('/api/workspaces', { name: `Airtable ${Date.now()}` });

  await page.goto(`/w/${ws.id}`);
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
  await expect(item).toContainText('Done: 2 tables, 153 records', { timeout: 150_000 });
  await expect(item).toContainText('3 views imported');
  await expect(item).toContainText('2 files not copied');
  await item.getByText('Import report').click();
  await expect(item).toContainText('Projects › Due dates (calendar)');
  await expect(item).toContainText('Projects › Files (missing.doc)');
  const axe = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  expect(
    axe.violations
      .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
      .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))
  ).toEqual([]);

  // The base, through the API: the links both ways, the count over them, the copied files.
  const list = await api.get<{ imports: { baseId: string; name: string }[] }>(
    `/api/workspaces/${ws.id}/airtable/imports`
  );
  const baseId = list.imports.find((i) => i.name === 'Product launch')?.baseId ?? '';
  const tables = await api.get<{ tables: { id: string; name: string }[] }>(
    `/api/bases/${baseId}/tables`
  );
  const projectsId = tables.tables.find((t) => t.name === 'Projects')?.id ?? '';
  const projects = await api.get<{ fields: Field[] }>(`/api/tables/${projectsId}`);
  const fieldId = (name: string) => projects.fields.find((f) => f.name === name)?.id ?? '';
  expect(projects.fields.find((f) => f.name === 'Tasks')?.type).toBe('link');
  const records = await api.get<{ records: { fields: Record<string, unknown> }[] }>(
    `/api/tables/${projectsId}/records?limit=10`
  );
  const apollo = records.records.find((r) => r.fields[fieldId('Name')] === 'Apollo');
  expect(apollo?.fields[fieldId('Task count')]).toBe(75);
  expect(
    ((apollo?.fields[fieldId('Files')] ?? []) as { filename: string }[]).map((f) => f.filename)
  ).toEqual(['logo.png', 'brief.txt']);

  // Open the base from the dialog: the imported grid view is there.
  await item.getByRole('link', { name: 'Open base' }).click();
  await expect(page.getByRole('grid')).toBeVisible();
  await expect(page.getByText('All projects').first()).toBeVisible();
});
