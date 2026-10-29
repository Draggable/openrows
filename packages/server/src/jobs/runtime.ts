import { EVENTS_RETENTION_DAYS } from '@openrows/shared';
import { sql } from 'drizzle-orm';
import { fromDrizzle, type Job, PgBoss } from 'pg-boss';
import { runAiFieldJob } from '../ai/fields/generate.js';
import type { AiService } from '../ai/service.js';
import { type AirtableDeps, runAirtableImport } from '../airtable/import.js';
import { collectAttachmentGarbage, type GcMode, type GcResult } from '../attachments/gc.js';
import type { MalwareScanner } from '../attachments/scan.js';
import { runScanJob, sweepScans } from '../attachments/scan-job.js';
import type { ObjectStore } from '../attachments/storage.js';
import { deleteExpiredSessions } from '../auth/sessions.js';
import type { OutboundDeps } from '../automations/outbound.js';
import {
  AUTOMATION_OUTBOUND_WAIT_MS,
  automationJobData,
  runAutomationJob,
} from '../automations/run.js';
import type { ScriptSandbox } from '../automations/script/types.js';
import { pruneAutomationRuns, scheduleDueAutomations } from '../automations/subscriber.js';
import { runDuplicateJob } from '../bases/duplicate.js';
import { runDunning } from '../billing/dunning.js';
import { SEATS_QUEUE, seatsJobData, seatsSingletonKey, syncSeats } from '../billing/seats.js';
import { pruneOutbox } from '../data/outbox.js';
import type { Database } from '../db/index.js';
import { ossEntitlements } from '../edition/oss.js';
import type { BillingProvider, EntitlementsProvider } from '../edition/types.js';
import type { EmailTransport } from '../email/transport.js';
import { runImportJob } from '../import-export/import.js';
import { type IndexDdl, syncFieldIndexes } from '../indexes/sync.js';
import type { Logger } from '../lib/logger.js';
import { type MailerResult, NotificationMailer } from '../notifications/mailer.js';
import { NOTIFICATION_RETENTION_DAYS, pruneNotifications } from '../notifications/repo.js';
import { pruneOAuth } from '../oauth/service.js';
import {
  OutboundDeferred,
  type OutboundGate,
  type OutboundLimits,
  OutboundSlots,
  pruneOutboundLeases,
  SLOT_RETRY_SECONDS,
} from '../outbound/limits.js';
import type { IdentityAdmin } from '../purge/identity.js';
import { purgeDeleted, purgeExpiredTrash } from '../purge/service.js';
import {
  pruneRateLimits,
  pruneTokenUsage,
  TOKEN_USAGE_RETENTION_DAYS,
} from '../ratelimit/postgres.js';
import { pruneRevisions } from '../revisions/repo.js';
import { pruneSnapshots, runAutoSnapshots } from '../snapshots/jobs.js';
import { runRestoreJob } from '../snapshots/restore-job.js';
import { runSyncJob } from '../syncs/run.js';
import { scheduleDueSyncs } from '../syncs/service.js';
import type { SyncSources } from '../syncs/sources/index.js';
import { reconcileRecordCounts } from '../usage/counters.js';
import { checkUsageWarnings, runUsageWarnings } from '../usage/warnings.js';
import {
  deliverWebhook,
  WEBHOOK_OUTBOUND_WAIT_MS,
  type WebhookDeliveryDeps,
  webhookJobData,
} from '../webhooks/deliver.js';
import { pruneWebhookDeliveries, WEBHOOK_QUEUE } from '../webhooks/subscriber.js';
import { refreshVolatileFormulas, runComputedRefresh, volatileRunOf } from './computed.js';
import { deferJob } from './defer.js';
import { ensureQueues, JOB_QUEUES, JOBS_SCHEMA, type QueueSpec } from './queues.js';
import { OUTBOX_SUBSCRIBERS, type OutboxSubscriber, relayLag, relayOutbox } from './relay.js';
import { sweepJobs } from './status.js';
import { tenantJobData } from './tenant.js';

/** A job's work. `data` is untrusted JSON: check it (tenantJob does). Throwing retries the job. */
export type JobHandler = (
  data: unknown,
  ctx: { job: Job<unknown>; boss: PgBoss }
) => Promise<unknown>;

export interface QueueDefinition {
  spec: QueueSpec;
  handler: JobHandler;
}

