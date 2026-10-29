import AxeBuilder from '@axe-core/playwright';
import { signInDevUser } from './helpers/stack.js';
import { expect, test } from './helpers/test.js';

// Plans and usage against the whole Compose stack (E2E_STACK=1): records created and
// trashed, and a REST API call, show up on the workspace's Usage page next to the plan's limits
// (CI's stack runs the cloud edition: the catalog's default plan, Free).
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

interface Meter {
  used: number;
  limit: number | null;
}
interface Usage {
  plan: { id: string; name: string };
  bases: { baseId: string; name: string; records: number; limit: number | null }[];
  apiCalls: Meter;
  editors: Meter;
}

const text = (m: Meter) =>
  m.limit === null
    ? m.used.toLocaleString('en-US')
    : `${m.used.toLocaleString('en-US')} / ${m.limit.toLocaleString('en-US')}`;

test('the Usage page shows records per base, API calls and editors against the plan', async ({
  page,
}) => {
  await signInDevUser(page);
  const origin = new URL(page.url()).origin;
  const headers = { origin };
  const post = async <T>(path: string, data: unknown, status = 201) => {
    const res = await page.request.post(path, { data, headers });
    expect(res.status(), path).toBe(status);
    return (await res.json()) as T;
  };
  const name = `Usage ${Date.now()}`;
  const workspace = await post<{ id: string }>('/api/workspaces', { name });
  const base = await post<{ id: string }>(`/api/workspaces/${workspace.id}/bases`, {
    name: 'Roadmap',
  });
  const table = await post<{ id: string }>(`/api/bases/${base.id}/tables`, { name: 'Tasks' });
  const { records } = await post<{ records: { id: string }[] }>(`/api/tables/${table.id}/records`, {
    records: [{ fields: {} }, { fields: {} }, { fields: {} }],
  });
  await post(`/api/tables/${table.id}/records/delete`, { recordIds: [records[0]?.id] }, 200);
  // One REST API v1 call on the base: a monthly API call of the workspace.
  expect((await page.request.get(`/api/v1/${base.id}/Tasks`)).status()).toBe(200);

  const usage = (await (
    await page.request.get(`/api/workspaces/${workspace.id}/usage`)
  ).json()) as Usage;
  expect(usage.bases).toEqual([
    expect.objectContaining({ baseId: base.id, name: 'Roadmap', records: 2 }),
  ]);
  expect(usage.apiCalls.used).toBe(1);
  expect(usage.editors.used).toBe(1);

  await page.goto(`/w/${workspace.id}`);
  await page.getByRole('button', { name: `Workspace: ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Usage and plan' }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspace.id}/usage$`));
  await expect(page.getByRole('heading', { name: `${usage.plan.name} plan` })).toBeVisible();

  const records2 = { used: 2, limit: usage.bases[0]?.limit ?? null };
  const recordsRegion = page.getByRole('region', { name: 'Records per base' });
  await expect(recordsRegion).toContainText('Roadmap');
  await expect(recordsRegion).toContainText(text(records2));
  const planRegion = page.getByRole('region', { name: `${usage.plan.name} plan` });
  await expect(planRegion).toContainText(text(usage.apiCalls));
  await expect(planRegion).toContainText(text(usage.editors));

  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    axe.violations
      .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
      .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))
  ).toEqual([]);
});
