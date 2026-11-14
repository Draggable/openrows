import {
  type AirtableImport,
  type AirtableReport,
  type AttachmentValue,
  emptyAirtableCollaboratorsReport,
  emptyAirtableCommentsReport,
  getFieldType,
  MAX_AIRTABLE_TABLE_RECORDS,
  MAX_LINKS_PER_CELL,
  roleAllows,
  type UserRole,
} from '@openrows/shared';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { storageUsage } from '../attachments/service.js';
import type { ObjectStore } from '../attachments/storage.js';
import type { Cipher } from '../auth/crypto.js';
import { resolveResource } from '../authz/resolve.js';
import { inScope } from '../authz/scope.js';
import { createBase } from '../bases/service.js';
import { qualified } from '../data/columns.js';
import { recomputeForRecords } from '../data/computed/engine.js';
import {
  airtableImportRecords,
  bases,
  type Database,
  jobs as jobsTable,
  type Transaction,
} from '../db/index.js';
import { ossEntitlements } from '../edition/oss.js';
import type { AuditSink, EntitlementsProvider } from '../edition/types.js';
import {
  type FieldRow,
  fieldType,
  liveFields,
  parseOptions,
  type SchemaContext,
  type TableRow,
} from '../fields/service.js';
import type { Jobs } from '../jobs/send.js';
import {
  beginAttempt,
  failJob,
  failureMessage,
  finishJob,
  JOB_RETENTION_DAYS,
  type JobRow,
  lockRunningJob,
  startJob,
} from '../jobs/status.js';
import { withTenant } from '../jobs/tenant.js';
import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { SafeFetch } from '../lib/safe-fetch/index.js';
import { createRecords, type RecordContext, updateRecords } from '../records/service.js';
import { loadTable, MAX_TABLES_PER_BASE } from '../tables/service.js';
import { type AirtableClient, type AirtableClientDeps, createAirtableClient } from './client.js';
import {
  applyCollaborators,
  COLLABORATORS_NOT_APPLIED,
  readCollaborators,
} from './collaborators.js';
import {
  COMMENTS_OUT_OF_TIME,
  COMMENTS_SCOPE_MISSING,
  COMMENTS_STOPPED,
  COMMENTS_TOKEN_REJECTED,
  type CommentReadOutcome,
  MAX_COMMENT_FAILURES,
  type RecordCommentsRead,
  readFailure,
  readRecordComments,
  writeRecordComments,
} from './comments.js';
import {
  type AirtableFile,
  ATTACHMENT_CONCURRENCY,
  airtableFiles,
  copyFile,
  insertFiles,
  mapLimit,
  type StoredFile,
} from './files.js';
import { cellInput, planTables } from './mapping.js';
import { buildSchema, capped, type LinkPair, type TableState } from './schema.js';

/**
 * The Airtable importer's job. The request checks the token against Airtable,
 * creates one empty base per picked Airtable base and stores a job for each (`jobs`, kind
 * `airtable`) with the token encrypted in `payload`; the worker's `airtable.import` then fills
 * the base:
 *
 * 1. Schema, in one transaction with the progress (schema.ts): the tables, their fields
 *    (mapping.ts), the links between them, formulas, lookups, rollups and counts, the views.
 * 2. Records, a page of 100 at a time (Airtable's page size, 5 requests a second): the page's
 *    files are copied from Airtable's file hosts first (files.ts), then the page is written
 *    through the RecordService in one transaction that also gives the records Airtable's
 *    creation time and creator (`seedCreated`), stores each record's Airtable id and link cells
 *    in the record map (`airtable_import_records`) and commits the progress, so a retry resumes
 *    after the last page.
 * 3. Links, once every table's records are in: per link pair, from the side whose cells hold
 *    the fewest links, 100 records a transaction, Airtable's record ids mapped to ours through
 *    the record map and written through the RecordService (the inverse side, lookups, rollups
 *    and counts follow).
 * 4. Comments, when the token has `data.recordComments:read` (comments.ts): Airtable lists them
 *    per record, so 25 records' comments are read (one request or more each), then written in
 *    one transaction with the progress, straight into the threads (no outbox events or
 *    notifications). A 403 on the first record means the token lacks the scope: the pass ends
 *    with one report line, and the import still succeeds. The map is deleted when the job ends.
 * 5. Collaborators (collaborators.ts), once everything else is in: Airtable's base collaborators
 *    are read (one request), and in the transaction that finishes the job, workspace members whose
 *    access is lower than their Airtable level get a base role. Nobody is invited or emailed;
 *    everyone else is listed in the report. A cancelled or failed import never gets here, and a
 *    refused or failed read only adds a report line.
 *
 * Every step runs as the person who started it, with their live workspace role (a creator's),
 * and only ever in the job's own base. The token is decrypted for the job only, and cleared from
 * the row when the job ends (or after 24 hours, by `jobs_sweep`). Cancelling fails the job,
 * which the next step sees.
 */

export const AIRTABLE_QUEUE = 'airtable.import';

