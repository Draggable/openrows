import AxeBuilder from '@axe-core/playwright';
import type { Page, Route } from '@playwright/test';
import { mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// OAuth apps against the mocked API: Settings → "Developer: OAuth apps" registers an app
// and shows its client secret once; Settings → Integrations lists an authorized app and revokes
// it; the consent screen shows the app and its scopes, takes a workspace and sends the browser
// back to the app's redirect URI with the code. Needs only the built client.

const REDIRECT = 'https://acme.example.test/oauth/callback';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const stamp = { createdAt: '2026-10-25T10:00:00.000Z', updatedAt: '2026-10-25T10:00:00.000Z' };

const json = (route: Route, data: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });

async function expectAxeClean(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    results.violations
      .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
      .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))
  ).toEqual([]);
}

test('registers an OAuth app and revokes an authorized one in Settings', async ({ page }) => {
  await mockApi(page, { rows: 1 });
  const apps: Record<string, unknown>[] = [];
  const authorizations = [
    {
      id: '0199a000-0000-7000-8000-00000000a001',
      app: { id: '0199a000-0000-7000-8000-00000000a002', name: 'Zap', homepageUrl: null },
      scopes: ['data.records:read', 'schema.bases:read'],
      workspaceIds: ['0199a000-0000-7000-8000-00000000a003'],
      baseIds: [],
      ...stamp,
      lastUsedAt: null,
    },
  ];
  await page.route('**/api/me/tokens', (route) => json(route, { tokens: [] }));
  await page.route('**/api/me/oauth-apps', (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      const app = {
        id: '0199a000-0000-7000-8000-00000000a010',
        description: '',
        homepageUrl: null,
        ...body,
        clientId: 'or_app_abcdefghijklmnopqrst',
        ...stamp,
      };
      apps.unshift(app);
      return json(route, { ...app, clientSecret: `or_secret_${'S'.repeat(43)}` }, 201);
    }
    return json(route, { apps });
  });
  await page.route('**/api/me/authorizations', (route) => json(route, { authorizations }));
  await page.route('**/api/me/authorizations/*', (route) => {
    authorizations.splice(0, 1);
    return route.fulfill({ status: 204 });
  });

  await page.goto('/settings');
  const integrations = page.getByRole('region', { name: 'Integrations' });
  await expect(integrations.getByText('Zap', { exact: true })).toBeVisible();
  await expect(integrations).toContainText('data.records:read, schema.bases:read · 1 workspace');
  await expectAxeClean(page);

  const developer = page.getByRole('region', { name: 'Developer: OAuth apps' });
  await developer.getByRole('button', { name: 'New app' }).click();
  const form = page.getByRole('dialog', { name: 'Register an OAuth app' });
  await form.getByLabel('Name').fill('Acme Sync');
  await form.getByLabel('Redirect URIs').fill(`${REDIRECT}\nhttp://localhost:8765/cb`);
  await expectAxeClean(page);
  await form.getByRole('button', { name: 'Register app' }).click();
  const shown = page.getByRole('dialog', { name: 'Copy the client secret' });
  await expect(shown.getByLabel('Client ID', { exact: true })).toHaveValue(
    'or_app_abcdefghijklmnopqrst'
  );
  await expect(shown.getByLabel('Client secret', { exact: true })).toHaveValue(/^or_secret_S{43}$/);
  await shown.getByRole('button', { name: 'Done' }).click();
  await expect(developer.getByText('Acme Sync')).toBeVisible();
  await expect(developer).toContainText(`${REDIRECT}, http://localhost:8765/cb`);
  expect(await page.content()).not.toContain(`or_secret_${'S'.repeat(43)}`);

  page.once('dialog', (d) => void d.accept());
  await integrations.getByRole('button', { name: 'Revoke Zap' }).click();
  await expect(integrations.getByText('No apps have access.')).toBeVisible();
});

test('the consent screen sends the browser back to the app with a code', async ({ page }) => {
  await mockApi(page, { rows: 1 });
  const decisions: Record<string, unknown>[] = [];
  await page.route(
    (url) => url.pathname === '/api/oauth/authorize',
    (route) => {
      if (route.request().method() === 'GET') {
        return json(route, {
          app: {
            name: 'Acme Sync',
            description: 'Keeps your CRM and OpenRows in step.',
            homepageUrl: 'https://acme.example.test',
          },
          clientId: 'or_app_abcdefghijklmnopqrst',
          redirectUri: REDIRECT,
          scopes: ['data.records:read', 'data.records:write'],
          current: null,
        });
      }
      const body = route.request().postDataJSON() as Record<string, unknown>;
      decisions.push(body);
      return json(route, { redirectTo: `${REDIRECT}?code=the-code&state=${body['state']}` });
    }
  );
  await page.route('https://acme.example.test/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Acme</title>Connected' })
  );

  const query = new URLSearchParams({
    response_type: 'code',
    client_id: 'or_app_abcdefghijklmnopqrst',
    redirect_uri: REDIRECT,
    scope: 'data.records:read data.records:write',
    state: 'st-42',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
  });
  await page.goto(`/oauth/authorize?${query}`);
  await expect(
    page.getByRole('heading', { name: 'Allow Acme Sync to access your data?' })
  ).toBeVisible();
  await expect(page.getByRole('list', { name: 'Requested access' })).toContainText(
    'Create, edit and delete records'
  );
  await expect(page.getByText('acme.example.test', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'All bases in Ada' }).check();
  await expectAxeClean(page);
  await page.getByRole('button', { name: 'Allow Acme Sync' }).click();
  await expect(page).toHaveURL(`${REDIRECT}?code=the-code&state=st-42`);
  expect(decisions).toEqual([
    expect.objectContaining({
      clientId: 'or_app_abcdefghijklmnopqrst',
      redirectUri: REDIRECT,
      scope: 'data.records:read data.records:write',
      state: 'st-42',
      codeChallenge: CHALLENGE,
      codeChallengeMethod: 'S256',
      decision: 'allow',
    }),
  ]);
});
