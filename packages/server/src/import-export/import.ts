import {
  type CreateImportInput,
  CsvParseError,
  type FieldTypeName,
  getFieldType,
  type ImportJob,
  MAX_CHOICE_NAME,
  MAX_CHOICES,
  MAX_COLLABORATORS,
  MAX_IMPORT_ROWS,
  type ProblemFieldError,
  parseCsv,
  roleAllows,
  type UserRole,
} from '@openrows/shared';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { effectiveRole } from '../authz/policy.js';
import { resolveResource } from '../authz/resolve.js';
import { inScope } from '../authz/scope.js';
import { type Database, jobs, type Transaction } from '../db/index.js';
import { ossEntitlements } from '../edition/oss.js';
import type { EntitlementsProvider } from '../edition/types.js';
import {
  addChoices,
  createField,
  type FieldRow,
  fieldType,
  liveFields,
  MAX_FIELDS_PER_TABLE,
  parseOptions,
  type TableRow,
} from '../fields/service.js';
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
import { assertTableAllows, cellDenial, editRestricted } from '../records/permissions.js';
import { createRecords, tableFields } from '../records/service.js';
import { loadTable } from '../tables/service.js';

/**
 * CSV import. The request parses and checks the file and the mapping, then stores the job
 * (`jobs`: the plan, the CSV text) and sends it to the worker in its transaction (
 * ADR-004). The worker creates the new fields, then the records in batches of 1,000 through the
 * RecordService, one transaction per batch that also commits the progress, so the progress is
 * visible, a failure keeps the batches before it, and a retry (a killed worker) resumes after
 * the last committed batch.
 */

/** Rows per batch: the RecordService's bulk limit. */
export const IMPORT_BATCH = 1000;
/** The pg-boss queue (jobs/queues.ts). */
export const IMPORT_QUEUE = 'imports.run';

/** One mapped column: an existing field (`fieldId`) or a new one (`newField`). */
interface PlannedColumn {
  index: number;
  fieldId?: string;
  newField?: { name: string; type: FieldTypeName; options: unknown };
}

/** A checked import, ready to run. */
export interface ImportPlan {
  rows: string[][];
  columns: PlannedColumn[];
  /** Create the select options the file names that don't exist yet. */
  typecast: boolean;
}

function invalid(errors: ProblemFieldError[], detail = 'The import is invalid.'): never {
  throw new AppError('VALIDATION_FAILED', { detail, extensions: { errors } });
}

/**
 * Parses the CSV and checks the mapping against the table's live fields: existing fields must be
 * writable and mapped once, new fields need `field:create` (403 otherwise), a free name, a
 * writable type and valid options.
 */
