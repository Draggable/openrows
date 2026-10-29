import { AiService } from './ai/service.js';
import { clamdScanner } from './attachments/scan.js';
import { S3ObjectStore } from './attachments/storage.js';
import { createCipher } from './auth/crypto.js';
import { createScriptSandbox } from './automations/script/index.js';
import { ConfigError, loadEdition, loadWorkerConfig } from './config.js';
import { OUTBOX_CHANNEL } from './data/outbox.js';
import { createDb } from './db/index.js';
import { describeEdition, type EditionProviders, resolveEdition } from './edition/index.js';
import type { Edition } from './edition/types.js';
import { logTransport, smtpTransport } from './email/transport.js';
import { ownerIndexDdl } from './indexes/sync.js';
import { startWorkerHttp } from './jobs/http.js';
import {
  builtinQueues,
  type QueueDefinition,
  type RunningWorker,
  startWorker,
  type WorkerDeps,
} from './jobs/runtime.js';
import { createLogger } from './lib/logger.js';
import { createSafeFetch, outboundPolicy } from './lib/safe-fetch/index.js';
import { NOTIFICATIONS_CHANNEL } from './notifications/repo.js';
import { configOutboundLimits, OutboundGate } from './outbound/limits.js';
import { keycloakAdmin } from './purge/identity.js';
import { PostgresRateLimiter } from './ratelimit/postgres.js';
import { revisionRetentionDays } from './revisions/retention.js';
import { createSyncSources } from './syncs/sources/index.js';

export interface WorkerStartOptions {
  /** The hosted edition's providers; the OSS ones when omitted. */
  providers?: EditionProviders;
}

/**
 * The background worker process (`startWorkerProcess()` is what an entry point runs; the
 * core's `dist/worker.js` starts the OSS edition, the hosted edition's composition root passes the hosted
 * providers), the `worker` Compose service.
 *
 * Runs pg-boss (ADR-004; jobs/runtime.ts): the outbox relay every minute and soon after
 * each outbox NOTIFY, webhook deliveries (needs the API's ENCRYPTION_KEY, APP_URL and
 * optionally SMTP_* for the "webhook turned off" email), computed-field recomputes (fields
 * past the sync limit, relayed, and the NOW()/TODAY() refresh at :00, :30 and :45), and the
 * hourly cron jobs that replaced the interval timers: the outbox, revision,
 * notification and rate limit prunes, and with the `S3_*` settings the base
 * snapshots (the automatic daily snapshots and the prune past retention). Each also runs
 * once at start. Notification emails go out soon after each notification's NOTIFY and
 * every minute, and the hourly and daily digests on the hour and at 08:00 UTC.
 * With `INDEX_DATABASE_URL` (the schema owner, which owns the record tables) it also builds the
 * field indexes saved views want every 5 minutes, on that connection only.
 * Cron occurrences run once across every worker, so the service scales out. Webhook deliveries
 * and automations' outbound requests are limited per workspace (OUTBOUND_WORKSPACE_*).
 *
 * Needs `DATABASE_URL` (openrows_app; pg-boss's schema was installed by the migrate one-shot);
 * without it the worker only idles and reports unhealthy. `GET /health` and `GET /metrics`
 * listen on WORKER_HOST:WORKER_PORT (default 0.0.0.0:3001, never published). SIGTERM stops
 * fetching, lets running jobs finish (up to 15 s) and exits.
 */
