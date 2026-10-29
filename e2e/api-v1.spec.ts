import type { APIRequestContext } from '@playwright/test';
import { signInDevUser } from './helpers/stack.js';
import { expect, test } from './helpers/test.js';

// The REST API v1 against the whole Compose stack (E2E_STACK=1): a personal access token
// creates, filters, updates and deletes records in Airtable's shape, and the grid shows the
// records it wrote.
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

async function post<T>(request: APIRequestContext, origin: string, path: string, data: unknown) {
  const res = await request.post(path, { data, headers: { origin } });
  expect(res.ok(), `${path}: ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

test('a token writes and reads records through /api/v1; the grid shows them', async ({
  page,
  playwright,
}) => {
  await signInDevUser(page);
  const origin = new URL(page.url()).origin;
  const session = <T>(path: string, data: unknown) => post<T>(page.request, origin, path, data);
  const workspace = await session<{ id: string }>('/api/workspaces', {
    name: `API v1 ${Date.now()}`,
  });
  const base = await session<{ id: string }>(`/api/workspaces/${workspace.id}/bases`, {
    name: 'Integrations',
  });
  const table = await session<{ id: string }>(`/api/bases/${base.id}/tables`, {
    name: 'Leads',
  });
  const { token } = await session<{ token: string }>('/api/me/tokens', {
    name: 'E2E v1',
    scopes: ['data.records:read', 'data.records:write', 'schema.bases:read'],
    baseIds: [base.id],
  });

  const api = await playwright.request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { authorization: `Bearer ${token}` },
  });
  const bases = await api.get('/api/v1/meta/bases');
  expect(((await bases.json()) as { bases: { id: string }[] }).bases.map((b) => b.id)).toEqual([
    base.id,
  ]);

  const created = await api.post(`/api/v1/${base.id}/Leads`, {
    data: {
      records: [
        { fields: { Name: 'Ada', Notes: 'Warm' } },
        { fields: { Name: 'Grace', Notes: 'Cold' } },
      ],
    },
  });
  expect(created.status()).toBe(200);
  const { records } = (await created.json()) as { records: { id: string }[] };

  const filtered = await api.get(
    `/api/v1/${base.id}/Leads?filterByFormula=${encodeURIComponent("{Notes} = 'Warm'")}`
  );
  const warm = (await filtered.json()) as { records: { fields: Record<string, unknown> }[] };
  expect(warm.records.map((r) => r.fields)).toEqual([{ Name: 'Ada', Notes: 'Warm' }]);

  const refused = await api.get(
    `/api/v1/${base.id}/Leads?filterByFormula=${encodeURIComponent("LOWER({Name}) = 'ada'")}`
  );
  expect(refused.status()).toBe(422);
  expect(((await refused.json()) as { error: { type: string } }).error.type).toBe(
    'INVALID_FILTER_BY_FORMULA'
  );

  const [ada, grace] = records;
  const patched = await api.patch(`/api/v1/${base.id}/Leads/${ada?.id}`, {
    data: { fields: { Notes: 'Signed' } },
  });
  expect(patched.status()).toBe(200);
  const deleted = await api.delete(`/api/v1/${base.id}/Leads/${grace?.id}`);
  expect(await deleted.json()).toEqual({ id: grace?.id, deleted: true });

  await page.goto(`/b/${base.id}/${table.id}`);
  const grid = page.getByRole('grid');
  await expect(grid.getByText('Signed')).toBeVisible();
  await expect(grid.getByText('Ada')).toBeVisible();
  await expect(grid.getByText('Grace')).toHaveCount(0);
  await api.dispose();
});
