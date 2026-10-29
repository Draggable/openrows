import { defineConfig } from 'vitest/config';

// Runs every package's unit tests in one Vitest process (`npm test`, `npm run test:coverage`).
// Each package project uses its own config. Server integration tests need Docker and run
// separately: `npm run test:integration`.
export default defineConfig({
  test: {
    projects: [
      'packages/shared',
      'packages/server',
      'packages/client',
      'packages/sdk',
      'packages/blocks',
      'packages/mcp-server',
      'packages/n8n-nodes-openrows',
      // Contract tests for committed deployment files: the Keycloak realm export and the Compose
      // files (`docker compose config` per environment, needs the Docker CLI).
      { test: { name: 'docker', include: ['docker/**/*.test.ts'] } },
      // The Helm chart: helm lint and template against golden files (needs the pinned
      // Helm, deploy/helm/install-tools.sh).
      { test: { name: 'helm', include: ['deploy/**/*.test.ts'] } },
      // The repository's own scripts (the brand name check, the published packages' check).
      { test: { name: 'scripts', include: ['scripts/**/*.test.ts'] } },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.{ts,tsx}'],
      exclude: ['**/*.test.{ts,tsx}', '**/src/test/**', '**/*.d.ts'],
      reporter: ['text-summary', 'html', 'lcov'],
    },
  },
});