export async function startWorkerProcess(options: WorkerStartOptions = {}): Promise<void> {
  const logger = createLogger({ level: process.env['LOG_LEVEL'] || 'info' });
  const env = process.env;
  // EDITION=cloud only from the hosted edition's entry point, with its providers; before
  // anything else.
  let edition: Edition;
  try {
    edition = resolveEdition(loadEdition(env), options.providers);
  } catch (err) {
    const issues = err instanceof ConfigError ? err.issues : [String(err)];
    logger.fatal({ issues }, 'invalid configuration, refusing to start');
    process.exit(1);
  }
  const databaseUrl = env['DATABASE_URL'];
  const revisionDays = revisionRetentionDays(env);
  const port = Number(env['WORKER_PORT'] || 3001);
  const host = env['WORKER_HOST'] || '0.0.0.0';
  const store =
    env['S3_ENDPOINT'] && env['S3_BUCKET'] && env['S3_ACCESS_KEY'] && env['S3_SECRET_KEY']
      ? new S3ObjectStore({
          endpoint: env['S3_ENDPOINT'],
          region: env['S3_REGION'] || 'us-east-1',
          bucket: env['S3_BUCKET'],
          accessKey: env['S3_ACCESS_KEY'],
          secretKey: env['S3_SECRET_KEY'],
          publicUrl: env['S3_PUBLIC_URL'] || undefined,
        })
      : undefined;

  const indexDatabaseUrl = env['INDEX_DATABASE_URL'];
  const indexDdl = indexDatabaseUrl ? ownerIndexDdl(indexDatabaseUrl) : undefined;

  const db = databaseUrl ? createDb(databaseUrl) : undefined;
  db?.pool.on('error', (err) => logger.warn({ err }, 'idle database client error'));

  let worker: RunningWorker | undefined;
  // Keeps the event loop alive even without a database.
  const http = await startWorkerHttp(() => worker, { port, host, logger });

  if (db && databaseUrl) {
    try {
      // Webhooks: secrets are decrypted with the API's ENCRYPTION_KEY, sent through the
      // SSRF-safe client (OUTBOUND_HTTP_*), and a webhook turned off is mailed to its creator.
      const config = loadWorkerConfig(env);
      const webhooks = {
        cipher: createCipher(config.encryptionKey, 'webhook-secret'),
        http: createSafeFetch(outboundPolicy(config.outbound)),
        email: config.smtp ? smtpTransport(config.smtp, config.mailFrom) : logTransport(logger),
        appUrl: config.appUrl,
      };
      // Automations' outbound steps: the same client and mailer, their own cipher.
      const automations = {
        cipher: createCipher(config.encryptionKey, 'automation-secret'),
        http: webhooks.http,
        email: webhooks.email,
        emailDailyLimit: config.automationEmailDailyLimit,
      };
      // Per-workspace outbound limits: the rate in the API's Postgres token buckets (shared
      // by every worker), the concurrency through pg-boss's group concurrency.
      const limits = configOutboundLimits(config.outboundLimits);
      const deps: WorkerDeps = {
        db: db.db,
        logger,
        store,
        entitlements: edition.entitlements,
        // Dunning and the seat sync, with the edition's billing.
        billing: edition.billing,
        revisionDays,
        webhooks,
        automations,
        outbound: { limits, gate: new OutboundGate(new PostgresRateLimiter(db.db), limits) },
        // Run-script steps: a container per script when AUTOMATION_SCRIPTS is on.
        scripts: createScriptSandbox(config.scripts),
        gc: { mode: config.attachmentGc },
        // Malware scans of uploads: clamd at CLAMAV_URL.
        scanner: config.clamav ? clamdScanner(config.clamav) : undefined,
        indexDdl,
        // Airtable imports: the API's cipher for the tokens, the SSRF-safe client.
        // : AIRTABLE_API_URL and the file hosts attachments are copied from, into S3.
        airtable: {
          cipher: createCipher(config.encryptionKey, 'airtable-token'),
          http: webhooks.http,
          origin: config.airtable.apiUrl,
          attachmentHosts: config.airtable.attachmentHosts,
          scanFiles: config.clamav !== undefined,
        },
        // Notification emails and digests, moved here from the API process.
        notifications: {
          email: webhooks.email,
          appUrl: config.appUrl,
          secret: config.encryptionKey,
        },
        // AI fields' answers: the API's providers, metered by the edition.
        ai: new AiService({
          config: config.ai,
          outbound: config.outbound,
          cipher: createCipher(config.encryptionKey, 'ai-key'),
          usage: edition.usage,
          entitlements: edition.entitlements,
          db: db.db,
          managed: edition.ai,
          logger,
        }),
        // Synced tables' CSV URLs and Postgres sources: the API's cipher and rules.
        syncSources: createSyncSources({
          encryptionKey: config.encryptionKey,
          outbound: config.outbound,
          requireTls: edition.name === 'cloud',
          // the edition's sync connectors (each sync reads with its creator's account).
          connectors: edition.syncConnectors,
        }),
        // Purged accounts' users at Keycloak; http only outside production.
        identity: config.identityAdmin
          ? keycloakAdmin({ ...config.identityAdmin, allowHttp: !config.isProduction })
          : undefined,
      };
      // The edition's own queues (the audit log's retention and SIEM stream), after the core's.
      const queues = builtinQueues(deps);
      const extra: Record<string, QueueDefinition> = {};
      edition.hooks.run('queues', extra, {
        db: db.db,
        logger,
        entitlements: edition.entitlements,
        http: webhooks.http,
        encryptionKey: config.encryptionKey,
      });
      for (const [name, queue] of Object.entries(extra)) {
        if (name in queues) throw new Error(`the edition's queue ${name} is one of the core's`);
        queues[name] = queue;
      }
      worker = await startWorker(deps, {
        connectionString: databaseUrl,
        instanceName: env['HOSTNAME'] || 'worker',
        queues,
      });
    } catch (err) {
      logger.error({ err }, 'worker failed to start');
      await http.close();
      await db.close();
      process.exit(1);
    }
  }

  // The relay runs every minute, and soon after the outbox notifies (a write committed), so
  // webhooks go out within seconds. `stately` keeps it to one queued run however many notify.
  // The same for notification emails: soon after a notification is created.
  let relayPending: NodeJS.Timeout | undefined;
  let emailPending: NodeJS.Timeout | undefined;
  const listener = db && worker ? await db.pool.connect().catch(() => undefined) : undefined;
  if (listener && worker) {
    const boss = worker.boss;
    const emails = worker.queues.includes('notifications.email');
    listener.on('notification', (msg) => {
      if (msg.channel === NOTIFICATIONS_CHANNEL) {
        emailPending ??= setTimeout(() => {
          emailPending = undefined;
          boss.send('notifications.email', null).catch(() => {});
        }, 1000);
        return;
      }
      relayPending ??= setTimeout(() => {
        relayPending = undefined;
        boss.send('outbox.relay', null).catch(() => {});
      }, 250);
    });
    listener.on('error', (err) => logger.warn({ err }, 'outbox listener error'));
    await listener.query(`LISTEN ${OUTBOX_CHANNEL}`);
    if (emails) await listener.query(`LISTEN ${NOTIFICATIONS_CHANNEL}`);
  }

  logger.info(
    { jobs: worker?.queues ?? [], revisionDays, port: http.port, ...describeEdition(edition) },
    'OpenRows worker started'
  );
  if (!db) logger.warn('DATABASE_URL is not set: the worker runs no jobs');
  if (db && !indexDdl) logger.warn('INDEX_DATABASE_URL is not set: no field indexes are built');
  if (db && worker && !env['OIDC_ADMIN_CLIENT_ID']) {
    logger.warn('OIDC_ADMIN_CLIENT_ID is not set: deleted accounts stay at the identity provider');
  }

  let stopping = false;
  async function shutdown(signal: string) {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'worker shutting down');
    try {
      clearTimeout(relayPending);
      clearTimeout(emailPending);
      listener?.release();
      await worker?.stop(15_000);
      await http.close();
      await db?.close();
      await indexDdl?.close();
      logger.info('worker stopped');
    } catch (err) {
      logger.error({ err }, 'worker shutdown failed');
      process.exitCode = 1;
    }
  }

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}
