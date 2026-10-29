import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { type ClientIpOptions, clientIp } from './client-ip.js';

// app.request() has no socket, so the peer address is unknown here; the real-socket behaviour is
// covered by rate-limit.server.test.ts.
async function ipFor(opts: ClientIpOptions, xff?: string) {
  const app = new Hono();
  app.get('/', (c) => c.text(clientIp(c, opts) ?? 'unknown'));
  const res = await app.request('/', { headers: xff ? { 'x-forwarded-for': xff } : {} });
  return res.text();
}

describe('clientIp', () => {
  it('ignores X-Forwarded-For without a trusted proxy', async () => {
    expect(await ipFor({ trustProxy: false, hops: 1 }, '203.0.113.7')).toBe('unknown');
  });

  it('takes the entry the trusted proxy appended, not what the client wrote', async () => {
    const opts = { trustProxy: true, hops: 1 };
    expect(await ipFor(opts, '203.0.113.7')).toBe('203.0.113.7');
    expect(await ipFor(opts, '1.1.1.1, 203.0.113.7')).toBe('203.0.113.7');
    expect(await ipFor({ trustProxy: true, hops: 2 }, '1.1.1.1, 203.0.113.7, 10.0.0.2')).toBe(
      '203.0.113.7'
    );
  });

  it('falls back to the peer for garbage or too few entries', async () => {
    expect(await ipFor({ trustProxy: true, hops: 1 }, 'not-an-ip')).toBe('unknown');
    expect(await ipFor({ trustProxy: true, hops: 3 }, '203.0.113.7')).toBe('unknown');
  });
});
