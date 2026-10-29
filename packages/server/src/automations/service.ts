import {
  type Automation,
  type AutomationAction,
  type AutomationListItem,
  type AutomationRun,
  type AutomationRunStatus,
  type AutomationScripts,
  type AutomationTrigger,
  automationActionSchema,
  automationTriggerSchema,
  type createAutomationSchema,
  type FailedAutomationRun,
  MAX_AUTOMATIONS_PER_BASE,
  nextScheduledRun,
  type Schedule,
  templateValuePaths,
  type updateAutomationSchema,
  viewQuerySchema,
} from '@openrows/shared';
import { and, count, desc, eq, inArray, isNull, ne, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import type { Cipher } from '../auth/crypto.js';
import { qualified } from '../data/columns.js';
import { compileViewQuery, QueryValidationError } from '../data/query/compile.js';
import {
  automationMatches,
  automationRuns,
  automations,
  type Transaction,
  tables,
  views,
} from '../db/index.js';
import type { TableRow } from '../fields/service.js';
import { AppError } from '../lib/errors.js';
import { SafeFetchError } from '../lib/safe-fetch/index.js';
import { type FieldInfo, tableFields, toQueryFields } from '../records/service.js';
import type { ScriptSandbox } from './script/types.js';
import {
  generateHookToken,
  hashHookToken,
  hookUrl,
  readSecrets,
  splitSecrets,
  writeSecrets,
} from './secrets.js';

export type AutomationRow = typeof automations.$inferSelect;
export type AutomationRunRow = typeof automationRuns.$inferSelect;

/** What the API needs for automations' secrets and URLs. */
export interface AutomationDeps {
  /** The `automation-secret` cipher: action secrets and webhook-received tokens. */
  cipher: Cipher;
  appUrl: string;
  /** The outbound rules without connecting (safe-fetch's createUrlCheck), for saved URLs. */
  checkUrl: (url: string) => Promise<void>;
  /** Whether workspaces may use run-script steps. */
  scripts: Pick<ScriptSandbox, 'limitsFor'>;
}

export interface AutomationContext {
  tx: Transaction;
  workspaceId: string;
  baseId: string;
  userId: string;
  deps: AutomationDeps;
}

/** The stored trigger and actions, read back with the schemas (a row is only written checked). */
export function triggerOf(row: Pick<AutomationRow, 'trigger'>): AutomationTrigger {
  return automationTriggerSchema.parse(row.trigger);
}

export function actionsOf(row: Pick<AutomationRow, 'actions'>): AutomationAction[] {
  return (Array.isArray(row.actions) ? row.actions : []).map((a) =>
    automationActionSchema.parse(a)
  );
}

/** The webhook-received URL, for its creators; null without a token or the key. */
function webhookUrlOf(
  row: AutomationRow,
  deps: Pick<AutomationDeps, 'cipher' | 'appUrl'> | undefined
) {
  if (!deps || !row.hookTokenEncrypted) return null;
  const token = deps.cipher.decrypt(row.hookTokenEncrypted);
  return token ? hookUrl(deps.appUrl, token) : null;
}

export function toAutomation(
  row: AutomationRow,
  deps?: Pick<AutomationDeps, 'cipher' | 'appUrl'>
): Automation {
  return {
    id: row.id,
    baseId: row.baseId,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    disabledReason: row.disabledReason === 'creator_access' ? 'creator_access' : null,
    trigger: triggerOf(row),
    actions: actionsOf(row),
    createdBy: row.createdBy,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastRunStatus: (row.lastRunStatus as Automation['lastRunStatus']) ?? null,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    webhookUrl: webhookUrlOf(row, deps),
    webhookSample: row.hookSampleAt
      ? { receivedAt: row.hookSampleAt.toISOString(), body: row.hookSample ?? null }
      : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toRun(row: AutomationRunRow): AutomationRun {
  return {
    id: row.id,
    automationId: row.automationId,
    status: row.status,
    mode: row.mode,
    skipReason: row.skipReason,
    retryOf: row.retryOf,
    trigger: row.trigger,
    steps: Array.isArray(row.steps) ? (row.steps as AutomationRun['steps']) : [],
    error: row.error,
    depth: row.depth,
    triggeredBy: row.triggeredBy,
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
  };
}

function invalid(errors: { path: string; message: string }[]): never {
  throw new AppError('VALIDATION_FAILED', {
    detail: errors[0]?.message ?? 'The automation is invalid.',
    extensions: { errors },
  });
}

/** A live table of this base, or null. */
export async function baseTable(
  tx: Transaction,
  baseId: string,
  tableId: string
): Promise<TableRow | null> {
  const [row] = await tx
    .select()
    .from(tables)
    .where(and(eq(tables.id, tableId), eq(tables.baseId, baseId), isNull(tables.deletedAt)));
  return row ?? null;
}

/**
 * A filter with its token-holding values left out: what can be checked before a run fills them
 * in (the field ids and operators; values with tokens are checked when the run compiles them).
 */
function withoutTokens(filter: unknown): unknown {
  if (Array.isArray(filter)) return filter.map(withoutTokens);
  if (filter && typeof filter === 'object') {
    const entry = filter as Record<string, unknown>;
    if ('fieldId' in entry && templateValuePaths(entry['value']).length) {
      const { value: _value, ...rest } = entry;
      return rest;
    }
    return Object.fromEntries(Object.entries(entry).map(([k, v]) => [k, withoutTokens(v)]));
  }
  return filter;
}

/** Compiles a filter against a table's fields; 422 with paths under `path`. */
function checkFilter(fields: FieldInfo[], filter: unknown, path: string, userId: string) {
  try {
    return compileViewQuery(viewQuerySchema.parse({ filter }), toQueryFields(fields), {
      userId,
      path,
    });
  } catch (err) {
    if (err instanceof QueryValidationError) invalid(err.errors);
    throw err;
  }
}

/**
 * The trigger and actions must name live tables of this base and fields of those tables, and
 * filters must compile. Cells of computed or read-only fields are refused here; values
 * are checked by the RecordService when a run writes them.
 */
async function checkConfig(
  ctx: AutomationContext,
  trigger: AutomationTrigger,
  actions: readonly AutomationAction[]
) {
  const cache = new Map<string, { table: TableRow; fields: FieldInfo[] } | null>();
  const load = async (tableId: string) => {
    if (!cache.has(tableId)) {
      const table = await baseTable(ctx.tx, ctx.baseId, tableId);
      cache.set(tableId, table ? { table, fields: await tableFields(ctx.tx, table) } : null);
    }
    return cache.get(tableId) ?? null;
  };
  const errors: { path: string; message: string }[] = [];
  if ('tableId' in trigger) {
    const t = await load(trigger.tableId);
    if (!t) invalid([{ path: 'trigger.tableId', message: 'No such table in this base.' }]);
    if (trigger.type === 'recordUpdated' && trigger.fieldIds) {
      trigger.fieldIds.forEach((id, i) => {
        if (!t.fields.some((f) => f.row.id === id)) {
          errors.push({ path: `trigger.fieldIds.${i}`, message: 'No such field in this table.' });
        }
      });
    }
    if (trigger.type === 'recordMatches') {
      checkFilter(t.fields, trigger.filter, 'trigger', ctx.userId);
    }
    if (trigger.type === 'formSubmitted') {
      const [view] = await ctx.tx
        .select({ type: views.type })
        .from(views)
        .where(
          and(eq(views.id, trigger.viewId), eq(views.tableId, t.table.id), isNull(views.deletedAt))
        );
      if (view?.type !== 'form') {
        errors.push({ path: 'trigger.viewId', message: 'No such form view in this table.' });
      }
    }
    if (trigger.type === 'buttonClicked') {
      const f = t.fields.find((x) => x.row.id === trigger.fieldId);
      if (f?.row.type !== 'button') {
        errors.push({ path: 'trigger.fieldId', message: 'No such button field in this table.' });
      }
    }
  }
  await checkScripts(ctx, actions, errors);
  for (const [i, action] of actions.entries()) {
    if (action.type === 'sendEmail' || action.type === 'runScript') continue;
    if (action.type === 'httpRequest' || action.type === 'slackMessage') {
      await checkActionUrl(ctx, action, i, errors);
      continue;
    }
    const t = await load(action.tableId);
    if (!t) {
      errors.push({ path: `actions.${i}.tableId`, message: 'No such table in this base.' });
      continue;
    }
    if (action.type === 'findRecords') {
      if (action.filter)
        checkFilter(t.fields, withoutTokens(action.filter), `actions.${i}`, ctx.userId);
      continue;
    }
    for (const fieldId of Object.keys(action.fields)) {
      const f = t.fields.find((x) => x.row.id === fieldId);
      const path = `actions.${i}.fields.${fieldId}`;
      if (!f) errors.push({ path, message: 'No such field in this table.' });
      else if (f.def.readOnly || f.def.computed) {
        errors.push({ path, message: `${f.row.name} is computed; it can't be set.` });
      }
    }
  }
  if (errors.length) invalid(errors);
}

/** Run-script steps only where the server runs scripts and the workspace may use them. */
async function checkScripts(
  ctx: AutomationContext,
  actions: readonly AutomationAction[],
  errors: { path: string; message: string }[]
) {
  const i = actions.findIndex((a) => a.type === 'runScript');
  if (i < 0) return;
  const availability = await ctx.deps.scripts.limitsFor(ctx.workspaceId);
  if (availability.available) return;
  errors.push({
    path: `actions.${i}.type`,
    message:
      availability.reason === 'plan'
        ? "This workspace's plan doesn't include scripts."
        : "This server doesn't run scripts.",
  });
}

/**
 * An HTTP or Slack step's URL must pass the outbound rules now; they apply again on every
 * request. An HTTP URL with tokens is checked when a run fills them in. A Slack URL is a secret
 * and holds no tokens. Secret header values hold no tokens either (they are sent as written).
 */
async function checkActionUrl(
  ctx: AutomationContext,
  action: AutomationAction & { type: 'httpRequest' | 'slackMessage' },
  i: number,
  errors: { path: string; message: string }[]
) {
  const url = action.type === 'httpRequest' ? action.url : action.webhookUrl;
  const path = `actions.${i}.${action.type === 'httpRequest' ? 'url' : 'webhookUrl'}`;
  if (action.type === 'httpRequest') {
    action.headers.forEach((h, j) => {
      if (h.secret && h.value !== undefined && templateValuePaths(h.value).length) {
        errors.push({
          path: `actions.${i}.headers.${j}.value`,
          message: "A secret header's value can't hold tokens.",
        });
      }
    });
  }
  if (url === undefined) return;
  // Secrets go to a fixed server: a host from a token would let whoever fills it in pick it.
  const origin = /^[^:/?#]*:\/\/[^/?#]*/.exec(url)?.[0] ?? url;
  if (
    action.type === 'httpRequest' &&
    action.headers.some((h) => h.secret) &&
    templateValuePaths(origin).length
  ) {
    errors.push({ path, message: "With secret headers, the URL's host can't hold tokens." });
    return;
  }
  if (templateValuePaths(url).length) {
    if (action.type === 'slackMessage') {
      errors.push({ path, message: "A Slack webhook URL can't hold tokens." });
    }
    return;
  }
  try {
    await ctx.deps.checkUrl(url);
  } catch (err) {
    if (err instanceof SafeFetchError) {
      errors.push({ path, message: `This URL can't be used: ${err.message}.` });
      return;
    }
    throw err;
  }
}

/**
 * The actions to store, with their secrets taken out and checked against what the row
 * had; and the webhook-received token, made when the trigger becomes one and dropped when it
 * stops being one.
 */
function storedParts(
  ctx: AutomationContext,
  trigger: AutomationTrigger,
  actions: readonly AutomationAction[],
  row: AutomationRow | null
) {
  const previous = row
    ? { actions: actionsOf(row), secrets: readSecrets(ctx.deps.cipher, row.secretsEncrypted) }
    : { actions: [], secrets: [] };
  const split = splitSecrets(actions, previous);
  if (split.problems.length) invalid(split.problems);
  let hook: { hookTokenHash: string | null; hookTokenEncrypted: Buffer | null } | undefined;
  if (trigger.type === 'webhookReceived' && !row?.hookTokenHash) hook = newHook(ctx.deps.cipher);
  if (trigger.type !== 'webhookReceived' && row?.hookTokenHash) {
    hook = { hookTokenHash: null, hookTokenEncrypted: null };
  }
  return {
    actions: split.actions,
    secretsEncrypted: writeSecrets(ctx.deps.cipher, split.secrets),
    ...(hook ?? {}),
  };
}

function newHook(cipher: Cipher) {
  const token = generateHookToken();
  return { hookTokenHash: hashHookToken(token), hookTokenEncrypted: cipher.encrypt(token) };
}

/**
 * Turns the trigger on as of now: events from now on trigger it, a "matches conditions"
 * trigger starts from the records already matching (they don't fire), and a schedule gets its
 * next run. Off: no next run and no match set.
 */
async function arm(tx: Transaction, row: AutomationRow, userId: string): Promise<AutomationRow> {
  await tx.delete(automationMatches).where(eq(automationMatches.automationId, row.id));
  const trigger = triggerOf(row);
  let nextRunAt: Date | null = null;
  if (row.enabled && trigger.type === 'scheduled') {
    nextRunAt = nextScheduledRun(trigger.schedule as Schedule, new Date());
  }
  if (row.enabled && trigger.type === 'recordMatches') {
    const table = await baseTable(tx, row.baseId, trigger.tableId);
    if (table) {
      const fields = await tableFields(tx, table);
      const { where } = checkFilter(fields, trigger.filter, 'trigger', userId);
      await tx.execute(sql`
        INSERT INTO automation_matches (workspace_id, automation_id, record_id)
        SELECT ${row.workspaceId}::uuid, ${row.id}::uuid, r.id FROM ${qualified(table)} AS r
         WHERE ${where}
        ON CONFLICT DO NOTHING`);
    }
  }
  const [updated] = await tx
    .update(automations)
    .set({ armedAt: sql`now()`, nextRunAt })
    .where(eq(automations.id, row.id))
    .returning();
  if (!updated) throw new Error('automation update returned nothing');
  return updated;
}

/** The base's automations, each with how many runs its history holds. */
/** Whether the workspace may add run-script steps and their limits, for the builder. */
export async function scriptsFor(
  deps: Pick<AutomationDeps, 'scripts'>,
  workspaceId: string
): Promise<AutomationScripts> {
  const a = await deps.scripts.limitsFor(workspaceId);
  return a.available
    ? { available: true, reason: null, limits: a.limits }
    : { available: false, reason: a.reason, limits: null };
}

export async function listAutomations(
  tx: Transaction,
  baseId: string,
  deps: Pick<AutomationDeps, 'cipher' | 'appUrl'>
): Promise<AutomationListItem[]> {
  const rows = await tx
    .select()
    .from(automations)
    .where(eq(automations.baseId, baseId))
    .orderBy(automations.createdAt, automations.id);
  const counts = rows.length
    ? await tx
        .select({ automationId: automationRuns.automationId, n: count() })
        .from(automationRuns)
        .where(
          inArray(
            automationRuns.automationId,
            rows.map((r) => r.id)
          )
        )
        .groupBy(automationRuns.automationId)
    : [];
  const runCount = new Map(counts.map((c) => [c.automationId, c.n]));
  return rows.map((r) => ({ ...toAutomation(r, deps), runCount: runCount.get(r.id) ?? 0 }));
}

/** The automation of this base, or 404 (ids of other bases and tenants never match). */
export async function loadAutomation(
  tx: Transaction,
  baseId: string,
  automationId: string
): Promise<AutomationRow> {
  const [row] = await tx
    .select()
    .from(automations)
    .where(and(eq(automations.id, automationId), eq(automations.baseId, baseId)));
  if (!row) throw new AppError('NOT_FOUND', { detail: 'No such automation.' });
  return row;
}

function needsAction(enabled: boolean, actions: readonly AutomationAction[]) {
  if (enabled && actions.length === 0) {
    invalid([{ path: 'enabled', message: 'Add an action before turning the automation on.' }]);
  }
}

export async function createAutomation(
  ctx: AutomationContext,
  input: z.output<typeof createAutomationSchema>
): Promise<Automation> {
  // One creation at a time per base, so the cap holds under concurrent requests.
  await ctx.tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`automations:${ctx.baseId}`}, 0))`
  );
  const [existing] = await ctx.tx
    .select({ n: count() })
    .from(automations)
    .where(eq(automations.baseId, ctx.baseId));
  if ((existing?.n ?? 0) >= MAX_AUTOMATIONS_PER_BASE) {
    throw new AppError('CONFLICT', {
      detail: `A base can have at most ${MAX_AUTOMATIONS_PER_BASE} automations.`,
    });
  }
  needsAction(input.enabled, input.actions);
  await checkConfig(ctx, input.trigger, input.actions);
  const parts = storedParts(ctx, input.trigger, input.actions, null);
  const [row] = await ctx.tx
    .insert(automations)
    .values({
      workspaceId: ctx.workspaceId,
      baseId: ctx.baseId,
      name: input.name,
      description: input.description,
      enabled: input.enabled,
      trigger: input.trigger,
      ...parts,
      triggerType: input.trigger.type,
      tableId: triggerTableId(input.trigger),
      createdBy: ctx.userId,
    })
    .returning();
  if (!row) throw new Error('automation insert returned nothing');
  return toAutomation(await arm(ctx.tx, row, ctx.userId), ctx.deps);
}

/**
 * Changes an automation. Whoever changes its trigger or actions, or turns it on, is the one it
 * runs as from then on: a creator can never make an automation do, as someone else, what
 * their own permissions don't allow.
 */
export async function updateAutomation(
  ctx: AutomationContext,
  automationId: string,
  input: z.output<typeof updateAutomationSchema>
): Promise<Automation> {
  const row = await loadAutomation(ctx.tx, ctx.baseId, automationId);
  const trigger = input.trigger ?? triggerOf(row);
  const actions = input.actions ?? actionsOf(row);
  const enabled = input.enabled ?? row.enabled;
  needsAction(enabled, actions);
  if (input.trigger || input.actions) await checkConfig(ctx, trigger, actions);
  else if (enabled && !row.enabled) {
    // Turning on: scripts must still be available (a plan may have changed).
    const errors: { path: string; message: string }[] = [];
    await checkScripts(ctx, actions, errors);
    if (errors.length) invalid(errors);
  }
  const parts = input.trigger || input.actions ? storedParts(ctx, trigger, actions, row) : {};
  const turningOn = enabled && !row.enabled;
  const takesOver = turningOn || input.trigger !== undefined || input.actions !== undefined;
  const [updated] = await ctx.tx
    .update(automations)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.trigger
        ? {
            trigger: input.trigger,
            triggerType: input.trigger.type,
            tableId: triggerTableId(input.trigger),
          }
        : {}),
      ...parts,
      ...(input.enabled !== undefined ? { enabled, disabledReason: null } : {}),
      ...(takesOver ? { createdBy: ctx.userId } : {}),
    })
    .where(eq(automations.id, row.id))
    .returning();
  if (!updated) throw new Error('automation update returned nothing');
  // Re-armed when it turns on or off, or its trigger changes while on.
  const rearm = enabled !== row.enabled || (enabled && input.trigger !== undefined);
  return toAutomation(rearm ? await arm(ctx.tx, updated, ctx.userId) : updated, ctx.deps);
}

/** A webhook-received trigger's new URL; the old token stops working at once. */
export async function rotateHookUrl(
  ctx: AutomationContext,
  automationId: string
): Promise<Automation> {
  const row = await loadAutomation(ctx.tx, ctx.baseId, automationId);
  if (triggerOf(row).type !== 'webhookReceived') {
    throw new AppError('CONFLICT', { detail: "This automation's trigger isn't a webhook." });
  }
  const [updated] = await ctx.tx
    .update(automations)
    .set(newHook(ctx.deps.cipher))
    .where(eq(automations.id, row.id))
    .returning();
  if (!updated) throw new Error('automation update returned nothing');
  return toAutomation(updated, ctx.deps);
}

/** The table a trigger watches (null: a schedule or a webhook). */
function triggerTableId(trigger: AutomationTrigger): string | null {
  return 'tableId' in trigger ? trigger.tableId : null;
}

export async function deleteAutomation(tx: Transaction, baseId: string, automationId: string) {
  const row = await loadAutomation(tx, baseId, automationId);
  await tx.delete(automations).where(eq(automations.id, row.id));
}

/**
 * The base's dead letters: failed runs (live or retries; tests are the tester's own) of
 * the retention window that no run retried, newest first, with their automation's name.
 */
export async function listFailedRuns(
  tx: Transaction,
  baseId: string,
  limit: number
): Promise<FailedAutomationRun[]> {
  const retried = alias(automationRuns, 'retried');
  const rows = await tx
    .select({ run: automationRuns, automationName: automations.name })
    .from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(
      and(
        eq(automations.baseId, baseId),
        eq(automationRuns.status, 'failed'),
        ne(automationRuns.mode, 'test'),
        notExists(
          tx.select({ one: sql`1` }).from(retried).where(eq(retried.retryOf, automationRuns.id))
        )
      )
    )
    .orderBy(desc(automationRuns.createdAt), desc(automationRuns.id))
    .limit(limit);
  return rows.map((r) => ({ ...toRun(r.run), automationName: r.automationName }));
}

export async function listRuns(
  tx: Transaction,
  baseId: string,
  automationId: string,
  query: { limit: number; status?: AutomationRunStatus | undefined }
): Promise<AutomationRun[]> {
  const row = await loadAutomation(tx, baseId, automationId);
  const rows = await tx
    .select()
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.automationId, row.id),
        query.status ? eq(automationRuns.status, query.status) : undefined
      )
    )
    .orderBy(desc(automationRuns.createdAt), desc(automationRuns.id))
    .limit(query.limit);
  return rows.map(toRun);
}