export async function planImport(
  tx: Transaction,
  table: TableRow,
  who: { role: UserRole; userId: string },
  input: CreateImportInput & { hasHeader: boolean; typecast: boolean }
): Promise<ImportPlan> {
  const { role } = who;
  // Edit permissions: checked here for a 403 before the job starts, and again by the
  // RecordService for every batch (a permission changed mid-import fails the job).
  assertTableAllows(table, 'addRecords', who);
  if (input.typecast && !roleAllows(role, 'field:update')) {
    throw new AppError('TYPECAST_FORBIDDEN', {
      detail: 'Only owners and creators can add select options.',
    });
  }
  let rows: string[][];
  try {
    rows = parseCsv(input.csv, { delimiter: input.delimiter });
  } catch (err) {
    if (err instanceof CsvParseError) invalid([{ path: 'csv', message: err.message }], err.message);
    throw err;
  }
  if (input.hasHeader) rows = rows.slice(1);
  if (rows.length === 0) invalid([{ path: 'csv', message: 'The file has no rows to import.' }]);
  if (rows.length > MAX_IMPORT_ROWS) {
    invalid([{ path: 'csv', message: `An import takes at most ${MAX_IMPORT_ROWS} rows.` }]);
  }
  const width = Math.max(...rows.map((r) => r.length));

  const live = await liveFields(tx, table.id);
  const byId = new Map(live.map((f) => [f.id, f]));
  const written = new Map((await tableFields(tx, table)).map((f) => [f.row.id, f]));
  const restricted: ProblemFieldError[] = [];
  const restrictedFields: FieldRow[] = [];
  const names = new Set(live.map((f) => f.name.toLowerCase()));
  const errors: ProblemFieldError[] = [];
  const used = new Set<string>();
  const columns: PlannedColumn[] = [];
  let newCount = 0;
  for (const [i, c] of input.columns.entries()) {
    const at = `columns.${i}`;
    if (c.index >= width) errors.push({ path: `${at}.index`, message: 'No such column.' });
    if (c.fieldId !== undefined) {
      const field = byId.get(c.fieldId);
      if (!field) {
        errors.push({ path: `${at}.fieldId`, message: 'No such field.' });
        continue;
      }
      const def = getFieldType(fieldType(field));
      if (def.readOnly || def.computed) {
        errors.push({ path: `${at}.fieldId`, message: `"${field.name}" can't be set.` });
        continue;
      }
      if (used.has(field.id)) {
        errors.push({ path: `${at}.fieldId`, message: 'Mapped twice.' });
        continue;
      }
      used.add(field.id);
      const info = written.get(field.id);
      const reason = info ? cellDenial(table, info, who, 'create') : null;
      if (reason) {
        restricted.push({ path: `${at}.fieldId`, message: reason });
        restrictedFields.push(field);
        continue;
      }
      columns.push({ index: c.index, fieldId: field.id });
    } else if (c.newField) {
      const { name, type } = c.newField;
      const def = getFieldType(type);
      if (def.readOnly || def.computed) {
        errors.push({ path: `${at}.newField.type`, message: `${def.label} can't be set.` });
        continue;
      }
      if (names.has(name.toLowerCase())) {
        errors.push({ path: `${at}.newField.name`, message: 'The name is taken.' });
        continue;
      }
      names.add(name.toLowerCase());
      const parsed = def.optionsSchema.safeParse(c.newField.options ?? {});
      if (!parsed.success) {
        errors.push({ path: `${at}.newField.options`, message: 'Invalid options.' });
        continue;
      }
      newCount++;
      columns.push({ index: c.index, newField: { name, type, options: parsed.data } });
    }
  }
  if (restricted.length) editRestricted(restricted, restrictedFields);
  if (newCount > 0 && !roleAllows(role, 'field:create')) {
    throw new AppError('FORBIDDEN', {
      detail: 'Your role can map columns to existing fields only.',
    });
  }
  if (live.length + newCount > MAX_FIELDS_PER_TABLE) {
    errors.push({
      path: 'columns',
      message: `A table can have at most ${MAX_FIELDS_PER_TABLE} fields.`,
    });
  }
  if (errors.length) invalid(errors);
  return { rows, columns, typecast: input.typecast };
}

/**
 * The options a select column names that its field doesn't have: first occurrence first,
 * deduplicated case-insensitively, names over MAX_CHOICE_NAME skipped, and no more than the
 * field has room for (cells past that are skipped like any unreadable cell).
 */
function missingChoices(
  rows: string[][],
  target: { index: number; field: FieldRow; options: unknown }
) {
  const def = getFieldType(fieldType(target.field));
  if (!def.unknownChoices) return [];
  const room = MAX_CHOICES - ((target.options as { choices?: unknown[] }).choices?.length ?? 0);
  const seen = new Set<string>();
  const names: string[] = [];
  for (const row of rows) {
    const raw = row[target.index] ?? '';
    if (raw.trim() === '') continue;
    for (const name of def.unknownChoices(raw, target.options)) {
      const key = name.toLowerCase();
      if (name.length > MAX_CHOICE_NAME || seen.has(key)) continue;
      if (names.length >= room) return names;
      seen.add(key);
      names.push(name);
    }
  }
  return names;
}

