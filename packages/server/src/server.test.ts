import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp } from '../test/helpers/app.js';
import { type StartedServer, startServer } from './server.js';

// Exercises the real Node HTTP adapter (@hono/node-server), not just app.request().
describe('startServer', () => {
  let started: StartedServer;

  beforeAll(async () => {
    started = await startServer(testApp().app, 0);
  });

  afterAll(async () => {
    await started.close();
  });

  it('listens on an ephemeral port', () => {
    expect(started.port).toBeGreaterThan(0);
  });

  it('answers /health over HTTP', async () => {
    const res = await fetch(`http://127.0.0.1:${started.port}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toMatchObject({ status: 'ok' });
  });

  it('returns problem+json 404 for unknown routes', async () => {
    const res = await fetch(`http://127.0.0.1:${started.port}/api/nope`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(await res.json()).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});
