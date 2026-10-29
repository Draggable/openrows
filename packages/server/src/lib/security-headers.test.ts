import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { testApp } from '../../test/helpers/app.js';
import { loadConfig } from '../config.js';
import {
  contentSecurityPolicy,
  formContentSecurityPolicy,
  shareContentSecurityPolicy,
} from './security-headers.js';

const dir = mkdtempSync(join(tmpdir(), 'openrows-headers-'));
mkdirSync(join(dir, 'assets'));
writeFileSync(join(dir, 'index.html'), '<!doctype html><title>OpenRows</title>');
writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const S3 = {
  S3_ENDPOINT: 'http://s3.internal:9000',
  S3_BUCKET: 'openrows',
  S3_ACCESS_KEY: 'access',
  S3_SECRET_KEY: 'secret-key',
};
const OIDC = {
  OIDC_ISSUER_URL: 'https://id.example.org/realms/openrows',
  OIDC_CLIENT_ID: 'openrows-app',
  OIDC_CLIENT_SECRET: 'client-secret',
};

const config = (env: Record<string, string> = {}) => loadConfig({ NODE_ENV: 'test', ...env });

/** The CSP as a map of directive → sources. */
function directives(csp: string | null): Record<string, string[]> {
  return Object.fromEntries(
    (csp ?? '')
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .filter(([name]) => name)
      .map(([name = '', ...values]) => [name, values])
  );
}

