import type { Job, PgBoss } from 'pg-boss';
import { namedJobId } from './ids.js';

/** The group a tenant job runs in: its workspace, for pg-boss's group concurrency. */
export function workspaceGroup(workspaceId: string): { id: string } {
  return { id: workspaceId };
}

/**
 * Puts a job back in its queue for later instead of failing it (a workspace over its
 * outbound rate): a copy with `data`, due in `seconds`, in the same workspace group, and the job
 * itself completes. The copy's id is named after the job's, so a handler that runs again after a
 * crash sends no second copy. Retries start afresh on the copy; a deferral isn't a failure.
 */
export async function deferJob(
  boss: Pick<PgBoss, 'insert'>,
  queue: string,
  job: Pick<Job<unknown>, 'id'>,
  data: { workspaceId: string } & Record<string, unknown>,
  seconds: number
): Promise<{ deferred: number }> {
  const delay = Math.max(1, Math.ceil(seconds));
  await boss.insert(queue, [
    {
      id: namedJobId(`openrows:deferred:${job.id}`),
      data,
      startAfter: new Date(Date.now() + delay * 1000),
      group: workspaceGroup(data.workspaceId),
    },
  ]);
  return { deferred: delay };
}
