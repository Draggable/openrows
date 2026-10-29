import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Integration tests against a real Postgres 16 in Docker (Testcontainers). The global setup
// starts one container per run and migrates a template database; each test file clones it.
export default defineConfig({
  // The SDK's, the MCP server's and the n8n nodes' tests (sdk.test.ts, mcp.test.ts, n8n.test.ts)
  // run their source, so they needn't be built first. n8n loads community nodes as CommonJS, so
  // n8n-workflow is its CommonJS build (its ESM build has extensionless imports).
  resolve: {
    alias: [
      {
        find: '@openrows/sdk',
        replacement: fileURLToPath(new URL('../sdk/src/index.ts', import.meta.url)),
      },
      {
        find: '@openrows/mcp-server',
        replacement: fileURLToPath(new URL('../mcp-server/src/index.ts', import.meta.url)),
      },
      {
        find: /^@openrows\/n8n-nodes-openrows\/dist\/(.*)\.js$/,
        replacement: fileURLToPath(new URL('../n8n-nodes-openrows/src/$1.ts', import.meta.url)),
      },
      { find: 'n8n-workflow', replacement: createRequire(import.meta.url).resolve('n8n-workflow') },
    ],
  },
  test: {
    name: 'server:integration',
    include: ['test/integration/**/*.test.ts'],
    globalSetup: ['test/integration/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