interface Input {
  airtableBaseId: string;
  name: string;
}

interface Progress {
  phase: 'schema' | 'records' | 'links' | 'comments';
  tables: TableState[];
  tableIndex: number;
  offset: string | null;
  records: number;
  attachments: number;
  attachmentsFailed: number;
  links: LinkPair[];
  linkIndex: number;
  /** The last Airtable record id of the current pair's side whose links were written. */
  linkCursor: string | null;
  linkedRecords: number;
  /** The table (index into `tables`) whose records' comments are being read. */
  commentTable: number;
  /** The last Airtable record id of that table whose comments were read. */
  commentCursor: string | null;
  commentRecords: number;
  comments: number;
  /** Whether Airtable listed comments at least once (a later 403 is that record's). */
  commentsRead: boolean;
  /** Records in a row whose comments couldn't be read. */
  commentFailures: number;
  cancelled?: boolean;
  report: AirtableReport;
}

const emptyReport = (): AirtableReport => ({
  tables: [],
  unsupportedFields: [],
  untranslatedFormulas: [],
  converted: [],
  skippedCells: 0,
  truncatedTables: [],
  failedAttachments: [],
  skippedLinks: 0,
  views: 0,
  unsupportedViews: [],
  partialViews: [],
  comments: emptyAirtableCommentsReport(),
  collaborators: null,
});

const progressOf = (job: JobRow): Progress => {
  const p = job.progress as Partial<Progress>;
  return {
    phase: p.phase ?? 'schema',
    tables: p.tables ?? [],
    tableIndex: p.tableIndex ?? 0,
    offset: p.offset ?? null,
    records: p.records ?? 0,
    attachments: p.attachments ?? 0,
    attachmentsFailed: p.attachmentsFailed ?? 0,
    links: p.links ?? [],
    linkIndex: p.linkIndex ?? 0,
    linkCursor: p.linkCursor ?? null,
    linkedRecords: p.linkedRecords ?? 0,
    commentTable: p.commentTable ?? 0,
    commentCursor: p.commentCursor ?? null,
    commentRecords: p.commentRecords ?? 0,
    comments: p.comments ?? 0,
    commentsRead: p.commentsRead ?? false,
    commentFailures: p.commentFailures ?? 0,
    ...(p.cancelled ? { cancelled: true } : {}),
    report: { ...emptyReport(), ...p.report },
  };
};

/**
 * How far along an import is, roughly: records and comments weigh most (comments take a
 * request per record), then links. Without the comments scope the last part goes at once.
 */
function percentOf(job: JobRow, p: Progress): number {
  if (job.status === 'done') return 100;
  if (p.phase === 'schema') return 2;
  if (p.phase === 'records') {
    const share = p.tables.length ? Math.min(p.tableIndex, p.tables.length) / p.tables.length : 1;
    return Math.round(5 + 40 * share);
  }
  if (p.phase === 'links') {
    const share = p.links.length ? Math.min(p.linkIndex, p.links.length) / p.links.length : 1;
    return Math.round(45 + 10 * share);
  }
  const share = p.records ? Math.min(p.commentRecords, p.records) / p.records : 1;
  return Math.min(99, Math.round(55 + 44 * share));
}

