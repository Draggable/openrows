import {
  AI_FIELD_OUTPUTS,
  ASSISTANT_FIELD_TYPES,
  ASSISTANT_VIEW_TYPES,
  type AssistantBaseInfo,
  FORMULA_FUNCTIONS,
  type FunctionSignature,
  NON_PRIMARY_TYPES,
  NUMERIC_ROLLUP_FUNCTIONS,
  ROLLUP_FUNCTIONS,
} from '@openrows/shared';

/**
 * The assistant's instructions. The formula guide is built from the shared function
 * catalog, so the model is told exactly the functions the type checker knows.
 */

function signature(name: string, f: FunctionSignature): string {
  const args = f.args.map((a, i) => (i < f.required ? a : `${a}?`));
  if (f.rest) args.push(`${f.rest}...`);
  const returns = f.returns === 'join' ? 'any' : f.returns;
  return `${name}(${args.join(', ')}) → ${returns}`;
}

let guide: string | undefined;

/** How formulas are written here, and every function with its argument and result types. */
export function formulaGuide(): string {
  guide ??= [
    'Formulas use Airtable syntax:',
    '- Fields are referenced by name in braces: {Unit Price}. Use only fields that exist.',
    '- Text in double quotes; & joins text; + - * / for numbers; = != < > <= >= compare;',
    '  AND(), OR(), NOT() for logic; IF(cond, then, else); BLANK() is empty.',
    '- Dates: DATETIME_DIFF(a, b, "days"), DATEADD(d, 1, "months"), TODAY(), NOW(),',
    '  DATETIME_FORMAT(d, "YYYY-MM-DD"). Units: "days", "weeks", "months", "years", "hours", "minutes".',
    '- Checkboxes are booleans; select fields are text; multiple selects and links are lists.',
    'Functions (argument types → result type):',
    ...Object.entries(FORMULA_FUNCTIONS).map(([name, f]) => signature(name, f)),
  ].join('\n');
  return guide;
}

export function formulaSystemPrompt(): string {
  return [
    'You write one formula for a field of a table in OpenRows, a spreadsheet-database.',
    'Answer with the formula and a one-sentence explanation. The formula must parse and',
    'type-check against the table fields given; never reference a field that is not listed.',
    '',
    formulaGuide(),
  ].join('\n');
}

export function planSystemPrompt(newBase: boolean): string {
  return [
    'You are the assistant of OpenRows, an open-source Airtable alternative. You turn a request',
    newBase
      ? 'into a change plan that builds a NEW base from scratch: set baseName to a short name.'
      : 'into a change plan for the existing base whose schema is given. Set baseName to null.',
    'The user reviews the plan and applies it themselves: propose, never claim it is done.',
    '',
    'Rules:',
    '- Operations run in order. Refer to tables and fields by name; a table or field must exist',
    '  in the base or be created by an earlier operation. Never reuse a taken name.',
    '- createTable: its first field is the primary field (a name or title: singleLineText,',
    `  or number, date, email, autoNumber; never ${NON_PRIMARY_TYPES.join(', ')}).`,
    `- Field types: ${ASSISTANT_FIELD_TYPES.join(', ')}.`,
    '- Set choices (an ordered list of option names) only for singleSelect, multipleSelect and',
    '  ai fields with output singleSelect; formula only for formula fields and openUrl buttons;',
    '  linkedTable only for link fields (an inverse link, named after the table it links from, is',
    '  added to the linked table automatically: do not create it). Every other key is null',
    '  unless the field type below needs it.',
    '- lookup: linkField = a link field of the same table, linkedField = the field of the linked',
    '  table whose values it shows.',
    `- rollup: linkField and linkedField as for lookup, aggregation = one of ${ROLLUP_FUNCTIONS.join(', ')}.`,
    `  ${NUMERIC_ROLLUP_FUNCTIONS.join(', ')} need a linkedField of numbers.`,
    '- count: linkField = a link field of the same table; it counts the linked records.',
    '- button: button = {label, action}. action openUrl opens the URL that formula gives;',
    '  action runAutomation runs the automations a click of it triggers (formula null).',
    `- ai: ai = {prompt, output}, output one of ${AI_FIELD_OUTPUTS.join(', ')}. The prompt names`,
    '  fields of the same table in braces, like {Description}, never an ai field or a field that',
    '  reads one. Each record gets its own answer later, in that field only.',
    '- A field must never read itself, directly or through formulas, lookups and rollups.',
    `- Views: ${ASSISTANT_VIEW_TYPES.join(', ')}. Every table already gets a grid view. kanban needs`,
    '  field = a singleSelect to stack by; calendar needs field = a date or dateTime field;',
    '  timeline needs field = the start date or dateTime field and endField = the end date field',
    '  or null; list needs field = a link field to records of the same table (the parent record).',
    '  Other views field = null; endField is null except for timeline.',
    '- Automations are created switched off. Triggers: recordCreated, recordUpdated (watchFields:',
    '  field names, or null for any change). Actions: sendEmail (to: addresses), updateRecord',
    '  (sets cells of the triggering record), createRecord (in a table). Cell values and email',
    '  text may use tokens like {{trigger.record.fields.Field name}}.',
    '- Operations that break these rules are shown with the problem and not applied.',
    '- Keep plans small and focused on the request; no operations when nothing fits, and say why',
    '  in the summary. The summary is one or two plain sentences.',
    '',
    formulaGuide(),
  ].join('\n');
}

/** The base's schema as the model reads it. */
export function describeBase(base: AssistantBaseInfo): string {
  if (base.tables.length === 0) return 'The base has no tables yet.';
  return base.tables
    .map(
      (t) =>
        `Table "${t.name}":\n${t.fields
          .map(
            (f, i) =>
              `- ${f.name} (${f.type}${f.detail ? `; ${f.detail}` : ''})${i === 0 ? ' [primary]' : ''}`
          )
          .join('\n')}`
    )
    .join('\n\n');
}
