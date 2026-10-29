import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/index.js';
import { useTestDb } from '../helpers/db.js';

describe('createDb', () => {
  const t = useTestDb();

  it('close() resolves only once every connection has ended', async () => {
    // pg-pool's end() resolves before its clients' sockets close; a DROP DATABASE WITH (FORCE)
    // right after then kills them mid-shutdown and the process crashes with 57P01.
    const { db, pool, close } = createDb(t.appUrl);
    let connected = 0;
    let ended = 0;
    pool.on('connect', () => connected++);
    pool.on('remove', () => ended++);
    await Promise.all(Array.from({ length: 5 }, () => db.execute(sql`SELECT pg_sleep(0.05)`)));
    await close();
    expect(connected).toBe(5);
    expect(ended).toBe(connected);
  });
});