describe('contentSecurityPolicy', () => {
  it('allows only the app origin by default, with no inline or eval scripts', () => {
    const csp = directives(contentSecurityPolicy(config()));
    expect(csp).toEqual({
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'"],
      'font-src': ["'self'"],
      'connect-src': ["'self'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'frame-ancestors': ["'none'"],
    });
  });

  it('adds the S3 public origin to img-src and connect-src, and the issuer to form-action', () => {
    const csp = directives(
      contentSecurityPolicy(
        config({ ...S3, ...OIDC, S3_PUBLIC_URL: 'https://files.example.org/openrows' })
      )
    );
    expect(csp['img-src']).toEqual(["'self'", 'https://files.example.org']);
    expect(csp['connect-src']).toEqual(["'self'", 'https://files.example.org']);
    expect(csp['form-action']).toEqual(["'self'", 'https://id.example.org']);
    // The browser never talks to the issuer directly (BFF), nor to the internal endpoint.
    expect(csp['connect-src']).not.toContain('https://id.example.org');
    expect(JSON.stringify(csp)).not.toContain('s3.internal');
  });

  it('falls back to the S3 endpoint origin without S3_PUBLIC_URL', () => {
    const csp = directives(contentSecurityPolicy(config(S3)));
    expect(csp['img-src']).toEqual(["'self'", 'http://s3.internal:9000']);
    expect(csp['connect-src']).toEqual(["'self'", 'http://s3.internal:9000']);
  });
});

describe('security headers on every response', () => {
  const env = { CLIENT_DIR: dir, ...S3, S3_PUBLIC_URL: 'https://files.example.org/openrows' };
  const { app } = testApp({ env });
  const expectedCsp = contentSecurityPolicy(config(env));

  function expectCommon(res: Response, what: string) {
    expect(res.headers.get('content-security-policy'), what).toBe(expectedCsp);
    expect(res.headers.get('x-content-type-options'), what).toBe('nosniff');
    expect(res.headers.get('referrer-policy'), what).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('permissions-policy'), what).toMatch(
      /camera=\(\).*microphone=\(\).*geolocation=\(\)/
    );
    expect(res.headers.get('cross-origin-opener-policy'), what).toBe('same-origin');
    expect(res.headers.get('x-frame-options'), what).toBe('DENY');
    // APP_URL is http in tests: no HSTS.
    expect(res.headers.get('strict-transport-security'), what).toBeNull();
  }

  it('an HTML page', async () => {
    const res = await app.request('/workspaces/1');
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expectCommon(res, 'html');
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('a hashed static asset, cached for a year', async () => {
    const res = await app.request('/assets/index-abc123.js');
    expect(res.status).toBe(200);
    expectCommon(res, 'asset');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('a JSON route, never stored', async () => {
    const res = await app.request('/api/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expectCommon(res, 'json');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('problem+json errors (401, 404, 503) and auth responses', async () => {
    for (const path of ['/api/me', '/api/nope', '/auth/login']) {
      const res = await app.request(path);
      expect(res.status, path).toBeGreaterThanOrEqual(400);
      expect(res.headers.get('content-type'), path).toBe('application/problem+json');
      expectCommon(res, path);
      expect(res.headers.get('cache-control'), path).toBe('no-store');
    }
    // A missing static file is a 404 too, outside /api.
    const missing = await app.request('/assets/missing.js');
    expect(missing.status).toBe(404);
    expectCommon(missing, 'missing asset');
  });

  it('an unexpected 500 and a refused cross-origin request', async () => {
    const { CLIENT_DIR: _, ...noClient } = env;
    const { app: plain, routes } = testApp({ env: noClient });
    routes.public('GET', '/api/boom', () => {
      throw new Error('boom');
    });
    const boom = await plain.request('/api/boom');
    expect(boom.status).toBe(500);
    expectCommon(boom, '500');
    expect(boom.headers.get('cache-control')).toBe('no-store');

    const refused = await plain.request('/api/me', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });
    expect(refused.status).toBe(403);
    expect(refused.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('a share link page (#97): no referrer, no index, no store, its own CSP', async () => {
    const token = 'A'.repeat(43);
    const page = await app.request(`/s/${token}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    const csp = directives(page.headers.get('content-security-policy'));
    expect(page.headers.get('content-security-policy')).toBe(
      shareContentSecurityPolicy(config(env))
    );
    expect(csp['script-src']).toEqual(["'self'"]);
    expect(csp['form-action']).toEqual(["'none'"]);
    expect(csp['connect-src']).toEqual(["'self'"]);
    expect(csp['img-src']).toEqual(["'self'", 'https://files.example.org']);
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
    // Its API, refusals included (a malformed token: no database is asked).
    const api = await app.request('/api/shared/short');
    expect(api.status).toBe(404);
    for (const res of [page, api]) {
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    }
    // Other pages keep the app's policy.
    expect((await app.request('/settings')).headers.get('x-robots-tag')).toBeNull();
  });

  it('an embed page (#99) of an unknown link: share headers, never framed', async () => {
    const page = await app.request('/embed/short?theme=dark');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    expect(page.headers.get('content-security-policy')).toBe(
      shareContentSecurityPolicy(config(env))
    );
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('cache-control')).toBe('private, no-store');
  });

  it('frames only the embed page, whatever a route asks for (#99)', async () => {
    const { CLIENT_DIR: _, ...noClient } = env;
    const { app: plain, routes } = testApp({ env: noClient });
    const paths = ['/api/framed', '/s/framed', '/embed/a/b'];
    for (const path of paths) {
      routes.public('GET', path, (c) => {
        c.set('frameAncestors', ['https://example.com']);
        return c.text('framed?');
      });
    }
    for (const path of paths) {
      const res = await plain.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('x-frame-options'), path).toBe('DENY');
      expect(directives(res.headers.get('content-security-policy'))['frame-ancestors']).toEqual([
        "'none'",
      ]);
    }
  });

  it('keeps a header a route set itself', async () => {
    const { app: plain, routes } = testApp();
    routes.public('GET', '/api/cached', (c) => {
      c.header('Cache-Control', 'private, max-age=60');
      c.header('Referrer-Policy', 'no-referrer');
      return c.json({ ok: true });
    });
    const res = await plain.request('/api/cached');
    expect(res.headers.get('cache-control')).toBe('private, max-age=60');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

describe('shareContentSecurityPolicy frame-ancestors (#99)', () => {
  it("is 'none' unless embed origins are given", () => {
    expect(directives(shareContentSecurityPolicy(config()))['frame-ancestors']).toEqual(["'none'"]);
    const csp = directives(
      shareContentSecurityPolicy(config(), ['https://a.example', 'https://b.example:8443'])
    );
    expect(csp['frame-ancestors']).toEqual(['https://a.example', 'https://b.example:8443']);
    expect(csp['script-src']).toEqual(["'self'"]);
    expect(csp['form-action']).toEqual(["'none'"]);
  });
});

describe('formContentSecurityPolicy (#101)', () => {
  it('allows Turnstile only when it is configured, uploads to the bucket, and no framing', () => {
    const none = directives(formContentSecurityPolicy(config(S3)));
    expect(none['script-src']).toEqual(["'self'"]);
    expect(none['frame-src']).toEqual(["'none'"]);
    expect(none['connect-src']).toEqual(["'self'", 'http://s3.internal:9000']);
    expect(none['frame-ancestors']).toEqual(["'none'"]);
    expect(none['form-action']).toEqual(["'none'"]);
    const turnstile = directives(
      formContentSecurityPolicy(
        config({
          TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
          TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
        })
      )
    );
    expect(turnstile['script-src']).toEqual(["'self'", 'https://challenges.cloudflare.com']);
    expect(turnstile['frame-src']).toEqual(['https://challenges.cloudflare.com']);
  });

  it('is what /f/ and /api/forms/ answer with, with the share headers', async () => {
    const { app } = testApp({ env: { CLIENT_DIR: dir } });
    for (const path of ['/f/abc', '/api/forms/abc']) {
      const res = await app.request(path);
      expect(res.headers.get('referrer-policy'), path).toBe('no-referrer');
      expect(res.headers.get('x-robots-tag'), path).toBe('noindex, nofollow, noarchive');
      expect(directives(res.headers.get('content-security-policy'))['form-action']).toEqual([
        "'none'",
      ]);
      expect(res.headers.get('x-frame-options'), path).toBe('DENY');
    }
  });
});

describe('Strict-Transport-Security', () => {
  it('is absent for an http APP_URL and present for https', async () => {
    const { app: http } = testApp({ env: { APP_URL: 'http://localhost:5173' } });
    expect((await http.request('/health')).headers.get('strict-transport-security')).toBeNull();

    const { app: https } = testApp({ env: { APP_URL: 'https://app.openrows.io' } });
    for (const path of ['/health', '/api/me']) {
      const res = await https.request(path);
      expect(res.headers.get('strict-transport-security'), path).toBe(
        'max-age=31536000; includeSubDomains'
      );
    }
  });
});
