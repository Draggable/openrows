import {
  ASSISTANT_FIELD_TYPES,
  ASSISTANT_VIEW_TYPES,
  type AssistantBaseInfo,
  FORMULA_FUNCTIONS,
  type FunctionSignature,
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
    '  or number, date, email, autoNumber; never link, formula, attachment or user).',
    `- Field types: ${ASSISTANT_FIELD_TYPES.join(', ')}.`,
    '- Set choices (an ordered list of option names) only for singleSelect and multipleSelect;',
    '  formula only for formula fields; linkedTable only for link fields (an inverse link is',
    '  added to the linked table automatically: do not create it). Otherwise null.',
    `- Views: ${ASSISTANT_VIEW_TYPES.join(', ')}. Every table already gets a grid view. kanban needs`,
    '  field = a singleSelect to stack by; calendar needs field = a date or dateTime field;',
    '  other views field = null.',
    '- Automations are created switched off. Triggers: recordCreated, recordUpdated (watchFields:',
    '  field names, or null for any change). Actions: sendEmail (to: addresses), updateRecord',
    '  (sets cells of the triggering record), createRecord (in a table). Cell values and email',
    '  text may use tokens like {{trigger.record.fields.Field name}}.',
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
