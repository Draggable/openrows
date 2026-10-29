import { defineConfig, devices } from '@playwright/test';

// E2E smoke tests (`npm run e2e`). By default Playwright serves the built app itself, the way the
// image does: the API server from packages/server/dist serving the built client
// (CLIENT_DIR=packages/client/dist) on one origin, with its security headers and CSP, so
// run `npm run build` first. E2E_PORT picks the port (4173 by default). Set E2E_BASE_URL to test
// an already-running stack instead.
// The Compose dev stack is one: E2E_BASE_URL=http://localhost:8180 (docker/README.md).
// CI runs it, with e2e/stack.spec.ts, inside the Compose stack (docker/ci.yml, job `smoke`).
const externalBaseUrl = process.env['E2E_BASE_URL'];
const isCI = Boolean(process.env['CI']);
const port = process.env['E2E_PORT'] ?? '4173';

export default defineConfig({
  testDir: './e2e',
  // e2e/auth needs the dev Keycloak: `npm run e2e:auth` (playwright.auth.config.ts).
  testIgnore: ['auth/**'],
  fullyParallel: true,
  // Against the Compose stack every spec signs in the same Keycloak dev user, and Keycloak's
  // brute-force protection refuses near-simultaneous sign-ins of one user: run one at a time.
  workers: process.env['E2E_STACK'] ? 1 : undefined,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: externalBaseUrl ?? `http://localhost:${port}`,
    trace: 'retain-on-failure',
    // page.route doesn't see requests a service worker makes: specs that test the worker
    // allow it and mock the API on the context (e2e/pwa.spec.ts).
    serviceWorkers: 'block',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: externalBaseUrl
    ? undefined
    : {
        command: 'node packages/server/dist/index.js',
        url: `http://localhost:${port}/health`,
        env: {
          PORT: port,
          APP_URL: `http://localhost:${port}`,
          CLIENT_DIR: 'packages/client/dist',
        },
        reuseExistingServer: !isCI,
      },
});
