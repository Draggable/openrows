import { describe, expect, it } from 'vitest';
import { testApp } from '../test/helpers/app.js';

describe('createApp', () => {
  const { app } = testApp();

  it('serves /health', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  // The prototype routers had critical authz holes (legacy/README.md). None may be reachable.
  it.each([
    ['GET', '/api/admin/users'],
    ['GET', '/api/backups'],
    ['POST', '/api/backups/restore'],
    ['GET', '/api/automations'],
    ['GET', '/api/embeds/any'],
    ['GET', '/api/forms/any'],
    ['GET', '/api/export/table/any'],
    ['GET', '/api/shares/data/any'],
    ['PATCH', '/api/records/bulk'],
    ['DELETE', '/api/records/bulk'],
    ['GET', '/api/webhooks'],
    ['GET', '/api/search'],
    ['POST', '/api/auth/sign-up/email'],
    ['GET', '/ws'],
  ])('does not mount %s %s', async (method, path) => {
    const res = await app.request(path, { method });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
  });
});
