import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createDb } from '../../src/db/index.js';
import { buildChecks, postgresCheck, redisCheck } from '../../src/health.js';
import { relayLag } from '../../src/jobs/relay.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { REDIS_IMAGE } from '../helpers/images.js';

describe('GET /ready against real dependencies', () => {
  const t = useTestDb();

  it('is ready when Postgres answers', async () => {
    const db = createDb(t.url);
    try {
      const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: t.url });
      const { app } = testApp({
        checks: buildChecks(config, db.pool),
        readyDetails: async () => ({ outboxRelay: await relayLag(db.db) }),
      });
      const res = await app.request('/ready');
      expect(res.status).toBe(200);
      // The relay's lag rides along as details.
      expect(await res.json()).toEqual({
        status: 'ok',
        checks: { database: { status: 'ok', durationMs: expect.any(Number) } },
        details: {
          outboxRelay: {
            pending: expect.any(Number),
            cursorAgeSeconds: expect.any(Number),
            oldestPendingAgeSeconds: expect.any(Number),
          },
        },
      });
    } finally {
      await db.close();
    }
  });

  it('reports the database as down with 503 problem+json', async () => {
    // Nothing listens on port 1, so every connection is refused.
    const down = createDb('postgresql://openrows:x@127.0.0.1:1/openrows');
    down.pool.on('error', () => {});
    try {
      const { app } = testApp({ checks: [postgresCheck(down.pool)] });
      const res = await app.request('/ready');
      expect(res.status).toBe(503);
      expect(res.headers.get('content-type')).toBe('application/problem+json');
      expect(await res.json()).toMatchObject({
        code: 'NOT_READY',
        requestId: res.headers.get('x-request-id'),
        checks: { database: { status: 'error', error: 'failed' } },
      });
    } finally {
      await down.close();
    }
  });

  describe('with Redis configured', () => {
    let redis: StartedTestContainer;
    let redisUrl: string;

    beforeAll(async () => {
      redis = await new GenericContainer(REDIS_IMAGE)
        .withCommand(['redis-server', '--requirepass', 'test-pass'])
        .withExposedPorts(6379)
        .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
        .start();
      redisUrl = `redis://:test-pass@${redis.getHost()}:${redis.getMappedPort(6379)}`;
    });

    afterAll(async () => {
      await redis?.stop();
    });

    it('reports database and Redis separately', async () => {
      const db = createDb(t.url);
      try {
        const config = loadConfig({ NODE_ENV: 'test', REDIS_URL: redisUrl });
        const { app } = testApp({ checks: buildChecks(config, db.pool) });
        const res = await app.request('/ready');
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({
          checks: { database: { status: 'ok' }, redis: { status: 'ok' } },
        });
      } finally {
        await db.close();
      }
    });

    it('fails the Redis check with a wrong password', async () => {
      const wrong = redisUrl.replace('test-pass', 'wrong');
      const { app } = testApp({ checks: [redisCheck(wrong)] });
      const res = await app.request('/ready');
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ checks: { redis: { status: 'error' } } });
    });
  });
});
