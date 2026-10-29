import { sql } from 'drizzle-orm';
import { fromDrizzle, PgBoss, type SendOptions } from 'pg-boss';
import type { Database, Transaction } from '../db/index.js';
import { API_QUEUES, ensureQueues, JOB_QUEUES, JOBS_SCHEMA } from './queues.js';

/**
 * How the API starts jobs (ADR-004): `send` writes the job in the caller's transaction, so
 * a rolled-back request leaves no job behind and a committed one always has it. The worker runs
 * it. Behind this interface the queue could move to another backend (ADR-004).
 */
export interface Jobs {
  /**
   * The job's id, or null when an identical job (same id or singleton) already exists. Tenant
   * jobs carry their workspace; `null` runs a maintenance job that isn't about one.
   */
  send(
    tx: Transaction,
    queue: string,
    data: ({ workspaceId: string } & Record<string, unknown>) | null,
    options?: Omit<SendOptions, 'db'>
  ): Promise<string | null>;
  stop(): Promise<void>;
}

/**
 * Jobs over pg-boss on the API's database. pg-boss starts on the first `send` (it only reads the
 * schema then: no maintenance, cron or workers in the API process) and never opens a
 * connection of its own.
 */
export function createJobs(db: Database): Jobs {
  let boss: PgBoss | undefined;
  let starting: Promise<PgBoss> | undefined;
  const started = () => {
    starting ??= (async () => {
      const instance = new PgBoss({
        db: fromDrizzle(db, sql),
        schema: JOBS_SCHEMA,
        migrate: false,
        supervise: false,
        schedule: false,
        registerInstance: false,
      });
      instance.on('error', () => {});
      await instance.start();
      // The queues the API sends to, in case no worker has created them yet (a send to a
      // missing queue fails). A worker starting at the same moment may win the race: fine.
      const specs = Object.fromEntries(API_QUEUES.map((name) => [name, JOB_QUEUES[name]]));
      await ensureQueues(instance, specs).catch(() => ensureQueues(instance, specs));
      boss = instance;
      return instance;
    })().catch((err: unknown) => {
      starting = undefined;
      throw err;
    });
    return starting;
  };
  return {
    async send(tx, queue, data, options = {}) {
      const instance = await started();
      return instance.send(queue, data, { ...options, db: fromDrizzle(tx, sql) });
    },
    async stop() {
      await starting?.catch(() => {});
      await boss?.stop({ graceful: false, close: false });
    },
  };
}
