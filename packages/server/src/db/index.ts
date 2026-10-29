import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { DEV_DEFAULTS, isInsecureSecret } from '../config.js';
import * as schema from './schema.js';

export * from './schema.js';

export type Database = NodePgDatabase<typeof schema>;
/** The `tx` handed to `db.transaction(async (tx) => ...)`. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface MigrationSettings {
  /** The schema owner's connection: a superuser or a role with BYPASSRLS. */
  url: string;
  /** When set, migrations end by giving `openrows_app` LOGIN with this password. */
  appPassword: string | undefined;
}

/**
 * Settings for the migrate one-shot, which doesn't load the full config. It connects with
 * MIGRATION_DATABASE_URL (falling back to DATABASE_URL) and sets the `openrows_app` password from
 * OPENROWS_APP_DB_PASSWORD. With neither URL set it uses the dev database and the dev password,
 * outside production only.
 */
export function migrationSettings(
  env: Record<string, string | undefined> = process.env
): MigrationSettings {
  const get = (key: string) => (env[key]?.trim() ? env[key] : undefined);
  const prod = env['NODE_ENV'] === 'production';
  const url = get('MIGRATION_DATABASE_URL') ?? get('DATABASE_URL');
  const appPassword = get('OPENROWS_APP_DB_PASSWORD');
  if (prod && appPassword && isInsecureSecret(appPassword)) {
    throw new Error('OPENROWS_APP_DB_PASSWORD: a default or placeholder value is not allowed');
  }
  if (url) return { url, appPassword };
  if (prod) throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL is required in production');
  return {
    url: DEV_DEFAULTS.MIGRATION_DATABASE_URL,
    appPassword: appPassword ?? DEV_DEFAULTS.APP_DB_PASSWORD,
  };
}

/**
 * Whether the connected role bypasses row-level security (a superuser or BYPASSRLS). The server
 * must not: RLS is its second line of tenant isolation (ADR-002).
 */
export async function bypassesRls(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query<{ bypass: boolean }>(
    'SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user'
  );
  return rows[0]?.bypass ?? false;
}

/** Creates a pooled Drizzle client. Call `close()` on shutdown. */
export function createDb(connectionString: string) {
  const pool = new Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  const db: Database = drizzle(pool, { schema });
  return { db, pool, close: () => endPool(pool) };
}

/**
 * `pool.end()`, resolving only once every client's connection has closed: pg-pool resolves as
 * soon as it has asked them to end, so a backend terminated right after (DROP DATABASE WITH
 * (FORCE), a Postgres shutdown) could still send a FATAL to a client nothing listens to.
 */
async function endPool(pool: Pool): Promise<void> {
  let open = pool.totalCount;
  const closed = new Promise<void>((resolve) => {
    if (open === 0) resolve();
    pool.on('remove', () => {
      if (--open === 0) resolve();
    });
  });
  await pool.end();
  await closed;
}
