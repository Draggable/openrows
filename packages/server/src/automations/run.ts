import {
  type AutomationAction,
  type AutomationRun,
  type AutomationRunMode,
  type AutomationRunStatus,
  type AutomationSkipReason,
  type AutomationStep,
  type AutomationTrigger,
  MAX_AUTOMATION_DEPTH,
  MAX_UPDATE_RECORDS,
  queryRecordsSchema,
  renderTemplate,
  renderTemplateValue,
  roleAllows,
  TemplateError,
  type UserRole,
} from '@openrows/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { ZodError, z } from 'zod';
import { effectiveRole } from '../authz/policy.js';
import { resolveResource } from '../authz/resolve.js';
import { setScope } from '../authz/scope.js';
import { qualified } from '../data/columns.js';
import { compileViewQuery, QueryValidationError } from '../data/query/compile.js';
import {
  automationMatches,
  automationRunCounts,
  automationRuns,
  automations,
  bases,
  type Database,
  outbox,
  type Transaction,
  tables,
  users,
} from '../db/index.js';
import { ossEntitlements } from '../edition/oss.js';
import type { Entitlements, EntitlementsProvider } from '../edition/types.js';
import type { TableRow } from '../fields/service.js';
import { tenantJobData, withTenant } from '../jobs/tenant.js';
import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { SafeFetchError } from '../lib/safe-fetch/index.js';
import { OutboundDeferred, type OutboundGate } from '../outbound/limits.js';
import {
  createRecords,
  type FieldInfo,
  getRecord,
  queryRecords,
  tableFields,
  toQueryFields,
  updateRecords,
} from '../records/service.js';
import { monthlyRunRoom } from '../usage/quota.js';
import {
  gatedOutbound,
  httpRequestStep,
  logInput,
  type OutboundDeps,
  type OutboundEnv,
  renderOutbound,
  StepFailure,
  sendEmailStep,
  slackMessageStep,
} from './outbound.js';
import { createScriptBridge, type ScriptSandbox, type ScriptTableInfo } from './script/index.js';
import { readSecrets, type StepSecrets } from './secrets.js';
import {
  type AutomationRow,
  type AutomationRunRow,
  actionsOf,
  baseTable,
  toRun,
  triggerOf,
} from './service.js';

/**
 * The `automations.run` job: one run of one automation, for one outbox event (record
 * triggers, sent by the relay) or one scheduled time (sent by `automations.schedule`).
 *
 * - **Exactly once.** The run's row has a unique `(automation, idempotency key)`, the key being
 *   `<outbox id>:<automation id>` or `schedule:<time>`. The whole run (the row, every step's
 *   writes and the outcome) is one transaction, so a crash leaves nothing and the retry starts
 *   over, and a replayed or duplicate job finds the row and does nothing.
 * - **As the creator.** Actions run as `created_by` (the last person to change the trigger or
 *   actions, or to turn it on) with their live role, through the RecordService, so table and
 *   field edit permissions apply. A creator without access to the base any more turns the
 *   automation off.
 * - **Loop guard.** The run sets `app.automation_id`/`app.automation_depth` for its transaction,
 *   so every outbox event of its writes (recomputes and the linked side too) carries its depth.
 *   A run triggered by an event at depth N has depth N + 1; past MAX_AUTOMATION_DEPTH it is
 *   recorded as skipped and does nothing.
 * - **Steps.** Each action runs in a savepoint: a failing step (an AppError, a bad token) is
 *   rolled back alone, recorded with its message, and the steps after it are skipped; earlier
 *   steps' writes stay, as in Airtable. Other errors fail the job, which pg-boss retries; the last
 *   attempt records a failed run.
 * - **Tests and retries** (testAutomation and retryRun below) run the same steps
 *   (performRun) in the API's request transaction, as the person testing or retrying.
 */

export const automationJobData = tenantJobData
  .extend({
    subscriberId: z.uuid(),
    outboxId: z.number().int().positive().optional(),
    scheduledAt: z.iso.datetime().optional(),
    /** A webhook-received trigger's request, sent by `POST /hooks/a/<token>`. */
    hook: z
      .object({ requestId: z.uuid(), receivedAt: z.iso.datetime(), body: z.unknown() })
      .optional(),
    /** A button click: who clicked which record's button. */
    button: z
      .object({ clickId: z.uuid(), recordId: z.uuid(), fieldId: z.uuid(), userId: z.uuid() })
      .optional(),
  })
  .refine(
    (d) =>
      [d.outboxId, d.scheduledAt, d.hook, d.button].filter((x) => x !== undefined).length === 1,
    { message: 'One of outboxId, scheduledAt, hook or button' }
  );
export type AutomationRunJobData = z.infer<typeof automationJobData>;

export interface AutomationRunDeps {
  /** openrows_app; the run is scoped to its workspace (and then its creator). */
  db: Database;
  logger: Pick<Logger, 'info' | 'warn'>;
  /** Email, HTTP and Slack steps; without it they fail as not configured. */
  outbound?: OutboundDeps | undefined;
  /** Run-script steps; without it they fail as not available. */
  scripts?: ScriptSandbox | undefined;
  /**
   * The workspace's outbound rate, for live runs in the worker: each outbound request
   * waits up to `waitMs` for a token; past that the run is rolled back and deferred. Tests and
   * retries from the builder (in the request) have none.
   */
  gate?: { gate: OutboundGate; waitMs: number } | undefined;
  /**
   * The workspaces' plans: runs past the monthly quota are recorded as skipped, record
   * creates past records per base fail their step. The OSS edition's (unlimited) when omitted.
   */
  entitlements?: EntitlementsProvider | undefined;
}

