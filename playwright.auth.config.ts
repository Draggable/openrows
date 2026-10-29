import { defineConfig, devices } from '@playwright/test';
import { APP_URL, KEYCLOAK_URL } from './e2e/auth/env.js';

// Sign-up and sign-in through the local Keycloak dev realm (`npm run e2e:auth`, opt-in, not in
// CI yet). Needs, besides `npm run build`:
//   docker/compose.sh dev up -d --wait
// (its Postgres on localhost:5432, Keycloak on 8080 and Mailpit on 8025/1025; the stack's own
// app on 8180 doesn't get in the way).
// The server runs its migrations first, then serves with the dev realm's client; the client is
// `vite preview` on 4173, a redirect URI the dev realm registers.
export default defineConfig({
  testDir: './e2e/auth',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
  globalSetup: './e2e/auth/global-setup.ts',
  use: { baseURL: APP_URL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node packages/server/dist/migrate.js && node packages/server/dist/index.js',
      url: 'http://localhost:3000/health',
      env: {
        PORT: '3000',
        APP_URL,
        OIDC_ISSUER_URL: `${KEYCLOAK_URL}/realms/openrows`,
        OIDC_CLIENT_ID: 'openrows-app',
        OIDC_CLIENT_SECRET: 'openrows-dev-client-secret',
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: '1025',
      },
      reuseExistingServer: false,
    },
    {
      command: 'npm run preview -w @openrows/client -- --port 4173 --strictPort',
      url: APP_URL,
      reuseExistingServer: false,
    },
  ],
});
