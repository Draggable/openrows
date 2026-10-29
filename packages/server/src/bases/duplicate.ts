import {
  type Action,
  type Base,
  type DuplicateBaseInput,
  type DuplicateJob,
  MAX_RUNNING_DUPLICATES,
  roleAllows,
} from '@openrows/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import type { ObjectStore } from '../attachments/storage.js';
import type { Principal } from '../auth/sessions.js';
import { assertAllowed, authorize, effectiveRole, type ResolvedResource } from '../authz/policy.js';
import { resolveResource } from '../authz/resolve.js';
import { inScope, setScope } from '../authz/scope.js';
import {
  automations,
  type Database,
  jobs as jobsTable,
  storageGarbage,
  type Transaction,
} from '../db/index.js';
import { ossEntitlements } from '../edition/oss.js';
import type { Entitlements, EntitlementsProvider } from '../edition/types.js';
import type { Jobs } from '../jobs/send.js';
import {
  beginAttempt,
  failJob,
  failureMessage,
  finishJob,
  type JobRow,
  startJob,
} from '../jobs/status.js';
import { withTenant } from '../jobs/tenant.js';
import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { remapIds, type SnapshotHeader } from '../snapshots/format.js';
import { restoreBase, withRowIds } from '../snapshots/restore.js';
import { bodyLines, readHeader } from '../snapshots/writer.js';
import { assertAttachmentRoom, baseRecords, quotaExceeded } from '../usage/quota.js';

/**
 * Duplicating a base, into its own workspace or another one where the person is a creator:
 * tables, fields (links, lookups, rollups and formulas pointing at the copy's ids), sections,
 * views (configs: filters, sorts, colors, form settings), the files of views, and automations
 * (turned off, without their secrets or webhook URL tokens); with `withRecords` the records,
 * links and record files too. Never share links, webhooks, base collaborators, comments,
 * revisions or other people's personal views.
 *
 * The request checks access and the target's plan and stores the job; the worker copies from a
 * read-only REPEATABLE READ transaction on the source workspace into one transaction on the
 * target's (both scoped by RLS, ADR-002) with the snapshot restore's engine, and marks the
 * job done in the same commit, so a killed worker leaves nothing behind and the retry starts
 * over. Files are shared by object key inside a workspace and copied server-side across
 * workspaces (restore.ts).
 */

/** The pg-boss queue (jobs/queues.ts). */
export const DUPLICATE_QUEUE = 'bases.duplicate';

const inputSchema = z.object({
  targetWorkspaceId: z.uuid(),
  name: z.string().min(1).max(255),
  withRecords: z.boolean(),
});
type DuplicateJobInput = z.infer<typeof inputSchema>;

const progressSchema = z.object({
  records: z.int().min(0).catch(0),
  totalRecords: z.int().min(0).catch(0),
});

