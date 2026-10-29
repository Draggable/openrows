import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, inject } from 'vitest';
import { createDb, type Database } from '../../src/db/index.js';
import { APP_ROLE } from '../../src/db/migrate.js';

/** The migrated database each test file clones (built once per run by global-setup.ts). */
export const TEMPLATE_DATABASE = 'openrows_template';
/** The schema owner that runs migrations (non-superuser, BYPASSRLS), as in production. */
export const OWNER_ROLE = 'openrows_owner';
export const OWNER_PASSWORD = 'openrows_owner_test';
/** Password migrations give openrows_app, the role the server connects as. */
export const APP_PASSWORD = 'openrows_app_test';

/** `url` pointed at another database and, optionally, another role. */
export function withDatabase(
  url: string,
  database: string,
  as?: { user: string; password: string }
): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (as) {
    u.username = as.user;
    u.password = as.password;
  }
  return u.toString();
}

async function admin(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: inject('pgAdminUrl') });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/** Creates a new database, empty or cloned from the migrated template, and returns its URL. */
export async function createDatabase(opts: { template?: boolean } = {}): Promise<{
  /** As the superuser, which bypasses RLS. */
  url: string;
  /** As openrows_app, which RLS applies to. */
  appUrl: string;
  drop: () => Promise<void>;
}> {
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  // As in production, the schema owner owns the database: the DDL manager creates schemas.
  const template =
    opts.template === false ? '' : ` TEMPLATE "${TEMPLATE_DATABASE}" OWNER ${OWNER_ROLE}`;
  await admin(`CREATE DATABASE "${name}"${template}`);
  return {
    url: withDatabase(inject('pgAdminUrl'), name),
    appUrl: withDatabase(inject('pgAdminUrl'), name, { user: APP_ROLE, password: APP_PASSWORD }),
    drop: () => admin(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
  };
}

export interface TestDb {
  /** Superuser connection for fixtures and assertions: sees every tenant's rows. */
  readonly db: Database;
  readonly url: string;
  /** openrows_app connection, as the server uses in production: RLS applies. */
  readonly appDb: Database;
  readonly appUrl: string;
}

/**
 * Gives the current test file its own migrated database (cloned from the template in
 * beforeAll, dropped in afterAll). Use `t.db` for fixtures and `t.appDb` for the app under test,
 * inside tests and hooks.
 */
export function useTestDb(): TestDb {
  let state: {
    db: Database;
    url: string;
    appDb: Database;
    appUrl: string;
    close: () => Promise<void>;
    drop: () => Promise<void>;
  };

  beforeAll(async () => {
    const { url, appUrl, drop } = await createDatabase();
    const owner = createDb(url);
    const app = createDb(appUrl);
    state = {
      db: owner.db,
      url,
      appDb: app.db,
      appUrl,
      close: async () => {
        await Promise.all([owner.close(), app.close()]);
      },
      drop,
    };
  });

  afterAll(async () => {
    await state?.close();
    await state?.drop();
  });

  const ready = () => {
    if (!state)
      throw new Error('useTestDb(): the database is only available inside tests and hooks');
    return state;
  };
  return {
    get db() {
      return ready().db;
    },
    get url() {
      return ready().url;
    },
    get appDb() {
      return ready().appDb;
    },
    get appUrl() {
      return ready().appUrl;
    },
  };
}
