import { DAILY_DIGEST_HOUR_UTC } from '@openrows/shared';
import type { PgBoss, Queue } from 'pg-boss';

/** The Postgres schema pg-boss keeps its tables in (ADR-004). */
export const JOBS_SCHEMA = 'pgboss';

/** A queue's settings: pg-boss's, plus the cron schedule of a recurring job. */
export interface QueueSpec extends Omit<Queue, 'name' | 'deadLetter'> {
  /** A cron expression (UTC); the job then runs once per occurrence across every worker. */
  cron?: string;
  /** Sent once when a worker starts (deduplicated across workers for 10 minutes). */
  onStart?: boolean;
  /** Handlers each worker runs at once (pg-boss's `localConcurrency`; default 1). */
  localConcurrency?: number;
  /**
   * Active jobs per group across every worker (pg-boss's `groupConcurrency`): tenant jobs
   * sent with their workspace as the group (`workspaceGroup`) then share it per workspace.
   */
  groupConcurrency?: number;
}

/**
 * ADR-004's job rules: 5 retries with exponential backoff, a per-run timeout and a dead-letter
 * queue. `stately` allows one queued and one active job, so a slow run never piles up behind it.
 */
const MAINTENANCE: QueueSpec = {
  policy: 'stately',
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 900,
  expireInSeconds: 30 * 60,
};

/**
 * Every queue the worker runs. The hourly prunes and snapshots replace the old interval
 * timers (and run once at start, as they did); the outbox relay runs every minute and whenever
 * the outbox notifies. Webhooks and automations add their delivery queues here.
 */
