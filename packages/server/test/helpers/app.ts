import { Writable } from 'node:stream';
import { sql } from 'drizzle-orm';
import { fakeAirtable } from '../../src/airtable/__fixtures__/fake.js';
import { runAirtableImport } from '../../src/airtable/import.js';
import { createApp } from '../../src/app.js';
import type { ObjectStore } from '../../src/attachments/storage.js';
import { createCipher } from '../../src/auth/crypto.js';
import type { ScriptSandbox } from '../../src/automations/script/types.js';
import { runDuplicateJob } from '../../src/bases/duplicate.js';
import { type Config, loadConfig } from '../../src/config.js';
import { createDb, type Database } from '../../src/db/index.js';
import type { Edition } from '../../src/edition/types.js';
import { type EmailTransport, memoryTransport } from '../../src/email/transport.js';
import type { CaptchaVerifier } from '../../src/forms/turnstile.js';
import type { DependencyCheck } from '../../src/health.js';
import { runImportJob } from '../../src/import-export/import.js';
import { createLogger } from '../../src/lib/logger.js';
import type { SafeFetch } from '../../src/lib/safe-fetch/index.js';
import type { RateLimiter } from '../../src/ratelimit/limiter.js';
import type { FieldVisibility } from '../../src/realtime/projection.js';
import { runRestoreJob } from '../../src/snapshots/restore-job.js';
import type { SyncSources } from '../../src/syncs/sources/index.js';

/**
 * The API's rate limits out of the way of suites that call one base many times a second;
 * `ratelimit.test.ts` sets its own.
 */
const GENEROUS_RATE_LIMITS = {
  API_RATE_LIMIT_BASE: '100000',
  API_RATE_LIMIT_BASE_BURST: '100000',
  API_RATE_LIMIT_TOKEN: '100000',
  API_RATE_LIMIT_TOKEN_BURST: '100000',
};

/**
 * The app with test config, no readiness checks unless given, and a logger whose JSON lines are
 * collected in `logs`. Without `db` the app gets a pool for the config's DATABASE_URL that never
 * connects unless a route queries it (unit tests don't).
 */
export function testApp(
  opts: {
    config?: Partial<Config>;
    checks?: DependencyCheck[];
    env?: Record<string, string>;
    db?: Database;
    email?: EmailTransport;
    objectStore?: ObjectStore;
    visibility?: FieldVisibility;
    captcha?: CaptchaVerifier;
    rateLimiter?: RateLimiter;
    /** Airtable for the importer: the recorded-fixture fake by default, never the real one. */
    airtable?: {
      http: SafeFetch;
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
    };
    /** Run-script steps' sandbox; AUTOMATION_SCRIPTS from `env` when omitted. */
    scripts?: ScriptSandbox;
    /** Extra `/ready` details. */
    readyDetails?: () => Promise<Record<string, unknown>>;
    /** The edition's providers; the OSS edition when omitted. */
    edition?: Edition;
    /** Synced tables' CSV and Postgres sources; the config's (no private hosts) when omitted. */
    syncSources?: SyncSources;
  } = {}
) {
  const opts_ = opts;
  const logs: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk, _enc, done) {
      logs.push(JSON.parse(String(chunk)));
      done();
    },
  });
  const config = {
    ...loadConfig({ NODE_ENV: 'test', ...GENEROUS_RATE_LIMITS, ...opts.env }),
    ...opts.config,
  };
  const logger = createLogger({ level: 'debug', destination });
  const db = opts.db ?? createDb(config.databaseUrl).db;
  const email = opts.email ?? memoryTransport();
  const airtable = opts.airtable ?? { http: fakeAirtable().http };
  const { app, routes, store, thumbnails } = createApp({
    config,
    logger,
    db,
    checks: opts.checks ?? [],
    email,
    objectStore: opts.objectStore,
    visibility: opts.visibility,
    captcha: opts.captcha,
    rateLimiter: opts.rateLimiter,
    airtable,
    ...(opts.scripts ? { scripts: opts.scripts } : {}),
    ...(opts.readyDetails ? { readyDetails: opts.readyDetails } : {}),
    ...(opts.edition ? { edition: opts.edition } : {}),
    ...(opts.syncSources ? { syncSources: opts.syncSources } : {}),
  });
  /**
   * Runs a background job the app sent the way the worker would, by its id (an import's
   * or restore's id), and resolves when it finished.
   */
  async function runJob(
    id: string,
    opts: { lastAttempt?: boolean; afterPage?: (records: number) => Promise<void> | void } = {}
  ) {
    const { rows } = await db.execute<{ name: string; data: unknown }>(
      sql`SELECT name, data FROM pgboss.job WHERE id = ${id}`
    );
    const job = rows[0];
    if (!job) throw new Error(`runJob: no job ${id}`);
    if (job.name === 'imports.run')
      return runImportJob(
        { db, logger, entitlements: opts_.edition?.entitlements },
        job.data,
        opts
      );
    if (job.name === 'airtable.import') {
      const cipher = createCipher(config.encryptionKey, 'airtable-token');
      return runAirtableImport(
        {
          db,
          logger,
          cipher,
          store: opts_.objectStore,
          entitlements: opts_.edition?.entitlements,
          ...airtable,
        },
        job.data,
        opts
      );
    }
    if (job.name === 'snapshots.restore' && opts_.objectStore) {
      return runRestoreJob(
        { db, logger, store: opts_.objectStore, entitlements: opts_.edition?.entitlements },
        job.data,
        opts
      );
    }
    if (job.name === 'bases.duplicate') {
      return runDuplicateJob(
        {
          db,
          logger,
          store: opts_.objectStore,
          entitlements: opts_.edition?.entitlements,
          progressEveryMs: 0,
        },
        job.data,
        opts
      );
    }
    throw new Error(`runJob: can't run ${job.name}`);
  }
  return { app, routes, store, thumbnails, config, logger, logs, email, runJob };
}
