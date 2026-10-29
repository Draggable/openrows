import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpMetrics, processMetrics, startMetricsHttp } from './metrics.js';

function appWith(metrics: HttpMetrics) {
  const app = new Hono();
  app.use('*', metrics.middleware());
  app.get('/ok', (c) => c.text('ok'));
  app.get('/health', (c) => c.text('ok'));
  app.get('/ready', (c) => c.text('down', 503));
  app.get('/boom', () => {
    throw new Error('boom');
  });
  app.onError((_err, c) => c.text('error', 500));
  return app;
}

describe('HttpMetrics', () => {
  it('counts requests by method and status, thrown errors as 500, probes not at all', async () => {
    const metrics = new HttpMetrics();
    const app = appWith(metrics);
    await app.request('/ok');
    await app.request('/ok');
    await app.request('/missing', { method: 'POST' });
    await app.request('/boom');
    await app.request('/health');
    await app.request('/ready');
    await app.request('/ok', { method: 'PROPFIND' });
    const text = metrics.render();
    expect(text).toContain('openrows_http_requests_total{method="GET",code="200"} 2');
    expect(text).toContain('openrows_http_requests_total{method="POST",code="404"} 1');
    expect(text).toContain('openrows_http_requests_total{method="GET",code="500"} 1');
    expect(text).toContain('openrows_http_requests_total{method="OTHER",code="404"} 1');
    expect(text).not.toContain('code="503"');
    expect(text).toContain('openrows_http_request_duration_seconds_count 5');
    expect(text).toContain('openrows_http_request_duration_seconds_bucket{le="+Inf"} 5');
    expect(text).toContain('# TYPE openrows_http_requests_total counter');
  });

  it('fills the histogram buckets cumulatively', () => {
    const metrics = new HttpMetrics();
    metrics.observe('GET', 200, 0.01);
    metrics.observe('GET', 200, 0.3);
    metrics.observe('GET', 200, 20);
    const text = metrics.render();
    expect(text).toContain('openrows_http_request_duration_seconds_bucket{le="0.025"} 1');
    expect(text).toContain('openrows_http_request_duration_seconds_bucket{le="0.5"} 2');
    expect(text).toContain('openrows_http_request_duration_seconds_bucket{le="10"} 2');
    expect(text).toContain('openrows_http_request_duration_seconds_bucket{le="+Inf"} 3');
    expect(text).toMatch(/openrows_http_request_duration_seconds_sum 20\.31/);
  });

  it('never labels by path', async () => {
    const metrics = new HttpMetrics();
    await appWith(metrics).request('/s/secret-share-token');
    expect(metrics.render()).not.toContain('secret');
  });
});

describe('startMetricsHttp', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('serves GET /metrics only', async () => {
    const warnings: unknown[] = [];
    const started = await startMetricsHttp(() => `x 1\n${processMetrics()}`, {
      port: 0,
      host: '127.0.0.1',
      logger: { warn: (o: unknown) => warnings.push(o) },
    });
    close = started.close;
    const base = `http://127.0.0.1:${started.port}`;
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain('x 1');
    expect(body).toMatch(/process_resident_memory_bytes \d+/);
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/metrics`, { method: 'POST' })).status).toBe(405);
  });

  it('answers 503 when rendering fails', async () => {
    const warnings: unknown[] = [];
    const started = await startMetricsHttp(
      () => {
        throw new Error('nope');
      },
      { port: 0, host: '127.0.0.1', logger: { warn: (o: unknown) => warnings.push(o) } }
    );
    close = started.close;
    expect((await fetch(`http://127.0.0.1:${started.port}/metrics`)).status).toBe(503);
    expect(warnings).toHaveLength(1);
  });
});
