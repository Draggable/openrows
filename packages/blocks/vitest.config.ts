import { defineConfig } from 'vitest/config';

// Unit tests of the SDK against the real frame runtime (shared's extensions/runtime.ts) with a
// fake port; the host's side is tested in the client (features/extensions/host.test.ts).
export default defineConfig({
  test: {
    name: 'blocks',
    include: ['src/**/*.test.ts'],
  },
});
