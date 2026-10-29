import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { installJobSchema } from '../jobs/install.js';

/** packages/server/drizzle, from both src/db (tsx) and dist/db (node). */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

// Any constant works; it only has to be the same for every OpenRows migrate run.
const MIGRATION_LOCK_ID = 7_250_001;

/** The role the server connects as (created by drizzle/0003_rls.sql, ADR-002). */
export const APP_ROLE = 'openrows_app';

/**
 * Applies pending migrations from MIGRATIONS_FOLDER as the schema owner, installs or migrates
 * pg-boss's `pgboss` schema (ADR-004), then, with `appPassword`, lets APP_ROLE log in
 * with it. Safe to run concurrently (a session advisory lock
 * serializes runs) and idempotent (applied migrations are skipped).
 */
export async function runMigrations(
  connectionString: string,
  opts: { appPassword?: string | undefined } = {}
): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
    await installJobSchema(client, APP_ROLE);
    if (opts.appPassword) {
      // ALTER ROLE takes no bind parameters; escapeLiteral quotes the password safely.
      await client.query(
        `ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD ${client.escapeLiteral(opts.appPassword)}`
      );
    }
  } finally {
    await client.end();
  }
}