/**
 * The base's collaborators by lower-cased name, email and id: user cells of a file name
 * people as the export writes them (display names), or by email. Only current collaborators of
 * the base are matched (workspace members and the base's own, under the tenant's RLS policy).
 */
async function collaboratorLookup(tx: Transaction, baseId: string): Promise<Map<string, string>> {
  const { rows } = await tx.execute<{ id: string; name: string | null; email: string | null }>(sql`
    SELECT u.id::text AS id, u.name, u.email FROM users u
     WHERE EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.user_id = u.id)
        OR EXISTS (SELECT 1 FROM base_members bm WHERE bm.user_id = u.id AND bm.base_id = ${baseId})
     LIMIT ${MAX_COLLABORATORS}`);
  const out = new Map<string, string>();
  // Ids and emails first, so a name never shadows them.
  for (const u of rows) {
    out.set(u.id, u.id);
    if (u.email) out.set(u.email.toLowerCase(), u.id);
  }
  for (const u of rows) {
    const name = u.name?.trim().toLowerCase();
    if (name && !out.has(name)) out.set(name, u.id);
  }
  return out;
}

/** Converts one row's cells into record input through the registry; counts unreadable cells. */
function rowInput(
  row: string[],
  targets: { index: number; field: FieldRow; options: unknown }[],
  skipped: { n: number },
  people: Map<string, string>
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const t of targets) {
    const raw = row[t.index] ?? '';
    if (raw.trim() === '') continue;
    const def = getFieldType(fieldType(t.field));
    // Link cells name records by primary field: the RecordService matches them.
    if (def.storage.kind === 'link') {
      input[t.field.id] = raw;
      continue;
    }
    // User cells name collaborators; people who aren't one are skipped.
    const source =
      def.name === 'user'
        ? raw.split(',').flatMap((part) => people.get(part.trim().toLowerCase()) ?? [])
        : raw;
    const value = def.coerce(source, t.options);
    if (value === null) skipped.n++;
    else input[t.field.id] = value;
  }
  return input;
}

/** What the job row keeps of the request: the checked mapping and how to read the CSV again. */
interface ImportInput {
  columns: PlannedColumn[];
  typecast: boolean;
  hasHeader: boolean;
  delimiter?: string | undefined;
}

/** Committed with every step, so a retry carries on from there. */
interface ImportProgress {
  totalRows: number;
  processedRows: number;
  skippedCells: number;
  createdFieldIds: string[];
  /** Set once the new fields exist: the field of every mapped column, by column index. */
  mapped?: Record<string, string>;
}

const progressOf = (job: JobRow) => job.progress as ImportProgress;

