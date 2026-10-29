import { z } from 'zod';
import { compareNullable, compareText, defineFieldType, first } from '../util.js';
import { formulaOptionsSchema } from './formula.js';
import { url } from './url.js';

/** Longest button label. */
export const MAX_BUTTON_LABEL = 100;

export const BUTTON_ACTIONS = ['openUrl', 'runAutomation'] as const;
export type ButtonAction = (typeof BUTTON_ACTIONS)[number];

/**
 * A button's options: its label and the formula that gives the URL it opens (the formula keys
 * of `formulaOptionsSchema`: the server stores the stored form, result type and referenced
 * fields, as for a formula field). With `action: 'runAutomation'` a click runs the enabled
 * automations whose trigger is this button instead of opening the URL.
 */
export const buttonOptionsSchema = formulaOptionsSchema
  .extend({
    label: z.string().trim().min(1).max(MAX_BUTTON_LABEL).default('Open'),
    action: z.enum(BUTTON_ACTIONS).default('openUrl'),
  })
  .strict();

export type ButtonOptions = z.infer<typeof buttonOptionsSchema>;

/** Only an http(s) URL (a bare domain gets `https://`); `javascript:` and friends are empty. */
function readButtonUrl(input: unknown): string | null {
  const v = first(input);
  return typeof v === 'string' ? url.coerce(v, {}) : null;
}

/**
 * A button that opens a URL. Its URL formula is computed like a formula field (the
 * server's recompute engine writes the result to the `jsonb` column); only http(s) results
 * count, so a cell never links to `javascript:`. The client opens it with
 * `rel="noopener noreferrer"`. Buttons don't sort, as in Airtable; filters only test whether there is a URL.
 */
export const button = defineFieldType({
  name: 'button',
  label: 'Button',
  category: 'computed',
  optionsSchema: buttonOptionsSchema,
  // The label and what a click does; the URL is the cell's value.
  publicOptions: (o) => ({ label: o.label, action: o.action }),
  storage: { kind: 'computed', sqlType: 'jsonb' },
  filterOperators: ['isEmpty', 'isNotEmpty'],
  sort: 'none',
  formulaType: 'text',
  editor: { kind: 'button', align: 'left', width: 140 },
  readOnly: true,
  computed: true,
  conversionInput: 'primitive',
  emptyValue: null,
  valueSchema: () => z.string().refine((v) => readButtonUrl(v) === v, 'Not an http(s) URL'),
  coerce: readButtonUrl,
  toStorage: (value) => value,
  fromStorage: readButtonUrl,
  compare: (a, b) => compareNullable(a, b, compareText),
  format: (value) => value ?? '',
  toPrimitive: (value) => value,
});

/** Types whose options carry a formula the server computes (formula, button). */
export const FORMULA_FIELD_TYPES: readonly string[] = ['formula', 'button'];

export function hasFormula(type: string): boolean {
  return FORMULA_FIELD_TYPES.includes(type);
}
