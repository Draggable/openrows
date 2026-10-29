/**
 * Demo data: `node dist/seed/cli.js --email <address>` (or `npm run db:seed -- --email
 * <address>` in development) gives that user the "Product Roadmap (demo)" workspace: 5 tables,
 * 31 fields, 2,000 records. The user must have signed in once. Connects as openrows_app
 * (DATABASE_URL, the dev default otherwise), so RLS applies as in the app. Idempotent per user.
 */
import { parseArgs } from 'node:util';
import { DEV_DEFAULTS } from '../config.js';
import { createDb } from '../db/index.js';
import { findUserByEmail, seedDemo } from './index.js';

const { values } = parseArgs({ options: { email: { type: 'string' } } });
const email = values.email ?? process.env['SEED_EMAIL'];
if (!email) {
  console.error('Usage: seed --email <address of a user who has signed in once>');
  process.exit(2);
}

const { db, close } = createDb(process.env['DATABASE_URL'] ?? DEV_DEFAULTS.DATABASE_URL);
try {
  const user = await findUserByEmail(db, email);
  if (!user) throw new Error(`No user with the email ${email}: sign in once, then seed.`);
  const started = Date.now();
  const result = await seedDemo(db, { userId: user.id });
  console.log(
    JSON.stringify({
      msg: result.created ? 'Demo workspace created' : 'Demo workspace already exists',
      ms: Date.now() - started,
      ...result,
    })
  );
} catch (err) {
  console.error('Seed failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await close();
}
