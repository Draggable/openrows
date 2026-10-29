import { describe, expect, it } from 'vitest';
import { testApp } from '../../test/helpers/app.js';

// No database and no issuer: only paths that never reach either. The full flow runs against a
// mock issuer and Postgres in test/integration/auth.test.ts.
describe('auth routes without a provider', () => {
  const { app, config } = testApp();

  it('GET /api/me is 401 problem+json without a session', async () => {
    const res = await app.request('/api/me');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(await res.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('GET /auth/login is 503 when sign-in is not configured', async () => {
    const res = await app.request('/auth/login');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('GET /auth/providers lists no buttons when sign-in is not configured', async () => {
    const res = await app.request('/auth/providers');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ providers: [], statusPageUrl: null });
  });

  it('GET /auth/providers names the status page when STATUS_PAGE_URL is set (#137)', async () => {
    const { app } = testApp({ env: { STATUS_PAGE_URL: 'https://status.example.org' } });
    const res = await app.request('/auth/providers');
    expect(await res.json()).toEqual({
      providers: [],
      statusPageUrl: 'https://status.example.org',
    });
  });

  it('POST /auth/logout from another origin is refused (CSRF)', async () => {
    const res = await app.request('/auth/logout', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });

  it('POST /auth/logout without a session clears the cookie and goes home', async () => {
    const res = await app.request('/auth/logout', {
      method: 'POST',
      headers: { origin: config.appUrl },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${config.appUrl}/`);
    expect(res.headers.get('set-cookie')).toMatch(/^openrows_session=; Max-Age=0/);
  });

  it('GET /auth/logout is not a route (no logout CSRF via links or images)', async () => {
    expect((await app.request('/auth/logout')).status).toBe(404);
  });
});
