import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './helpers/test.js';

// The API reference: public, rendered from /api/openapi.json by the app itself. It must
// work with nothing but the app's origin (no CDN, no fonts, no third-party viewer), so every
// request elsewhere is refused and recorded, and it must pass axe.

/** Refuses and records every request that leaves the app's origin. */
async function offline(page: Page, origin: string): Promise<string[]> {
  const external: string[] = [];
  await page.route(
    (url) => url.origin !== origin,
    (route) => {
      external.push(route.request().url());
      return route.abort();
    }
  );
  return external;
}

async function expectAxeClean(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    axe.violations
      .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
      .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))
  ).toEqual([]);
}

test('the API reference renders offline from the OpenAPI document, axe-clean', async ({
  page,
  baseURL,
}) => {
  const external = await offline(page, new URL(baseURL ?? '').origin);
  await page.goto('/docs/api');

  await expect(page.getByRole('heading', { level: 1, name: 'OpenRows API' })).toBeVisible();
  for (const guide of ['Authentication', 'Pagination', 'Rate limits', 'Errors']) {
    await expect(page.getByRole('heading', { level: 2, name: guide })).toBeVisible();
  }
  const rateLimits = page.getByRole('region', { name: 'Rate limits' });
  await expect(rateLimits).toContainText('Retry-After');
  await expect(rateLimits).toContainText('RateLimit-Remaining');
  // The n8n nodes: what each does and the token scopes it needs.
  const n8n = page.getByRole('region', { name: 'n8n', exact: true });
  await expect(n8n).toContainText('@openrows/n8n-nodes-openrows');
  await expect(n8n.getByRole('table', { name: 'n8n nodes' })).toContainText('webhook:manage');

  // The reference: v1 first, every operation from the document.
  const v1 = page.getByRole('region', { name: 'REST API v1' });
  await expect(v1.getByRole('article', { name: /^List records: pageSize/ })).toBeVisible();
  await expect(page.getByText(/Version 0\.1\.0 · \d+ endpoints/)).toBeVisible();

  // A request body opens on demand.
  const create = v1.getByRole('article', { name: /^Create one record/ });
  await create.getByText('Request body').click();
  await expect(create.getByText('typecast', { exact: true }).first()).toBeVisible();

  // The filter narrows the navigation and the list.
  const nav = page.getByRole('navigation', { name: 'API documentation' });
  await nav.getByRole('searchbox', { name: 'Filter endpoints' }).fill('listRecords');
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.getByRole('article')).toHaveAccessibleName(/^List records with the parameters/);

  await expectAxeClean(page);
  expect(external).toEqual([]);
});

test('the "From Airtable" page maps the endpoints, and deep links reach an operation', async ({
  page,
  baseURL,
}) => {
  const external = await offline(page, new URL(baseURL ?? '').origin);
  await page.goto('/docs/api');
  await page
    .getByRole('navigation', { name: 'API documentation' })
    .getByRole('link', { name: 'From Airtable' })
    .click();
  await expect(page).toHaveURL(/\/docs\/api\/from-airtable$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Coming from Airtable' })).toBeVisible();
  const mapping = page.getByRole('table', {
    name: 'Airtable endpoints and their OpenRows equivalents',
  });
  await expect(mapping.getByRole('row', { name: /^List records GET \/v0/ })).toContainText(
    'GET /api/v1/{baseId}/{tableIdOrName}'
  );
  await expectAxeClean(page);

  // Every operation has an anchor.
  await page.goto('/docs/api#getMe');
  await expect(
    page.getByRole('article', { name: 'The signed-in user and their session' })
  ).toBeInViewport();
  expect(external).toEqual([]);
});

test('the JavaScript SDK page shows the guide and the TypeDoc reference, axe-clean', async ({
  page,
  baseURL,
}) => {
  const external = await offline(page, new URL(baseURL ?? '').origin);
  await page.goto('/docs/api');
  await page
    .getByRole('navigation', { name: 'API documentation' })
    .getByRole('link', { name: 'JavaScript SDK' })
    .click();
  await expect(page).toHaveURL(/\/docs\/api\/sdk$/);
  await expect(page.getByRole('heading', { level: 1, name: 'JavaScript SDK' })).toBeVisible();
  await expect(page.getByText(/@openrows\/sdk \d+\.\d+\.\d+/)).toBeVisible();
  await expect(page.getByRole('figure', { name: 'Install the SDK' })).toContainText(
    'npm install @openrows/sdk'
  );

  // The reference: the client's classes with their methods' signatures.
  const table = page.getByRole('article', { name: /^Table class/ });
  await expect(table).toContainText('select(params?: SelectParams): Query<F>');
  await expect(table).toContainText('10 per request');
  await expect(page.getByRole('article', { name: /^OpenRowsError class/ })).toContainText(
    'requestId'
  );

  // The filter narrows it; a deep link reaches an item.
  const nav = page.getByRole('navigation', { name: 'API documentation' });
  await nav.getByRole('searchbox', { name: 'Filter the SDK reference' }).fill('upsert');
  await expect(page.getByRole('article', { name: /^Table class/ })).toBeVisible();
  await expect(page.getByRole('article', { name: /^Webhooks class/ })).toHaveCount(0);
  await nav.getByRole('searchbox', { name: 'Filter the SDK reference' }).fill('');

  await expectAxeClean(page);
  await page.goto('/docs/api/sdk#sdk-Webhooks');
  await expect(page.getByRole('article', { name: /^Webhooks class/ })).toBeInViewport();
  expect(external).toEqual([]);
});

test('the MCP server page gives Claude Code and Cursor settings for this server, axe-clean', async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL ?? '').origin;
  const external = await offline(page, origin);
  await page.goto('/docs/api');
  await page
    .getByRole('navigation', { name: 'API documentation' })
    .getByRole('link', { name: 'MCP server (AI agents)' })
    .click();
  await expect(page).toHaveURL(/\/docs\/api\/mcp$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'MCP server (AI agents)' })
  ).toBeVisible();
  const tools = page.getByRole('table', { name: 'MCP tools' });
  for (const tool of ['list_bases', 'list_records', 'update_records', 'delete_records']) {
    await expect(tools).toContainText(tool);
  }
  await expect(
    page.getByRole('figure', { name: 'Claude Code: add the remote server' })
  ).toContainText(`claude mcp add --transport http openrows ${origin}/mcp`);
  await expect(
    page.getByRole('figure', { name: 'Cursor: ~/.cursor/mcp.json, local server' })
  ).toContainText(`"OPENROWS_URL": "${origin}"`);
  await expectAxeClean(page);
  expect(external).toEqual([]);

  // The docs index for agents points here; the endpoint wants a token.
  const llms = await page.request.get('/llms.txt');
  expect(llms.status()).toBe(200);
  expect(await llms.text()).toContain('/docs/api/mcp');
  const mcp = await page.request.post('/mcp', { data: {} });
  expect(mcp.status()).toBe(401);
});
