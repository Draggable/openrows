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

/** How long `close()` of a pinned connection waits for its advisory locks to be let go. */
const UNLOCK_WAIT_MS = 5_000;

/**
 * One connection of `db`'s pool, as a Database of its own, for work that spans several
 * transactions on one session (a session-level advisory lock, a temporary table): its
 * transactions run on that connection, one after another. `close()` lets go of the session's
 * advisory locks, then ends the connection instead of returning it to the pool, so nothing of the
 * session reaches the pool's next user; a process that dies with it open leaves Postgres to drop
 * it all.
 */
export async function pinConnection(
  db: Database
): Promise<{ db: Database; close: () => Promise<void> }> {
  const pool = (db as Database & { $client?: unknown }).$client;
  if (!(pool instanceof Pool)) throw new Error('pinConnection needs a pooled database');
  const client = await pool.connect();
  // Lost while idle (between statements), the connection's next query fails instead: the pool's
  // own listener isn't on a checked-out client, and an unheard 'error' would end the process.
  client.on('error', () => {});
  return {
    db: drizzle(client, { schema }) as unknown as Database,
    close: async () => {
      // Ending the connection isn't awaited: its locks are let go first, so whoever waits for
      // them (a retry) needn't wait for the connection to close. A lost connection has none.
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        client.query('SELECT pg_advisory_unlock_all()').catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, UNLOCK_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
      client.release(true);
    },
  };
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