export interface WorkerDeps {
  /** openrows_app: RLS applies; tenant jobs scope themselves with withTenant. */
  db: Database;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** Snapshot storage; without it the snapshot jobs aren't run or scheduled. */
  store?: ObjectStore | undefined;
  revisionDays: number;
  /** Outbox subscribers; by default those of OUTBOX_SUBSCRIBERS whose queue this worker runs. */
  subscribers?: readonly OutboxSubscriber[];
  /** Webhook delivery; without it webhooks aren't delivered (their log is still pruned). */
  webhooks?: Omit<WebhookDeliveryDeps, 'db' | 'logger'> | undefined;
  /** Automations' email, HTTP and Slack steps; without it those steps fail. */
  automations?: OutboundDeps | undefined;
  /** Run-script steps' sandbox; without it those steps fail as not available. */
  scripts?: ScriptSandbox | undefined;
  /**
   * The attachment GC (needs `store`): `dry-run` (the default) only counts, `on` deletes,
   * `off` doesn't run it. `last` holds the last run's counts, for the metrics.
   */
  gc?: { mode: GcMode; last?: GcResult } | undefined;
  /**
   * The schema owner's connection for field index builds (INDEX_DATABASE_URL); without it
   * the `indexes.sync` job isn't run.
   */
  indexDdl?: IndexDdl | undefined;
  /**
   * Deletes purged users at the identity provider (OIDC_ADMIN_CLIENT_*); without it only
   * OpenRows' copy of the account is deleted.
   */
  identity?: IdentityAdmin | undefined;
  /**
   * The workspaces' plans: imports, restores and automation runs are checked against
   * their limits. The OSS edition's (unlimited) when omitted.
   */
  entitlements?: EntitlementsProvider | undefined;
  /**
   * The edition's billing: with it enabled, the hourly dunning sweep runs, and with
   * per-seat billing (`updateSeats`) the seat sync after membership changes. Without it, neither.
   */
  billing?: BillingProvider | undefined;
  /**
   * Malware scanning of uploads (needs `store`): clamd. Without it the scan jobs aren't
   * run (an api with CLAMAV_URL then leaves uploads waiting).
   */
  scanner?: MalwareScanner | undefined;
  /** Airtable imports: the token's cipher and the SSRF-safe client; without it, not run. */
  airtable?: AirtableDeps | undefined;
  /**
   * Notification emails and digests: the transport, APP_URL for links and ENCRYPTION_KEY
   * for unsubscribe tokens; without it those jobs aren't run.
   */
  notifications?: { email: EmailTransport; appUrl: string; secret: string } | undefined;
  /**
   * Per-workspace outbound limits: the rate gate every webhook delivery and automation
   * request goes through, and the concurrency cap of `webhooks.deliver` and `automations.run`
   * per workspace. `waitMs` overrides how long a request waits for a token (tests). Without it,
   * no limits.
   */
  outbound?: { limits: OutboundLimits; gate: OutboundGate; waitMs?: number } | undefined;
  /** AI providers for AI fields' answers; without it, the answers fail as "AI off". */
  ai?: AiService | undefined;
  /** Synced tables' CSV URL and Postgres sources; without it, their runs fail. */
  syncSources?: SyncSources | undefined;
}

/** pg-boss counts retries from 0: the attempt after the last retry is the last one. */
const lastAttempt = (job: Job<unknown>, name: keyof typeof JOB_QUEUES) =>
  job.retryCount >= ((JOB_QUEUES[name] as { retryLimit?: number }).retryLimit ?? 0);

// Any constant works; it only has to be the same for every worker.
const RELAY_LOCK_ID = 7_250_105;

/**
 * The worker's built-in jobs: the outbox relay, and the hourly prunes and snapshots that
 * used to be interval timers (same functions, same retention settings).
 */