/** The job as the API shows it. */
export function toImportJob(job: JobRow): ImportJob {
  const p = progressOf(job);
  return {
    id: job.id,
    tableId: job.tableId ?? '',
    status: job.status,
    totalRows: p.totalRows ?? 0,
    processedRows: p.processedRows ?? 0,
    skippedCells: p.skippedCells ?? 0,
    createdFieldIds: p.createdFieldIds ?? [],
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

/**
 * Stores a checked import and sends it to the worker, in the request's transaction; 409 while
 * another import into the table is running.
 */
export async function startImport(
  tx: Transaction,
  jobs: Jobs,
  scope: { workspaceId: string; userId: string },
  table: TableRow,
  plan: ImportPlan,
  request: { csv: string; hasHeader: boolean; delimiter?: string | undefined }
): Promise<ImportJob> {
  const input: ImportInput = {
    columns: plan.columns,
    typecast: plan.typecast,
    hasHeader: request.hasHeader,
    delimiter: request.delimiter,
  };
  const progress: ImportProgress = {
    totalRows: plan.rows.length,
    processedRows: 0,
    skippedCells: 0,
    createdFieldIds: [],
  };
  const job = await startJob(
    tx,
    jobs,
    IMPORT_QUEUE,
    {
      workspaceId: scope.workspaceId,
      baseId: table.baseId,
      tableId: table.id,
      kind: 'import',
      createdBy: scope.userId,
      input,
      payload: request.csv,
      progress,
    },
    'An import into this table is already running. Wait for it to finish.'
  );
  return toImportJob(job);
}

export const importJobData = z.object({ workspaceId: z.uuid(), jobId: z.uuid() });

export interface ImportRunDeps {
  db: Database;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** The workspaces' plans: each batch is checked against records per base. OSS: none. */
  entitlements?: EntitlementsProvider | undefined;
}

export interface ImportRunOptions {
  /** The job's last attempt: any error fails it for good instead of retrying. */
  lastAttempt?: boolean;
  /** Called after each committed batch (tests: a crash between batches). */
  afterBatch?: (processedRows: number) => Promise<void> | void;
}

/** The requester's live role on the table: every step runs with it, never the one at start. */
async function liveRole(tx: Transaction, tableId: string, userId: string): Promise<UserRole> {
  const resolved = await resolveResource(tx, 'table', tableId, userId);
  const role = resolved ? effectiveRole(resolved) : null;
  if (!resolved || !role) {
    throw new AppError('NOT_FOUND', { detail: 'The table is gone, or you lost access to it.' });
  }
  if (!roleAllows(role, 'record:create')) {
    throw new AppError('FORBIDDEN', { detail: 'You can no longer add records to this table.' });
  }
  return role;
}

/**
 * The worker's handler for one import (`imports.run`). Idempotent: a finished job is left alone,
 * and every step locks the job row and reads the committed progress first, so a retry (or a
 * second run racing the first) carries on where the last commit left off and never imports a
 * row twice. Errors the requester can act on (AppError) and any error on the last attempt fail
 * the job with a message; other errors are thrown, and pg-boss retries.
 */
export async function runImportJob(
  deps: ImportRunDeps,
  raw: unknown,
  opts: ImportRunOptions = {}
): Promise<{ status: string }> {
  const { workspaceId, jobId } = importJobData.parse(raw);
  const job = await withTenant(deps.db, workspaceId, (tx) => beginAttempt(tx, jobId));
  if (!job) return { status: 'gone' };
  try {
    await importRows(deps, job, opts);
    return { status: 'done' };
  } catch (err) {
    if (!(err instanceof AppError) && !opts.lastAttempt) throw err;
    await withTenant(deps.db, workspaceId, (tx) =>
      failJob(tx, jobId, failureMessage(err, 'import'))
    );
    deps.logger.warn({ err, importId: jobId }, 'import failed');
    return { status: 'failed' };
  }
}

/** Thrown inside a step when the job finished meanwhile (another run, the sweep). */
class JobGone extends Error {}

async function importRows(deps: ImportRunDeps, job: JobRow, opts: ImportRunOptions) {
  const { workspaceId, id: jobId } = job;
  const tableId = job.tableId;
  const userId = job.createdBy;
  if (!tableId || !userId) throw new AppError('NOT_FOUND', { detail: 'The import is gone.' });
  const input = job.input as ImportInput;
  const run = <T>(fn: (tx: Transaction, row: JobRow, role: UserRole) => Promise<T>) =>
    inScope(deps.db, { workspaceId, userId }, async (tx) => {
      const row = await lockRunningJob(tx, jobId);
      if (!row) throw new JobGone();
      return fn(tx, row, await liveRole(tx, tableId, userId));
    });
  const saveProgress = (tx: Transaction, progress: ImportProgress) =>
    tx.update(jobs).set({ progress }).where(eq(jobs.id, jobId));

  let rows: string[][];
  try {
    rows = parseCsv(job.payload ?? '', { delimiter: input.delimiter });
  } catch (err) {
    if (err instanceof CsvParseError)
      throw new AppError('VALIDATION_FAILED', { detail: err.message });
    throw err;
  }
  if (input.hasHeader) rows = rows.slice(1);

  try {
    // The new fields and select options first, in one transaction with the column → field map.
    const mapped = await run(async (tx, row, role) => {
      const progress = progressOf(row);
      if (progress.mapped) return progress.mapped;
      const scope = { workspaceId, userId, role };
      const table = await loadTable(tx, tableId);
      const ids = new Map<number, string>();
      const created: string[] = [];
      for (const c of input.columns) {
        if (!c.newField) continue;
        if (!roleAllows(role, 'field:create')) {
          throw new AppError('FORBIDDEN', {
            detail: 'You can no longer add fields to this table.',
          });
        }
        const field = await createField({ tx, ...scope }, table, {
          name: c.newField.name,
          type: c.newField.type,
          options: c.newField.options as Record<string, unknown>,
        });
        ids.set(c.index, field.id);
        created.push(field.id);
      }
      const map: Record<string, string> = {};
      for (const c of input.columns) map[c.index] = c.fieldId ?? ids.get(c.index) ?? '';
      if (input.typecast) {
        // Every missing option of the file at once, before the batches.
        const fieldsById = new Map((await liveFields(tx, tableId)).map((f) => [f.id, f]));
        const wanted = new Map<string, string[]>();
        for (const [index, fieldId] of Object.entries(map)) {
          const field = fieldsById.get(fieldId);
          if (!field) continue;
          const options = parseOptions(fieldType(field), field.config);
          const names = missingChoices(rows, { index: Number(index), field, options });
          if (names.length) wanted.set(field.id, names);
        }
        if (wanted.size) await addChoices({ tx, ...scope }, table, wanted, { maxNew: Infinity });
      }
      await saveProgress(tx, { ...progress, createdFieldIds: created, mapped: map });
      return map;
    });

    const { targets, people } = await run(async (tx) => {
      const live = new Map((await liveFields(tx, tableId)).map((f) => [f.id, f]));
      const targets = input.columns.map((c) => {
        const field = live.get(mapped[c.index] ?? '');
        if (!field) throw new AppError('CONFLICT', { detail: 'A mapped field was deleted.' });
        return { index: c.index, field, options: parseOptions(fieldType(field), field.config) };
      });
      const people = targets.some((t) => fieldType(t.field) === 'user')
        ? await collaboratorLookup(tx, (await loadTable(tx, tableId)).baseId)
        : new Map<string, string>();
      return { targets, people };
    });

    for (;;) {
      const processed = await run(async (tx, row, role) => {
        const progress = progressOf(row);
        const start = progress.processedRows;
        if (start >= rows.length) return null;
        const batch = rows.slice(start, start + IMPORT_BATCH);
        const skipped = { n: 0 };
        const inputs = batch.map((r) => rowInput(r, targets, skipped, people));
        const table = await loadTable(tx, tableId);
        // Link names nothing matches: new linked records with typecast, else skipped.
        const unmatchedLinks = input.typecast ? 'create' : 'skip';
        // Over the plan's records per base the job fails with the limit's message; the batches
        // before it stay imported.
        const entitlements = await (deps.entitlements ?? ossEntitlements).forWorkspace(
          workspaceId,
          tx
        );
        await createRecords(
          { tx, workspaceId, userId, role, table, unmatchedLinks, entitlements },
          inputs
        );
        await saveProgress(tx, {
          ...progress,
          processedRows: start + batch.length,
          skippedCells: progress.skippedCells + skipped.n,
        });
        return start + batch.length;
      });
      if (processed === null) break;
      await opts.afterBatch?.(processed);
    }
    await inScope(deps.db, { workspaceId, userId }, (tx) => finishJob(tx, jobId, null));
  } catch (err) {
    if (err instanceof JobGone) return;
    throw err;
  }
}
