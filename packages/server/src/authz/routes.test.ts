import { describe, expect, it } from 'vitest';
import { testApp } from '../../test/helpers/app.js';
import { unregisteredRoutes } from './routes.js';

describe('route registry', () => {
  it('has an access rule for every route of the app', () => {
    const { app, routes } = testApp();
    expect(unregisteredRoutes(app, routes)).toEqual([]);
    expect(routes.entries.length).toBeGreaterThan(0);
  });

  it('flags a route added without one', () => {
    const { app, routes } = testApp();
    app.get('/api/sneaky', (c) => c.text('no authorize'));
    expect(unregisteredRoutes(app, routes)).toEqual(['GET /api/sneaky']);
  });

  it('makes no /api route public except the OpenAPI document, share links and forms', () => {
    const { routes } = testApp();
    const open = routes.entries.filter(
      (e) => e.path.startsWith('/api') && e.access.kind === 'public'
    );
    // Share links are read-only GETs whose token is the credential, plus the
    // password unlock, rate-limited per link and IP (shares.test.ts). Public forms take
    // submissions and their uploads through the form link's allowlist (public-forms.test.ts),
    // and a link field's picker over the view its creator chose (public-form-links.test.ts).
    // The billing provider's webhooks are authenticated by their signature on the raw
    // body, a 5-minute window and one application per event id (billing.test.ts).
    expect(open.map((e) => `${e.method} ${e.path}`).sort()).toEqual([
      'GET /api/forms/:formToken',
      'GET /api/forms/:formToken/fields/:fieldId/records',
      'GET /api/forms/:formToken/images/:image',
      'GET /api/openapi.json',
      'GET /api/shared/:shareToken',
      'GET /api/shared/:shareToken/views/:viewId',
      'GET /api/shared/:shareToken/views/:viewId/attachments/:attachmentId',
      'GET /api/shared/:shareToken/views/:viewId/attachments/:attachmentId/thumbnail',
      'GET /api/shared/:shareToken/views/:viewId/export.csv',
      'GET /api/shared/:shareToken/views/:viewId/records',
      'POST /api/billing/:provider/webhooks',
      'POST /api/forms/:formToken/attachments',
      'POST /api/forms/:formToken/attachments/:attachmentId/confirm',
      'POST /api/forms/:formToken/submissions',
      'POST /api/shared/:shareToken/unlock',
    ]);
  });

  it('keeps only the MCP endpoint to personal access tokens alone (#116)', () => {
    const { routes } = testApp();
    const tokenOnly = routes.entries.filter((e) => e.access.kind === 'token');
    expect(tokenOnly.map((e) => `${e.method} ${e.path}`).sort()).toEqual([
      'DELETE /mcp',
      'GET /mcp',
      'POST /mcp',
    ]);
  });

  it('answers 401 with WWW-Authenticate on the MCP endpoint without a bearer token', async () => {
    const { app } = testApp();
    const res = await app.request('/mcp', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(res.headers.get('content-type')).toBe('application/problem+json');
  });

  it('lets personal access tokens into only these session routes (#102)', () => {
    const { routes } = testApp();
    const open = routes.entries.flatMap((e) =>
      e.access.kind === 'session' && e.access.token !== null
        ? [`${e.method} ${e.path} ${e.access.token}`]
        : []
    );
    expect(open.sort()).toEqual([
      'GET /api/me user.email:read',
      // The REST API v1's base list.
      'GET /api/v1/meta/bases schema.bases:read',
      'GET /api/workspaces schema.bases:read',
      'GET /api/workspaces/:workspaceId/bases schema.bases:read',
    ]);
  });

  it('keeps sharing, permissions, members, exports, snapshots and purges to sessions (#102)', () => {
    const { routes } = testApp();
    const sessionOnly = routes.entries.flatMap((e) =>
      e.access.kind === 'resource' && e.access.token === null ? [`${e.method} ${e.path}`] : []
    );
    for (const route of [
      'GET /api/bases/:baseId/export.zip',
      'POST /api/views/:viewId/shares',
      'POST /api/bases/:baseId/shares',
      'PATCH /api/bases/:baseId/collaborators/:userId',
      'POST /api/workspaces/:workspaceId/invitations',
      'DELETE /api/workspaces/:workspaceId',
      'DELETE /api/bases/:baseId',
      'POST /api/bases/:baseId/snapshots',
      'POST /api/tables/:tableId/trash/records/purge',
      'POST /api/tables/:tableId/imports',
    ]) {
      expect(sessionOnly, route).toContain(route);
    }
    // Record data behind a base:read route needs the data scope.
    const events = routes.entries.find((e) => e.path === '/api/bases/:baseId/events');
    expect(events?.access).toMatchObject({ token: 'data.records:read' });
  });

  it('answers 401 for a malformed bearer token, before touching the database', async () => {
    const { app } = testApp();
    const res = await app.request('/api/workspaces', {
      headers: { authorization: 'Bearer or_pat_nope' },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('refuses a resource route without the resource id in its path', () => {
    const { routes } = testApp();
    expect(() =>
      routes.resource('GET', '/api/things', { resource: 'base', action: 'base:read' }, (c) =>
        c.text('x')
      )
    ).toThrow(/no :baseId parameter/);
  });

  it('refuses registering the same route twice', () => {
    const { routes } = testApp();
    expect(() => routes.public('GET', '/health', (c) => c.text('again'))).toThrow(
      /registered twice/
    );
  });

  it('answers 401 on resource routes without a session, before touching the database', async () => {
    const { app, routes } = testApp();
    for (const e of routes.entries.filter((r) => r.access.kind !== 'public')) {
      const path = e.path.replace(/:\w+/g, '00000000-0000-7000-8000-000000000000');
      const res = await app.request(path, {
        method: e.method,
        headers: { origin: 'http://localhost:5173' },
      });
      expect(res.status, `${e.method} ${e.path}`).toBe(401);
    }
  });
});
