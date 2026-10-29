import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testApp } from '../../test/helpers/app.js';
import { loggablePath } from './context.js';

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('request context', () => {
  it('assigns a UUIDv7 request id per request', async () => {
    const { app } = testApp();
    const a = (await app.request('/health')).headers.get('x-request-id');
    const b = (await app.request('/health')).headers.get('x-request-id');
    expect(a).toMatch(UUIDV7);
    expect(b).toMatch(UUIDV7);
    expect(a).not.toBe(b);
  });

  it('ignores an incoming X-Request-Id unless the proxy is trusted', async () => {
    const headers = { 'X-Request-Id': 'proxy-id-123' };
    const untrusted = testApp();
    expect(
      (await untrusted.app.request('/health', { headers })).headers.get('x-request-id')
    ).toMatch(UUIDV7);
    const trusted = testApp({ config: { trustProxy: true } });
    expect((await trusted.app.request('/health', { headers })).headers.get('x-request-id')).toBe(
      'proxy-id-123'
    );
    const bad = { 'X-Request-Id': 'not a valid id; has spaces' };
    expect(
      (await trusted.app.request('/health', { headers: bad })).headers.get('x-request-id')
    ).toMatch(UUIDV7);
  });

  it('logs one line per request with the id, path but no query string', async () => {
    const { app, logs } = testApp();
    const res = await app.request('/auth/callback?code=secret-code&state=s');
    const line = logs.find((l) => l['msg'] === 'request completed');
    expect(line).toMatchObject({
      level: 'info',
      requestId: res.headers.get('x-request-id'),
      method: 'GET',
      path: '/auth/callback',
      status: 302, // sign-in not configured: back to /login?error=not_configured
    });
    expect(JSON.stringify(logs)).not.toContain('secret-code');
  });

  it('redacts share link tokens (#97, #99) from logged paths', async () => {
    const { app, logs } = testApp();
    const token = 'tok_'.padEnd(43, 'x');
    await app.request(`/api/shared/${token}/records`);
    await app.request(`/s/${token}`);
    await app.request(`/embed/${token}?theme=dark`);
    const paths = logs.filter((l) => l['msg'] === 'request completed').map((l) => l['path']);
    expect(paths).toEqual(['/api/shared/:token/records', '/s/:token', '/embed/:token']);
    expect(JSON.stringify(logs)).not.toContain(token);
  });

  it('redacts invitation (#16) and webhook trigger (#110) tokens from logged paths', async () => {
    const { app, logs } = testApp();
    const token = 'inv_'.padEnd(43, 'y');
    await app.request(`/invite/${token}`);
    await app.request(`/hooks/a/${token}`, { method: 'POST' });
    const paths = logs.filter((l) => l['msg'] === 'request completed').map((l) => l['path']);
    expect(paths).toEqual(['/invite/:token', '/hooks/a/:token']);
    expect(loggablePath(`/api/invitations/${token}/accept`)).toBe('/api/invitations/:token/accept');
    expect(JSON.stringify(logs)).not.toContain(token);
  });

  it('never logs cookies, authorization headers or query strings (#75)', async () => {
    const { app, logs } = testApp();
    const secrets = ['cookie-secret-1', 'bearer-secret-2', 'query-secret-3', 'basic-secret-4'];
    await app.request(`/api/me?token=${secrets[2]}`, {
      headers: { cookie: `or_session=${secrets[0]}`, authorization: `Bearer or_pat_${secrets[1]}` },
    });
    await app.request(`/email/unsubscribe?token=${secrets[2]}`);
    await app.request('/llms.txt', { headers: { authorization: `Basic ${secrets[3]}` } });
    const lines = logs.filter((l) => l['msg'] === 'request completed');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual([
        'durationMs',
        'level',
        'method',
        'msg',
        'path',
        'requestId',
        'service',
        'status',
        'time',
      ]);
    }
    const all = JSON.stringify(logs);
    for (const secret of secrets) expect(all).not.toContain(secret);
  });

  it('redacts the token of every registered route and client route that has one (#75)', () => {
    const { routes } = testApp();
    const isToken = (name: string) => name === 'token' || name.endsWith('Token');
    const secret = 'S3cretTokenValue_0123456789abcdefghijklmnopq';
    const withToken = routes.entries
      .map((e) => e.path)
      .filter((path) => [...path.matchAll(/:(\w+)/g)].some((m) => isToken(m[1] ?? '')));
    // The client's routes with a `$token` (TanStack Router syntax), served by the SPA fallback.
    const router = readFileSync(
      resolve(import.meta.dirname, '../../../client/src/router.tsx'),
      'utf8'
    );
    const clientPaths = [...router.matchAll(/path: '([^']*\$\w*[tT]oken[^']*)'/g)].map((m) =>
      (m[1] ?? '').replace(/\$(\w+)/g, ':$1')
    );
    expect(withToken.length).toBeGreaterThan(10);
    expect(clientPaths).toEqual(expect.arrayContaining(['/invite/:token', '/s/:token']));
    for (const path of [...withToken, ...clientPaths]) {
      const sample = path.replace(/:(\w+)/g, (_, name: string) => (isToken(name) ? secret : 'x1'));
      expect(loggablePath(sample), path).not.toContain(secret);
    }
  });

  it('logs probes at debug level', async () => {
    const { app, logs } = testApp();
    await app.request('/health');
    expect(logs.find((l) => l['msg'] === 'request completed')).toMatchObject({ level: 'debug' });
  });
});