/** The longest an automation's request waits for its workspace's next token. */
export const AUTOMATION_OUTBOUND_WAIT_MS = 10_000;

export type RunOutcome =
  /** `suspended`: the workspace is suspended, so nothing in it changes. */
  | { skipped: 'disabled' | 'duplicate' | 'not_triggered' | 'suspended' }
  | { status: AutomationRunStatus; runId: string }
  /** Over the workspace's outbound rate: nothing was kept; run it again in N seconds. */
  | { deferred: number };

/** Most characters of JSON a step's input or output, or the trigger, keeps in the run history. */
const MAX_STORED_JSON = 32 * 1024;

function stored(value: unknown): unknown {
  const text = JSON.stringify(value ?? null);
  return text.length <= MAX_STORED_JSON ? value : { truncated: true, size: text.length };
}

type ContextRecord = {
  id: string;
  createdAt: string;
  updatedAt: string;
  fields: Record<string, unknown>;
};

/** A record as tokens see it: cells by field name, and by field id. */
function contextRecord(
  record: { id: string; createdAt: string; updatedAt: string; fields: Record<string, unknown> },
  fields: readonly FieldInfo[]
): ContextRecord {
  const cells: Record<string, unknown> = {};
  for (const f of fields) {
    if (!(f.row.id in record.fields)) continue;
    const value = record.fields[f.row.id] ?? null;
    cells[f.row.name] = value;
    cells[f.row.id] = value;
  }
  return { id: record.id, createdAt: record.createdAt, updatedAt: record.updatedAt, fields: cells };
}

/** The record in the run history: cells by name only. */
function historyRecord(record: ContextRecord, fields: readonly FieldInfo[]) {
  const names = new Set(fields.map((f) => f.row.name));
  return {
    ...record,
    fields: Object.fromEntries(Object.entries(record.fields).filter(([k]) => names.has(k))),
  };
}

function outboundAcquire(gate: { gate: OutboundGate; waitMs: number }, workspaceId: string) {
  return () => gate.gate.acquire(workspaceId, gate.waitMs);
}

/** A step's error as a message, or null for an error that should fail (and retry) the job. */
function stepError(err: unknown): string | null {
  if (err instanceof AppError) {
    const first = (err.extensions?.['errors'] as { message?: string }[] | undefined)?.[0];
    const detail = err.detail ?? err.message;
    return first?.message && first.message !== detail ? `${detail} ${first.message}` : detail;
  }
  if (err instanceof TemplateError) return err.message;
  if (err instanceof QueryValidationError)
    return err.errors[0]?.message ?? 'The filter is invalid.';
  if (err instanceof ZodError) return err.issues[0]?.message ?? 'The step is invalid.';
  if (err instanceof StepFailure) return err.message;
  if (err instanceof SafeFetchError) return err.message;
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The record ids an update's rendered `recordId` names: an id, a list of ids or of records. */
function recordIdsOf(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value];
  const ids = items.flatMap((item): string[] => {
    if (typeof item === 'string')
      return item
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
      return [(item as { id: string }).id];
    }
    return [];
  });
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    throw new AppError('VALIDATION_FAILED', { detail: 'There is no record to update.' });
  }
  if (unique.length > MAX_UPDATE_RECORDS) {
    throw new AppError('VALIDATION_FAILED', {
      detail: `One step updates at most ${MAX_UPDATE_RECORDS} records.`,
    });
  }
  const bad = unique.find((id) => !UUID_RE.test(id));
  if (bad) {
    throw new AppError('VALIDATION_FAILED', { detail: `"${bad.slice(0, 60)}" isn't a record id.` });
  }
  return unique;
}

interface RunEnv extends OutboundEnv {
  /** Its record writes' revisions say `via: 'automation'`. */
  automationId: string;
  userId: string;
  role: UserRole;
  /** The workspace's plan: record creates past records per base fail their step. */
  entitlements: Entitlements;
  db: Database;
  secrets: (StepSecrets | null)[];
  scripts: ScriptSandbox | undefined;
}

/** Fills in an action's tokens: cells, the record id and filter values. */
function renderAction(action: AutomationAction, context: Record<string, unknown>) {
  switch (action.type) {
    case 'createRecord':
      return { ...action, fields: renderTemplateValue(action.fields, context) };
    case 'updateRecord':
      return {
        ...action,
        recordId: renderTemplate(action.recordId, context),
        fields: renderTemplateValue(action.fields, context),
      };
    case 'findRecords':
      return { ...action, filter: renderTemplateValue(action.filter, context) };
    case 'runScript':
      return {
        ...action,
        inputs: renderTemplateValue(action.inputs, context) as Record<string, unknown>,
      };
    default:
      return renderOutbound(action, context);
  }
}

