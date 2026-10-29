import {
  type Automation,
  type AutomationAction,
  type AutomationActionType,
  type AutomationRun,
  type AutomationRunStatus,
  type AutomationSkipReason,
  type AutomationTrigger,
  type AutomationTriggerType,
  type FieldMeta,
  getFieldType,
  roleAllows,
  type UserRole,
} from '@openrows/shared';
import { ApiError } from '../../api/client';

/**
 * The automations builder: labels, a new trigger or action of each type, the tokens a
 * step may insert (`{{trigger.record.fields.Name}}`, with friendly labels) and the server's
 * validation errors by the card they belong to. Pure, so it's tested without a DOM.
 */

export const canManageAutomations = (role: UserRole | null | undefined) =>
  !!role && roleAllows(role, 'base:manage_automations');

export const TRIGGER_TYPES: readonly AutomationTriggerType[] = [
  'recordCreated',
  'recordUpdated',
  'recordMatches',
  'formSubmitted',
  'buttonClicked',
  'scheduled',
  'webhookReceived',
];

export const TRIGGER_LABELS: Record<AutomationTriggerType, string> = {
  recordCreated: 'When a record is created',
  recordUpdated: 'When a record is updated',
  recordMatches: 'When a record matches conditions',
  formSubmitted: 'When a form is submitted',
  buttonClicked: 'When a button is clicked',
  scheduled: 'At a scheduled time',
  webhookReceived: 'When a webhook is received',
};

export const ACTION_TYPES: readonly AutomationActionType[] = [
  'createRecord',
  'updateRecord',
  'findRecords',
  'sendEmail',
  'slackMessage',
  'httpRequest',
  'runScript',
];

export const ACTION_LABELS: Record<AutomationActionType, string> = {
  createRecord: 'Create record',
  updateRecord: 'Update record',
  findRecords: 'Find records',
  sendEmail: 'Send email',
  slackMessage: 'Send Slack message',
  httpRequest: 'Send HTTP request',
  runScript: 'Run a script',
};

/** A new script step's source: what the API looks like. */
export const DEFAULT_SCRIPT = [
  '// Input variables (set below) are in input.config().',
  'const { recordId } = input.config();',
  "const table = base.getTable('TABLE_NAME');",
  'const record = recordId ? await table.selectRecordAsync(recordId) : null;',
  'const query = await table.selectRecordsAsync({ maxRecords: 100 });',
  "console.log(query.records.length, 'records');",
  '// Later steps read what you set as {{steps.N.output.<name>}}.',
  "output.set('count', query.records.length);",
  "output.set('name', record ? record.getCellValueAsString('Name') : null);",
  '',
].join('\n');