export function toAirtableImport(job: JobRow): AirtableImport {
  const input = job.input as Input;
  const p = progressOf(job);
  const report = (job.result as AirtableReport | null) ?? p.report;
  return {
    id: job.id,
    baseId: job.baseId,
    airtableBaseId: input.airtableBaseId,
    name: input.name,
    status: p.cancelled ? 'cancelled' : job.status,
    phase: p.phase,
    tables: p.tables.length,
    tablesDone:
      job.status === 'done' || p.phase === 'links' || p.phase === 'comments'
        ? p.tables.length
        : Math.min(p.tableIndex, p.tables.length),
    records: p.records,
    attachments: p.attachments,
    attachmentsFailed: p.attachmentsFailed,
    linkedRecords: p.linkedRecords,
    commentRecords: p.commentRecords,
    comments: p.comments,
    percent: percentOf(job, p),
    report: {
      ...emptyReport(),
      ...report,
      tables: p.tables.map((t) => ({
        name: t.name,
        tableId: t.tableId,
        fields: t.fields.length,
        records: t.records,
      })),
    },
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

export interface AirtableDeps {
  cipher: Cipher;
  http: SafeFetch;
  /** Airtable's API origin and file hosts (config `AIRTABLE_*`; defaults: Airtable's own). */
  origin?: string;
  attachmentHosts?: readonly string[];
  /** Where copied attachments go (the worker's S3); without it files are reported as failed. */
  store?: ObjectStore;
  /** Waits between requests (tests skip them). */
  sleep?: AirtableClientDeps['sleep'];
  now?: AirtableClientDeps['now'];
  /** The workspaces' plans: records per base. The OSS edition's when omitted. */
  entitlements?: EntitlementsProvider | undefined;
  /**
   * Malware scanning (CLAMAV_URL): copied files are stored `scanning`, and the worker's
   * scan sweep scans them, like uploads.
   */
  scanFiles?: boolean | undefined;
  /** The edition's audit log: base roles given from Airtable's collaborators are recorded. */
  audit?: AuditSink | undefined;
}

export function airtableClient(deps: AirtableDeps, token: string) {
  return createAirtableClient(token, {
    http: deps.http,
    sleep: deps.sleep,
    now: deps.now,
    ...(deps.origin ? { origin: deps.origin } : {}),
    ...(deps.attachmentHosts ? { attachmentHosts: deps.attachmentHosts } : {}),
  });
}

/**
 * Creates the new bases and their jobs, in the request's transaction. `picked` are Airtable
 * bases the token can read (the request listed them).
 */
export async function startAirtableImports(
  ctx: SchemaContext & { role: UserRole },
  deps: { jobs: Jobs; cipher: Cipher },
  token: string,
  picked: { id: string; name: string }[]
): Promise<AirtableImport[]> {
  const out: AirtableImport[] = [];
  for (const source of picked) {
    const name = source.name.trim().slice(0, 255) || 'Airtable base';
    const base = await createBase(ctx, { name }, ctx.role);
    const input: Input = { airtableBaseId: source.id, name };
    const job = await startJob(ctx.tx, deps.jobs, AIRTABLE_QUEUE, {
      workspaceId: ctx.workspaceId,
      baseId: base.id,
      kind: 'airtable',
      createdBy: ctx.userId,
      input,
      payload: deps.cipher.encrypt(token).toString('base64'),
      progress: { phase: 'schema', report: emptyReport() },
    });
    out.push(toAirtableImport(job));
  }
  return out;
}

/** The caller's Airtable imports in the workspace, newest first (finished ones for 7 days). */
export async function listAirtableImports(
  tx: Transaction,
  userId: string
): Promise<AirtableImport[]> {
  const rows = await tx
    .select()
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.kind, 'airtable'),
        eq(jobsTable.createdBy, userId),
        gt(jobsTable.createdAt, sql`now() - make_interval(days => ${JOB_RETENTION_DAYS})`)
      )
    )
    .orderBy(desc(jobsTable.createdAt))
    .limit(50);
  return rows.map(toAirtableImport);
}

export const airtableJobData = z.object({ workspaceId: z.uuid(), jobId: z.uuid() });