/** What the run log keeps of a step's input: outbound steps without secrets or header values. */
function loggedInput(input: ReturnType<typeof renderAction>): unknown {
  // The script is in the automation; its log keeps what it was given.
  if (input.type === 'runScript') return { type: input.type, inputs: input.inputs };
  return input.type === 'sendEmail' || input.type === 'httpRequest' || input.type === 'slackMessage'
    ? logInput(input)
    : input;
}

async function stepTable(tx: Transaction, env: RunEnv, tableId: string): Promise<TableRow> {
  const table = await baseTable(tx, env.baseId, tableId);
  if (!table) throw new AppError('NOT_FOUND', { detail: "This step's table is gone." });
  return table;
}

function mayWrite(env: RunEnv, action: 'record:create' | 'record:update') {
  if (!roleAllows(env.role, action)) {
    throw new AppError('FORBIDDEN', {
      detail: `The person this automation runs as can't ${action === 'record:create' ? 'add' : 'edit'} records.`,
    });
  }
}

/** Runs one action (in its savepoint) and answers its output for the steps after it. */
async function runAction(
  tx: Transaction,
  env: RunEnv,
  index: number,
  action: AutomationAction,
  input: ReturnType<typeof renderAction>
): Promise<Record<string, unknown>> {
  if (input.type === 'sendEmail') return sendEmailStep(tx, env.db, env, input);
  if (input.type === 'httpRequest') return httpRequestStep(env, input, env.secrets[index - 1]);
  if (input.type === 'slackMessage') return slackMessageStep(env, input, env.secrets[index - 1]);
  if (input.type === 'runScript') return runScriptStep(tx, env, input);
  if (!('tableId' in action)) throw new Error('a record step without a table');
  const table = await stepTable(tx, env, action.tableId);
  const ctx = {
    tx,
    workspaceId: env.workspaceId,
    userId: env.userId,
    role: env.role,
    table,
    entitlements: env.entitlements,
    automation: { automationId: env.automationId },
  };
  const fields = await tableFields(tx, table);
  const cells = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
  if (input.type === 'createRecord') {
    mayWrite(env, 'record:create');
    const [created] = await createRecords(ctx, [cells(input.fields)]);
    if (!created) throw new Error('createRecords returned nothing');
    const record = contextRecord(created, fields);
    return { id: record.id, record, records: [record] };
  }
  if (input.type === 'updateRecord') {
    mayWrite(env, 'record:update');
    const patch = cells(input.fields);
    const updated = await updateRecords(
      ctx,
      recordIdsOf(input.recordId).map((id) => ({ id, fields: patch }))
    );
    const records = updated.map((r) => contextRecord(r, fields));
    return { records, count: records.length, ...(records[0] ? { record: records[0] } : {}) };
  }
  const query = queryRecordsSchema.parse({
    query: input.filter ? { filter: input.filter } : {},
    limit: action.type === 'findRecords' ? action.limit : 100,
    count: false,
  });
  const found = await queryRecords(ctx, query);
  const records = found.records.map((r) => contextRecord(r, fields));
  return { records, count: records.length };
}

/** The base's live tables and fields, for the script's `base.getTable(...)`. */
async function scriptTables(tx: Transaction, baseId: string): Promise<ScriptTableInfo[]> {
  const rows = await tx
    .select()
    .from(tables)
    .where(and(eq(tables.baseId, baseId), isNull(tables.deletedAt)))
    .orderBy(tables.position, tables.id);
  const out: ScriptTableInfo[] = [];
  for (const table of rows) {
    const fields = await tableFields(tx, table);
    out.push({
      id: table.id,
      name: table.name,
      fields: fields.map((f) => ({ id: f.row.id, name: f.row.name, type: f.row.type })),
    });
  }
  return out;
}

/**
 * A run-script step: the script in the server's sandbox with the workspace's limits, its
 * calls run here as the run's person in this step's savepoint. Its output (`output.set`) and
 * console lines are the step's output; a script that throws or hits a limit fails the step.
 */
async function runScriptStep(
  tx: Transaction,
  env: RunEnv,
  input: ReturnType<typeof renderAction> & { type: 'runScript' }
): Promise<Record<string, unknown>> {
  const availability = env.scripts
    ? await env.scripts.limitsFor(env.workspaceId)
    : ({ available: false, reason: 'disabled' } as const);
  const executor = env.scripts?.executor;
  if (!availability.available || !executor) {
    throw new StepFailure(
      availability.available === false && availability.reason === 'plan'
        ? "This workspace's plan doesn't include scripts."
        : "This server doesn't run scripts (AUTOMATION_SCRIPTS is off)."
    );
  }
  const bridge = createScriptBridge({
    tx,
    automationId: env.automationId,
    workspaceId: env.workspaceId,
    baseId: env.baseId,
    userId: env.userId,
    role: env.role,
    entitlements: env.entitlements,
    http: env.outbound?.http,
    describe: stepError,
  });
  const result = await executor.run(
    {
      script: input.script,
      config: input.inputs,
      base: { id: env.baseId, name: env.baseName, tables: await scriptTables(tx, env.baseId) },
      limits: availability.limits,
    },
    bridge
  );
  const output = { output: result.output, logs: result.logs, durationMs: result.durationMs };
  if (result.status === 'failed')
    throw new StepFailure(result.error ?? 'The script failed.', output);
  return output;
}

