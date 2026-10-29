import { afterEach, describe, expect, it } from 'vitest';
import { testApp } from '../../test/helpers/app.js';
import { type StartedServer, startServer } from '../server.js';

// Over a real socket, so the limiter sees the true peer address (H7). /auth/login answers 503
// here (no provider configured), which still counts against the budget.
describe('auth rate limit, keyed on the real client IP', () => {
  let server: StartedServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function serve(env: Record<string, string>) {
    const { app } = testApp({ env: { AUTH_RATE_LIMIT: '3', ...env } });
    server = await startServer(app, 0);
    const port = server.port;
    return (xff: string) =>
      fetch(`http://127.0.0.1:${port}/auth/login`, { headers: { 'x-forwarded-for': xff } }).then(
        (r) => r.status
      );
  }

  it('ignores a spoofed X-Forwarded-For when not behind a trusted proxy', async () => {
    const hit = await serve({ TRUST_PROXY: 'false' });
    const statuses = [];
    for (let i = 1; i <= 5; i++) statuses.push(await hit(`203.0.113.${i}`));
    expect(statuses).toEqual([503, 503, 503, 429, 429]);
  });

  it('behind a trusted proxy, limits per forwarded client', async () => {
    const hit = await serve({ TRUST_PROXY: 'true' });
    for (let i = 0; i < 3; i++) expect(await hit('203.0.113.1')).toBe(503);
    expect(await hit('203.0.113.1')).toBe(429);
    // A client prepending a fake address doesn't escape: the proxy's entry is the rightmost.
    expect(await hit('198.51.100.9, 203.0.113.1')).toBe(429);
    expect(await hit('203.0.113.2')).toBe(503);
  });
});
