import { type Base, type RestoreJob, roleAllows } from '@openrows/shared';
import { z } from 'zod';
import type { ObjectStore } from '../attachments/storage.js';
import { resolveResource } from '../authz/resolve.js';
import { inScope } from '../authz/scope.js';
import type { Database, Transaction } from '../db/index.js';
import { ossEntitlements } from '../edition/oss.js';
import type { EntitlementsProvider } from '../edition/types.js';
import type { Jobs } from '../jobs/send.js';
import {
  beginAttempt,
  failJob,
  failureMessage,
  finishJob,
  type JobRow,
  lockRunningJob,
  startJob,
} from '../jobs/status.js';
import { withTenant } from '../jobs/tenant.js';
import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { assertBaseWithinLimit } from '../usage/quota.js';
import { restoreSnapshot } from './restore.js';
import { loadSnapshot } from './service.js';

/**
 * Snapshot restore in the worker: the request checks access and stores the job; the
 * worker restores in one transaction that also marks the job done, so a killed worker leaves
 * nothing behind and the retry starts over.
 */

/** The pg-boss queue (jobs/queues.ts). */
export const RESTORE_QUEUE = 'snapshots.restore';

interface RestoreInput {
  snapshotId: string;
  name?: string | undefined;
}

export function toRestoreJob(job: JobRow): RestoreJob {
  const input = job.input as RestoreInput;
  return {
    id: job.id,
    snapshotId: input.snapshotId,
    status: job.status,
    base: job.status === 'done' ? ((job.result as Base | null) ?? null) : null,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

export async function startRestore(
  tx: Transaction,
  jobs: Jobs,
  scope: { workspaceId: string; userId: string; baseId: string },
  input: RestoreInput
): Promise<RestoreJob> {
  const job = await startJob(tx, jobs, RESTORE_QUEUE, {
    workspaceId: scope.workspaceId,
    baseId: scope.baseId,
    kind: 'restore',
    createdBy: scope.userId,
    input,
    progress: {},
  });
  return toRestoreJob(job);
}

export const restoreJobData = z.object({ workspaceId: z.uuid(), jobId: z.uuid() });

export interface RestoreRunDeps {
  db: Database;
  store: ObjectStore;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** The workspaces' plans: records per base. The OSS edition's when omitted. */
  entitlements?: EntitlementsProvider | undefined;
}

/**
 * The worker's handler for one restore (`snapshots.restore`). The requester's live roles are
 * checked again (`base:snapshot` on the base, `base:create` on the workspace). AppErrors and any
 * error on the last attempt fail the job with a message; others are thrown and retried.
 */
export async function runRestoreJob(
  deps: RestoreRunDeps,
  raw: unknown,
  opts: { lastAttempt?: boolean } = {}
): Promise<{ status: string }> {
  const { workspaceId, jobId } = restoreJobData.parse(raw);
  const job = await withTenant(deps.db, workspaceId, (tx) => beginAttempt(tx, jobId));
  if (!job) return { status: 'gone' };
  const userId = job.createdBy;
  try {
    if (!userId) throw new AppError('NOT_FOUND', { detail: 'The restore is gone.' });
    const base = await inScope(deps.db, { workspaceId, userId }, async (tx) => {
      // Held to the end: a second run of the job waits, then finds it done.
      const row = await lockRunningJob(tx, jobId);
      if (!row) return null;
      const resolved = await resolveResource(tx, 'base', row.baseId, userId);
      const role = resolved?.workspaceRole ?? null;
      if (!resolved || !role) {
        throw new AppError('NOT_FOUND', { detail: 'The base is gone, or you lost access to it.' });
      }
      if (!roleAllows(role, 'base:create')) {
        throw new AppError('FORBIDDEN', {
          detail: 'Only creators of the workspace can restore a snapshot to a new base.',
        });
      }
      const input = row.input as RestoreInput;
      const snapshot = await loadSnapshot(tx, row.baseId, input.snapshotId);
      const restored = await restoreSnapshot(
        { tx, workspaceId, userId, role },
        deps.store,
        snapshot,
        {
          name: input.name,
          role,
        }
      );
      // The plan's records per base: a snapshot too big for it isn't restored at all.
      await assertBaseWithinLimit(
        tx,
        await (deps.entitlements ?? ossEntitlements).forWorkspace(workspaceId, tx),
        restored.id
      );
      await finishJob(tx, jobId, restored);
      return restored;
    });
    if (base) {
      deps.logger.info(
        { restoreId: jobId, from: job.baseId, baseId: base.id },
        'snapshot restored to a new base'
      );
    }
    return { status: base ? 'done' : 'gone' };
  } catch (err) {
    if (!(err instanceof AppError) && !opts.lastAttempt) throw err;
    await withTenant(deps.db, workspaceId, (tx) =>
      failJob(tx, jobId, failureMessage(err, 'restore'))
    );
    deps.logger.warn({ err, restoreId: jobId }, 'snapshot restore failed');
    return { status: 'failed' };
  }
}
