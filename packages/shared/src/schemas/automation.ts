import { z } from 'zod';
import {
  MAX_SCHEDULE_EVERY,
  SCHEDULE_UNITS,
  type Schedule,
  scheduleProblems,
} from '../automations/schedule.js';
import { type PathKey, TemplateError, valuePaths } from '../automations/template.js';
import { timeZoneSchema } from '../fields/datetime.js';
import { filterGroupSchema } from '../query/index.js';

/**
 * Automations: a base's trigger (a record created, updated or entering a filter, or a
 * schedule) and its ordered actions (create, update and find records), run by the worker as the
 * automation's creator. Managed by the base's creators; every run is kept 30 days.
 */

export const MAX_AUTOMATIONS_PER_BASE = 50;
export const MAX_AUTOMATION_ACTIONS = 25;
/** Automation writes trigger automations up to this depth; deeper runs are skipped (loop guard). */
export const MAX_AUTOMATION_DEPTH = 3;
export const AUTOMATION_RUN_RETENTION_DAYS = 30;
export const MAX_FIND_RECORDS = 100;
/** Records one update action may change (a found list). */
export const MAX_UPDATE_RECORDS = 100;
export const MAX_AUTOMATION_NAME = 255;
export const MAX_AUTOMATION_DESCRIPTION = 2000;
/** The trigger and actions as JSON. */
export const MAX_AUTOMATION_CONFIG_BYTES = 64 * 1024;
export const MAX_AUTOMATION_CELLS = 500;
export const MAX_AUTOMATION_RUNS_PAGE = 100;
/** A webhook-received trigger's request body. */
export const MAX_AUTOMATION_HOOK_BYTES = 100 * 1024;
/** Recipients of one send-email step, after tokens and user fields are resolved. */
export const MAX_EMAIL_RECIPIENTS = 50;
export const MAX_EMAIL_SUBJECT = 500;
export const MAX_EMAIL_BODY = 20_000;
export const MAX_HTTP_HEADERS = 20;
export const MAX_HTTP_URL = 2000;
export const MAX_HTTP_HEADER_VALUE = 4000;
export const MAX_SLACK_TEXT = 4000;
/** A run-script step's source; the whole config stays under MAX_AUTOMATION_CONFIG_BYTES. */
export const MAX_SCRIPT_LENGTH = 50_000;
/** A run-script step's input variables (`input.config()`), by name. */
export const MAX_SCRIPT_INPUTS = 50;
export const MAX_SCRIPT_INPUT_VALUE = 4000;
/** What a run log shows instead of a header value or a secret. */
export const REDACTED = '[redacted]';

const at = z.iso.datetime({ offset: true });

export const scheduleSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('cron'),
      /** Five fields (minute hour day month weekday) or a macro such as `@daily`. */
      expression: z.string().trim().min(1).max(120),
      timeZone: timeZoneSchema,
    }),
    z.strictObject({
      kind: z.literal('interval'),
      every: z.number().int().min(1).max(MAX_SCHEDULE_EVERY),
      unit: z.enum(SCHEDULE_UNITS),
      /** The first run, a wall time in `timeZone`: `YYYY-MM-DDTHH:mm`. */
      startAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Expected YYYY-MM-DDTHH:mm'),
      timeZone: timeZoneSchema,
    }),
  ])
  .superRefine((s, ctx) => {
    for (const message of scheduleProblems(s as Schedule))
      ctx.addIssue({ code: 'custom', message });
  });

export const AUTOMATION_TRIGGER_TYPES = [
  'recordCreated',
  'recordUpdated',
  'recordMatches',
  'scheduled',
  'formSubmitted',
  'webhookReceived',
  'buttonClicked',
] as const;
export type AutomationTriggerType = (typeof AUTOMATION_TRIGGER_TYPES)[number];