export function builtinQueues(deps: WorkerDeps): Record<string, QueueDefinition> {
  const { db, logger, store, outbound } = deps;
  const entitlements = deps.entitlements ?? ossEntitlements;
  // Per-workspace concurrency on the queues of outbound work.
  const capped = (spec: QueueSpec): QueueSpec =>
    outbound ? { ...spec, groupConcurrency: outbound.limits.concurrency } : spec;
  // ...and exact, through a slot per running job (pg-boss's count is a snapshot).
  const slots = outbound ? new OutboundSlots(db) : undefined;
  const inSlot = <T>(
    kind: 'webhooks' | 'automations',
    workspaceId: string,
    job: Job<unknown>,
    fn: () => Promise<T>
  ): Promise<T | { busy: true }> => {
    if (!slots || !outbound) return fn();
    // Held at most as long as pg-boss lets the job run, so a crashed worker's slot comes back.
    const seconds = (job.expireInSeconds || 300) + 30;
    return slots.run(kind, workspaceId, outbound.limits.concurrency, job.id, seconds, fn);
  };
  const queues: Record<string, QueueDefinition> = {
    'outbox.relay': {
      spec: JOB_QUEUES['outbox.relay'],
      // One relay at a time, whichever job (cron occurrence or start) got here first.
      handler: (_data, { boss }) =>
        db.transaction(async (tx) => {
          const { rows } = await tx.execute<{ locked: boolean }>(
            sql`SELECT pg_try_advisory_xact_lock(${RELAY_LOCK_ID}) AS locked`
          );
          if (!rows[0]?.locked) return { skipped: true };
          return relayOutbox(db, (queue, jobs) => boss.insert(queue, jobs), subscribers);
        }),
    },
    'outbox.prune': {
      spec: JOB_QUEUES['outbox.prune'],
      handler: async () => {
        const pruned = await pruneOutbox(db, EVENTS_RETENTION_DAYS);
        if (pruned > 0) logger.info({ pruned }, 'outbox events past retention removed');
        return { pruned };
      },
    },
    'revisions.prune': {
      spec: JOB_QUEUES['revisions.prune'],
      handler: async () => {
        const pruned = await pruneRevisions(db, deps.revisionDays);
        if (pruned > 0) logger.info({ pruned }, 'record revisions past retention removed');
        return { pruned };
      },
    },
    'notifications.prune': {
      spec: JOB_QUEUES['notifications.prune'],
      handler: async () => {
        const pruned = await pruneNotifications(db, NOTIFICATION_RETENTION_DAYS);
        if (pruned > 0) logger.info({ pruned }, 'notifications past retention removed');
        return { pruned };
      },
    },
    'webhooks.prune': {
      spec: JOB_QUEUES['webhooks.prune'],
      handler: async () => {
        const pruned = await pruneWebhookDeliveries(db);
        if (pruned > 0) logger.info({ pruned }, 'webhook deliveries past retention removed');
        return { pruned };
      },
    },
    // Automations: runs from the relay and the scheduler, and the 30-day history.
    'automations.run': {
      spec: capped(JOB_QUEUES['automations.run']),
      handler: async (data, { job, boss }) => {
        const parsed = automationJobData.parse(data);
        const outcome = await inSlot('automations', parsed.workspaceId, job, () =>
          runAutomationJob(
            {
              db,
              logger,
              entitlements,
              outbound: deps.automations,
              scripts: deps.scripts,
              gate: outbound && {
                gate: outbound.gate,
                waitMs: outbound.waitMs ?? AUTOMATION_OUTBOUND_WAIT_MS,
              },
            },
            parsed,
            { lastAttempt: lastAttempt(job, 'automations.run') }
          )
        );
        // The workspace's runs are all busy, or it's over its outbound rate (rolled back): run
        // it again later.
        if ('busy' in outcome) {
          return deferJob(boss, 'automations.run', job, parsed, SLOT_RETRY_SECONDS);
        }
        if ('deferred' in outcome) {
          return deferJob(boss, 'automations.run', job, parsed, outcome.deferred);
        }
        return outcome;
      },
    },
    'automations.schedule': {
      spec: JOB_QUEUES['automations.schedule'],
      handler: (_data, { boss }) =>
        scheduleDueAutomations(db, (queue, jobs) => boss.insert(queue, jobs)),
    },
    'syncs.run': {
      spec: JOB_QUEUES['syncs.run'],
      handler: (data) => runSyncJob({ db, logger, entitlements, sources: deps.syncSources }, data),
    },
    'syncs.schedule': {
      spec: JOB_QUEUES['syncs.schedule'],
      handler: (_data, { boss }) =>
        scheduleDueSyncs(db, {
          send: (tx, queue, payload, options = {}) =>
            boss.send(queue, payload, { ...options, db: fromDrizzle(tx, sql) }),
          stop: async () => {},
        }),
    },
    'automations.prune': {
      spec: JOB_QUEUES['automations.prune'],
      handler: async () => {
        const pruned = await pruneAutomationRuns(db);
        if (pruned > 0) logger.info({ pruned }, 'automation runs past retention removed');
        return { pruned };
      },
    },
    // CSV imports: resumable after the last committed batch.
    'imports.run': {
      spec: JOB_QUEUES['imports.run'],
      handler: (data, { job }) =>
        runImportJob({ db, logger, entitlements }, data, {
          lastAttempt: lastAttempt(job, 'imports.run'),
        }),
    },
    'jobs.sweep': {
      spec: JOB_QUEUES['jobs.sweep'],
      handler: async () => {
        const swept = await sweepJobs(db);
        if (swept.failed > 0) logger.warn({ failed: swept.failed }, 'stalled jobs failed');
        return swept;
      },
    },
    // Background recomputes of computed fields.
    'computed.refresh': {
      spec: JOB_QUEUES['computed.refresh'],
      handler: (data) => runComputedRefresh({ db, logger }, data),
    },
    // AI field answers.
    'ai.generate': {
      spec: JOB_QUEUES['ai.generate'],
      handler: (data, { boss }) => runAiFieldJob({ db, logger, ai: deps.ai }, data, boss),
    },
    'computed.volatile': {
      spec: JOB_QUEUES['computed.volatile'],
      handler: () => refreshVolatileFormulas({ db, logger }, volatileRunOf(new Date())),
    },
    // Hard deletion: accounts and workspaces marked deleted, and the trash past 30 days.
    'purge.deleted': {
      spec: JOB_QUEUES['purge.deleted'],
      handler: async () => {
        const result = await purgeDeleted({ db, logger, store, identity: deps.identity });
        if (result.users + result.workspaces + result.skipped > 0) {
          logger.info({ ...result }, 'deleted accounts and workspaces purged');
        }
        return result;
      },
    },
    'purge.trash': {
      spec: JOB_QUEUES['purge.trash'],
      handler: async () => {
        const result = await purgeExpiredTrash({ db, logger, store });
        logger.info({ ...result }, 'trash past retention purged');
        return result;
      },
    },
    'usage.reconcile': {
      spec: JOB_QUEUES['usage.reconcile'],
      handler: async () => reconcileRecordCounts(db, logger),
    },
    'sessions.sweep': {
      spec: JOB_QUEUES['sessions.sweep'],
      handler: async () => {
        const deleted = await deleteExpiredSessions(db);
        if (deleted > 0) logger.info({ deleted }, 'expired sessions removed');
        return { deleted };
      },
    },
    'ratelimit.prune': {
      spec: JOB_QUEUES['ratelimit.prune'],
      // Idle API rate limit buckets are full again; per-token usage counters age out;
      // expired OAuth codes and tokens go.
      handler: async () => ({
        buckets: await pruneRateLimits(db, 3600),
        outboundLeases: await pruneOutboundLeases(db),
        usage: await pruneTokenUsage(db, TOKEN_USAGE_RETENTION_DAYS),
        oauth: await pruneOAuth(db),
      }),
    },
  };
  const billing = deps.billing;
  if (billing?.enabled) {
    if (billing.updateSeats) {
      queues[SEATS_QUEUE] = {
        spec: JOB_QUEUES['billing.seats'],
        handler: async (data) => {
          const { workspaceId } = seatsJobData.parse(data);
          return syncSeats({ db, billing, logger }, workspaceId);
        },
      };
    }
    queues['billing.dunning'] = {
      spec: JOB_QUEUES['billing.dunning'],
      handler: (_data, { boss }) =>
        runDunning({
          db,
          billing,
          entitlements,
          logger,
          email: deps.notifications && {
            transport: deps.notifications.email,
            appUrl: deps.notifications.appUrl,
          },
          queueSeatSync: (workspaceId) =>
            boss.send(
              SEATS_QUEUE,
              { workspaceId },
              { singletonKey: seatsSingletonKey(workspaceId) }
            ),
        }),
    };
  }
  if (deps.notifications) {
    const mailer = new NotificationMailer({ ...deps.notifications, db, logger });
    const logged = (what: string) => (result: MailerResult) => {
      if (result.sent > 0) logger.info({ ...result }, what);
      return result;
    };
    // Plan-limit warnings to owners go out through the same transport.
    const warnings = { db, entitlements, logger, ...deps.notifications };
    queues['usage.warnings'] = {
      spec: JOB_QUEUES['usage.warnings'],
      handler: async () => {
        const result = await runUsageWarnings(warnings);
        if (result.emails > 0) logger.info(result, 'plan limit warnings checked');
      },
    };
    queues['usage.check'] = {
      spec: JOB_QUEUES['usage.check'],
      // Checked like a tenant job's data; the check scopes its own transaction.
      handler: (data) => checkUsageWarnings(warnings, tenantJobData.parse(data).workspaceId),
    };
    queues['notifications.email'] = {
      spec: JOB_QUEUES['notifications.email'],
      handler: () => mailer.run().then(logged('notification emails sent')),
    };
    queues['notifications.digest.hourly'] = {
      spec: JOB_QUEUES['notifications.digest.hourly'],
      handler: () => mailer.runDigest('hourly').then(logged('hourly digests sent')),
    };
    queues['notifications.digest.daily'] = {
      spec: JOB_QUEUES['notifications.digest.daily'],
      handler: () => mailer.runDigest('daily').then(logged('daily digests sent')),
    };
  }
  if (deps.indexDdl) {
    const ddl = deps.indexDdl;
    queues['indexes.sync'] = {
      spec: JOB_QUEUES['indexes.sync'],
      handler: async () => {
        const result = await syncFieldIndexes({ db, ddl, logger });
        if (result.created > 0 || result.dropped > 0 || result.errors > 0) {
          logger.info({ ...result }, 'field indexes synced');
        }
        return result;
      },
    };
  }
  // Without a store only duplicates inside a workspace (no file copies) can finish.
  queues['bases.duplicate'] = {
    spec: JOB_QUEUES['bases.duplicate'],
    handler: (data, { job }) =>
      runDuplicateJob({ db, store, logger, entitlements }, data, {
        lastAttempt: lastAttempt(job, 'bases.duplicate'),
      }),
  };
  if (deps.airtable) {
    const airtable = { store: deps.store, ...deps.airtable, db, logger, entitlements };
    queues['airtable.import'] = {
      spec: JOB_QUEUES['airtable.import'],
      handler: (data, { job }) =>
        runAirtableImport(airtable, data, { lastAttempt: lastAttempt(job, 'airtable.import') }),
    };
  }
  if (deps.webhooks) {
    const delivery: WebhookDeliveryDeps = {
      ...deps.webhooks,
      db,
      logger,
      outbound: outbound && {
        gate: outbound.gate,
        waitMs: outbound.waitMs ?? WEBHOOK_OUTBOUND_WAIT_MS,
      },
    };
    queues[WEBHOOK_QUEUE] = {
      spec: capped(JOB_QUEUES['webhooks.deliver']),
      // The job's id is the event id receivers see: the same for every retry (relayJobId), and
      // kept in the data of a deferred copy.
      handler: async (data, { job, boss }) => {
        const parsed = webhookJobData.parse(data);
        const eventId = parsed.eventId ?? job.id;
        const attempt = (parsed.priorAttempts ?? 0) + job.retryCount + 1;
        const copy = { ...parsed, eventId, priorAttempts: attempt - 1 };
        try {
          const outcome = await inSlot('webhooks', parsed.workspaceId, job, () =>
            deliverWebhook(delivery, parsed, eventId, attempt)
          );
          // Every one of the workspace's delivery slots is taken: a little later.
          if ('busy' in outcome)
            return deferJob(boss, WEBHOOK_QUEUE, job, copy, SLOT_RETRY_SECONDS);
          return outcome;
        } catch (err) {
          if (!(err instanceof OutboundDeferred)) throw err;
          return deferJob(boss, WEBHOOK_QUEUE, job, copy, err.retryAfterSeconds);
        }
      },
    };
  }
  // Only subscribers whose queue runs here; the others' events pass by.
  const subscribers =
    deps.subscribers ?? OUTBOX_SUBSCRIBERS.filter((s) => queues[s.queue] !== undefined);
  if (store) {
    queues['snapshots.prune'] = {
      spec: JOB_QUEUES['snapshots.prune'],
      handler: async () => {
        const pruned = await pruneSnapshots(db, store, logger);
        if (pruned > 0) logger.info({ pruned }, 'base snapshots past retention removed');
        return { pruned };
      },
    };
    queues['snapshots.auto'] = {
      spec: JOB_QUEUES['snapshots.auto'],
      handler: async () => ({ taken: await runAutoSnapshots(db, store, logger) }),
    };
    queues['snapshots.restore'] = {
      spec: JOB_QUEUES['snapshots.restore'],
      handler: (data, { job }) =>
        runRestoreJob({ db, store, logger, entitlements }, data, {
          lastAttempt: lastAttempt(job, 'snapshots.restore'),
        }),
    };
    const scanner = deps.scanner;
    if (scanner) {
      const scan = {
        db,
        store,
        scanner,
        logger,
        email: deps.notifications?.email,
        appUrl: deps.notifications?.appUrl ?? '',
      };
      queues['attachments.scan'] = {
        spec: JOB_QUEUES['attachments.scan'],
        handler: (data) => runScanJob(scan, data),
      };
      queues['attachments.scan.sweep'] = {
        spec: JOB_QUEUES['attachments.scan.sweep'],
        handler: (_data, { boss }) => sweepScans(db, boss),
      };
    }
    const gc = deps.gc ?? { mode: 'dry-run' };
    if (gc.mode !== 'off') {
      queues['attachments.gc'] = {
        spec: JOB_QUEUES['attachments.gc'],
        handler: async () => {
          const result = await collectAttachmentGarbage(
            { db, store, logger },
            { dryRun: gc.mode === 'dry-run' }
          );
          gc.last = result;
          logger.info({ ...result }, result.dryRun ? 'attachment gc dry run' : 'attachment gc');
          return result;
        },
      };
    }
  }
  return queues;
}

