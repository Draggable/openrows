/**
 * One-shot migration entrypoint: `node dist/migrate.js` (the `migrate` Compose service) or
 * `npm run db:migrate` in development. Connects as the schema owner (MIGRATION_DATABASE_URL, or
 * DATABASE_URL), sets the openrows_app password from OPENROWS_APP_DB_PASSWORD, and exits non-zero
 * on failure. See docs/deploy/database.md.
 */
import { migrationSettings } from './db/index.js';
import { runMigrations } from './db/migrate.js';

try {
  const { url, appPassword } = migrationSettings();
  await runMigrations(url, { appPassword });
  console.log('Migrations applied');
} catch (err) {
  console.error('Migration failed:', err);
  process.exitCode = 1;
}
