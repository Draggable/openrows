import { sql } from 'drizzle-orm';
import type { Database } from '../../src/db/index.js';
import { type JobInserter, type OutboxSubscriber, relayOutbox } from '../../src/jobs/relay.js';

export interface RelayAllOptions {
  /** Receives the subscribers' jobs (default: none are sent anywhere). */
  insert?: JobInserter;
  subscribers?: readonly OutboxSubscriber[];
  timeoutMs?: number;
}

/**
 * Relays every outbox row written so far, the way a running worker would: to `subscribers`
 * through `insert` (none by default: it only moves the cursor). The prune keeps unrelayed rows
 * , so tests that age and prune events relay first. The relay's horizon is cluster-wide: a
 * transaction open in another test file's database holds it back for a moment, so this waits
 * until nothing is pending, rather than relaying once and missing the events still held back.
 */
export async function relayAll(db: Database, opts: RelayAllOptions = {}): Promise<void> {
  const { insert = async () => {}, subscribers = [], timeoutMs = 20_000 } = opts;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await relayOutbox(db, insert, subscribers);
    const { rows } = await db.execute<{ pending: string }>(
      sql`SELECT pending FROM outbox_relay_lag()`
    );
    if (Number(rows[0]?.pending ?? 0) === 0) return;
    if (Date.now() > deadline) throw new Error('relayAll: timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}