export const JOB_QUEUES = {
  /** Outbox rows → one job per matching subscriber (relay.ts). */
  'outbox.relay': {
    policy: 'stately',
    retryLimit: 5,
    retryDelay: 5,
    retryBackoff: true,
    retryDelayMax: 300,
    expireInSeconds: 5 * 60,
    cron: '* * * * *',
    onStart: true,
  },
  /** Realtime events past the 7-day retention. */
  'outbox.prune': { ...MAINTENANCE, cron: '0 * * * *', onStart: true },
  /** Record revisions past REVISION_RETENTION_DAYS. */
  'revisions.prune': { ...MAINTENANCE, cron: '2 * * * *', onStart: true },
  /**
   * Notification emails as they come: every minute, and soon after a notification is
   * created (the worker LISTENs). A failed send is put back and the job retried.
   */
  'notifications.email': {
    policy: 'stately',
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 900,
    expireInSeconds: 10 * 60,
    cron: '* * * * *',
    onStart: true,
  },
  /** Hourly digests, on the hour. */
  'notifications.digest.hourly': { ...MAINTENANCE, cron: '0 * * * *' },
  /** Daily digests, at DAILY_DIGEST_HOUR_UTC. */
  'notifications.digest.daily': { ...MAINTENANCE, cron: `0 ${DAILY_DIGEST_HOUR_UTC} * * *` },
  /** Notifications older than 90 days. */
  'notifications.prune': { ...MAINTENANCE, cron: '4 * * * *', onStart: true },
  /** Expired sessions (moved here from a timer in every API process). */
  'sessions.sweep': { ...MAINTENANCE, cron: '20 * * * *', onStart: true },
  /** Idle API rate limit buckets and per-token usage counts past 90 days. */
  'ratelimit.prune': { ...MAINTENANCE, cron: '6 * * * *', onStart: true },
  /**
   * One outbox event to one webhook. 8 attempts: the 7 retries wait about 7.5 min, 15
   * min, 30 min, 1 h, 2 h, 4 h and 8 h (each up to twice that, at random), ~24 h in all.
   */
  'webhooks.deliver': {
    policy: 'standard',
    // several at once, at most the workspace cap of one workspace's (builtinQueues).
    localConcurrency: 8,
    retryLimit: 7,
    retryDelay: 450,
    retryBackoff: true,
    retryDelayMax: 16 * 3600,
    expireInSeconds: 2 * 60,
  },
  /**
   * One automation run, sent by the outbox relay or the scheduler. The run is one
   * transaction, so a retry starts over; its idempotency key makes a duplicate a no-op.
   */
  'automations.run': {
    policy: 'standard',
    // a run holds a transaction; at most the workspace cap of one workspace's at once.
    localConcurrency: 4,
    retryLimit: 3,
    retryDelay: 10,
    retryBackoff: true,
    retryDelayMax: 600,
    expireInSeconds: 5 * 60,
  },
  /** Scheduled automations whose next run is due. */
  'automations.schedule': {
    ...MAINTENANCE,
    expireInSeconds: 5 * 60,
    cron: '* * * * *',
    onStart: true,
  },
  /** Automation runs past 30 days. */
  'automations.prune': { ...MAINTENANCE, cron: '18 * * * *', onStart: true },
  /** Webhook delivery log entries past 7 days. */
  'webhooks.prune': { ...MAINTENANCE, cron: '12 * * * *', onStart: true },
  /**
   * A CSV import, sent by the API. The worker heartbeats while it runs, so a killed
   * worker's import is retried within a minute; a retry resumes after the last committed batch.
   */
  'imports.run': {
    policy: 'standard',
    retryLimit: 3,
    retryDelay: 10,
    retryBackoff: true,
    retryDelayMax: 300,
    expireInSeconds: 2 * 3600,
    heartbeatSeconds: 30,
  },
  /** A snapshot restore to a new base (needs S3): one transaction, so a retry restarts. */
  /** Airtable imports: one base each; resumable after the last committed page. */
  'airtable.import': {
    policy: 'standard',
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 600,
    expireInSeconds: 6 * 3600,
    heartbeatSeconds: 30,
  },
  'snapshots.restore': {
    policy: 'standard',
    retryLimit: 2,
    retryDelay: 10,
    retryBackoff: true,
    retryDelayMax: 300,
    expireInSeconds: 2 * 3600,
    heartbeatSeconds: 30,
  },
  /** A base duplicate: copied in one transaction, like a restore. */
  'bases.duplicate': {
    policy: 'standard',
    retryLimit: 2,
    retryDelay: 10,
    retryBackoff: true,
    retryDelayMax: 300,
    expireInSeconds: 2 * 3600,
    heartbeatSeconds: 30,
  },
  /**
   * One run of a synced table, queued by "Sync now", the schedule or the sync's creation.
   * One transaction, so a retry starts over; the run row makes a finished run a no-op.
   */
  'syncs.run': {
    policy: 'standard',
    localConcurrency: 2,
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 600,
    expireInSeconds: 15 * 60,
  },
  /** Scheduled syncs whose next run is due. */
  'syncs.schedule': {
    ...MAINTENANCE,
    expireInSeconds: 5 * 60,
    cron: '* * * * *',
    onStart: true,
  },
  /** Imports and restores whose pg-boss job ended without them (failed), and old finished ones. */
  'jobs.sweep': { ...MAINTENANCE, expireInSeconds: 5 * 60, cron: '* * * * *', onStart: true },
  /** Recounts every live table's records against the plan counters, daily at 03:15 UTC. */
  'usage.reconcile': { ...MAINTENANCE, expireInSeconds: 60 * 60, cron: '15 3 * * *' },
  /**
   * Plan-limit warning emails to owners: every live workspace, hourly; once per limit,
   * level and month.
   */
  'usage.warnings': { ...MAINTENANCE, expireInSeconds: 30 * 60, cron: '25 * * * *' },
  /**
   * One workspace's warnings now, sent when a public form refused a response at the limit:
   * one queued per workspace (singletonKey).
   */
  'usage.check': { ...MAINTENANCE, retryLimit: 3, expireInSeconds: 5 * 60 },
  /**
   * A workspace's subscription seats = its billable editors, sent by the outbox relay a
   * minute after a membership change: one queued per workspace (singletonKey), so changes in that
   * minute coalesce. Only with per-seat billing.
   */
  'billing.seats': {
    policy: 'stately',
    retryLimit: 5,
    retryDelay: 60,
    retryBackoff: true,
    retryDelayMax: 3600,
    expireInSeconds: 5 * 60,
  },
  /**
   * Dunning: past-due subscriptions' emails to owners and the end of their grace period,
   * and seat drift, hourly. Only with billing.
   */
  'billing.dunning': {
    ...MAINTENANCE,
    expireInSeconds: 30 * 60,
    cron: '35 * * * *',
    onStart: true,
  },
  /**
   * One upload's malware scan (needs S3 and CLAMAV_URL), sent when it is confirmed: one
   * queued per file (singletonKey). While clamd is down the job retries for about 15 hours (the
   * file waits, never passes); the sweep below sends it again after that.
   */
  'attachments.scan': {
    policy: 'stately',
    localConcurrency: 4,
    retryLimit: 20,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 3600,
    expireInSeconds: 10 * 60,
  },
  /** Files still waiting for their scan: their scan sent again, every 5 minutes. */
  'attachments.scan.sweep': { ...MAINTENANCE, cron: '*/5 * * * *', onStart: true },
  /** Stored files no row names any more (needs S3). */
  'attachments.gc': { ...MAINTENANCE, expireInSeconds: 60 * 60, cron: '14 * * * *', onStart: true },
  /**
   * Field indexes for saved views' sorts, groups and filters (needs INDEX_DATABASE_URL):
   * builds missing ones with CREATE INDEX CONCURRENTLY, drops unwanted ones.
   */
  'indexes.sync': {
    ...MAINTENANCE,
    expireInSeconds: 3 * 3600,
    heartbeatSeconds: 60,
    cron: '*/5 * * * *',
    onStart: true,
  },
  /**
   * Computed fields a write left for the worker, sent by the outbox relay: one queued and
   * one active job per base (singletonKey). Pages of 1,000 records, each its own transaction.
   */
  'computed.refresh': {
    policy: 'stately',
    retryLimit: 5,
    retryDelay: 10,
    retryBackoff: true,
    retryDelayMax: 600,
    expireInSeconds: 2 * 3600,
    heartbeatSeconds: 60,
  },
  /**
   * AI field answers, sent by the outbox relay a few seconds after a request: one queued
   * and one active job per table (singletonKey), a run answers up to 200 records then continues
   * in a new job; at most 2 tables of a workspace at once.
   */
  'ai.generate': {
    policy: 'stately',
    localConcurrency: 4,
    groupConcurrency: 2,
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 600,
    expireInSeconds: 10 * 60,
  },
  /**
   * NOW()/TODAY() formulas: every hour, and at :30 and :45 for formulas with SET_TIMEZONE
   * (midnight in time zones with half and three-quarter hour offsets). TODAY() is UTC's day.
   */
  'computed.volatile': {
    ...MAINTENANCE,
    expireInSeconds: 2 * 3600,
    heartbeatSeconds: 60,
    cron: '0,30,45 * * * *',
  },
  /**
   * Accounts and workspaces marked deleted: hard-deleted with their files, record schemas
   * and identity-provider user. Sent by "Delete account" and a workspace's deletion, and hourly.
   */
  'purge.deleted': { ...MAINTENANCE, expireInSeconds: 60 * 60, cron: '16 * * * *', onStart: true },
  /** Trash items past TRASH_RETENTION_DAYS: bases, tables, fields, views, records. */
  'purge.trash': {
    ...MAINTENANCE,
    expireInSeconds: 3 * 3600,
    heartbeatSeconds: 60,
    cron: '40 3 * * *',
    onStart: true,
  },
  /** Base snapshots past their workspace's retention (needs S3). */
  'snapshots.prune': { ...MAINTENANCE, cron: '8 * * * *', onStart: true },
  /** The daily automatic snapshot of every changed base (needs S3). */
  'snapshots.auto': { ...MAINTENANCE, cron: '10 * * * *', onStart: true },
} satisfies Record<string, QueueSpec>;

