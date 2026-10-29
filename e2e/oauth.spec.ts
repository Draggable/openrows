import { createHash, randomBytes } from 'node:crypto';
import { signInDevUser } from './helpers/stack.js';
import { expect, test } from './helpers/test.js';

// OAuth apps against the whole Compose stack (E2E_STACK=1): register an app in Settings,
// go through the consent screen, exchange the code with PKCE at /oauth/token, call the REST API
// with the access token, rotate it with the refresh token, revoke the app in Settings → the
// tokens stop working. The app's redirect URI is answered by the browser context itself.
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

const REDIRECT = 'https://oauth-e2e.example.test/callback';

test('an app gets tokens through the consent screen and loses them on revoke', async ({
  page,
  playwright,
}) => {
  await signInDevUser(page);
  const origin = new URL(page.url()).origin;
  const name = `OAuth ${Date.now()}`;
  const created = await page.request.post('/api/workspaces', {
    data: { name },
    headers: { origin },
  });
  expect(created.status()).toBe(201);

  // Register the app.
  await page.goto('/settings');
  const developer = page.getByRole('region', { name: 'Developer: OAuth apps' });
  await developer.getByRole('button', { name: 'New app' }).click();
  const form = page.getByRole('dialog', { name: 'Register an OAuth app' });
  const appName = `E2E app ${Date.now()}`;
  await form.getByLabel('Name').fill(appName);
  await form.getByLabel('Redirect URIs').fill(REDIRECT);
  await form.getByRole('button', { name: 'Register app' }).click();
  const shown = page.getByRole('dialog', { name: 'Copy the client secret' });
  const clientId = await shown.getByLabel('Client ID', { exact: true }).inputValue();
  const clientSecret = await shown.getByLabel('Client secret', { exact: true }).inputValue();
  expect(clientSecret).toMatch(/^or_secret_[A-Za-z0-9_-]{43}$/);
  await shown.getByRole('button', { name: 'Done' }).click();

  // The consent screen, as the app would send the person there.
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  await page
    .context()
    .route('https://oauth-e2e.example.test/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Callback</title>ok' })
    );
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: 'schema.bases:read data.records:read',
    state: 'e2e-state',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  await page.goto(`/oauth/authorize?${query}`);
  await expect(
    page.getByRole('heading', { name: `Allow ${appName} to access your data?` })
  ).toBeVisible();
  await page.getByRole('checkbox', { name: `All bases in ${name}` }).check();
  await page.getByRole('button', { name: `Allow ${appName}` }).click();
  await page.waitForURL(/^https:\/\/oauth-e2e\.example\.test\/callback\?/);
  const back = new URL(page.url());
  expect(back.searchParams.get('state')).toBe('e2e-state');
  const code = back.searchParams.get('code') ?? '';
  expect(code).not.toBe('');

  // The app's server side: no cookies, its client credentials.
  const app = await playwright.request.newContext({ baseURL: origin });
  const basic = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  const token = async (params: Record<string, string>) =>
    app.post('/oauth/token', {
      headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' },
      data: new URLSearchParams(params).toString(),
    });
  const exchanged = await token({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  });
  expect(exchanged.status()).toBe(200);
  const tokens = (await exchanged.json()) as { access_token: string; refresh_token: string };
  const bases = (access: string) =>
    app.get('/api/v1/meta/bases', { headers: { authorization: `Bearer ${access}` } });
  expect((await bases(tokens.access_token)).status()).toBe(200);

  const refreshed = await token({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
  });
  expect(refreshed.status()).toBe(200);
  const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
  expect((await bases(next.access_token)).status()).toBe(200);

  // Settings → Integrations: revoke it.
  await page.goto('/settings');
  const integrations = page.getByRole('region', { name: 'Integrations' });
  await expect(integrations.getByText(appName)).toBeVisible();
  page.once('dialog', (d) => void d.accept());
  await integrations.getByRole('button', { name: `Revoke ${appName}` }).click();
  await expect(integrations.getByText(appName)).toHaveCount(0);
  expect((await bases(next.access_token)).status()).toBe(401);
  const after = await token({ grant_type: 'refresh_token', refresh_token: next.refresh_token });
  expect(after.status()).toBe(400);
  await app.dispose();
});
