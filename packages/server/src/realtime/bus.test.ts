import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../db/index.js';
import { createLogger } from '../lib/logger.js';
import {
  createEventBus,
  PostgresEventBus,
  type PresenceBusMessage,
  presenceFrames,
  RedisEventBus,
} from './bus.js';

const logger = createLogger({ level: 'silent' });
const { db, close } = createDb('postgresql://nobody:nothing@127.0.0.1:1/none');

afterAll(() => close());

describe('createEventBus', () => {
  it('picks the implementation from EVENT_BUS', async () => {
    const deps = { db, databaseUrl: 'postgresql://127.0.0.1:1/none', logger };
    expect(createEventBus('postgres', deps)).toBeInstanceOf(PostgresEventBus);
    const redis = createEventBus('redis', deps);
    expect(redis).toBeInstanceOf(RedisEventBus);
    // The hosted bus is M5: selecting it must fail loudly, not run without fan-out.
    await expect(redis.start()).rejects.toThrow(/not implemented/);
  });

  it('starts without a database and keeps retrying in the background', async () => {
    const bus = new PostgresEventBus(db, {
      connectionString: 'postgresql://nobody:nothing@127.0.0.1:1/none',
      logger,
    });
    await bus.start();
    expect(bus.position('anything')).toBeUndefined();
    await bus.close();
  });
});

describe('presenceFrames', () => {
  const ID = '0190a000-0000-7000-8000-000000000001';
  const upsert = (i: number): PresenceBusMessage => ({
    op: 'upsert',
    workspaceId: ID,
    viewId: ID,
    peer: {
      connectionId: `0190a000-0000-7000-8000-${String(i).padStart(12, '0')}`,
      userId: ID,
      name: 'N'.repeat(80),
      initials: 'NN',
      color: 'blue',
      state: { recordId: ID, fieldId: ID, editing: false, expandedRecordId: ID },
    },
  });

  it('splits a batch into NOTIFY payloads under 8000 bytes, keeping every change in order', () => {
    const messages = Array.from({ length: 120 }, (_, i) => upsert(i));
    const frames = presenceFrames(ID, messages);
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) expect(Buffer.byteLength(frame)).toBeLessThan(8000);
    const back = frames.flatMap((f) => (JSON.parse(f) as { messages: unknown[] }).messages);
    expect(back).toEqual(messages);
    expect(presenceFrames(ID, [])).toEqual([]);
  });
});