export interface WorkerOptions {
  /** pg-boss's own pool, as openrows_app (DATABASE_URL). */
  connectionString: string;
  /** The name in pg-boss's instance registry. */
  instanceName?: string;
  /** The queues to run; `builtinQueues(deps)` by default. */
  queues?: Record<string, QueueDefinition>;
  /** How often idle workers poll (seconds, default 2). */
  pollingIntervalSeconds?: number;
  /** How often cron schedules are checked (seconds, 1 to 45; default 30 and 5). */
  cronMonitorIntervalSeconds?: number;
  cronWorkerIntervalSeconds?: number;
  /** How often stalled jobs (no heartbeat, expired) are failed and retried (seconds, default 60). */
  superviseIntervalSeconds?: number;
  /** pg-boss's pool size (default 5). */
  maxConnections?: number;
}

export interface RunningWorker {
  boss: PgBoss;
  /** The queues this worker runs. */
  queues: string[];
  /** pg-boss is running and Postgres answers. */
  healthy(): Promise<boolean>;
  /** Prometheus text: queue depth and failures. */
  metrics(): Promise<string>;
  /** Stops fetching, lets running jobs finish (up to `timeoutMs`), closes pg-boss's pool. */
  stop(timeoutMs?: number): Promise<void>;
}

/**
 * Starts pg-boss in the worker (ADR-004): creates the queues and their dead-letter queues,
 * registers a handler per queue, and (re)declares the cron schedules, which pg-boss runs once
 * per occurrence across every worker. Recurring jobs also get one run at start, deduplicated
 * across workers. The schema itself is installed by the migrate one-shot, never here.
 */
