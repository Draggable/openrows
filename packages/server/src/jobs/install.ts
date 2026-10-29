import type pg from 'pg';
import { PgBoss } from 'pg-boss';
import { JOBS_SCHEMA } from './queues.js';

/**
 * Installs or migrates pg-boss's schema (ADR-004) on the migrate one-shot's connection, as the
 * schema owner, then gives `appRole` what pg-boss needs at run time: rows, not DDL. Idempotent;
 * called by runMigrations after the Drizzle migrations, under its advisory lock.
 */
export async function installJobSchema(client: pg.Client, appRole: string): Promise<void> {
  const boss = new PgBoss({
    db: { executeSql: (text, values) => client.query(text, values) },
    schema: JOBS_SCHEMA,
    migrate: true,
    supervise: false,
    schedule: false,
    registerInstance: false,
  });
  boss.on('error', () => {});
  await boss.start();
  await boss.stop({ graceful: false, close: false });
  // The schema name and role are constants, never input.
  await client.query(`
    GRANT USAGE ON SCHEMA ${JOBS_SCHEMA} TO ${appRole};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${JOBS_SCHEMA} TO ${appRole};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${JOBS_SCHEMA} TO ${appRole};
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${JOBS_SCHEMA} TO ${appRole};
  `);
}