/** Whether a live record of the table meets the filter now (as the creator sees it). */
async function recordMeets(
  tx: Transaction,
  table: TableRow,
  fields: FieldInfo[],
  filter: AutomationTrigger & { type: 'recordMatches' },
  recordId: string,
  userId: string
): Promise<boolean> {
  const { where } = compileViewQuery(
    { filter: filter.filter, sorts: [], groupBy: [] },
    toQueryFields(fields),
    {
      userId,
    }
  );
  const { rows } = await tx.execute(
    sql`SELECT 1 FROM ${qualified(table)} AS r WHERE r.id = ${recordId}::uuid AND ${where}`
  );
  return rows.length > 0;
}

/** A trigger that fired: what tokens see, what the run history keeps, and the run's depth. */
interface Fired {
  depth: number;
  outboxId: number | null;
  data: Record<string, unknown>;
  history: unknown;
  /** Who started it: who clicked the button, tested or retried. */
  triggeredBy?: string;
}

type Triggered = { fired: false } | ({ fired: true } & Fired);

/** A live record of a trigger's table as `userId` sees it now, or null when it's gone. */
async function triggerRecord(
  tx: Transaction,
  automation: AutomationRow,
  tableId: string,
  recordId: string,
  userId: string
): Promise<{ table: TableRow; record: ContextRecord; fields: FieldInfo[] } | null> {
  const table = await baseTable(tx, automation.baseId, tableId);
  if (!table) return null;
  const fields = await tableFields(tx, table);
  try {
    const record = await getRecord(
      { tx, workspaceId: automation.workspaceId, userId, table },
      recordId
    );
    return { table, record: contextRecord(record, fields), fields };
  } catch (err) {
    if (err instanceof AppError && err.code === 'NOT_FOUND') return null;
    throw err;
  }
}

/** A record trigger's data (tokens see cells by name and id; the history by name only). */
function recordFired(
  found: { record: ContextRecord; fields: FieldInfo[] },
  data: Record<string, unknown>,
  rest: Omit<Fired, 'data' | 'history'>
): Fired {
  const full = { ...data, record: found.record };
  return {
    ...rest,
    data: full,
    history: { ...full, record: historyRecord(found.record, found.fields) },
  };
}

/** Decides whether the event (or the schedule) runs the automation, and what tokens see. */
async function evaluate(
  tx: Transaction,
  automation: AutomationRow,
  trigger: AutomationTrigger,
  job: AutomationRunJobData,
  userId: string
): Promise<Triggered> {
  if (job.scheduledAt !== undefined) {
    if (trigger.type !== 'scheduled') return { fired: false };
    const data = {
      type: 'scheduled',
      scheduledAt: job.scheduledAt,
      firedAt: new Date().toISOString(),
    };
    return { fired: true, depth: 1, outboxId: null, data, history: data };
  }
  if (job.hook !== undefined) {
    if (trigger.type !== 'webhookReceived') return { fired: false };
    const data = { type: 'webhookReceived', receivedAt: job.hook.receivedAt, body: job.hook.body };
    return { fired: true, depth: 1, outboxId: null, data, history: data };
  }
  if (job.button !== undefined) return clicked(tx, automation, trigger, job.button, userId);
  if (
    trigger.type === 'scheduled' ||
    trigger.type === 'webhookReceived' ||
    trigger.type === 'buttonClicked' ||
    job.outboxId === undefined
  ) {
    return { fired: false };
  }
  const [event] = await tx.select().from(outbox).where(eq(outbox.id, job.outboxId));
  // Never another base's or table's events, whatever the job says.
  if (!event || event.baseId !== automation.baseId || event.tableId !== trigger.tableId) {
    return { fired: false };
  }
  if (event.createdAt < automation.armedAt) return { fired: false };
  const payload = (event.payload ?? {}) as {
    recordId?: string;
    fieldIds?: string[];
    computed?: boolean;
    viewId?: string;
  };
  if (!payload.recordId) return { fired: false };
  if (
    trigger.type === 'formSubmitted' &&
    (event.kind !== 'form.submitted' || payload.viewId !== trigger.viewId)
  ) {
    return { fired: false };
  }
  if (trigger.type === 'recordCreated' && event.kind !== 'record.created') return { fired: false };
  let changed: string[] | undefined;
  if (trigger.type === 'recordUpdated') {
    if (event.kind !== 'record.updated') return { fired: false };
    changed = payload.fieldIds ?? [];
    const watched = trigger.fieldIds;
    // Any field: a person's (or automation's) change, not the recompute it caused, which has
    // its own event and would run it twice.
    if (watched ? !changed.some((id) => watched.includes(id)) : payload.computed === true) {
      return { fired: false };
    }
  }
  if (
    trigger.type === 'recordMatches' &&
    !['record.created', 'record.updated'].includes(event.kind)
  ) {
    return { fired: false };
  }
  // Deleted since (or its table): nothing to run on.
  const found = await triggerRecord(tx, automation, trigger.tableId, payload.recordId, userId);
  if (!found) return { fired: false };
  if (trigger.type === 'recordMatches') {
    const meets = await recordMeets(
      tx,
      found.table,
      found.fields,
      trigger,
      found.record.id,
      userId
    );
    if (!meets) {
      await tx
        .delete(automationMatches)
        .where(
          and(
            eq(automationMatches.automationId, automation.id),
            eq(automationMatches.recordId, found.record.id)
          )
        );
      return { fired: false };
    }
    // Fires on the way in only: a record already in the set stays quiet.
    const entered = await tx
      .insert(automationMatches)
      .values({
        workspaceId: automation.workspaceId,
        automationId: automation.id,
        recordId: found.record.id,
      })
      .onConflictDoNothing()
      .returning();
    if (entered.length === 0) return { fired: false };
  }
  return {
    fired: true,
    ...recordFired(
      found,
      {
        type: trigger.type,
        ...(changed ? { changedFieldIds: changed } : {}),
        ...(trigger.type === 'formSubmitted' ? { viewId: trigger.viewId } : {}),
      },
      { depth: (event.automationDepth ?? 0) + 1, outboxId: event.id }
    ),
  };
}

