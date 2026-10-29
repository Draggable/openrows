import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { testApp } from '../test/helpers/app.js';

const dir = mkdtempSync(join(tmpdir(), 'openrows-client-'));
mkdirSync(join(dir, 'assets'));
writeFileSync(join(dir, 'index.html'), '<!doctype html><title>OpenRows</title>');
writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
writeFileSync(join(dir, 'favicon.svg'), '<svg/>');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('serving the client (CLIENT_DIR)', () => {
  const { app } = testApp({ env: { CLIENT_DIR: dir } });

  it('serves index.html at / and for client routes, revalidated on every load', async () => {
    for (const path of ['/', '/login', '/workspaces/123/bases']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toMatch(/^text\/html/);
      expect(res.headers.get('cache-control'), path).toBe('no-cache');
      expect(await res.text(), path).toContain('<title>OpenRows</title>');
    }
  });

  it('serves hashed assets as immutable and other files with revalidation', async () => {
    const asset = await app.request('/assets/index-abc123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toMatch(/javascript/);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const icon = await app.request('/favicon.svg');
    expect(icon.status).toBe(200);
    expect(icon.headers.get('cache-control')).toBe('no-cache');
  });

  it('keeps server routes and 404s as they are', async () => {
    expect((await app.request('/health')).status).toBe(200);
    for (const path of ['/api/nope', '/auth/nope', '/assets/missing.js', '/%2e%2e/package.json']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('content-type'), path).toBe('application/problem+json');
    }
    // A signed-out /api/me is still the API's answer, not the app shell.
    expect((await app.request('/api/me')).status).toBe(401);
  });

  it('is off without CLIENT_DIR', async () => {
    const { app: plain } = testApp();
    expect((await plain.request('/')).status).toBe(404);
  });
});