export function toDuplicateJob(job: JobRow): DuplicateJob {
  const input = job.input as DuplicateJobInput;
  return {
    id: job.id,
    baseId: job.baseId,
    workspaceId: input.targetWorkspaceId,
    withRecords: input.withRecords,
    status: job.status,
    progress: progressSchema.catch({ records: 0, totalRecords: 0 }).parse(job.progress),
    base: job.status === 'done' ? ((job.result as Base | null) ?? null) : null,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

/** The default name of a copy, as Airtable gives it. */
export const copyName = (name: string) => `${name} copy`.slice(0, 255);

/** Whether the resolved role may do `action` (the worker's re-check: no token, no route). */
function may(resolved: ResolvedResource | null, action: Action): boolean {
  if (!resolved || resolved.suspended) return false;
  const role = effectiveRole(resolved);
  return !!role && roleAllows(role, action);
}

/** The bytes of the files that come along (ready ones; record files only with records). */
async function sourceFileBytes(tx: Transaction, baseId: string, withRecords: boolean) {
  const { rows } = await tx.execute<{ n: string }>(sql`
    SELECT coalesce(sum(size + coalesce(thumbnail_size, 0)), 0) AS n FROM attachments
     WHERE base_id = ${baseId}::uuid AND status = 'ready'
       AND (share_id IS NULL OR record_id IS NOT NULL)
       ${withRecords ? sql`` : sql`AND field_id IS NULL`}`);
  return Number(rows[0]?.n ?? 0);
}

/** The target plan's records per base, against a copy of `records` records. */
function assertRecordsFit(entitlements: Entitlements, records: number) {
  const max = entitlements.limit('recordsPerBase');
  if (max === null || records <= max) return;
  throw quotaExceeded('recordsPerBase', records, max, {
    detail: `This base holds ${records.toLocaleString('en-US')} records, more than the ${max.toLocaleString('en-US')} per base the plan of the workspace you're copying to allows. Duplicate it without records, or upgrade that plan.`,
  });
}

export interface StartDuplicateContext {
  db: Database;
  jobs: Jobs;
  entitlements: EntitlementsProvider;
  /** The request's transaction, scoped to the source base's workspace. */
  tx: Transaction;
  principal: Principal;
  /** The source base (`base:duplicate` already authorized). */
  source: { id: string; workspaceId: string; name: string };
}

/**
 * The request's part: `base:create` in the target workspace (404 for a workspace the person has
 * no role in, like any other tenant's id), at most MAX_RUNNING_DUPLICATES of theirs at a time,
 * and the target plan's room for the records and files up front, then the job.
 */
export async function startDuplicate(
  ctx: StartDuplicateContext,
  body: DuplicateBaseInput
): Promise<DuplicateJob> {
  const { tx, principal, source } = ctx;
  const userId = principal.user.id;
  const targetId = body.workspaceId ?? source.workspaceId;
  const target = await resolveResource(tx, 'workspace', targetId, userId);
  assertAllowed(authorize(principal, 'base:create', target));

  const [running] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.kind, 'duplicate'),
        eq(jobsTable.status, 'running'),
        eq(jobsTable.createdBy, userId)
      )
    );
  if ((running?.n ?? 0) >= MAX_RUNNING_DUPLICATES) {
    throw new AppError('CONFLICT', {
      detail: `You can run ${MAX_RUNNING_DUPLICATES} duplicates at a time. Wait for one to finish.`,
    });
  }

  const totalRecords = body.withRecords ? await baseRecords(tx, source.id) : 0;
  const bytes = await sourceFileBytes(tx, source.id, body.withRecords);
  const check = async (ttx: Transaction) => {
    const plan = await ctx.entitlements.forWorkspace(targetId, ttx);
    assertRecordsFit(plan, totalRecords);
    if (bytes > 0) await assertAttachmentRoom(ttx, plan, targetId, bytes);
  };
  if (targetId === source.workspaceId) await check(tx);
  else await inScope(ctx.db, { workspaceId: targetId, userId }, check);

  const input: DuplicateJobInput = {
    targetWorkspaceId: targetId,
    name: body.name ?? copyName(source.name),
    withRecords: body.withRecords,
  };
  const job = await startJob(tx, ctx.jobs, DUPLICATE_QUEUE, {
    workspaceId: source.workspaceId,
    baseId: source.id,
    kind: 'duplicate',
    createdBy: userId,
    input,
    progress: { records: 0, totalRecords },
  });
  return toDuplicateJob(job);
}

/** Only the people who may still see them: personal views of anyone else stay behind. */
function ownViewsOnly(head: SnapshotHeader, userId: string): SnapshotHeader {
  return {
    ...head,
    tables: head.tables.map((t) => ({
      ...t,
      views: t.views.filter((v) => !v.personal || v.createdBy === userId),
    })),
  };
}

/** The writer's lines without their newline, as the restore reads them. */
async function* trimmed(lines: AsyncIterable<string>): AsyncGenerator<string> {
  for await (const line of lines) yield line.trimEnd();
}

/**
 * The source's automations in the copy: ids remapped (tables, fields, views; records and
 * files that came along), turned off, created by the person duplicating (whose live role runs
 * them once they turn them on). Secret header values and Slack URLs stay behind, so the
 * copy asks for them again; a webhook trigger gets its URL token when it is saved.
 */
async function copyAutomations(
  src: Transaction,
  dst: Transaction,
  from: { baseId: string },
  to: { workspaceId: string; baseId: string; userId: string },
  ids: ReadonlyMap<string, string>
): Promise<number> {
  const rows = await src
    .select()
    .from(automations)
    .where(eq(automations.baseId, from.baseId))
    .orderBy(asc(automations.createdAt), asc(automations.id));
  if (!rows.length) return 0;
  const map = await withRowIds(
    dst,
    ids,
    rows.flatMap((r) => [r.trigger, r.actions])
  );
  await dst.insert(automations).values(
    rows.map((r) => ({
      id: uuidv7(),
      workspaceId: to.workspaceId,
      baseId: to.baseId,
      name: r.name,
      description: r.description,
      enabled: false,
      trigger: remapIds(r.trigger, map),
      actions: remapIds(r.actions, map),
      triggerType: r.triggerType,
      tableId: r.tableId ? (map.get(r.tableId) ?? null) : null,
      createdBy: to.userId,
    }))
  );
  return rows.length;
}

export const duplicateJobData = z.object({ workspaceId: z.uuid(), jobId: z.uuid() });

export interface DuplicateRunDeps {
  db: Database;
  /** For files copied across workspaces; a duplicate inside one workspace never needs it. */
  store: ObjectStore | undefined;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** The workspaces' plans. The OSS edition's when omitted. */
  entitlements?: EntitlementsProvider | undefined;
  /** How often progress is written while records go in. */
  progressEveryMs?: number;
}

/**
 * The worker's handler for one duplicate (`bases.duplicate`). The person's live roles are checked
 * again (`base:duplicate` on the source, `base:create` on the target), and so are the target
 * plan's records per base and attachment room once the copy is in. AppErrors and any error on the
 * last attempt fail the job with a message; others are thrown and retried.
 */