export const automationTriggerSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('recordCreated'), tableId: z.uuid() }),
  z.strictObject({
    type: z.literal('recordUpdated'),
    tableId: z.uuid(),
    /** Run only when one of these fields changed; null: any field. */
    fieldIds: z.array(z.uuid()).min(1).max(MAX_AUTOMATION_CELLS).nullable().default(null),
  }),
  /** A record enters the filter (created matching it, or changed to match it). */
  z.strictObject({
    type: z.literal('recordMatches'),
    tableId: z.uuid(),
    filter: filterGroupSchema,
  }),
  z.strictObject({ type: z.literal('scheduled'), schedule: scheduleSchema }),
  /** A public form of the table was submitted: the form view's id. */
  z.strictObject({ type: z.literal('formSubmitted'), tableId: z.uuid(), viewId: z.uuid() }),
  /**
   * A POST to the automation's own URL, `/hooks/a/<token>` (the token is the secret; the server
   * makes it, `webhookUrl` shows it to creators). Its JSON body is `{{trigger.body...}}`.
   */
  z.strictObject({ type: z.literal('webhookReceived') }),
  /** Someone clicked the table's button field set to run automations. */
  z.strictObject({ type: z.literal('buttonClicked'), tableId: z.uuid(), fieldId: z.uuid() }),
]);
export type AutomationTrigger = z.infer<typeof automationTriggerSchema>;

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** An HTTP header name (RFC 9110 token). */
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;

export const httpHeaderSchema = z
  .strictObject({
    name: z.string().regex(HEADER_NAME_RE, 'Not a valid header name'),
    /** Omitted on a secret header: keep the stored value (responses never include it). */
    value: z
      .string()
      .max(MAX_HTTP_HEADER_VALUE)
      .refine((v) => !/[\r\n\0]/.test(v), 'A header value has no line breaks')
      .optional(),
    secret: z.boolean().default(false),
  })
  .refine((h) => h.secret || h.value !== undefined, {
    message: 'A header needs a value.',
    path: ['value'],
  });

/** Cells by field id; strings may hold tokens (`{{trigger.record.fields.Name}}`). */
const cellsSchema = z
  .record(z.uuid(), z.unknown())
  .refine((c) => Object.keys(c).length <= MAX_AUTOMATION_CELLS, {
    message: `At most ${MAX_AUTOMATION_CELLS} fields.`,
  });

export const AUTOMATION_ACTION_TYPES = [
  'createRecord',
  'updateRecord',
  'findRecords',
  'sendEmail',
  'httpRequest',
  'slackMessage',
  'runScript',
] as const;
export type AutomationActionType = (typeof AUTOMATION_ACTION_TYPES)[number];

