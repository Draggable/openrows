/**
 * Runs a recurring job now: `node dist/jobs/run-cli.js <queue>` queues one run of a cron
 * job (say `notifications.digest.daily`) for the worker, as its schedule would. For operators and
 * the stack's e2e specs. Connects as openrows_app (DATABASE_URL, the dev default otherwise), so it
 * needs the database's credentials: no new surface. Prints the job id (or null when a run is
 * already queued: the queues are `stately`).
 */
import { DEV_DEFAULTS } from '../config.js';
import { createDb } from '../db/index.js';
import { JOB_QUEUES } from './queues.js';
import { createJobs } from './send.js';

const recurring = Object.entries(JOB_QUEUES)
  .filter(([, spec]) => 'cron' in spec)
  .map(([name]) => name);
const queue = process.argv[2] ?? '';
if (!recurring.includes(queue)) {
  console.error(`Usage: run-cli <queue>, one of:\n  ${recurring.join('\n  ')}`);
  process.exit(2);
}

const { db, close } = createDb(process.env['DATABASE_URL'] ?? DEV_DEFAULTS.DATABASE_URL);
const jobs = createJobs(db);
try {
  const id = await db.transaction((tx) => jobs.send(tx, queue, null));
  console.log(JSON.stringify({ queue, jobId: id }));
} catch (err) {
  console.error('Could not queue the job:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await jobs.stop();
  await close();
}