export async function runDuplicateJob(
  deps: DuplicateRunDeps,
  raw: unknown,
  opts: { lastAttempt?: boolean } = {}
): Promise<{ status: string }> {
  const { workspaceId, jobId } = duplicateJobData.parse(raw);
  const job = await withTenant(deps.db, workspaceId, (tx) => beginAttempt(tx, jobId));
  if (!job) return { status: 'gone' };
  const userId = job.createdBy;
  const parsed = inputSchema.safeParse(job.input);
  const copiedKeys: string[] = [];
  const target = parsed.success ? parsed.data.targetWorkspaceId : workspaceId;
  try {
    if (!userId || !parsed.success) {
      throw new AppError('NOT_FOUND', { detail: 'The duplicate is gone.' });
    }
    const input = parsed.data;
    const entitlementsOf = deps.entitlements ?? ossEntitlements;
    const every = deps.progressEveryMs ?? 2000;
    const totalRecords = progressSchema.parse(job.progress).totalRecords;
    let lastProgress = Date.now();
    const onRecords = async (records: number) => {
      if (Date.now() - lastProgress < every) return;
      lastProgress = Date.now();
      await withTenant(deps.db, workspaceId, (tx) =>
        tx
          .update(jobsTable)
          .set({ progress: { records, totalRecords: Math.max(totalRecords, records) } })
          .where(and(eq(jobsTable.id, jobId), eq(jobsTable.status, 'running')))
      );
    };

    const base = await inScope(deps.db, { workspaceId: target, userId }, async (dst) => {
      // Held to the end: a second run of the job waits, then finds it done. (Not the job's row
      // lock: progress is written to that row from another connection meanwhile.)
      await dst.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${jobId}, 7142))`);
      const [current] = await withTenant(deps.db, workspaceId, (tx) =>
        tx.select({ status: jobsTable.status }).from(jobsTable).where(eq(jobsTable.id, jobId))
      );
      if (current?.status !== 'running') return null;
      const targetWorkspace = await resolveResource(dst, 'workspace', target, userId);
      const role = targetWorkspace?.workspaceRole ?? null;
      if (!role || !may(targetWorkspace, 'base:create')) {
        throw new AppError(role ? 'FORBIDDEN' : 'NOT_FOUND', {
          detail: role
            ? 'Only creators of the workspace can add a base to it.'
            : 'The workspace is gone, or you lost access to it.',
        });
      }
      const plan = await entitlementsOf.forWorkspace(target, dst);

      const copy = await deps.db.transaction(
        async (src) => {
          await setScope(src, { workspaceId, userId });
          const source = await resolveResource(src, 'base', job.baseId, userId);
          if (!may(source, 'base:duplicate')) {
            throw new AppError('NOT_FOUND', {
              detail: 'The base is gone, or you lost access to it.',
            });
          }
          const read = await readHeader(src, workspaceId, job.baseId);
          const head = ownViewsOnly(read.head, userId);
          const counts = { tables: 0, records: 0 };
          const lines = trimmed(
            bodyLines(src, job.baseId, head, read.tableRows, counts, {
              records: input.withRecords,
            })
          );
          const restored = await restoreBase(
            { tx: dst, workspaceId: target, userId },
            deps.store,
            head,
            lines,
            {
              name: input.name,
              role,
              // Edit permissions need the target's plan; without it the copy has none.
              keepPermissions: plan.has('editPermissions'),
              onRecords,
              copiedKeys,
            }
          );
          await copyAutomations(
            src,
            dst,
            { baseId: job.baseId },
            { workspaceId: target, baseId: restored.base.id, userId },
            restored.ids
          );
          return restored.base;
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' }
      );

      // The target plan again, on what actually went in: it may have filled up meanwhile.
      assertRecordsFit(plan, await baseRecords(dst, copy.id));
      await assertAttachmentRoom(dst, plan, target, 0);
      // The job's row is the source workspace's: done in the same commit as the copy.
      await setScope(dst, { workspaceId, userId });
      await finishJob(dst, jobId, copy);
      return copy;
    });
    if (base) {
      deps.logger.info(
        { duplicateId: jobId, from: job.baseId, baseId: base.id, workspaceId: target },
        'base duplicated'
      );
    }
    return { status: base ? 'done' : 'gone' };
  } catch (err) {
    // Files copied for a copy that never committed: garbage for the GC of their workspace.
    if (copiedKeys.length) {
      await withTenant(deps.db, target, (tx) =>
        tx.insert(storageGarbage).values(
          copiedKeys.map((key) => ({
            workspaceId: target,
            storageKey: key,
            kind: 'file' as const,
          }))
        )
      ).catch((e: unknown) => deps.logger.error({ err: e, duplicateId: jobId }, 'garbage lost'));
    }
    if (!(err instanceof AppError) && !opts.lastAttempt) throw err;
    await withTenant(deps.db, workspaceId, (tx) =>
      failJob(tx, jobId, failureMessage(err, 'duplicate'))
    );
    deps.logger.warn({ err, duplicateId: jobId }, 'base duplicate failed');
    return { status: 'failed' };
  }
}
