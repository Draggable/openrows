import { z } from 'zod';
import { SCHEDULE_UNITS } from '../automations/schedule.js';
import { AI_FIELD_OUTPUTS, AI_PROMPT_MAX } from '../fields/ai.js';
import { ROLLUP_FUNCTIONS } from '../fields/computed.js';
import { BUTTON_ACTIONS, MAX_BUTTON_LABEL } from '../fields/types/button.js';
import { FILTER_OPERATORS } from '../fields/types.js';
import {
  HTTP_METHODS,
  MAX_HTTP_HEADER_VALUE,
  MAX_HTTP_HEADERS,
  MAX_HTTP_URL,
} from '../schemas/automation.js';

/**
 * The AI assistant's change plan: what the model proposes for a base, as structured
 * output, shown to the user as a diff and applied only when they confirm. Operations name tables
 * and fields by name (what the model sees and what the user reads); the server resolves the names
 * when it applies the plan, through the same services as the API.
 *
 * Two schemas of one shape: `assistantPlanOutputSchema` is what the provider is asked for (no
 * length or count limits, which strict JSON schema modes don't all accept), and
 * `assistantPlanSchema` adds the caps; every answer and every request body goes through it.
 */

/** Field types the assistant creates. */
export const ASSISTANT_FIELD_TYPES = [
  'singleLineText',
  'longText',
  'number',
  'currency',
  'percent',
  'checkbox',
  'date',
  'dateTime',
  'duration',
  'rating',
  'singleSelect',
  'multipleSelect',
  'email',
  'url',
  'phone',
  'attachment',
  'user',
  'link',
  'formula',
  'autoNumber',
  'createdTime',
  'lastModifiedTime',
  'createdBy',
  'lastModifiedBy',
  'lookup',
  'rollup',
  'count',
  'button',
  'ai',
] as const;
export type AssistantFieldType = (typeof ASSISTANT_FIELD_TYPES)[number];

/**
 * View types the assistant creates: kanban stacks by `field`, calendar places by `field`,
 * timeline draws bars from `field` (to `endField`), list nests records under `field`.
 */
export const ASSISTANT_VIEW_TYPES = [
  'grid',
  'kanban',
  'calendar',
  'gallery',
  'form',
  'timeline',
  'list',
] as const;
/**
 * Triggers the assistant proposes. Every one but `scheduled` and `webhookReceived` belongs to
 * the automation's `table`; those two have no table (null).
 */
export const ASSISTANT_TRIGGERS = [
  'recordCreated',
  'recordUpdated',
  'recordMatches',
  'formSubmitted',
  'buttonClicked',
  'scheduled',
  'webhookReceived',
] as const;
export type AssistantTrigger = (typeof ASSISTANT_TRIGGERS)[number];
/** Triggers that set an automation off with a record (`{{trigger.record...}}`). */
export const RECORD_TRIGGERS: readonly string[] = [
  'recordCreated',
  'recordUpdated',
  'recordMatches',
  'formSubmitted',
  'buttonClicked',
];
/** Triggers of no table. */
export const TABLELESS_TRIGGERS: readonly string[] = ['scheduled', 'webhookReceived'];
/** Actions the assistant proposes. */
export const ASSISTANT_ACTIONS = [
  'sendEmail',
  'updateRecord',
  'createRecord',
  'findRecords',
  'httpRequest',
] as const;

/** A prompt's length, in characters. */
export const ASSISTANT_PROMPT_MAX = 4000;
export const MAX_PLAN_OPERATIONS = 40;
export const MAX_PLAN_TABLE_FIELDS = 40;
export const MAX_PLAN_CHOICES = 30;
export const MAX_PLAN_ACTIONS = 5;
export const MAX_PLAN_CELLS = 20;
/** Conditions of one planned filter (a trigger's or a find step's). */
export const MAX_PLAN_CONDITIONS = 10;
export const MAX_PLAN_HTTP_BODY = 5000;
export const MAX_PLAN_NAME = 100;
/** Sample records per table the model gets when the user opts in. */
export const ASSISTANT_SAMPLE_RECORDS = 3;

