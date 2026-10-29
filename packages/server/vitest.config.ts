import { defineConfig } from 'vitest/config';

// Unit tests: fast, no Docker. Integration tests have their own config
// (vitest.integration.config.ts, `npm run test:integration`).
export default defineConfig({
  test: {
    name: 'server',
    include: ['src/**/*.test.ts'],
  },
});