export async function startWorker(deps: WorkerDeps, opts: WorkerOptions): Promise<RunningWorker> {
  const { logger } = deps;
  const queues = opts.queues ?? builtinQueues(deps);
  const boss = new PgBoss({
    connectionString: opts.connectionString,
    schema: JOBS_SCHEMA,
    application_name: 'openrows-worker',
    max: opts.maxConnections ?? 5,
    // The migrate one-shot owns the schema; the app role can't run DDL.
    migrate: false,
    supervise: true,
    schedule: true,
    reindex: false,
    instanceName: opts.instanceName ?? 'worker',
    ...(opts.cronMonitorIntervalSeconds
      ? { cronMonitorIntervalSeconds: opts.cronMonitorIntervalSeconds }
      : {}),
    ...(opts.cronWorkerIntervalSeconds
      ? { cronWorkerIntervalSeconds: opts.cronWorkerIntervalSeconds }
      : {}),
    ...(opts.superviseIntervalSeconds
      ? { superviseIntervalSeconds: opts.superviseIntervalSeconds }
      : {}),
  });
  boss.on('error', (err) => logger.warn({ err }, 'job queue error'));
  boss.on('warning', (warning) => logger.warn({ warning }, 'job queue warning'));
  await boss.start();

  const failures = new Map<string, number>();
  const specs = Object.fromEntries(Object.entries(queues).map(([name, q]) => [name, q.spec]));
  await ensureQueues(boss, specs);
  for (const [name, { handler }] of Object.entries(queues)) {
    failures.set(name, 0);
    const { localConcurrency, groupConcurrency } = queues[name]?.spec ?? {};
    await boss.work<unknown>(
      name,
      {
        batchSize: 1,
        pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 2,
        ...(localConcurrency ? { localConcurrency } : {}),
        ...(groupConcurrency ? { groupConcurrency } : {}),
      },
      async ([job]) => {
        if (!job) return null;
        try {
          return await handler(job.data, { job, boss });
        } catch (err) {
          failures.set(name, (failures.get(name) ?? 0) + 1);
          logger.warn({ err, queue: name, jobId: job.id, retry: job.retryCount }, 'job failed');
          throw err;
        }
      }
    );
  }
  for (const [name, { spec }] of Object.entries(queues)) {
    if (spec.cron) await boss.schedule(name, spec.cron, null, { tz: 'UTC' });
    if (spec.onStart) {
      // One run per 10 minutes however many workers start: the old timers' run at start.
      await boss.send(name, null, { singletonKey: 'start', singletonSeconds: 600 });
    }
  }

  let stopped = false;
  return {
    boss,
    queues: Object.keys(queues),
    async healthy() {
      if (stopped) return false;
      try {
        await deps.db.execute(sql`SELECT 1`);
        return true;
      } catch {
        return false;
      }
    },
    async metrics() {
      const lines: string[] = [];
      const metric = (name: string, help: string, type: string) =>
        lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      const stats = await boss.getQueues();
      const gauges = [
        ['openrows_jobs_queued', 'Jobs waiting to run, deferred included.', 'queuedCount'],
        ['openrows_jobs_ready', 'Jobs ready to run now.', 'readyCount'],
        ['openrows_jobs_active', 'Jobs running.', 'activeCount'],
        ['openrows_jobs_failed', 'Failed jobs still retained.', 'failedCount'],
      ] as const;
      for (const [name, help, key] of gauges) {
        metric(name, help, 'gauge');
        for (const q of stats) lines.push(`${name}{queue="${q.name}"} ${q[key]}`);
      }
      metric('openrows_job_failures_total', 'Job attempts that threw, this process.', 'counter');
      for (const [name, n] of failures)
        lines.push(`openrows_job_failures_total{queue="${name}"} ${n}`);
      const gc = deps.gc?.last;
      if (gc) {
        const mode = gc.dryRun ? 'dry-run' : 'on';
        metric(
          'openrows_attachment_gc_orphaned_rows',
          'Orphaned attachment rows the last GC run deleted (dry run: found).',
          'gauge'
        );
        lines.push(`openrows_attachment_gc_orphaned_rows{mode="${mode}"} ${gc.orphanedRows}`);
        metric(
          'openrows_attachment_gc_objects',
          'Stored objects the last GC run deleted (dry run: could delete).',
          'gauge'
        );
        lines.push(`openrows_attachment_gc_objects{mode="${mode}"} ${gc.objects}`);
        metric('openrows_attachment_gc_errors', 'Failures in the last GC run.', 'gauge');
        lines.push(`openrows_attachment_gc_errors{mode="${mode}"} ${gc.errors}`);
      }
      const lag = await relayLag(deps.db);
      if (lag) {
        metric('openrows_outbox_relay_pending', 'Outbox events past the relay cursor.', 'gauge');
        lines.push(`openrows_outbox_relay_pending ${lag.pending}`);
        metric('openrows_outbox_relay_cursor_age_seconds', 'Since the cursor last moved.', 'gauge');
        lines.push(`openrows_outbox_relay_cursor_age_seconds ${lag.cursorAgeSeconds}`);
        metric(
          'openrows_outbox_relay_oldest_pending_age_seconds',
          'Age of the oldest outbox event the relay has not read (0: none).',
          'gauge'
        );
        lines.push(
          `openrows_outbox_relay_oldest_pending_age_seconds ${lag.oldestPendingAgeSeconds}`
        );
      }
      return `${lines.join('\n')}\n`;
    },
    async stop(timeoutMs = 15_000) {
      if (stopped) return;
      stopped = true;
      await boss.stop({ graceful: true, close: true, timeout: timeoutMs });
    },
  };
}