/** Field types a kanban view stacks by, and a calendar or timeline view places records by. */
export const KANBAN_FIELD_TYPES: readonly string[] = ['singleSelect', 'user'];
export const CALENDAR_FIELD_TYPES: readonly string[] = [
  'date',
  'dateTime',
  'createdTime',
  'lastModifiedTime',
];
/** Field types a plan can't make the primary field. */
export const NON_PRIMARY_TYPES: readonly string[] = [
  'link',
  'formula',
  'attachment',
  'user',
  'lookup',
  'rollup',
  'count',
  'button',
  'ai',
];
/** Field types no automation writes to. */
export const READ_ONLY_PLAN_TYPES: readonly string[] = [
  'formula',
  'autoNumber',
  'createdTime',
  'lastModifiedTime',
  'createdBy',
  'lastModifiedBy',
  'lookup',
  'rollup',
  'count',
  'button',
  'ai',
];
/** Rollup aggregations that read numbers: they don't apply to a field of other values. */
export const NUMERIC_ROLLUP_FUNCTIONS: readonly string[] = ['SUM', 'AVG', 'MIN', 'MAX', 'COUNT'];
/** Rollup aggregations whose result is text; the others give a number. */
export const TEXT_ROLLUP_FUNCTIONS: readonly string[] = [
  'ARRAYJOIN',
  'ARRAYUNIQUE',
  'ARRAYCOMPACT',
  'CONCATENATE',
];

