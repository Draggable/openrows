import { defineConfig } from 'vitest/config';

// Unit tests of the SDK against a fake fetch; the integration tests against the real server are in
// packages/server/test/integration/sdk.test.ts.
export default defineConfig({
  test: {
    name: 'sdk',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
});
