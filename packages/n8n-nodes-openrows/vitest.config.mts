import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);

// Unit tests of the n8n nodes against a fake OpenRows API on a local port; the integration tests
// against the real server are in packages/server/test/integration/n8n.test.ts.
export default defineConfig({
  // n8n loads community nodes as CommonJS: the tests use n8n-workflow's CommonJS build too (its
  // ESM build has extensionless imports and source maps without sources).
  resolve: { alias: { 'n8n-workflow': require.resolve('n8n-workflow') } },
  test: {
    name: 'n8n-nodes-openrows',
    include: ['src/**/*.test.ts'],
  },
});