function build(capped: boolean) {
  const name = capped ? z.string().trim().min(1).max(MAX_PLAN_NAME) : z.string();
  const text = (max: number) => (capped ? z.string().max(max) : z.string());
  const list = <T extends z.ZodType>(item: T, min: number, max: number) =>
    capped ? z.array(item).min(min).max(max) : z.array(item);

  // Keys added after the first version default to null in requests, so a plan body without
  // them still reads. The provider's schema has no defaults: strict modes want every key listed
  // as required, and some refuse the `default` keyword.
  const later = <T extends z.ZodType>(schema: T) =>
    capped ? schema.nullable().default(null) : schema.nullable();

  const button = z.strictObject({
    label: text(MAX_BUTTON_LABEL),
    /** `openUrl`: opens the URL `formula` gives; `runAutomation`: runs the automations it triggers. */
    action: z.enum(BUTTON_ACTIONS),
  });
  const ai = z.strictObject({
    /** The prompt, with `{Field name}` references to fields of the same table. */
    prompt: text(AI_PROMPT_MAX),
    /** `singleSelect`: the answer is one of `choices`. */
    output: z.enum(AI_FIELD_OUTPUTS),
  });

  const field = z.strictObject({
    name,
    type: z.enum(ASSISTANT_FIELD_TYPES),
    description: text(500).nullable(),
    /** Single and multiple selects, and AI fields with a single select output: the options. */
    choices: list(name, 0, MAX_PLAN_CHOICES).nullable(),
    /** Formulas, and an `openUrl` button's URL formula, with `{Field name}` references. */
    formula: text(2000).nullable(),
    /** Links: the linked table's name (in the base, or created earlier in the plan). */
    linkedTable: name.nullable(),
    /** Lookups, rollups and counts: the link field of the same table they read through. */
    linkField: later(name),
    /** Lookups and rollups: the field of the linked table whose values they read. */
    linkedField: later(name),
    /** Rollups: how the linked values are aggregated. */
    aggregation: later(z.enum(ROLLUP_FUNCTIONS)),
    /** Buttons: the label and what a click does. */
    button: later(button),
    /** AI fields: the prompt and the kind of answer. */
    ai: later(ai),
  });

  const cell = z.strictObject({ field: name, value: text(2000) });
  /**
   * A filter by field names: the conditions of the view filter language, joined by
   * `conjunction`. `value` is text as the user would type it (a number, `true`/`false`, a date
   * `YYYY-MM-DD` or `today`, an option's name), null for isEmpty/isNotEmpty.
   */
  const filter = z.strictObject({
    conjunction: z.enum(['and', 'or']),
    conditions: list(
      z.strictObject({
        field: name,
        operator: z.enum(FILTER_OPERATORS),
        value: text(1000).nullable(),
      }),
      1,
      MAX_PLAN_CONDITIONS
    ),
  });
  /** A schedule as the automations engine takes it (checked by its own rules). */
  const schedule = z.union([
    z.strictObject({
      kind: z.literal('cron'),
      /** Five fields (minute hour day month weekday) or a macro such as `@daily`. */
      expression: text(120),
      /** An IANA time zone, such as `Europe/Paris`. */
      timeZone: text(64),
    }),
    z.strictObject({
      kind: z.literal('interval'),
      every: z.int(),
      unit: z.enum(SCHEDULE_UNITS),
      /** The first run, a wall time in `timeZone`: `YYYY-MM-DDTHH:mm`. */
      startAt: text(16),
      timeZone: text(64),
    }),
  ]);
  const action = z.union([
    z.strictObject({
      type: z.literal('sendEmail'),
      to: list(text(1000), 1, 10),
      subject: text(200),
      body: text(5000),
    }),
    /**
     * Changes the record that set the automation off, or (`step`: the number of an earlier
     * findRecords action, from 1) the records that step found, in its table.
     */
    z.strictObject({
      type: z.literal('updateRecord'),
      cells: list(cell, 1, MAX_PLAN_CELLS),
      step: later(capped ? z.int().min(1).max(MAX_PLAN_ACTIONS) : z.int()),
    }),
    z.strictObject({
      type: z.literal('createRecord'),
      table: name,
      cells: list(cell, 0, MAX_PLAN_CELLS),
    }),
    /** Records of a table that meet the filter (null: every record), at most `limit`. */
    z.strictObject({
      type: z.literal('findRecords'),
      table: name,
      filter: filter.nullable(),
      limit: z.int().nullable(),
    }),
    /**
     * A request to a URL. Headers are plain ones only: secret headers (credentials) are
     * added by the user in the automation's builder. `body`: JSON text, or null.
     */
    z.strictObject({
      type: z.literal('httpRequest'),
      method: z.enum(HTTP_METHODS),
      url: text(MAX_HTTP_URL),
      headers: list(
        z.strictObject({ name: text(100), value: text(MAX_HTTP_HEADER_VALUE) }),
        0,
        MAX_HTTP_HEADERS
      ),
      body: text(MAX_PLAN_HTTP_BODY).nullable(),
    }),
  ]);

  const operation = z.union([
    z.strictObject({
      op: z.literal('createTable'),
      name,
      description: text(1000).nullable(),
      /** The first field is the primary field. */
      fields: list(field, 1, MAX_PLAN_TABLE_FIELDS),
    }),
    z.strictObject({ op: z.literal('createField'), table: name, field }),
    z.strictObject({
      op: z.literal('createView'),
      table: name,
      name,
      type: z.enum(ASSISTANT_VIEW_TYPES),
      /**
       * Kanban: the single select it stacks by; calendar and timeline: the (start) date field;
       * list: the link to records of the same table that names a record's parent; else null.
       */
      field: name.nullable(),
      /** Timeline: the end date field, or null for one-day bars; else null. */
      endField: later(name),
    }),
    z.strictObject({
      op: z.literal('createAutomation'),
      /** The trigger's table; null for scheduled and webhookReceived triggers. */
      table: name.nullable(),
      name,
      trigger: z.enum(ASSISTANT_TRIGGERS),
      /** recordUpdated: run only when one of these fields changes; null: any field. */
      watchFields: list(name, 1, MAX_PLAN_CELLS).nullable(),
      actions: list(action, 1, MAX_PLAN_ACTIONS),
      /** recordMatches: the conditions a record enters (no tokens). */
      filter: later(filter),
      /** formSubmitted: the name of the table's form view. */
      formView: later(name),
      /** buttonClicked: the name of the table's button field that runs automations. */
      buttonField: later(name),
      /** scheduled: when it runs. */
      schedule: later(schedule),
    }),
  ]);

  return z.strictObject({
    /** One or two sentences: what the plan does. */
    summary: text(1000),
    /** Describe-it plans for a new base: its name. Null for an existing base. */
    baseName: name.nullable(),
    operations: list(operation, 0, MAX_PLAN_OPERATIONS),
  });
}

