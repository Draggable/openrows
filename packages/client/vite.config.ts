/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { serviceWorker } from './vite/service-worker.ts';

// The API server (packages/server) listens on PORT, 3000 by default.
const apiTarget = `http://localhost:${process.env['PORT'] ?? 3000}`;

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorker()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Zod and its jitless setting (lib/zod.ts) share one chunk, so the setting runs
          // before any schema parses in whatever chunk comes first (the lazy editors share
          // `@openrows/shared` with the entry); else Zod probes for eval and the CSP reports it.
          groups: [
            { name: 'zod', test: /[\\/]node_modules[\\/]zod[\\/]|[\\/]src[\\/]lib[\\/]zod\.ts$/ },
          ],
        },
      },
    },
  },
  test: {
    name: 'client',
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': apiTarget,
      '/auth': apiTarget,
      '/health': apiTarget,
      // The remote MCP endpoint and the docs index for AI agents.
      '/mcp': apiTarget,
      '/llms.txt': apiTarget,
      // OAuth apps' token endpoints and metadata; /oauth/authorize is the client's page.
      '/oauth/token': apiTarget,
      '/oauth/revoke': apiTarget,
      '/.well-known/oauth-authorization-server': apiTarget,
      // SCIM provisioning: identity providers' requests, bearer only.
      '/scim': apiTarget,
      // The browser scripts' sandbox document, served by the API with its own CSP.
      '/sandbox': apiTarget,
      // The realtime WebSocket; the server checks Origin against APP_URL.
      '/ws': { target: apiTarget, ws: true },
    },
  },
});