export const automationActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('createRecord'), tableId: z.uuid(), fields: cellsSchema }),
  z.strictObject({
    type: z.literal('updateRecord'),
    tableId: z.uuid(),
    /**
     * The record(s): an id, or a token such as `{{trigger.record.id}}` or `{{steps.1.records}}`
     * (a list of found records updates each of them, at most MAX_UPDATE_RECORDS).
     */
    recordId: z.string().trim().min(1).max(2000),
    fields: cellsSchema,
  }),
  z.strictObject({
    type: z.literal('findRecords'),
    tableId: z.uuid(),
    /** Condition values may hold tokens. No filter: every record (up to `limit`). */
    filter: filterGroupSchema.optional(),
    limit: z.number().int().min(1).max(MAX_FIND_RECORDS).default(MAX_FIND_RECORDS),
  }),
  /**
   * An email through the server's mailer, from its own address (no From of your choice). `to`:
   * addresses, or tokens giving addresses or users (a user field's value, `{{trigger.user.id}}`);
   * users must have access to the base. The body is Markdown, sent as sanitized HTML and as plain
   * text. Counts against the workspace's daily email cap, per recipient.
   */
  z.strictObject({
    type: z.literal('sendEmail'),
    to: z.array(z.string().trim().min(1).max(1000)).min(1).max(MAX_EMAIL_RECIPIENTS),
    subject: z.string().trim().min(1).max(MAX_EMAIL_SUBJECT),
    body: z.string().max(MAX_EMAIL_BODY).default(''),
  }),
  /**
   * A request through the SSRF-safe client. A secret header's value is stored encrypted and
   * never shown again: leave `value` out to keep the stored one. Run logs show no header values.
   */
  z.strictObject({
    type: z.literal('httpRequest'),
    method: z.enum(HTTP_METHODS).default('POST'),
    url: z.string().trim().min(1).max(MAX_HTTP_URL),
    headers: z.array(httpHeaderSchema).max(MAX_HTTP_HEADERS).default([]),
    /** JSON; strings may hold tokens. Not sent with GET. */
    body: z.unknown().optional(),
  }),
  /**
   * A message to a Slack incoming webhook (or a Slack-compatible one): `{ "text": ... }`. The URL
   * is stored encrypted and never shown again; leave it out to keep the stored one.
   */
  z.strictObject({
    type: z.literal('slackMessage'),
    webhookUrl: z.string().trim().min(1).max(MAX_HTTP_URL).optional(),
    text: z.string().trim().min(1).max(MAX_SLACK_TEXT),
  }),
  /**
   * JavaScript run in a sandbox: a throwaway container with no network, as the person the
   * run runs as. `inputs` are its input variables (`input.config()`), whose values may hold
   * tokens; what it passes to `output.set(key, value)` is `{{steps.N.output.key}}`.
   */
  z.strictObject({
    type: z.literal('runScript'),
    script: z.string().min(1).max(MAX_SCRIPT_LENGTH),
    inputs: z
      .record(
        z
          .string()
          .regex(/^[A-Za-z_$][\w$]{0,63}$/, 'An input name is a JavaScript identifier')
          .refine((k) => !['__proto__', 'constructor', 'prototype'].includes(k), {
            message: "This name can't be used.",
          }),
        z.string().max(MAX_SCRIPT_INPUT_VALUE)
      )
      .refine((v) => Object.keys(v).length <= MAX_SCRIPT_INPUTS, {
        message: `At most ${MAX_SCRIPT_INPUTS} input variables.`,
      })
      .default({}),
  }),
]);
export type AutomationAction = z.infer<typeof automationActionSchema>;

/** Where a token may point: the trigger's data, or a step before this one (1-based). */
function tokenProblem(path: PathKey[], step: number | null): string | null {
  const [root, n] = path;
  if (step === null) return "Tokens can't be used in the trigger.";
  if (root === 'trigger') return null;
  if (typeof n !== 'number' || n < 1 || n >= step) {
    return `Step ${step} can only use the steps before it.`;
  }
  return null;
}

function checkTokens(
  trigger: unknown,
  actions: readonly unknown[] | undefined,
  ctx: z.RefinementCtx
) {
  const check = (value: unknown, step: number | null, path: (string | number)[]) => {
    try {
      for (const p of valuePaths(value)) {
        const message = tokenProblem(p, step);
        if (message) {
          ctx.addIssue({ code: 'custom', path, message });
          return;
        }
      }
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      ctx.addIssue({ code: 'custom', path, message: err.message });
    }
  };
  if (trigger !== undefined) check(trigger, null, ['trigger']);
  actions?.forEach((a, i) => {
    // A script is code, never filled in: only its input variables hold tokens.
    const script = (a as { type?: unknown } | null)?.type === 'runScript';
    check(script ? (a as { inputs?: unknown }).inputs : a, i + 1, ['actions', i]);
  });
  const size = JSON.stringify({ trigger, actions }).length;
  if (size > MAX_AUTOMATION_CONFIG_BYTES) {
    ctx.addIssue({ code: 'custom', message: 'The trigger and actions are too large.' });
  }
}

const name = z.string().trim().min(1).max(MAX_AUTOMATION_NAME);
const description = z.string().trim().max(MAX_AUTOMATION_DESCRIPTION);
const actions = z.array(automationActionSchema).max(MAX_AUTOMATION_ACTIONS);

export const createAutomationSchema = z
  .strictObject({
    name,
    description: description.default(''),
    trigger: automationTriggerSchema,
    actions: actions.default([]),
    /** Off by default, as in Airtable; it needs an action to turn on. */
    enabled: z.boolean().default(false),
  })
  .superRefine((v, ctx) => checkTokens(v.trigger, v.actions, ctx));
export type CreateAutomationInput = z.input<typeof createAutomationSchema>;

