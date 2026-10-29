import { createServer, type Server } from 'node:http';
import type { Logger } from '../lib/logger.js';

export interface WorkerProbe {
  healthy(): Promise<boolean>;
  metrics(): Promise<string>;
}

/**
 * The worker's internal HTTP endpoints, for the Compose healthcheck and Prometheus:
 * `GET /health` (200 when pg-boss runs and Postgres answers, else 503) and `GET /metrics`
 * (queue depth, failures, relay lag). Nothing else; no tenant data. Never publish the port.
 */
export function startWorkerHttp(
  probe: () => WorkerProbe | undefined,
  opts: { port: number; host: string; logger: Pick<Logger, 'warn'> }
): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://worker');
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain', '');
    const current = probe();
    if (url.pathname === '/health') {
      void (current?.healthy() ?? Promise.resolve(false)).then((ok) =>
        send(ok ? 200 : 503, 'application/json', JSON.stringify({ status: ok ? 'ok' : 'error' }))
      );
      return;
    }
    if (url.pathname === '/metrics') {
      if (!current) return send(503, 'text/plain', '');
      void current.metrics().then(
        (body) => send(200, 'text/plain; version=0.0.4', body),
        (err: unknown) => {
          opts.logger.warn({ err }, 'worker metrics failed');
          send(503, 'text/plain', '');
        }
      );
      return;
    }
    send(404, 'text/plain', '');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      const address = server.address();
      resolve({
        server,
        port: typeof address === 'object' && address ? address.port : opts.port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