/** The names a script passes to `output.set('<name>', …)` literally, for the token picker. */
export function scriptOutputNames(script: string): string[] {
  const names = new Set<string>();
  for (const m of script.matchAll(/output\.set\(\s*(['"`])([A-Za-z_$][\w$]*)\1/g)) {
    if (m[2]) names.add(m[2]);
  }
  return [...names].slice(0, 50);
}

export const RUN_STATUS_LABELS: Record<AutomationRunStatus, string> = {
  succeeded: 'Succeeded',
  failed: 'Failed',
  skipped: 'Skipped',
};

/** Why a skipped run did nothing, as the run list tags it. */
export const SKIP_REASON_LABELS: Record<AutomationSkipReason, string> = {
  loop: 'Loop guard',
  quota: 'Plan limit',
};

/** Triggers a test needs a sample record for (the trigger table's). */
export const needsRecord = (trigger: AutomationTrigger) =>
  trigger.type !== 'scheduled' && trigger.type !== 'webhookReceived';

export const triggerTableId = (trigger: AutomationTrigger): string | null =>
  'tableId' in trigger ? trigger.tableId : null;

export const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const pad = (n: number) => String(n).padStart(2, '0');

/** Tomorrow at 09:00, as a schedule's wall time (`YYYY-MM-DDTHH:mm`). */
export function tomorrowAtNine(now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00`;
}

/** A new trigger of this type on the given table (the first one by default). */
export function defaultTrigger(
  type: AutomationTriggerType,
  tableId: string,
  now = new Date()
): AutomationTrigger {
  switch (type) {
    case 'recordCreated':
      return { type, tableId };
    case 'recordUpdated':
      return { type, tableId, fieldIds: null };
    case 'recordMatches':
      return { type, tableId, filter: { conjunction: 'and', conditions: [] } };
    case 'formSubmitted':
      return { type, tableId, viewId: '' };
    case 'buttonClicked':
      return { type, tableId, fieldId: '' };
    case 'scheduled':
      return {
        type,
        schedule: {
          kind: 'interval',
          every: 1,
          unit: 'days',
          startAt: tomorrowAtNine(now),
          timeZone: browserTimeZone(),
        },
      };
    case 'webhookReceived':
      return { type };
  }
}

/** A new action of this type; record steps start on the trigger's table. */
export function defaultAction(
  type: AutomationActionType,
  trigger: AutomationTrigger,
  firstTableId: string,
  /** The trigger's (or first) table's name, for a new script's example. */
  tableNameHint?: string
): AutomationAction {
  const tableId = triggerTableId(trigger) ?? firstTableId;
  switch (type) {
    case 'createRecord':
      return { type, tableId, fields: {} };
    case 'updateRecord':
      return {
        type,
        tableId,
        recordId: needsRecord(trigger) ? '{{trigger.record.id}}' : '',
        fields: {},
      };
    case 'findRecords':
      return { type, tableId, filter: { conjunction: 'and', conditions: [] }, limit: 100 };
    case 'sendEmail':
      return { type, to: [], subject: '', body: '' };
    case 'slackMessage':
      return { type, text: '' };
    case 'httpRequest':
      return { type, method: 'POST', url: '', headers: [] };
    case 'runScript':
      return {
        type,
        script: DEFAULT_SCRIPT.replace('TABLE_NAME', () =>
          (tableNameHint ?? 'Table 1').replace(/['\\]/g, (c) => `\\${c}`)
        ),
        inputs: needsRecord(trigger) ? { recordId: '{{trigger.record.id}}' } : {},
      };
  }
}

/** Moves an item of a list (reordering actions); out-of-range moves change nothing. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || to < 0 || to >= list.length || from < 0 || from >= list.length) {
    return [...list];
  }
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

/** Fields an action may set: not computed, not read-only. */
export const writableFields = (fields: readonly FieldMeta[]) =>
  fields.filter((f) => {
    const def = getFieldType(f.type);
    return !def.readOnly && !def.computed;
  });

// ---- Tokens ----

export interface TokenOption {
  /** Who it comes from: "Trigger" or "Step 2: Find records". */
  group: string;
  /** What it is, in words: "Record › Name". */
  label: string;
  token: string;
}

/**
 * A key in a token path: `.Name` (spaces are fine), else `["a.b"]`; a name the token grammar
 * can't hold (braces, both quote kinds) falls back to the field's id, which tokens also know.
 */
export function pathKey(name: string, fallback: string): string {
  if (/[{}]/.test(name) || name.trim() === '') return `.${fallback}`;
  if (name === name.trim() && !/[.[\]]/.test(name) && !/^\d+$/.test(name)) return `.${name}`;
  if (!name.includes('"')) return `["${name}"]`;
  if (!name.includes("'")) return `['${name}']`;
  return `.${fallback}`;
}

const token = (path: string) => `{{${path}}}`;

function recordTokens(
  group: string,
  prefix: string,
  noun: string,
  fields: readonly FieldMeta[] | undefined
): TokenOption[] {
  return [
    { group, label: `${noun} › Record ID`, token: token(`${prefix}.id`) },
    ...(fields ?? []).map((f) => ({
      group,
      label: `${noun} › ${f.name}`,
      token: token(`${prefix}.fields${pathKey(f.name, f.id)}`),
    })),
  ];
}

const MAX_SAMPLE_TOKENS = 60;

/** The leaves of a webhook's sample body, as `trigger.body...` tokens (a few levels deep). */
export function bodyTokens(body: unknown): TokenOption[] {
  const out: TokenOption[] = [];
  const walk = (value: unknown, path: string, label: string, depth: number) => {
    if (out.length >= MAX_SAMPLE_TOKENS) return;
    if (Array.isArray(value)) {
      if (depth < 4 && value.length) walk(value[0], `${path}[0]`, `${label} › 1st`, depth + 1);
      else out.push({ group: 'Trigger', label, token: token(path) });
      return;
    }
    if (value && typeof value === 'object' && depth < 4) {
      for (const [k, v] of Object.entries(value)) {
        const key = /[{}]/.test(k) ? null : pathKey(k, '');
        if (key && key !== '.') walk(v, `${path}${key}`, label ? `${label} › ${k}` : k, depth + 1);
      }
      return;
    }
    out.push({ group: 'Trigger', label: label || 'Body', token: token(path) });
  };
  walk(body, 'trigger.body', '', 0);
  return out;
}

export interface TokenContext {
  trigger: AutomationTrigger;
  actions: readonly AutomationAction[];
  /** The fields of a table, when loaded. */
  fieldsOf: (tableId: string) => readonly FieldMeta[] | undefined;
  webhookSample?: Automation['webhookSample'];
}

/**
 * The tokens step `step` (1-based) may use: the trigger's data, then each step before it.
 * The server refuses tokens pointing at the step itself or later ones.
 */
export function tokensFor(ctx: TokenContext, step: number): TokenOption[] {
  const { trigger } = ctx;
  const out: TokenOption[] = [];
  const tableId = triggerTableId(trigger);
  if (tableId)
    out.push(...recordTokens('Trigger', 'trigger.record', 'Record', ctx.fieldsOf(tableId)));
  if (trigger.type === 'buttonClicked') {
    out.push(
      { group: 'Trigger', label: 'Clicked by › Name', token: token('trigger.user.name') },
      { group: 'Trigger', label: 'Clicked by › Email', token: token('trigger.user.email') }
    );
  }
  if (trigger.type === 'scheduled') {
    out.push({ group: 'Trigger', label: 'Scheduled time', token: token('trigger.scheduledAt') });
  }
  if (trigger.type === 'webhookReceived') {
    const sample = ctx.webhookSample?.body;
    out.push(
      ...(sample === undefined
        ? [{ group: 'Trigger', label: 'Body', token: token('trigger.body') }]
        : bodyTokens(sample))
    );
  }
  ctx.actions.slice(0, Math.max(0, step - 1)).forEach((a, i) => {
    const n = i + 1;
    const group = `Step ${n}: ${ACTION_LABELS[a.type]}`;
    const fields = 'tableId' in a ? ctx.fieldsOf(a.tableId) : undefined;
    switch (a.type) {
      case 'createRecord':
        out.push(...recordTokens(group, `steps.${n}.record`, 'Created record', fields));
        break;
      case 'updateRecord':
      case 'findRecords':
        out.push(
          { group, label: 'Records (list)', token: token(`steps.${n}.records`) },
          { group, label: 'Number of records', token: token(`steps.${n}.count`) },
          ...recordTokens(group, `steps.${n}.records[0]`, 'First record', fields)
        );
        break;
      case 'httpRequest':
        out.push(
          { group, label: 'Response status', token: token(`steps.${n}.status`) },
          { group, label: 'Response body', token: token(`steps.${n}.body`) }
        );
        break;
      case 'sendEmail':
        out.push({ group, label: 'Emails sent', token: token(`steps.${n}.sent`) });
        break;
      case 'slackMessage':
        out.push({ group, label: 'Response status', token: token(`steps.${n}.status`) });
        break;
      case 'runScript':
        out.push(
          ...scriptOutputNames(a.script).map((name) => ({
            group,
            label: `Output: ${name}`,
            token: token(`steps.${n}.output.${name}`),
          })),
          { group, label: 'All outputs', token: token(`steps.${n}.output`) }
        );
        break;
    }
  });
  return out;
}

/** Puts a token at the caret (replacing a selection); answers the text and the new caret. */
export function insertToken(
  value: string,
  start: number | null,
  end: number | null,
  tokenText: string
): { value: string; caret: number } {
  const s = Math.min(Math.max(start ?? value.length, 0), value.length);
  const e = Math.min(Math.max(end ?? s, s), value.length);
  return { value: value.slice(0, s) + tokenText + value.slice(e), caret: s + tokenText.length };
}

// ---- Errors ----

export interface ProblemErrors {
  /** The first message, for a toast. */
  message: string;
  /** Messages by path (`trigger.tableId`, `actions.1.url`). */
  byPath: Record<string, string>;
}

/** The server's 422 for an automation, by path; other errors are only a message. */
export function problemErrors(err: unknown, fallback: string): ProblemErrors {
  if (!(err instanceof ApiError)) return { message: fallback, byPath: {} };
  const byPath: Record<string, string> = {};
  const errors = (err.data as { errors?: { path?: unknown; message?: unknown }[] } | undefined)
    ?.errors;
  for (const e of errors ?? []) {
    if (typeof e.path === 'string' && typeof e.message === 'string' && !(e.path in byPath)) {
      byPath[e.path] = e.message;
    }
  }
  return { message: err.message || fallback, byPath };
}

/** Paths whose message shows next to its control; others show at the foot of the card. */
const INLINE_PATH =
  /^(trigger\.(tableId|fieldIds|viewId|fieldId|schedule\.(every|startAt|expression|timeZone))|actions\.\d+\.(tableId|recordId|fields|fields\.[0-9a-f-]{36}|limit|to|subject|body|text|webhookUrl|url))$/i;

/** The messages for a card (`trigger`, `actions.2`) that no control of it shows. */
export function cardErrors(byPath: Record<string, string>, prefix: string): string[] {
  return [
    ...new Set(
      Object.entries(byPath)
        .filter(([p]) => (p === prefix || p.startsWith(`${prefix}.`)) && !INLINE_PATH.test(p))
        .map(([, m]) => m)
    ),
  ];
}

/** Errors that belong to no card (the name, enabling it, the whole config). */
export function generalErrors(byPath: Record<string, string>): string[] {
  return Object.entries(byPath)
    .filter(([p]) => !p.startsWith('trigger') && !p.startsWith('actions.'))
    .map(([, m]) => m);
}

// ---- Runs ----

export const runWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

/** What a run's trigger was about, in a line: the record's primary value or the time. */
export function runSubject(run: AutomationRun): string {
  const t = run.trigger as
    | { type?: string; record?: { id?: string; fields?: Record<string, unknown> } }
    | null
    | undefined;
  const fields = t?.record?.fields;
  if (fields) {
    const first = Object.values(fields).find((v) => typeof v === 'string' && v.trim());
    if (typeof first === 'string') return first;
    if (t?.record?.id) return `Record ${t.record.id.slice(0, 8)}`;
  }
  if (t?.type === 'scheduled') return 'Scheduled run';
  if (t?.type === 'webhookReceived') return 'Webhook request';
  return 'Run';
}

export const modeLabel = (run: AutomationRun) =>
  run.mode === 'test' ? 'Test' : run.mode === 'retry' ? 'Retry' : null;

/** A failed run whose trigger data was kept can be run again (once). */
export function canRetry(run: AutomationRun, runs: readonly AutomationRun[]): boolean {
  if (run.status !== 'failed' || run.mode === 'test') return false;
  const t = run.trigger as Record<string, unknown> | null | undefined;
  if (!t || typeof t !== 'object' || !('type' in t)) return false;
  return !runs.some((r) => r.retryOf === run.id);
}

/** JSON for the run log, shortened past a few thousand characters. */
export function pretty(value: unknown, max = 4000): string {
  const text = JSON.stringify(value ?? null, null, 2) ?? 'null';
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}