export const updateAutomationSchema = z
  .strictObject({
    name: name.optional(),
    description: description.optional(),
    trigger: automationTriggerSchema.optional(),
    actions: actions.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' })
  .superRefine((v, ctx) => checkTokens(v.trigger, v.actions, ctx));
export type UpdateAutomationInput = z.input<typeof updateAutomationSchema>;

export const AUTOMATION_RUN_STATUSES = ['succeeded', 'failed', 'skipped'] as const;
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

export const AutomationSchema = z.object({
  id: z.uuid(),
  baseId: z.uuid(),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  /** Why the server turned it off: its creator lost access to the base. */
  disabledReason: z.enum(['creator_access']).nullable(),
  trigger: automationTriggerSchema,
  actions: z.array(automationActionSchema),
  /** Whose permissions the actions run with. */
  createdBy: z.uuid().nullable(),
  lastRunAt: at.nullable(),
  lastRunStatus: z.enum(AUTOMATION_RUN_STATUSES).nullable(),
  /** A scheduled trigger's next run while it is on. */
  nextRunAt: at.nullable(),
  /** A webhook-received trigger's URL (creators only see automations): POST JSON to it. */
  webhookUrl: z.string().nullable(),
  /** The last request it received (its JSON body), to map fields from. */
  webhookSample: z.object({ receivedAt: at, body: z.unknown() }).nullable(),
  createdAt: at,
  updatedAt: at,
});
export type Automation = z.infer<typeof AutomationSchema>;

/**
 * Whether this workspace may use run-script steps, and their limits. Self-hosted servers
 * turn scripts on with AUTOMATION_SCRIPTS; the hosted service gates them by plan.
 */
export const AutomationScriptsSchema = z.object({
  available: z.boolean(),
  /** Why not: the server runs no scripts, or the workspace's plan doesn't include them. */
  reason: z.enum(['disabled', 'plan']).nullable(),
  limits: z
    .object({
      timeoutSeconds: z.number().int(),
      cpuSeconds: z.number().int(),
      memoryMb: z.number().int(),
    })
    .nullable(),
});
export type AutomationScripts = z.infer<typeof AutomationScriptsSchema>;

/** A list entry: the automation and how many runs its history holds (the last 30 days). */
export const AutomationListItemSchema = AutomationSchema.extend({ runCount: z.number().int() });
export type AutomationListItem = z.infer<typeof AutomationListItemSchema>;

export const AutomationListSchema = z.object({
  automations: z.array(AutomationListItemSchema),
  scripts: AutomationScriptsSchema,
});
export type AutomationList = z.infer<typeof AutomationListSchema>;

export const AutomationStepSchema = z.object({
  /** 1-based, as tokens count them (`steps.1`). */
  index: z.number().int(),
  type: z.enum(AUTOMATION_ACTION_TYPES),
  status: z.enum(['succeeded', 'failed', 'skipped']),
  /** The action with its tokens filled in. */
  input: z.unknown(),
  output: z.unknown(),
  error: z.string().nullable(),
  durationMs: z.number().int(),
});
export type AutomationStep = z.infer<typeof AutomationStepSchema>;

/**
 * How a run started: `live` (its trigger fired), `test` (the builder's Test, run as the
 * person testing; not counted, the automation's last run unchanged) or `retry` (a failed run
 * started again from its trigger data, as the person retrying).
 */
export const AUTOMATION_RUN_MODES = ['live', 'test', 'retry'] as const;
export type AutomationRunMode = (typeof AUTOMATION_RUN_MODES)[number];

/**
 * Why a skipped run did nothing: `loop` (automations triggered each other too deep) or
 * `quota` (the workspace's plan's automation runs for the month were used up).
 */
export const AUTOMATION_SKIP_REASONS = ['loop', 'quota'] as const;
export type AutomationSkipReason = (typeof AUTOMATION_SKIP_REASONS)[number];

export const AutomationRunSchema = z.object({
  id: z.uuid(),
  automationId: z.uuid(),
  status: z.enum(AUTOMATION_RUN_STATUSES),
  mode: z.enum(AUTOMATION_RUN_MODES),
  /** Why a skipped run did nothing; null for other runs. */
  skipReason: z.enum(AUTOMATION_SKIP_REASONS).nullable(),
  /** A retry's failed run. */
  retryOf: z.uuid().nullable(),
  /** What started it: the record (by field name and id) or the scheduled time. */
  trigger: z.unknown(),
  steps: z.array(AutomationStepSchema),
  error: z.string().nullable(),
  /** 1 for a run a person's change started; one more for each automation in the chain. */
  depth: z.number().int(),
  /** Who started it: who clicked the button, tested or retried; null otherwise. */
  triggeredBy: z.uuid().nullable(),
  durationMs: z.number().int(),
  createdAt: at,
});
export type AutomationRun = z.infer<typeof AutomationRunSchema>;

export const AutomationRunListSchema = z.object({ runs: z.array(AutomationRunSchema) });
export type AutomationRunList = z.infer<typeof AutomationRunListSchema>;

/**
 * The builder's failed runs (the dead-letter view): a base's failed live and retry runs of
 * the last 30 days that weren't retried yet, newest first, each with its automation's name.
 */
export const FailedAutomationRunSchema = AutomationRunSchema.extend({ automationName: z.string() });
export type FailedAutomationRun = z.infer<typeof FailedAutomationRunSchema>;
export const FailedAutomationRunListSchema = z.object({ runs: z.array(FailedAutomationRunSchema) });
export type FailedAutomationRunList = z.infer<typeof FailedAutomationRunListSchema>;
export const failedAutomationRunsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(MAX_AUTOMATION_RUNS_PAGE).default(50),
});

