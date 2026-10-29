import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../lib/context.js';
import { rateLimit } from './rate-limit.js';

function app(now: () => number) {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('requestId', 'test');
    await next();
  });
  a.use(
    '*',
    rateLimit({ limit: 2, windowMs: 60_000, key: (c) => c.req.header('x-key') ?? '', now })
  );
  a.get('/', (c) => c.text('ok'));
  return a;
}

describe('rateLimit', () => {
  it('allows `limit` requests per key and window, then answers 429 problem+json', async () => {
    let t = 0;
    const a = app(() => t);
    const hit = (key: string) => a.request('/', { headers: { 'x-key': key } });

    expect((await hit('a')).status).toBe(200);
    expect((await hit('a')).status).toBe(200);
    const limited = await hit('a');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('content-type')).toBe('application/problem+json');
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(await limited.json()).toMatchObject({ code: 'RATE_LIMITED' });

    // Other keys have their own budget, and the window resets.
    expect((await hit('b')).status).toBe(200);
    t = 60_000;
    expect((await hit('a')).status).toBe(200);
  });
});