export type JobName = keyof typeof JOB_QUEUES;

/** The queues the API sends to: it creates them if the worker hasn't yet. */
export const API_QUEUES = [
  'imports.run',
  'airtable.import',
  'snapshots.restore',
  'bases.duplicate',
  'purge.deleted',
  // Webhook-received and button-clicked automation runs.
  'automations.run',
  // A public form refused a response at the plan's limit.
  'usage.check',
  // A confirmed upload's malware scan.
  'attachments.scan',
  // "Sync now" and new synced tables.
  'syncs.run',
  // A webhook delivery redelivered from the log.
  'webhooks.deliver',
] as const satisfies JobName[];

/** The dead-letter queue of `name`: jobs that failed every retry are copied there. */
export function deadLetterQueue(name: string): string {
  return `${name}.dead`;
}

/** Dead letters stay 30 days, unprocessed, for an operator (and later the automations UI). */
const DEAD_LETTER: Omit<Queue, 'name'> = {
  policy: 'standard',
  retentionSeconds: 30 * 24 * 3600,
  deleteAfterSeconds: 30 * 24 * 3600,
};

/**
 * Creates each queue and its dead-letter queue, or brings an existing one's settings up to date.
 * Idempotent; every worker runs it at start (non-partitioned queues need no DDL, so openrows_app
 * can).
 */
export async function ensureQueues(
  boss: Pick<PgBoss, 'getQueue' | 'createQueue' | 'updateQueue'>,
  queues: Record<string, QueueSpec>
): Promise<void> {
  for (const [name, spec] of Object.entries(queues)) {
    const {
      cron: _cron,
      onStart: _onStart,
      localConcurrency: _local,
      groupConcurrency: _group,
      ...options
    } = spec;
    const dead = deadLetterQueue(name);
    if (!(await boss.getQueue(dead))) await boss.createQueue(dead, DEAD_LETTER);
    if (await boss.getQueue(name)) {
      const { policy: _policy, partition: _partition, retryDelayMax: _max, ...updatable } = options;
      await boss.updateQueue(name, { ...updatable, deadLetter: dead });
    } else {
      await boss.createQueue(name, { ...options, deadLetter: dead });
    }
  }
}