export const assistantPlanSchema = build(true);
export const assistantPlanOutputSchema = build(false);
export type AssistantPlan = z.infer<typeof assistantPlanSchema>;
export type AssistantOperation = AssistantPlan['operations'][number];
export type AssistantFieldSpec = Extract<AssistantOperation, { op: 'createField' }>['field'];
export type AssistantAutomationOp = Extract<AssistantOperation, { op: 'createAutomation' }>;
export type AssistantAction = AssistantAutomationOp['actions'][number];
export type AssistantFilter = NonNullable<AssistantAutomationOp['filter']>;
export type AssistantSchedule = NonNullable<AssistantAutomationOp['schedule']>;

/** A reason an operation can't be applied as proposed. */
export const AssistantProblemSchema = z.strictObject({
  /** The operation's index in `operations`. */
  operation: z.int().min(0),
  /** The field's name, when the problem is one field's. */
  field: z.string().nullable(),
  /**
   * `formula`: the formula (or a button's URL formula) doesn't parse, type-check or would read
   * itself in a loop (the server asks the model once more).
   */
  kind: z.enum(['formula', 'reference', 'name', 'type']),
  message: z.string(),
});
export type AssistantProblem = z.infer<typeof AssistantProblemSchema>;

/** `POST /api/bases/:baseId/assistant/plan`. */
export const assistantPlanRequestSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(ASSISTANT_PROMPT_MAX),
  /** Send a few records of each table to the model (off by default: the schema only). */
  includeRecords: z.boolean().default(false),
});
export type AssistantPlanRequest = z.input<typeof assistantPlanRequestSchema>;

/** `POST /api/workspaces/:workspaceId/assistant/plan`: a new base, described. */
export const assistantBasePlanRequestSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(ASSISTANT_PROMPT_MAX),
});

export const AssistantPlanResultSchema = z.strictObject({
  plan: assistantPlanSchema,
  /** What still doesn't hold after the retry; the app leaves those operations unticked. */
  problems: z.array(AssistantProblemSchema),
  /** Requests made to the provider (2 when a formula was fixed in a second round). */
  attempts: z.int().min(1),
});
export type AssistantPlanResult = z.infer<typeof AssistantPlanResultSchema>;

/** `POST /api/bases/:baseId/assistant/apply`: the confirmed plan (or the operations kept). */
export const assistantApplySchema = z.strictObject({ plan: assistantPlanSchema });

/** `POST /api/workspaces/:workspaceId/assistant/apply`: a new base from the confirmed plan. */
export const assistantApplyBaseSchema = z.strictObject({
  name: z.string().trim().min(1).max(255),
  plan: assistantPlanSchema,
});

export const AssistantApplyResultSchema = z.strictObject({
  baseId: z.uuid(),
  tables: z.int().min(0),
  fields: z.int().min(0),
  views: z.int().min(0),
  automations: z.int().min(0),
  /** The first table created, to open after applying. */
  firstTableId: z.uuid().nullable(),
});
export type AssistantApplyResult = z.infer<typeof AssistantApplyResultSchema>;
