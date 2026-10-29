import { and, eq, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../db/index.js';
import { jobs as jobsTable } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import type { Jobs } from './send.js';

/**
 * The `jobs` rows: the state of a background job someone started and waits for (a CSV
 * import, a snapshot restore). The request inserts the row and sends the pg-boss job under the
 * same id in its transaction; the worker's handler updates the row as it goes.
 */

export type JobRow = typeof jobsTable.$inferSelect;
export type JobKind = JobRow['kind'];

/** Finished jobs stay readable this long; `jobs.prune` deletes them after. */
export const JOB_RETENTION_DAYS = 7;

/** Inserts the row and sends its pg-boss job (same id) in the request's transaction. */
export async function startJob(
  tx: Transaction,
  jobs: Jobs,
  queue: string,
  row: Omit<typeof jobsTable.$inferInsert, 'status'>,
  conflict = 'This job is already running.'
): Promise<JobRow> {
  // The partial unique index allows one running import per table: a second one is a 409.
  const [job] = await tx.insert(jobsTable).values(row).onConflictDoNothing().returning();
  if (!job) throw new AppError('CONFLICT', { detail: conflict });
  await jobs.send(tx, queue, { workspaceId: job.workspaceId, jobId: job.id }, { id: job.id });
  return job;
}

/** The job if `userId` started it (anyone else, or another kind or base: 404). */
export async function loadOwnJob(
  tx: Transaction,
  where: { id: string; kind: JobKind; userId: string; baseId?: string; tableId?: string },
  notFound: string
): Promise<JobRow> {
  const [job] = await tx
    .select()
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.id, where.id),
        eq(jobsTable.kind, where.kind),
        eq(jobsTable.createdBy, where.userId),
        where.baseId ? eq(jobsTable.baseId, where.baseId) : undefined,
        where.tableId ? eq(jobsTable.tableId, where.tableId) : undefined
      )
    );
  if (!job) throw new AppError('NOT_FOUND', { detail: notFound });
  return job;
}

/**
 * Locks the job's row for the rest of the transaction and returns it while it is running (null
 * once it finished or is gone): a second run of the same job waits here, then sees it done.
 */
export async function lockRunningJob(tx: Transaction, id: string): Promise<JobRow | null> {
  const [job] = await tx.select().from(jobsTable).where(eq(jobsTable.id, id)).for('update');
  return job?.status === 'running' ? job : null;
}

/** Counts an attempt; the row as it is now, or null when it isn't running any more. */
export async function beginAttempt(tx: Transaction, id: string): Promise<JobRow | null> {
  const [job] = await tx
    .update(jobsTable)
    .set({ attempts: sql`${jobsTable.attempts} + 1`, startedAt: sql`coalesce(started_at, now())` })
    .where(and(eq(jobsTable.id, id), eq(jobsTable.status, 'running')))
    .returning();
  return job ?? null;
}

export async function finishJob(tx: Transaction, id: string, result: unknown): Promise<void> {
  await tx
    .update(jobsTable)
    .set({ status: 'done', result, payload: null, finishedAt: sql`now()` })
    .where(and(eq(jobsTable.id, id), eq(jobsTable.status, 'running')));
}

export async function failJob(tx: Transaction, id: string, error: string): Promise<void> {
  await tx
    .update(jobsTable)
    .set({ status: 'failed', error, payload: null, finishedAt: sql`now()` })
    .where(and(eq(jobsTable.id, id), eq(jobsTable.status, 'running')));
}

/** What the requester sees when a job failed: an AppError's detail, else a generic message. */
export function failureMessage(err: unknown, what: string): string {
  return err instanceof AppError
    ? (err.detail ?? err.message)
    : `The ${what} stopped because of a server error.`;
}

/**
 * Marks running jobs whose pg-boss job is gone or failed for good as failed (a worker killed on
 * the last attempt, retries used up), and deletes finished jobs past JOB_RETENTION_DAYS. Every
 * workspace, through the SECURITY DEFINER `jobs_sweep` and `jobs_prune`.
 */
export async function sweepJobs(db: Database): Promise<{ failed: number; pruned: number }> {
  const { rows: failed } = await db.execute<{ n: number }>(sql`SELECT jobs_sweep() AS n`);
  const { rows: pruned } = await db.execute<{ n: number }>(
    sql`SELECT jobs_prune(${JOB_RETENTION_DAYS}) AS n`
  );
  return { failed: failed[0]?.n ?? 0, pruned: pruned[0]?.n ?? 0 };
}