export const automationRunsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(MAX_AUTOMATION_RUNS_PAGE).default(25),
  /** Only runs with this outcome. */
  status: z.enum(AUTOMATION_RUN_STATUSES).optional(),
});

/**
 * A test run: the trigger fires with this record of the trigger's table (record, form and
 * button triggers; required there), or with the last request a webhook trigger received, or now
 * (scheduled). The actions run for real, as the person testing.
 */
export const testAutomationSchema = z.strictObject({ recordId: z.uuid().optional() });
export type TestAutomationInput = z.input<typeof testAutomationSchema>;

export const AutomationButtonClickSchema = z.object({
  /** The automations the click started (enabled ones whose trigger is this button). */
  started: z.number().int(),
});
export type AutomationButtonClick = z.infer<typeof AutomationButtonClickSchema>;

/**
 * An automation in the REST API v1: everything the builder shows except the webhook URL,
 * a credential of its own, and the last request it received, which may hold anyone's data.
 */
export const V1AutomationSchema = AutomationSchema.omit({ webhookUrl: true, webhookSample: true });
export type V1Automation = z.infer<typeof V1AutomationSchema>;

export const V1AutomationListSchema = z.object({ automations: z.array(V1AutomationSchema) });
export type V1AutomationList = z.infer<typeof V1AutomationListSchema>;

/** Turning an automation on or off: the only change the API makes (the builder does the rest). */
export const v1UpdateAutomationSchema = z.strictObject({ enabled: z.boolean() });

/**
 * Triggering an automation through the API: a webhook-received one with `body` (any JSON,
 * as if POSTed to its URL; `{}` when left out, at most 100 KB), or a button-clicked one with the
 * `recordId` whose button was clicked.
 */
export const v1TriggerAutomationSchema = z
  .strictObject({ recordId: z.uuid().optional(), body: z.unknown().optional() })
  .refine((v) => !(v.recordId !== undefined && v.body !== undefined), {
    message: 'Give a recordId (button) or a body (webhook), not both.',
  });
export type V1TriggerAutomationInput = z.input<typeof v1TriggerAutomationSchema>;

export const V1AutomationTriggeredSchema = z.object({
  /** The run is queued; it shows in the run history once the worker ran it. */
  queued: z.literal(true),
  /** The trigger's id: the webhook request's or the button click's. */
  triggerId: z.uuid(),
});
export type V1AutomationTriggered = z.infer<typeof V1AutomationTriggeredSchema>;
