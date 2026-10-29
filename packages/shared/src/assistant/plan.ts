import { z } from 'zod';

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

/** Field types the assistant creates. Lookups, rollups, counts, buttons and AI fields wait. */
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
] as const;
export type AssistantFieldType = (typeof ASSISTANT_FIELD_TYPES)[number];

/** View types the assistant creates; kanban stacks by `field`, calendar places by `field`. */
export const ASSISTANT_VIEW_TYPES = ['grid', 'kanban', 'calendar', 'gallery', 'form'] as const;
export const ASSISTANT_TRIGGERS = ['recordCreated', 'recordUpdated'] as const;

/** A prompt's length, in characters. */
export const ASSISTANT_PROMPT_MAX = 4000;
export const MAX_PLAN_OPERATIONS = 40;
export const MAX_PLAN_TABLE_FIELDS = 40;
export const MAX_PLAN_CHOICES = 30;
export const MAX_PLAN_ACTIONS = 5;
export const MAX_PLAN_CELLS = 20;
export const MAX_PLAN_NAME = 100;
/** Sample records per table the model gets when the user opts in. */
export const ASSISTANT_SAMPLE_RECORDS = 3;

/** Field types a kanban view stacks by, and a calendar view places records by. */
export const KANBAN_FIELD_TYPES: readonly string[] = ['singleSelect', 'user'];
export const CALENDAR_FIELD_TYPES: readonly string[] = [
  'date',
  'dateTime',
  'createdTime',
  'lastModifiedTime',
];
/** Field types a plan can't make the primary field. */
export const NON_PRIMARY_TYPES: readonly string[] = ['link', 'formula', 'attachment', 'user'];
/** Field types no automation writes to. */
export const READ_ONLY_PLAN_TYPES: readonly string[] = [
  'formula',
  'autoNumber',
  'createdTime',
  'lastModifiedTime',
  'createdBy',
  'lastModifiedBy',
];

function build(capped: boolean) {
  const name = capped ? z.string().trim().min(1).max(MAX_PLAN_NAME) : z.string();
  const text = (max: number) => (capped ? z.string().max(max) : z.string());
  const list = <T extends z.ZodType>(item: T, min: number, max: number) =>
    capped ? z.array(item).min(min).max(max) : z.array(item);

  const field = z.strictObject({
    name,
    type: z.enum(ASSISTANT_FIELD_TYPES),
    description: text(500).nullable(),
    /** Single and multiple selects: the options, in order. */
    choices: list(name, 0, MAX_PLAN_CHOICES).nullable(),
    /** Formulas: Airtable syntax with `{Field name}` references. */
    formula: text(2000).nullable(),
    /** Links: the linked table's name (in the base, or created earlier in the plan). */
    linkedTable: name.nullable(),
  });

  const cell = z.strictObject({ field: name, value: text(2000) });
  const action = z.union([
    z.strictObject({
      type: z.literal('sendEmail'),
      to: list(text(1000), 1, 10),
      subject: text(200),
      body: text(5000),
    }),
    /** Changes the record that set the automation off. */
    z.strictObject({ type: z.literal('updateRecord'), cells: list(cell, 1, MAX_PLAN_CELLS) }),
    z.strictObject({
      type: z.literal('createRecord'),
      table: name,
      cells: list(cell, 0, MAX_PLAN_CELLS),
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
      /** Kanban: the single select it stacks by; calendar: the date field; else null. */
      field: name.nullable(),
    }),
    z.strictObject({
      op: z.literal('createAutomation'),
      table: name,
      name,
      trigger: z.enum(ASSISTANT_TRIGGERS),
      /** recordUpdated: run only when one of these fields changes; null: any field. */
      watchFields: list(name, 1, MAX_PLAN_CELLS).nullable(),
      actions: list(action, 1, MAX_PLAN_ACTIONS),
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
export type AssistantAction = Extract<
  AssistantOperation,
  { op: 'createAutomation' }
>['actions'][number];

/** A reason an operation can't be applied as proposed. */
export const AssistantProblemSchema = z.strictObject({
  /** The operation's index in `operations`. */
  operation: z.int().min(0),
  /** The field's name, when the problem is one field's. */
  field: z.string().nullable(),
  /** `formula`: the formula doesn't parse or type-check (the server asks the model once more). */
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
