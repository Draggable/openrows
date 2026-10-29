import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import type { Download } from '@playwright/test';
import { signInDevUser } from './helpers/stack.js';
import { expect, test } from './helpers/test.js';

// Data export against the whole Compose stack (E2E_STACK=1): the base menu's "Export base
// (ZIP)" and Settings' "Export my data" download ZIP archives.
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

async function isZip(download: Download) {
  const path = await download.path();
  const bytes = await readFile(path);
  // A local file header first, the end of central directory record last.
  expect(bytes.subarray(0, 4).toString('hex')).toBe('504b0304');
  expect(bytes.subarray(-22, -18).toString('hex')).toBe('504b0506');
}

test('exports a base and the account as ZIP downloads', async ({ page }) => {
  await signInDevUser(page);
  const origin = new URL(page.url()).origin;
  const post = async <T>(path: string, data: unknown) => {
    const res = await page.request.post(path, { data, headers: { origin } });
    expect(res.status(), path).toBe(201);
    return (await res.json()) as T;
  };
  const ws = await post<{ id: string }>('/api/workspaces', { name: `Export ${Date.now()}` });
  const base = await post<{ id: string }>(`/api/workspaces/${ws.id}/bases`, { name: 'Launch' });
  const table = await post<{ id: string }>(`/api/bases/${base.id}/tables`, { name: 'Tasks' });

  await page.goto(`/b/${base.id}/${table.id}`);
  await page.getByRole('button', { name: 'Switch base' }).click();
  const [baseZip] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: 'Export base (ZIP)' }).click(),
  ]);
  expect(baseZip.suggestedFilename()).toMatch(/^Launch \d{4}-\d{2}-\d{2}\.zip$/);
  await isZip(baseZip);

  await page.goto('/settings');
  const section = page.getByRole('region', { name: 'Your data' });
  await expect(section).toBeVisible();
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    axe.violations
      .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
      .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))
  ).toEqual([]);
  const [accountZip] = await Promise.all([
    page.waitForEvent('download'),
    section.getByRole('link', { name: 'Export my data' }).click(),
  ]);
  expect(accountZip.suggestedFilename()).toMatch(/^OpenRows account data .*\.zip$/);
  await isZip(accountZip);
});
