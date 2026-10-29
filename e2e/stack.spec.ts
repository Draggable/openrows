import { expect, test } from './helpers/test.js';

// Against the whole Compose stack only (E2E_STACK=1): CI's smoke job sets it in docker/ci.yml.
// Locally: E2E_STACK=1 E2E_BASE_URL=http://localhost:8180 npm run e2e, with the dev stack up.
// `npm run e2e` alone runs the server without Postgres or Keycloak, where neither would pass.
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

const KEYCLOAK_URL = 'http://localhost:8080';

test('/ready: Postgres and S3 answer', async ({ request }) => {
  const res = await request.get('/ready');
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({
    status: 'ok',
    checks: { database: { status: 'ok' }, s3: { status: 'ok' } },
  });
});

// The worker's port is never published, so only CI's e2e container (in the stack's network
// namespace) sets E2E_WORKER_URL.
test('the worker runs pg-boss: /health and its queues in /metrics', async ({ request }) => {
  const worker = process.env['E2E_WORKER_URL'];
  test.skip(!worker, 'needs E2E_WORKER_URL (the worker in the same network namespace)');
  const health = await request.get(`${worker}/health`);
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ status: 'ok' });
  const metrics = await (await request.get(`${worker}/metrics`)).text();
  for (const queue of ['outbox.relay', 'outbox.prune', 'snapshots.auto']) {
    expect(metrics).toContain(`openrows_jobs_queued{queue="${queue}"}`);
  }
  expect(metrics).toMatch(/^openrows_outbox_relay_pending \d+$/m);
});

test('/auth/login redirects to Keycloak, and the seeded dev user signs in', async ({ page }) => {
  await page.goto('/auth/login');
  await expect(page).toHaveURL(
    new RegExp(`^${KEYCLOAK_URL}/realms/openrows/protocol/openid-connect/auth\\?`)
  );
  await page.locator('#username').fill('dev@openrows.test');
  await page.locator('#password').fill('openrows-dev-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(/^http:\/\/localhost:8180\/$/);
  await expect(page.getByTestId('current-user')).toContainText('dev@openrows.test');
  expect((await page.request.get('/api/me')).status()).toBe(200);
});