/**
 * A button click: the record as the automation's creator sees it now, and who clicked
 * (their id, name and email for tokens: `{{trigger.user.email}}`).
 */
async function clicked(
  tx: Transaction,
  automation: AutomationRow,
  trigger: AutomationTrigger,
  click: NonNullable<AutomationRunJobData['button']>,
  userId: string
): Promise<Triggered> {
  if (trigger.type !== 'buttonClicked' || trigger.fieldId !== click.fieldId)
    return { fired: false };
  const found = await triggerRecord(tx, automation, trigger.tableId, click.recordId, userId);
  if (!found) return { fired: false };
  return {
    fired: true,
    ...recordFired(
      found,
      { type: 'buttonClicked', fieldId: click.fieldId, user: await whoClicked(tx, click.userId) },
      { depth: 1, outboxId: null, triggeredBy: click.userId }
    ),
  };
}

/** `{{trigger.user...}}`: the person's id, name and email. */
async function whoClicked(tx: Transaction, userId: string) {
  const [user] = await tx
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  return { id: userId, name: user?.name ?? null, email: user?.email ?? null };
}

function idempotencyKey(job: AutomationRunJobData): string {
  if (job.outboxId !== undefined) return `${job.outboxId}:${job.subscriberId}`;
  if (job.hook !== undefined) return `hook:${job.hook.requestId}`;
  if (job.button !== undefined) return `button:${job.button.clickId}`;
  return `schedule:${job.scheduledAt}`;
}

async function finish(
  tx: Transaction,
  automation: AutomationRow,
  runId: string,
  outcome: {
    status: AutomationRunStatus;
    steps: AutomationStep[];
    error: string | null;
    durationMs: number;
    /** Why a skipped run did nothing. */
    skipReason?: AutomationSkipReason;
  },
  opts: { counted: boolean; updateLastRun: boolean }
): Promise<AutomationRunRow> {
  const [run] = await tx
    .update(automationRuns)
    .set({
      status: outcome.status,
      steps: outcome.steps,
      error: outcome.error,
      durationMs: outcome.durationMs,
      skipReason: outcome.skipReason ?? null,
    })
    .where(eq(automationRuns.id, runId))
    .returning();
  if (!run) throw new Error('automation run update returned nothing');
  if (opts.updateLastRun) {
    await tx
      .update(automations)
      .set({
        lastRunAt: sql`now()`,
        lastRunStatus: outcome.status,
        updatedAt: sql`${automations.updatedAt}`,
      })
      .where(eq(automations.id, automation.id));
  }
  if (opts.counted) {
    await tx
      .insert(automationRunCounts)
      .values({
        workspaceId: automation.workspaceId,
        month: sql`date_trunc('month', now())::date`,
        runs: 1,
      })
      .onConflictDoUpdate({
        target: [automationRunCounts.workspaceId, automationRunCounts.month],
        set: { runs: sql`${automationRunCounts.runs} + 1` },
      });
  }
  return run;
}

interface PerformOptions {
  /** Who it runs as, with their live role on the base. */
  userId: string;
  role: UserRole;
  triggered: Fired;
  /** Unique per automation: a second run with the same key does nothing. */
  key: string;
  mode: AutomationRunMode;
  retryOf?: string | null;
  /** In the workspace's monthly run count. */
  counted: boolean;
  /** Sets the automation's last run (time and outcome). */
  updateLastRun: boolean;
}

/**
 * One run of the automation in `tx` (scoped to its workspace and to `userId`): the run row, the
 * loop guard, each action in its savepoint, the outcome. Null when a run with the same key
 * exists (a duplicate job, a second retry).
 */
