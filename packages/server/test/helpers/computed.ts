import { isNotNull } from 'drizzle-orm';
import { type Database, fields } from '../../src/db/index.js';
import { COMPUTED_QUEUE, computedSubscriber, runComputedRefresh } from '../../src/jobs/computed.js';
import { relayOutbox } from '../../src/jobs/relay.js';
import { createLogger } from '../../src/lib/logger.js';

const logger = createLogger({ level: 'silent' });

/**
 * The worker's background recomputes, drained: relays outbox events to `computed.refresh`
 * (moving the relay's cursor, as the worker would) and runs those jobs until no field is flagged
 * any more. The relay only reads transactions older than every running one in the cluster (other
 * test files' too), so it polls until the flagged fields' events come through. `db` is
 * openrows_app (the worker's role), `owner` reads the flags across workspaces.
 */
export async function drainComputed(db: Database, owner: Database): Promise<number> {
  let ran = 0;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const jobs: unknown[] = [];
    const relayed = await relayOutbox(
      db,
      async (queue, inserted) => {
        if (queue === COMPUTED_QUEUE) jobs.push(...inserted.map((j) => j.data));
      },
      [computedSubscriber]
    );
    for (const data of jobs) await runComputedRefresh({ db, logger }, data);
    ran += jobs.length;
    if (jobs.length || relayed.events) continue;
    const flagged = await owner
      .select({ id: fields.id })
      .from(fields)
      .where(isNotNull(fields.recomputeRequestedAt))
      .limit(1);
    if (!flagged.length) return ran;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('drainComputed: fields still flagged after 60 s');
}
