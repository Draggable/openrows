import { once } from 'node:events';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { testApp } from '../test/helpers/app.js';
import { loadConfig } from './config.js';
import { buildChecks, type DependencyCheck, redisCheck, runChecks, s3Check } from './health.js';

const ok: DependencyCheck = { name: 'ok', check: async () => {} };
const failing: DependencyCheck = {
  name: 'failing',
  check: async () => {
    throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
  },
};
const hanging: DependencyCheck = { name: 'hanging', check: () => new Promise(() => {}) };

describe('runChecks', () => {
  it('reports per-dependency status, timing out slow checks', async () => {
    const result = await runChecks([ok, failing, hanging], { timeoutMs: 50 });
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual({
      ok: { status: 'ok', durationMs: expect.any(Number) },
      failing: { status: 'error', durationMs: expect.any(Number), error: 'failed' },
      hanging: { status: 'error', durationMs: expect.any(Number), error: 'timeout' },
    });
  });

  it('is ok with all checks passing', async () => {
    expect((await runChecks([ok])).ok).toBe(true);
  });
});

describe('GET /ready', () => {
  it('returns 200 with each check when all pass', async () => {
    const { app } = testApp({ checks: [{ ...ok, name: 'database' }] });
    const res = await app.request('/ready');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'ok',
      checks: { database: { status: 'ok', durationMs: expect.any(Number) } },
    });
  });

  it('returns 503 problem+json naming the failed dependency, without leaking the error', async () => {
    const { app, logs } = testApp({ checks: [{ ...ok, name: 'database' }, failing] });
    const res = await app.request('/ready');
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = await res.json();
    expect(body).toMatchObject({
      code: 'NOT_READY',
      status: 503,
      requestId: res.headers.get('x-request-id'),
      checks: { database: { status: 'ok' }, failing: { status: 'error', error: 'failed' } },
    });
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
    expect(logs.find((l) => l['msg'] === 'readiness check failed')).toMatchObject({
      dependency: 'failing',
    });
  });
});

describe('buildChecks', () => {
  const pool = { query: async () => ({}) } as never;

  it('checks only the database by default', () => {
    expect(buildChecks(loadConfig({}), pool).map((c) => c.name)).toEqual(['database']);
  });

  it('adds S3 and Redis when configured', () => {
    const config = loadConfig({
      S3_ENDPOINT: 'http://localhost:9000',
      S3_BUCKET: 'b',
      S3_ACCESS_KEY: 'a',
      S3_SECRET_KEY: 's',
      REDIS_URL: 'redis://localhost:6379',
    });
    expect(buildChecks(config, pool).map((c) => c.name)).toEqual(['database', 's3', 'redis']);
  });
});

describe('redisCheck', () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  /** A fake Redis that answers each RESP command with the next canned reply. */
  async function fakeRedis(replies: string[]): Promise<{ port: number; received: string[] }> {
    const received: string[] = [];
    server = createServer((socket: Socket) => {
      socket.on('data', (data) => {
        received.push(String(data));
        socket.write(replies.map((r) => `${r}\r\n`).join(''));
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    return { port: address.port, received };
  }

  const run = (check: DependencyCheck) => check.check(AbortSignal.timeout(1000));

  it('PINGs without credentials', async () => {
    const { port, received } = await fakeRedis(['+PONG']);
    await run(redisCheck(`redis://127.0.0.1:${port}`));
    expect(received.join('')).toBe('*1\r\n$4\r\nPING\r\n');
  });

  it('AUTHs first when the URL has a password', async () => {
    const { port, received } = await fakeRedis(['+OK', '+PONG']);
    await run(redisCheck(`redis://default:p%40ss@127.0.0.1:${port}`));
    expect(received.join('')).toContain('$4\r\nAUTH\r\n$7\r\ndefault\r\n$4\r\np@ss\r\n');
  });

  it('fails on an error reply or refused connection', async () => {
    const { port } = await fakeRedis(['-NOAUTH Authentication required.']);
    await expect(run(redisCheck(`redis://127.0.0.1:${port}`))).rejects.toThrow(/NOAUTH/);
    await expect(run(redisCheck('redis://127.0.0.1:1'))).rejects.toThrow();
  });
});

describe('s3Check', () => {
  let server: HttpServer | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  async function fakeS3(status: number) {
    const seen: { method?: string; url?: string; authorization?: string } = {};
    server = createHttpServer((req, res) => {
      Object.assign(seen, {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
      });
      res.writeHead(status).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const check = s3Check({
      endpoint: `http://127.0.0.1:${address.port}/`,
      region: 'us-east-1',
      bucket: 'openrows',
      accessKey: 'AKIDEXAMPLE',
      secretKey: 'test-secret',
      publicUrl: undefined,
    });
    return { seen, check };
  }

  it('sends a SigV4-signed HeadBucket (path style)', async () => {
    const { seen, check } = await fakeS3(200);
    await check.check(AbortSignal.timeout(1000));
    expect(seen.method).toBe('HEAD');
    expect(seen.url).toBe('/openrows');
    expect(seen.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request/
    );
  });

  it('fails when the bucket is missing or the keys are wrong', async () => {
    const { check } = await fakeS3(403);
    await expect(check.check(AbortSignal.timeout(1000))).rejects.toThrow(/403/);
  });
});