async function performRun(
  tx: Transaction,
  deps: AutomationRunDeps,
  automation: AutomationRow,
  opts: PerformOptions
): Promise<AutomationRunRow | null> {
  const { triggered } = opts;
  const started = performance.now();
  const [run] = await tx
    .insert(automationRuns)
    .values({
      workspaceId: automation.workspaceId,
      automationId: automation.id,
      idempotencyKey: opts.key,
      status: 'succeeded',
      mode: opts.mode,
      retryOf: opts.retryOf ?? null,
      depth: triggered.depth,
      trigger: stored(triggered.history),
      outboxId: triggered.outboxId,
      triggeredBy: triggered.triggeredBy ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (!run) return null;

  if (triggered.depth > MAX_AUTOMATION_DEPTH) {
    deps.logger.info(
      { automationId: automation.id, depth: triggered.depth },
      'automation stopped by the loop guard'
    );
    return finish(
      tx,
      automation,
      run.id,
      {
        status: 'skipped',
        steps: [],
        error: `Stopped: automations triggered each other ${MAX_AUTOMATION_DEPTH} levels deep (loop guard).`,
        durationMs: 0,
        skipReason: 'loop',
      },
      { counted: false, updateLastRun: opts.updateLastRun }
    );
  }

  const entitlements = await (deps.entitlements ?? ossEntitlements).forWorkspace(
    automation.workspaceId,
    tx
  );
  // The plan's automation runs per month: a counted run past it is kept in the history as
  // skipped, never lost silently. Tests and retries (not counted) still run.
  if (opts.counted) {
    const quota = await monthlyRunRoom(tx, entitlements, automation.workspaceId);
    if (quota) {
      deps.logger.info(
        { automationId: automation.id, used: quota.used, max: quota.max },
        'automation run skipped: monthly quota'
      );
      return finish(
        tx,
        automation,
        run.id,
        {
          status: 'skipped',
          steps: [],
          error: `Skipped: this workspace's plan allows ${quota.max.toLocaleString('en-US')} automation runs per month and they are used up. Runs resume on ${quota.resetsAt.toISOString().slice(0, 10)} or after an upgrade.`,
          durationMs: 0,
          skipReason: 'quota',
        },
        { counted: false, updateLastRun: opts.updateLastRun }
      );
    }
  }

  // Every outbox event this transaction writes from here carries the run's depth.
  await tx.execute(
    sql`SELECT set_config('app.automation_id', ${automation.id}, true),
               set_config('app.automation_depth', ${String(triggered.depth)}, true)`
  );
  const [base] = await tx
    .select({ name: bases.name })
    .from(bases)
    .where(eq(bases.id, automation.baseId));
  const env: RunEnv = {
    automationId: automation.id,
    workspaceId: automation.workspaceId,
    baseId: automation.baseId,
    baseName: base?.name ?? 'a base',
    automationName: automation.name,
    outbound:
      deps.outbound && deps.gate && opts.mode === 'live'
        ? gatedOutbound(deps.outbound, outboundAcquire(deps.gate, automation.workspaceId))
        : deps.outbound,
    scripts: deps.scripts,
    db: deps.db,
    secrets: deps.outbound ? readSecrets(deps.outbound.cipher, automation.secretsEncrypted) : [],
    userId: opts.userId,
    role: opts.role,
    entitlements,
  };
  const context: { trigger: Record<string, unknown>; steps: Record<number, unknown> } = {
    trigger: triggered.data,
    steps: {},
  };
  const steps: AutomationStep[] = [];
  let error: string | null = null;
  for (const [i, action] of actionsOf(automation).entries()) {
    const index = i + 1;
    if (error) {
      steps.push({
        index,
        type: action.type,
        status: 'skipped',
        input: null,
        output: null,
        error: null,
        durationMs: 0,
      });
      continue;
    }
    const t0 = performance.now();
    let input: unknown = null;
    try {
      const rendered = renderAction(action, context);
      input = loggedInput(rendered);
      const output = await tx.transaction((sp) => runAction(sp, env, index, action, rendered));
      context.steps[index] = output;
      steps.push({
        index,
        type: action.type,
        status: 'succeeded',
        input: stored(input),
        output: stored(output),
        error: null,
        durationMs: Math.round(performance.now() - t0),
      });
    } catch (err) {
      const message = stepError(err);
      if (message === null) throw err;
      error = `Step ${index} failed: ${message}`;
      steps.push({
        index,
        type: action.type,
        status: 'failed',
        input: stored(input),
        // A script's logs and output so far.
        output: err instanceof StepFailure && err.output !== undefined ? stored(err.output) : null,
        error: message,
        durationMs: Math.round(performance.now() - t0),
      });
    }
  }
  return finish(
    tx,
    automation,
    run.id,
    {
      status: error ? 'failed' : 'succeeded',
      steps,
      error,
      durationMs: Math.round(performance.now() - started),
    },
    { counted: opts.counted, updateLastRun: opts.updateLastRun }
  );
}

async function execute(deps: AutomationRunDeps, job: AutomationRunJobData): Promise<RunOutcome> {
  const key = idempotencyKey(job);
  return deps.db.transaction(async (tx): Promise<RunOutcome> => {
    await setScope(tx, { userId: '', workspaceId: job.workspaceId });
    const [automation] = await tx
      .select()
      .from(automations)
      .where(eq(automations.id, job.subscriberId));
    if (!automation?.enabled) return { skipped: 'disabled' };
    const [done] = await tx
      .select({ id: automationRuns.id })
      .from(automationRuns)
      .where(
        and(eq(automationRuns.automationId, automation.id), eq(automationRuns.idempotencyKey, key))
      );
    if (done) return { skipped: 'duplicate' };
    const trigger = triggerOf(automation);

    const userId = automation.createdBy;
    const resolved = userId ? await resolveResource(tx, 'base', automation.baseId, userId) : null;
    const role = resolved ? effectiveRole(resolved) : null;
    if (resolved?.suspended) return { skipped: 'suspended' };
    if (!userId || !role) {
      // Refused and turned off: whoever turns it on again is who it runs as.
      await tx
        .update(automations)
        .set({ enabled: false, disabledReason: 'creator_access', nextRunAt: null })
        .where(eq(automations.id, automation.id));
      const [run] = await tx
        .insert(automationRuns)
        .values({
          workspaceId: automation.workspaceId,
          automationId: automation.id,
          idempotencyKey: key,
          status: 'failed',
          depth: 1,
          outboxId: job.outboxId ?? null,
          error:
            'The person this automation runs as no longer has access to the base; it was turned off.',
        })
        .onConflictDoNothing()
        .returning();
      deps.logger.info(
        { automationId: automation.id },
        'automation disabled: its creator lost access'
      );
      return run ? { status: 'failed', runId: run.id } : { skipped: 'duplicate' };
    }
    await setScope(tx, { userId, workspaceId: job.workspaceId });

    const triggered = await evaluate(tx, automation, trigger, job, userId);
    if (!triggered.fired) return { skipped: 'not_triggered' };
    const run = await performRun(tx, deps, automation, {
      userId,
      role,
      triggered,
      key,
      mode: 'live',
      counted: true,
      updateLastRun: true,
    });
    // A duplicate job that raced this one and committed first.
    if (!run) return { skipped: 'duplicate' };
    return { status: run.status, runId: run.id };
  });
}

/**
 * The worker's handler. Errors that aren't a step's (a lost connection, a bug) are thrown, so
 * pg-boss retries the run from scratch; on the last attempt the run is recorded as failed.
 */
export async function runAutomationJob(
  deps: AutomationRunDeps,
  raw: unknown,
  opts: { lastAttempt?: boolean } = {}
): Promise<RunOutcome> {
  const job = automationJobData.parse(raw);
  try {
    return await execute(deps, job);
  } catch (err) {
    // Rolled back before anything was kept; the worker puts the job back for later.
    if (err instanceof OutboundDeferred) {
      deps.logger.info(
        { automationId: job.subscriberId, retryAfter: err.retryAfterSeconds },
        'automation run deferred: workspace outbound rate'
      );
      return { deferred: err.retryAfterSeconds };
    }
    if (!opts.lastAttempt) throw err;
    deps.logger.warn({ err, automationId: job.subscriberId }, 'automation run failed');
    return withTenant(deps.db, job.workspaceId, async (tx) => {
      const [run] = await tx
        .insert(automationRuns)
        .values({
          workspaceId: job.workspaceId,
          automationId: job.subscriberId,
          idempotencyKey: idempotencyKey(job),
          status: 'failed',
          depth: 1,
          outboxId: job.outboxId ?? null,
          error: 'The run failed unexpectedly.',
        })
        .onConflictDoNothing()
        .returning();
      if (!run) return { skipped: 'duplicate' } as const;
      await tx
        .update(automations)
        .set({
          lastRunAt: sql`now()`,
          lastRunStatus: 'failed',
          updatedAt: sql`${automations.updatedAt}`,
        })
        .where(eq(automations.id, job.subscriberId));
      return { status: 'failed', runId: run.id } as const;
    });
  }
}

/** What a person's test or retry needs: the automation, and who runs it with their role. */
interface ManualRun {
  automation: AutomationRow;
  /** The person testing or retrying; the steps run as them. */
  userId: string;
  /** Their effective role on the base. */
  role: UserRole;
}

function invalid(path: string, message: string): never {
  throw new AppError('VALIDATION_FAILED', {
    detail: message,
    extensions: { errors: [{ path, message }] },
  });
}

function conflict(detail: string): never {
  throw new AppError('CONFLICT', { detail });
}

/**
 * The builder's Test: the trigger fires as its live trigger would, with a record of the
 * trigger's table (record, form and button triggers), the last request the webhook received, or
 * now (scheduled), and the actions run for real, as the person testing with their own role (never
 * as the automation's creator). Whether it's on or not. A record test doesn't touch the
 * "matches conditions" set, and the record needn't match. Depth 1, like a person's change: the
 * loop guard applies to what its writes trigger. Not counted, and the automation's last run
 * stays as it was.
 */
export async function testAutomation(
  tx: Transaction,
  deps: AutomationRunDeps,
  input: ManualRun & { recordId?: string | undefined }
): Promise<AutomationRun> {
  const { automation, userId } = input;
  if (actionsOf(automation).length === 0) {
    invalid('actions', 'Add an action before testing the automation.');
  }
  const trigger = triggerOf(automation);
  const base = { depth: 1, outboxId: null, triggeredBy: userId };
  let triggered: Fired;
  if (trigger.type === 'scheduled') {
    const now = new Date().toISOString();
    const data = { type: 'scheduled', scheduledAt: now, firedAt: now };
    triggered = { ...base, data, history: data };
  } else if (trigger.type === 'webhookReceived') {
    if (!automation.hookSampleAt) {
      conflict('Send a request to the webhook URL first; a test uses the last one it received.');
    }
    const data = {
      type: 'webhookReceived',
      receivedAt: automation.hookSampleAt.toISOString(),
      body: automation.hookSample ?? null,
    };
    triggered = { ...base, data, history: data };
  } else {
    if (!input.recordId) invalid('recordId', 'Pick a record to test with.');
    const found = await triggerRecord(tx, automation, trigger.tableId, input.recordId, userId);
    if (!found) {
      throw new AppError('NOT_FOUND', { detail: "No such record in the trigger's table." });
    }
    triggered = recordFired(found, await recordData(tx, trigger, userId), base);
  }
  const run = await performRun(tx, deps, automation, {
    userId,
    role: input.role,
    triggered,
    key: `test:${uuidv7()}`,
    mode: 'test',
    counted: false,
    updateLastRun: false,
  });
  if (!run) throw new Error('a test run with a fresh key conflicted');
  return toRun(run);
}

/** A record trigger's data besides the record, as its live trigger gives it. */
async function recordData(
  tx: Transaction,
  trigger: AutomationTrigger & { tableId: string },
  userId: string,
  stored?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  switch (trigger.type) {
    case 'recordUpdated': {
      const changed = stored?.['changedFieldIds'];
      return {
        type: trigger.type,
        changedFieldIds: Array.isArray(changed)
          ? changed.filter((id) => typeof id === 'string')
          : (trigger.fieldIds ?? []),
      };
    }
    case 'formSubmitted':
      return { type: trigger.type, viewId: trigger.viewId };
    case 'buttonClicked':
      return { type: trigger.type, fieldId: trigger.fieldId, user: await whoClicked(tx, userId) };
    default:
      return { type: trigger.type };
  }
}

/**
 * Runs a failed run again, once: from its stored trigger data (a record trigger's record
 * re-read with its values now, a webhook's body, a schedule's time, a button's clicker) with the
 * automation's trigger and actions as they are now, as the person retrying with their role.
 * Counted, and it becomes the automation's last run. Depth 1.
 */
export async function retryRun(
  tx: Transaction,
  deps: AutomationRunDeps,
  input: ManualRun & { runId: string }
): Promise<AutomationRun> {
  const { automation, userId } = input;
  const [failed] = await tx
    .select()
    .from(automationRuns)
    .where(and(eq(automationRuns.id, input.runId), eq(automationRuns.automationId, automation.id)));
  if (!failed) throw new AppError('NOT_FOUND', { detail: 'No such run.' });
  if (failed.status !== 'failed') conflict('Only failed runs can be retried.');
  const key = `retry:${failed.id}`;
  const [again] = await tx
    .select({ id: automationRuns.id })
    .from(automationRuns)
    .where(
      and(eq(automationRuns.automationId, automation.id), eq(automationRuns.idempotencyKey, key))
    );
  if (again) conflict('This run was already retried.');
  if (actionsOf(automation).length === 0) {
    invalid('actions', 'Add an action before retrying the run.');
  }
  const trigger = triggerOf(automation);
  const history = failed.trigger;
  const noData = "This run can't be retried: it has no trigger data.";
  if (!history || typeof history !== 'object' || Array.isArray(history)) conflict(noData);
  const old = history as Record<string, unknown>;
  if (old['truncated'] === true || typeof old['type'] !== 'string') conflict(noData);
  if (old['type'] !== trigger.type) {
    conflict("The automation's trigger changed since this run; it can't be retried.");
  }
  const base = { depth: 1, outboxId: null, triggeredBy: userId };
  let triggered: Fired;
  if (trigger.type === 'scheduled') {
    if (typeof old['scheduledAt'] !== 'string') conflict(noData);
    const data = {
      type: 'scheduled',
      scheduledAt: old['scheduledAt'],
      firedAt: new Date().toISOString(),
    };
    triggered = { ...base, data, history: data };
  } else if (trigger.type === 'webhookReceived') {
    if (!('body' in old) || typeof old['receivedAt'] !== 'string') conflict(noData);
    const data = { type: 'webhookReceived', receivedAt: old['receivedAt'], body: old['body'] };
    triggered = { ...base, data, history: data };
  } else {
    const record = old['record'] as { id?: unknown } | undefined;
    const recordId = typeof record?.id === 'string' ? record.id : null;
    if (!recordId || !UUID_RE.test(recordId)) conflict(noData);
    const found = await triggerRecord(tx, automation, trigger.tableId, recordId, userId);
    if (!found) conflict('The record is gone.');
    // A button run keeps who clicked; the others are as their trigger gives them.
    let clicker: string | null = null;
    if (trigger.type === 'buttonClicked') {
      const user = old['user'] as { id?: unknown } | undefined;
      // The clicker as stored (a retried retry's triggeredBy is who retried it).
      clicker = typeof user?.id === 'string' ? user.id : failed.triggeredBy;
      if (!clicker) conflict(noData);
    }
    triggered = recordFired(found, await recordData(tx, trigger, clicker ?? userId, old), base);
  }
  const run = await performRun(tx, deps, automation, {
    userId,
    role: input.role,
    triggered,
    key,
    mode: 'retry',
    retryOf: failed.id,
    counted: true,
    updateLastRun: true,
  });
  // A concurrent retry of the same run committed first.
  if (!run) conflict('This run was already retried.');
  return toRun(run);
}
