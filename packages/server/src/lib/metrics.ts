import { createServer, type Server } from 'node:http';
import type { MiddlewareHandler } from 'hono';
import type { Logger } from './logger.js';

/** Request durations' histogram buckets, in seconds. */
export const DURATION_BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

// Probes (the Compose healthcheck, Prometheus' blackbox) would drown the real traffic.
const PROBE_PATHS = new Set(['/health', '/ready']);

/**
 * The api's request metrics in Prometheus' text format, without a client library:
 * `openrows_http_requests_total{method,code}` and one `openrows_http_request_duration_seconds`
 * histogram. Labels are bounded (known methods, the numeric status), never a path, so nothing
 * tenant-specific reaches Prometheus. `/health` and `/ready` aren't counted.
 */
export class HttpMetrics {
  readonly #requests = new Map<string, number>();
  readonly #buckets: number[] = DURATION_BUCKETS.map(() => 0);
  #count = 0;
  #sum = 0;

  middleware(): MiddlewareHandler {
    return async (c, next) => {
      if (PROBE_PATHS.has(c.req.path)) return next();
      const start = performance.now();
      try {
        await next();
      } finally {
        this.observe(c.req.method, c.res.status, (performance.now() - start) / 1000);
      }
    };
  }

  observe(method: string, status: number, seconds: number): void {
    const key = `${METHODS.has(method) ? method : 'OTHER'} ${status}`;
    this.#requests.set(key, (this.#requests.get(key) ?? 0) + 1);
    this.#count += 1;
    this.#sum += seconds;
    DURATION_BUCKETS.forEach((le, i) => {
      if (seconds <= le) this.#buckets[i] = (this.#buckets[i] ?? 0) + 1;
    });
  }

  render(): string {
    const lines = [
      '# HELP openrows_http_requests_total HTTP requests answered, by method and status (probes excluded).',
      '# TYPE openrows_http_requests_total counter',
    ];
    for (const [key, n] of [...this.#requests].sort(([a], [b]) => a.localeCompare(b))) {
      const [method, code] = key.split(' ');
      lines.push(`openrows_http_requests_total{method="${method}",code="${code}"} ${n}`);
    }
    lines.push(
      '# HELP openrows_http_request_duration_seconds Time to answer an HTTP request (probes excluded).',
      '# TYPE openrows_http_request_duration_seconds histogram'
    );
    DURATION_BUCKETS.forEach((le, i) => {
      lines.push(`openrows_http_request_duration_seconds_bucket{le="${le}"} ${this.#buckets[i]}`);
    });
    lines.push(
      `openrows_http_request_duration_seconds_bucket{le="+Inf"} ${this.#count}`,
      `openrows_http_request_duration_seconds_sum ${this.#sum}`,
      `openrows_http_request_duration_seconds_count ${this.#count}`
    );
    return `${lines.join('\n')}\n`;
  }
}

/** Gauges every Node process reports: memory and start time. */
export function processMetrics(): string {
  const mem = process.memoryUsage();
  const started = Math.round((Date.now() - process.uptime() * 1000) / 1000);
  return [
    '# HELP process_resident_memory_bytes Resident memory size in bytes.',
    '# TYPE process_resident_memory_bytes gauge',
    `process_resident_memory_bytes ${mem.rss}`,
    '# HELP nodejs_heap_used_bytes V8 heap in use, in bytes.',
    '# TYPE nodejs_heap_used_bytes gauge',
    `nodejs_heap_used_bytes ${mem.heapUsed}`,
    '# HELP process_start_time_seconds Start time of the process since the Unix epoch.',
    '# TYPE process_start_time_seconds gauge',
    `process_start_time_seconds ${started}`,
    '',
  ].join('\n');
}

/**
 * The api's internal metrics listener: `GET /metrics` on its own port (METRICS_PORT,
 * 9464 in Compose), never published and never routed through the tunnel, like the worker's
 * (jobs/http.ts). Not an app route: it serves nothing but these counters, no tenant data.
 */
export function startMetricsHttp(
  render: () => string,
  opts: { port: number; host: string; logger: Pick<Logger, 'warn'> }
): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://api').pathname;
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain', '');
    if (path !== '/metrics') return send(404, 'text/plain', '');
    try {
      send(200, 'text/plain; version=0.0.4', render());
    } catch (err) {
      opts.logger.warn({ err }, 'api metrics failed');
      send(503, 'text/plain', '');
    }
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