export interface AirtableRunDeps extends AirtableDeps {
  db: Database;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export interface AirtableRunOptions {
  lastAttempt?: boolean;
  /** Called after each committed page or batch (tests: a crash between pages). */
  afterPage?: (records: number) => Promise<void> | void;
}

/** Thrown inside a step when the job finished meanwhile (another run, the sweep). */
class JobGone extends Error {}

/**
 * The worker's handler for one Airtable import. AppErrors (the token was refused, the base is
 * gone, the person lost their role) and any error on the last attempt fail the job with a
 * message; other errors are thrown and pg-boss retries.
 */
export async function runAirtableImport(
  deps: AirtableRunDeps,
  raw: unknown,
  opts: AirtableRunOptions = {}
): Promise<{ status: string }> {
  const { workspaceId, jobId } = airtableJobData.parse(raw);
  const job = await withTenant(deps.db, workspaceId, (tx) => beginAttempt(tx, jobId));
  if (!job) return { status: 'gone' };
  try {
    await importBase(deps, job, opts);
    return { status: 'done' };
  } catch (err) {
    if (err instanceof JobGone) return { status: 'gone' };
    if (!(err instanceof AppError) && !opts.lastAttempt) throw err;
    await withTenant(deps.db, workspaceId, (tx) =>
      failJob(tx, jobId, failureMessage(err, 'Airtable import'))
    );
    deps.logger.warn({ err, airtableImportId: jobId }, 'airtable import failed');
    return { status: 'failed' };
  }
}

/** The starter's live workspace role: creating bases (a creator) is what the import needs. */
async function liveRole(tx: Transaction, baseId: string, userId: string): Promise<UserRole> {
  const resolved = await resolveResource(tx, 'base', baseId, userId);
  const role = resolved?.workspaceRole ?? null;
  if (!resolved || !role) {
    throw new AppError('NOT_FOUND', { detail: 'The new base is gone, or you lost access to it.' });
  }
  if (!roleAllows(role, 'base:create')) {
    throw new AppError('FORBIDDEN', {
      detail: 'Only creators of the workspace can import from Airtable.',
    });
  }
  return role;
}

/** A table of the job's base, never another's. */
async function ownTable(tx: Transaction, job: JobRow, tableId: string): Promise<TableRow> {
  const table = await loadTable(tx, tableId);
  if (table.baseId !== job.baseId) throw new Error('airtable: a table outside the job base');
  return table;
}

/**
 * Stops a running import of the caller's (the route checked who started it): the job fails as
 * cancelled, its token and record map go, and the worker's next step sees it ended. The new
 * base keeps what was imported. A finished import is left as it is.
 */
export async function cancelAirtableImport(tx: Transaction, job: JobRow): Promise<JobRow> {
  const [row] = await tx
    .update(jobsTable)
    .set({
      status: 'failed',
      error: 'You cancelled the import. The base keeps what was imported.',
      payload: null,
      finishedAt: sql`now()`,
      progress: sql`${jobsTable.progress} || '{"cancelled": true}'::jsonb`,
    })
    .where(and(eq(jobsTable.id, job.id), eq(jobsTable.status, 'running')))
    .returning();
  if (!row) return job;
  await tx.delete(airtableImportRecords).where(eq(airtableImportRecords.jobId, job.id));
  return row;
}

/** One record's work before its page's transaction: cells, files, Airtable link ids. */
interface Prepared {
  airtableId: string;
  /** When Airtable says the record was created. */
  createdTime?: string;
  cells: Record<string, unknown>;
  files: { fieldId: string; stored: StoredFile[] }[];
  links: Record<string, string[]> | null;
  /** Files that couldn't be copied. */
  failures: { fieldId: string; filename: string; message: string }[];
}

/** Most Airtable record ids kept for one link cell (ours take MAX_LINKS_PER_CELL). */
const MAX_LINK_IDS = MAX_LINKS_PER_CELL + 1;

/** Records whose comments are read before each write. */
const COMMENT_BATCH = 25;
/**
 * Past this since the start, the comments pass stops (reported): the token is deleted at 24
 * hours (`jobs_sweep`), which would fail an import whose records are all in.
 */
const COMMENTS_DEADLINE_MS = 23 * 60 * 60 * 1000;

async function importBase(deps: AirtableRunDeps, job: JobRow, opts: AirtableRunOptions) {
  const { workspaceId, id: jobId, baseId } = job;
  const userId = job.createdBy;
  if (!userId) throw new AppError('NOT_FOUND', { detail: 'The import is gone.' });
  const input = job.input as Input;
  const token = job.payload ? deps.cipher.decrypt(Buffer.from(job.payload, 'base64')) : undefined;
  if (!token) {
    throw new AppError('CONFLICT', {
      detail: 'The Airtable token is no longer kept for this import. Start it again.',
    });
  }
  const airtable = airtableClient(deps, token);
  // The workspace's plan: past records per base the job fails with the limit's message,
  // keeping what it imported.
  const plan = (tx: Transaction) =>
    (deps.entitlements ?? ossEntitlements).forWorkspace(workspaceId, tx);
  const step = <T>(fn: (tx: Transaction, row: JobRow, role: UserRole) => Promise<T>) =>
    inScope(deps.db, { workspaceId, userId }, async (tx) => {
      const row = await lockRunningJob(tx, jobId);
      if (!row) throw new JobGone();
      return fn(tx, row, await liveRole(tx, baseId, userId));
    });
  const save = (tx: Transaction, progress: Progress) =>
    tx.update(jobsTable).set({ progress }).where(eq(jobsTable.id, jobId));

  // 1. The schema.
  let progress = progressOf(job);
  if (progress.phase === 'schema') {
    const sources = await airtable.tables(input.airtableBaseId);
    const plans = planTables(sources).slice(0, MAX_TABLES_PER_BASE);
    progress = await step(async (tx, row, role) => {
      const current = progressOf(row);
      if (current.phase !== 'schema') return current;
      const [base] = await tx.select().from(bases).where(eq(bases.id, baseId));
      if (!base) throw new AppError('NOT_FOUND', { detail: 'The new base is gone.' });
      const ctx: SchemaContext = { tx, workspaceId, userId, role };
      const report = emptyReport();
      const { tables, links } = await buildSchema(ctx, base, plans, sources, report);
      const next: Progress = {
        ...current,
        phase: 'records',
        tables,
        links,
        tableIndex: 0,
        offset: null,
        report,
      };
      await save(tx, next);
      return next;
    });
  }

  // 2. The records (and their files), a page at a time.
  const people = await inScope(deps.db, { workspaceId, userId }, (tx) => memberEmails(tx));
  const optionsCache = new Map<string, Map<string, { field: FieldRow; options: unknown }>>();
  while (progress.phase === 'records') {
    const table = progress.tables[progress.tableIndex];
    if (!table) {
      progress = await step(async (tx, row) => {
        const next: Progress = { ...progressOf(row), phase: 'links' };
        await save(tx, next);
        return next;
      });
      break;
    }
    const page =
      table.records < MAX_AIRTABLE_TABLE_RECORDS
        ? await airtable.records(
            input.airtableBaseId,
            table.airtableId,
            progress.offset ?? undefined
          )
        : null;
    const room = MAX_AIRTABLE_TABLE_RECORDS - table.records;
    const records = page?.records.slice(0, room) ?? [];
    const prepared = await prepareRecords(deps, airtable, job, table, records);
    const before = progress;
    progress = await step(async (tx, row, role) => {
      const current = progressOf(row);
      // Another run got here first: carry on from what it committed.
      if (current.tableIndex !== before.tableIndex || current.offset !== before.offset) {
        return current;
      }
      const report = current.report;
      const tables = current.tables.map((t) => ({ ...t }));
      const state = tables[current.tableIndex] as TableState;
      if (!page) return advance(tx, current, tables, null);
      const ours = await ownTable(tx, job, state.tableId);
      let fieldsById = optionsCache.get(state.tableId);
      if (!fieldsById) {
        fieldsById = new Map(
          (await liveFields(tx, state.tableId)).map((f) => [
            f.id,
            { field: f, options: parseOptions(fieldType(f), f.config) },
          ])
        );
        optionsCache.set(state.tableId, fieldsById);
      }
      let copied = 0;
      let failed = 0;
      const inputs: Record<string, unknown>[] = [];
      for (const r of prepared) {
        const cells: Record<string, unknown> = {};
        for (const f of state.fields) {
          if (!f.copy || f.type === 'attachment') continue;
          const raw = r.cells[f.airtableId];
          if (raw === undefined || raw === null || raw === '') continue;
          const target = fieldsById.get(f.fieldId);
          if (!target) continue;
          const value = getFieldType(f.type).coerce(cellInput(f, raw, people), target.options);
          if (value === null || (Array.isArray(value) && value.length === 0)) {
            report.skippedCells++;
          } else cells[f.fieldId] = value;
        }
        for (const file of r.files) {
          const values: AttachmentValue[] = await insertFiles(
            tx,
            { workspaceId, baseId, tableId: state.tableId, fieldId: file.fieldId, userId },
            file.stored,
            deps.scanFiles ? 'scanning' : 'ready'
          );
          if (values.length) cells[file.fieldId] = values;
          copied += values.length;
        }
        inputs.push(cells);
      }
      for (const f of prepared.flatMap((r) => r.failures)) {
        failed++;
        capped(report.failedAttachments, {
          table: state.name,
          field: fieldsById.get(f.fieldId)?.field.name ?? '',
          filename: f.filename,
          message: f.message,
        });
      }
      const created = inputs.length
        ? await createRecords(
            {
              tx,
              workspaceId,
              userId,
              role,
              table: ours,
              unmatchedLinks: 'skip',
              entitlements: await plan(tx),
            },
            inputs
          )
        : [];
      if (created.length) {
        await seedCreated(
          tx,
          ours,
          state,
          created.map((rec) => rec.id),
          prepared,
          people,
          report
        );
        await tx
          .insert(airtableImportRecords)
          .values(
            created.map((rec, i) => ({
              jobId,
              workspaceId,
              airtableId: prepared[i]?.airtableId ?? '',
              tableId: state.tableId,
              recordId: rec.id,
              links: prepared[i]?.links ?? null,
            }))
          )
          .onConflictDoNothing();
      }
      state.records += inputs.length;
      const more = page.offset && state.records < MAX_AIRTABLE_TABLE_RECORDS ? page.offset : null;
      if ((page.offset || records.length < page.records.length) && !more) {
        capped(report.truncatedTables, state.name);
      }
      return advance(
        tx,
        {
          ...current,
          records: current.records + inputs.length,
          attachments: current.attachments + copied,
          attachmentsFailed: current.attachmentsFailed + failed,
        },
        tables,
        more
      );
    });
    await opts.afterPage?.(progress.records);
  }

  // 3. The links, a pair at a time, 100 records a transaction.
  while (progress.phase === 'links' && progress.linkIndex < progress.links.length) {
    const before = progress;
    progress = await step(async (tx, row, role) => {
      const current = progressOf(row);
      if (current.linkIndex !== before.linkIndex || current.linkCursor !== before.linkCursor) {
        return current;
      }
      const links = current.links.map((l) => ({ ...l }));
      const pair = links[current.linkIndex] as LinkPair;
      if (!pair.writer) pair.writer = await writerOf(tx, jobId, pair);
      const side = (pair.writer === 'b' ? pair.b : pair.a) ?? pair.a;
      const batch = await writeLinks(
        {
          tx,
          workspaceId,
          userId,
          role,
          table: await ownTable(tx, job, side.tableId),
          entitlements: await plan(tx),
        },
        jobId,
        side,
        current.linkCursor
      );
      const report = current.report;
      report.skippedLinks += batch.skipped;
      const next: Progress = {
        ...current,
        links,
        linkedRecords: current.linkedRecords + batch.written,
        ...(batch.cursor
          ? { linkCursor: batch.cursor }
          : { linkCursor: null, linkIndex: current.linkIndex + 1 }),
      };
      await save(tx, next);
      return next;
    });
    await opts.afterPage?.(progress.records);
  }
  if (progress.phase === 'links') {
    progress = await step(async (tx, row) => {
      const current = progressOf(row);
      if (current.phase !== 'links') return current;
      const next: Progress = {
        ...current,
        phase: 'comments',
        commentTable: 0,
        commentCursor: null,
      };
      await save(tx, next);
      return next;
    });
  }

  // 4. The comments, 25 records at a time.
  while (
    progress.phase === 'comments' &&
    progress.commentTable < progress.tables.length &&
    !progress.report.comments.unavailable
  ) {
    const table = progress.tables[progress.commentTable] as TableState;
    const before = progress;
    const map = airtableImportRecords;
    const batch = await inScope(deps.db, { workspaceId, userId }, (tx) =>
      tx
        .select({ airtableId: map.airtableId, recordId: map.recordId })
        .from(map)
        .where(
          and(
            eq(map.jobId, jobId),
            eq(map.tableId, table.tableId),
            before.commentCursor ? gt(map.airtableId, before.commentCursor) : undefined
          )
        )
        .orderBy(asc(map.airtableId))
        .limit(COMMENT_BATCH)
    );
    // Read outside any transaction (Airtable takes 5 requests a second).
    const read: { recordId: string; airtableId: string; result: RecordCommentsRead }[] = [];
    let commentsRead = before.commentsRead;
    let failures = before.commentFailures;
    let unread = 0;
    let unavailable: string | null = null;
    for (const r of batch) {
      if (Date.now() - job.createdAt.getTime() > COMMENTS_DEADLINE_MS) {
        unavailable = COMMENTS_OUT_OF_TIME;
        break;
      }
      let result: RecordCommentsRead | null = null;
      let outcome: CommentReadOutcome;
      try {
        result = await readRecordComments(
          airtable,
          input.airtableBaseId,
          table.airtableId,
          r.airtableId
        );
        outcome = result.status === 'ok' ? 'read' : result.status;
      } catch (err) {
        outcome = readFailure(err);
      }
      if (outcome === 'rejected') unavailable = COMMENTS_TOKEN_REJECTED;
      else if (outcome === 'forbidden' && !commentsRead) unavailable = COMMENTS_SCOPE_MISSING;
      if (unavailable) break;
      if (outcome === 'read') {
        commentsRead = true;
        failures = 0;
      } else {
        unread++;
        if (outcome !== 'missing') failures++;
      }
      read.push({
        recordId: r.recordId,
        airtableId: r.airtableId,
        result: result ?? { status: 'missing' },
      });
      if (failures >= MAX_COMMENT_FAILURES) {
        unavailable = COMMENTS_STOPPED;
        break;
      }
    }
    progress = await step(async (tx, row) => {
      const current = progressOf(row);
      if (
        current.commentTable !== before.commentTable ||
        current.commentCursor !== before.commentCursor
      ) {
        return current;
      }
      const report = current.report;
      const ours = await ownTable(tx, job, table.tableId);
      const ok = read.flatMap((r) =>
        r.result.status === 'ok' ? [{ ...r, result: r.result }] : []
      );
      // Records deleted meanwhile (in the new base, by someone) are left out.
      const live = ok.length
        ? await liveRecordIds(
            { tx, table: ours },
            ok.map((r) => r.recordId)
          )
        : new Set<string>();
      let written = 0;
      for (const r of ok) {
        if (!live.has(r.recordId)) continue;
        written += await writeRecordComments(
          tx,
          { workspaceId, baseId, tableId: ours.id, recordId: r.recordId },
          table.name,
          r.result,
          people,
          report.comments
        );
      }
      report.comments.unreadRecords += unread;
      if (unavailable) report.comments.unavailable = unavailable;
      const last = read.at(-1)?.airtableId ?? null;
      const tableDone = !unavailable && batch.length < COMMENT_BATCH;
      const next: Progress = {
        ...current,
        report,
        commentsRead,
        commentFailures: failures,
        commentRecords: current.commentRecords + read.length,
        comments: current.comments + written,
        ...(tableDone
          ? { commentTable: current.commentTable + 1, commentCursor: null }
          : { commentCursor: last ?? current.commentCursor }),
      };
      await save(tx, next);
      return next;
    });
    await opts.afterPage?.(progress.records);
  }

  // 5. The collaborators: read now, applied with the job's end (a cancel since skips them).
  const collaborators = await readCollaborators(airtable, input.airtableBaseId);
  if ('err' in collaborators) {
    deps.logger.warn(
      { err: collaborators.err, airtableImportId: jobId },
      'airtable collaborators not read'
    );
  }
  await step(async (tx, row) => {
    const p = progressOf(row);
    const report = p.report;
    if ('plan' in collaborators) {
      const ctx = {
        tx,
        workspaceId,
        baseId,
        userId,
        entitlements: await plan(tx),
        audit: deps.audit,
      };
      // In a savepoint: anything unexpected gives nobody a role, and the import still ends.
      try {
        report.collaborators = await tx.transaction((sp) =>
          applyCollaborators({ ...ctx, tx: sp as Transaction }, collaborators.plan)
        );
      } catch (err) {
        deps.logger.error({ err, airtableImportId: jobId }, 'airtable collaborators not applied');
        report.collaborators = {
          ...collaborators.plan.report,
          unavailable: COLLABORATORS_NOT_APPLIED,
        };
      }
    } else {
      report.collaborators = {
        ...emptyAirtableCollaboratorsReport(),
        unavailable: collaborators.unavailable,
      };
    }
    await tx.delete(airtableImportRecords).where(eq(airtableImportRecords.jobId, jobId));
    await finishJob(tx, jobId, report);
  });
  deps.logger.info(
    { airtableImportId: jobId, baseId, tables: progress.tables.length, records: progress.records },
    'airtable base imported'
  );

  async function advance(
    tx: Transaction,
    current: Progress,
    tables: TableState[],
    offset: string | null
  ): Promise<Progress> {
    const next: Progress = {
      ...current,
      tables,
      offset,
      tableIndex: offset ? current.tableIndex : current.tableIndex + 1,
    };
    await save(tx, next);
    return next;
  }
}

/** A file not copied because the workspace's plan has no attachment storage left. */
const NO_STORAGE_ROOM =
  "Not copied: the workspace's plan has no attachment storage left. Upgrade it, then add the file.";

/**
 * A page's records before its transaction: their cells by Airtable field id, their files
 * copied (attachments' URLs expire, so now), and their link cells' Airtable record ids.
 */
async function prepareRecords(
  deps: AirtableRunDeps,
  airtable: AirtableClient,
  job: JobRow,
  table: TableState,
  records: { id: string; createdTime?: string; fields: Record<string, unknown> }[]
): Promise<Prepared[]> {
  const fileFields = table.fields.filter((f) => f.copy && f.type === 'attachment');
  const linkFields = table.fields.filter((f) => f.link);
  const target = { workspaceId: job.workspaceId, baseId: job.baseId, tableId: table.tableId };
  const jobsList: { record: number; field: number; file: AirtableFile }[] = [];
  records.forEach((r, record) => {
    fileFields.forEach((f, field) => {
      for (const file of airtableFiles(r.fields[f.airtableId])) {
        jobsList.push({ record, field, file });
      }
    });
  });
  // The plan's attachment storage: files past it aren't copied, and are reported as
  // failed attachments; the records are imported without them.
  let room: number | null = null;
  if (jobsList.length) {
    room = await withTenant(deps.db, job.workspaceId, async (tx) => {
      const entitlements = await (deps.entitlements ?? ossEntitlements).forWorkspace(
        job.workspaceId,
        tx
      );
      const max = entitlements.limit('attachmentBytesPerWorkspace');
      return max === null ? null : max - (await storageUsage(tx, job.workspaceId)).bytes;
    });
  }
  const results = await mapLimit(
    jobsList,
    ATTACHMENT_CONCURRENCY,
    async (j): Promise<StoredFile | { error: string }> => {
      if (room !== null && room - (j.file.size ?? 0) < 0) return { error: NO_STORAGE_ROOM };
      if (room !== null) room -= j.file.size ?? 0;
      const result = await copyFile(airtable, deps.store, target, j.file);
      if (room !== null && 'id' in result) {
        room -= result.size + (result.thumbnailSize ?? 0) - (j.file.size ?? 0);
      }
      return result;
    }
  );
  return records.map((r, i) => {
    const failures: Prepared['failures'] = [];
    const files = fileFields.map((f, fi) => {
      const stored: StoredFile[] = [];
      jobsList.forEach((j, k) => {
        if (j.record !== i || j.field !== fi) return;
        const result = results[k];
        if (result && 'id' in result) stored.push(result);
        else {
          failures.push({
            fieldId: f.fieldId,
            filename: j.file.filename,
            message: result?.error ?? 'The file could not be copied.',
          });
        }
      });
      return { fieldId: f.fieldId, stored };
    });
    const links: Record<string, string[]> = {};
    for (const f of linkFields) {
      const raw = r.fields[f.airtableId];
      if (!Array.isArray(raw)) continue;
      const ids = raw
        .filter((v): v is string => typeof v === 'string' && /^rec[A-Za-z0-9]{14}$/.test(v))
        .slice(0, MAX_LINK_IDS);
      if (ids.length) links[f.fieldId] = ids;
    }
    return {
      airtableId: r.id,
      ...(r.createdTime ? { createdTime: r.createdTime } : {}),
      cells: r.fields,
      files: files.filter((f) => f.stored.length),
      links: Object.keys(links).length ? links : null,
      failures,
    };
  });
}

/**
 * Gives a page's new records Airtable's creation time and, when the table has a Created by
 * field, its creator (the person matched by email, else nobody): what our Created time and
 * Created by fields and CREATED_TIME() read. The records' formulas are then computed again.
 * Lookups and rollups of these fields in other tables are computed by the links pass, later.
 */
async function seedCreated(
  tx: Transaction,
  table: TableRow,
  state: TableState,
  ids: readonly string[],
  prepared: readonly Prepared[],
  people: ReadonlyMap<string, string>,
  report: AirtableReport
): Promise<void> {
  const creator = state.fields.find((f) => f.type === 'createdBy');
  const rows = ids.map((id, i) => {
    const p = prepared[i];
    const time = p?.createdTime ? Date.parse(p.createdTime) : Number.NaN;
    const row: { id: string; created_at: string | null; created_by?: string | null } = {
      id,
      created_at: Number.isNaN(time) ? null : new Date(time).toISOString(),
    };
    if (creator) {
      const raw = p?.cells[creator.airtableId];
      const matched = raw === undefined || raw === null ? [] : cellInput(creator, raw, people);
      row.created_by = Array.isArray(matched) ? (matched[0] ?? null) : null;
      if (raw !== undefined && raw !== null && !row.created_by) report.skippedCells++;
    }
    return row;
  });
  const by = creator ? sql`, created_by = s.created_by` : sql``;
  await tx.execute(sql`
    UPDATE ${qualified(table)} AS r
       SET created_at = coalesce(s.created_at, r.created_at)${by}
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
           AS s(id uuid, created_at timestamptz, created_by uuid)
     WHERE r.id = s.id`);
  if (state.fields.some((f) => f.type === 'formula')) {
    await recomputeForRecords(tx, table, ids, { ai: false });
  }
}

/** The side of a pair whose cells hold the fewest links (a one-to-many's "one" side). */
async function writerOf(tx: Transaction, jobId: string, pair: LinkPair): Promise<'a' | 'b'> {
  if (!pair.b) return 'a';
  const most = async (side: { tableId: string; fieldId: string }) => {
    const { rows } = await tx.execute<{ n: number | null }>(sql`
      SELECT max(jsonb_array_length(links -> ${side.fieldId}))::int AS n
        FROM airtable_import_records
       WHERE job_id = ${jobId} AND table_id = ${side.tableId} AND links ? ${side.fieldId}`);
    return rows[0]?.n ?? 0;
  };
  return (await most(pair.b)) < (await most(pair.a)) ? 'b' : 'a';
}

/** Writes the links of up to 100 records of one side; the cursor to go on from, if any. */
async function writeLinks(
  ctx: RecordContext,
  jobId: string,
  side: { tableId: string; fieldId: string; linkedTableId: string },
  cursor: string | null
): Promise<{ written: number; skipped: number; cursor: string | null }> {
  const { tx } = ctx;
  const map = airtableImportRecords;
  const rows = await tx
    .select({ airtableId: map.airtableId, recordId: map.recordId, links: map.links })
    .from(map)
    .where(
      and(
        eq(map.jobId, jobId),
        eq(map.tableId, side.tableId),
        cursor ? gt(map.airtableId, cursor) : undefined,
        sql`${map.links} ? ${side.fieldId}`
      )
    )
    .orderBy(asc(map.airtableId))
    .limit(100);
  if (!rows.length) return { written: 0, skipped: 0, cursor: null };
  const wanted = rows.map((r) => (r.links as Record<string, string[]>)[side.fieldId] ?? []);
  const all = [...new Set(wanted.flat())];
  const found = new Map(
    (
      await tx
        .select({ airtableId: map.airtableId, recordId: map.recordId })
        .from(map)
        .where(
          and(
            eq(map.jobId, jobId),
            eq(map.tableId, side.linkedTableId),
            inArray(map.airtableId, all)
          )
        )
    ).map((r) => [r.airtableId, r.recordId])
  );
  let skipped = 0;
  const patches = rows.map((r, i) => {
    const ids = [...new Set((wanted[i] ?? []).flatMap((a) => found.get(a) ?? []))];
    skipped += (wanted[i]?.length ?? 0) - Math.min(ids.length, MAX_LINKS_PER_CELL);
    return { id: r.recordId, fields: { [side.fieldId]: ids.slice(0, MAX_LINKS_PER_CELL) } };
  });
  // Records deleted meanwhile (in the new base, by someone) are left out.
  const live = await liveRecordIds(
    ctx,
    patches.map((p) => p.id)
  );
  const kept = patches.filter((p) => live.has(p.id));
  if (kept.length) await updateRecords({ ...ctx, unmatchedLinks: 'skip' }, kept);
  return {
    written: kept.length,
    skipped,
    cursor: rows.length === 100 ? (rows[rows.length - 1]?.airtableId ?? null) : null,
  };
}

async function liveRecordIds(
  ctx: { tx: Transaction; table: TableRow },
  ids: string[]
): Promise<Set<string>> {
  const { rows } = await ctx.tx.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM ${qualified(ctx.table)}
     WHERE id = ANY(${`{${ids.join(',')}}`}::uuid[]) AND deleted_at IS NULL`);
  return new Set(rows.map((r) => r.id));
}

/** Workspace members by lower-cased email: who Airtable's collaborator cells can name. */
async function memberEmails(tx: Transaction): Promise<Map<string, string>> {
  const { rows } = await tx.execute<{ id: string; email: string | null }>(sql`
    SELECT u.id::text AS id, lower(u.email) AS email FROM users u
     WHERE EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.user_id = u.id)`);
  const out = new Map<string, string>();
  for (const u of rows) if (u.email) out.set(u.email, u.id);
  return out;
}
