import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { signInDevUser } from './helpers/stack.js';
import { expect, test } from './helpers/test.js';

// Templates against the whole Compose stack (E2E_STACK=1): Home's "Start from a template"
// previews one and creates a base from it; then every built-in template is installed and each of
// its tables and views opens without an error page or a script error.
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

interface Summary {
  slug: string;
  name: string;
  tables: { name: string; records: number }[];
}

const errorHeading = (page: Page) =>
  page.getByRole('heading', { name: /Something went wrong|doesn't exist/ });

async function creatorWorkspace(page: Page): Promise<string> {
  const res = await page.request.get('/api/workspaces');
  expect(res.ok()).toBe(true);
  const { workspaces } = (await res.json()) as { workspaces: { id: string; role: string }[] };
  const own = workspaces.find((w) => w.role === 'owner' || w.role === 'creator');
  if (own) return own.id;
  const origin = new URL(page.url()).origin;
  const made = await page.request.post('/api/workspaces', {
    data: { name: 'E2E templates' },
    headers: { origin },
  });
  expect(made.status()).toBe(201);
  return ((await made.json()) as { id: string }).id;
}

test('previews a template from Home and creates a base from it', async ({ page }) => {
  await signInDevUser(page);
  await page.getByRole('button', { name: /Start from a template/ }).click();
  const gallery = page.getByRole('dialog', { name: 'Start from a template' });
  await expect(gallery.getByRole('button', { name: 'Sales CRM template' })).toBeVisible();
  await gallery.getByRole('button', { name: 'Sales', exact: true }).click();
  await expect(gallery.getByRole('button', { name: 'Bug tracker template' })).toBeHidden();
  await gallery.getByRole('button', { name: 'Sales CRM template' }).click();

  const preview = page.getByRole('dialog', { name: 'Sales CRM' });
  await expect(preview.getByRole('tab', { name: 'Deals' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(preview.getByRole('cell', { name: 'Northwind annual plan' })).toBeVisible();
  await preview.getByRole('tab', { name: 'Companies' }).click();
  await expect(preview.getByRole('cell', { name: 'Globex', exact: true })).toBeVisible();
  const results = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  expect(
    results.violations
      .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
      .map((v) => v.id)
  ).toEqual([]);

  await preview.getByRole('button', { name: 'Use template' }).click();
  await expect(page).toHaveURL(/\/b\/[0-9a-f-]{36}\/[0-9a-f-]{36}/);
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Sales CRM');
  await expect(page.getByText('Northwind annual plan').first()).toBeVisible();
});

test('every built-in template installs and opens without errors', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await signInDevUser(page);
  const origin = new URL(page.url()).origin;
  const workspaceId = await creatorWorkspace(page);
  const list = await page.request.get('/api/templates');
  expect(list.ok()).toBe(true);
  const { templates } = (await list.json()) as { templates: Summary[] };
  expect(templates.length).toBeGreaterThanOrEqual(8);

  for (const template of templates) {
    await test.step(template.slug, async () => {
      const res = await page.request.post(`/api/workspaces/${workspaceId}/templates`, {
        data: { slug: template.slug },
        headers: { origin },
      });
      expect(res.status(), await res.text()).toBe(201);
      const base = (await res.json()) as { id: string };
      const tables = await page.request.get(`/api/bases/${base.id}/tables`);
      const { tables: rows } = (await tables.json()) as {
        tables: { id: string; name: string }[];
      };
      expect(rows.map((t) => t.name)).toEqual(template.tables.map((t) => t.name));

      for (const [i, table] of rows.entries()) {
        const viewsRes = await page.request.get(`/api/tables/${table.id}/views`);
        const { views } = (await viewsRes.json()) as {
          views: { id: string; name: string; type: string }[];
        };
        for (const view of views) {
          await page.goto(`/b/${base.id}/${table.id}/${view.id}`);
          const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' });
          await expect(breadcrumb).toContainText(template.name);
          await expect(breadcrumb).toContainText(table.name);
          await expect(
            breadcrumb.getByRole('heading', { level: 1, name: view.name, exact: true })
          ).toBeVisible();
          await expect(errorHeading(page)).toHaveCount(0);
          if (view.type === 'grid') {
            const records = template.tables[i]?.records ?? 0;
            await expect(page.getByTestId('record-count')).toHaveText(
              `${records} ${records === 1 ? 'record' : 'records'}`
            );
          }
        }
      }
    });
  }
  expect(errors).toEqual([]);
});
