import { defineConfig } from 'vitest/config';

// Unit tests of the MCP server against a fake fetch, and over stdio against a fake API (the built
// bin); the integration tests against the real server are in
// packages/server/test/integration/mcp.test.ts.
export default defineConfig({
  test: {
    name: 'mcp-server',
    include: ['src/**/*.test.ts'],
  },
});
