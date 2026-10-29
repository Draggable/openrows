import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../../src/db/migrate.js';
import {
  APP_PASSWORD,
  OWNER_PASSWORD,
  OWNER_ROLE,
  TEMPLATE_DATABASE,
  withDatabase,
} from '../helpers/db.js';
import { ensureImages, POSTGRES_IMAGE, TEST_IMAGES } from '../helpers/images.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Connection URL of the container's admin database (not migrated). */
    pgAdminUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

/**
 * Pulls the suite's images, starts Postgres 16 once per run and builds the migrated template
 * database. Migrations run as a non-superuser owner with BYPASSRLS, as documented for production
 * (docs/deploy/database.md), and give openrows_app its password.
 */
export async function setup(project: TestProject) {
  try {
    await start(project);
  } catch (err) {
    await container?.stop().catch(() => {});
    // Vitest prints "No test files found" before this error, which is the real cause.
    throw setupError(err);
  }
}

/**
 * An error Vitest can print. Vitest 5 crashes ("code.charCodeAt is not a function") while
 * source-mapping the stack of an error created in a global setup module, and then shows only
 * that crash. A stack set as a plain string is never source-mapped, and Vitest prints the message.
 */
function setupError(err: unknown): Error {
  const message = `Integration global setup failed: ${err instanceof Error ? err.message : String(err)}`;
  const wrapped = new Error(message);
  wrapped.stack = `Error: ${message}`;
  return wrapped;
}

async function start(project: TestProject) {
  await ensureImages(TEST_IMAGES);
  container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('postgres')
    // Test data is throwaway; durability only slows the tests down.
    .withCommand(['postgres', '-c', 'fsync=off', '-c', 'full_page_writes=off'])
    .start();
  const adminUrl = container.getConnectionUri();

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(
      `CREATE ROLE ${OWNER_ROLE} LOGIN NOSUPERUSER CREATEROLE BYPASSRLS PASSWORD '${OWNER_PASSWORD}'`
    );
    await admin.query(`CREATE DATABASE "${TEMPLATE_DATABASE}" OWNER ${OWNER_ROLE}`);
  } finally {
    await admin.end();
  }
  // runMigrations closes its connection, so nothing holds the template open for cloning.
  await runMigrations(
    withDatabase(adminUrl, TEMPLATE_DATABASE, { user: OWNER_ROLE, password: OWNER_PASSWORD }),
    { appPassword: APP_PASSWORD }
  );

  project.provide('pgAdminUrl', adminUrl);
}

export async function teardown() {
  await container?.stop();
}
