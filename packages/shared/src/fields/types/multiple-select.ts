import { z } from 'zod';
import {
  type Choice,
  choiceIndex,
  choiceName,
  matchChoice,
  selectOptionsSchema,
  unknownChoiceNames,
  withNewChoices,
} from '../choices.js';
import { compareNullable, defineFieldType, readText } from '../util.js';

/**
 * The texts an input names: array items, or the text split on commas (unless the whole string
 * matches, so a choice named "a, b" still matches).
 */
function partsOf(input: unknown, choices: readonly Choice[]): string[] {
  if (Array.isArray(input)) return input.map(readText).filter((t): t is string => t !== null);
  const text = readText(input);
  if (text === null) return [];
  return matchChoice(text, choices) !== null ? [text] : text.split(',');
}

function matchAll(input: unknown, choices: readonly Choice[]): string[] | null {
  const ids: string[] = [];
  for (const part of partsOf(input, choices)) {
    const id = matchChoice(part, choices);
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  return ids.length ? ids : null;
}

function compareIds(a: string[], b: string[], choices: readonly Choice[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] ?? '';
    const y = b[i] ?? '';
    const d = choiceIndex(x, choices) - choiceIndex(y, choices) || (x < y ? -1 : x > y ? 1 : 0);
    if (d) return d;
  }
  return a.length - b.length;
}

/**
 * Any number of choices, in the order they were added; the column is `text[]` of choice ids.
 * Text input is split on commas (after trying the whole string). Unknown names are dropped.
 */
export const multipleSelect = defineFieldType({
  name: 'multipleSelect',
  label: 'Multiple select',
  category: 'choice',
  optionsSchema: selectOptionsSchema,
  storage: { kind: 'column', sqlType: 'text[]' },
  filterOperators: ['hasAnyOf', 'hasAllOf', 'isExactly', 'hasNoneOf', 'isEmpty', 'isNotEmpty'],
  sort: 'choiceOrder',
  formulaType: 'array',
  editor: { kind: 'multipleSelect', align: 'left', width: 180 },
  readOnly: false,
  computed: false,
  conversionInput: 'primitive',
  emptyValue: null,
  valueSchema: (o) =>
    z
      .array(z.string().refine((id) => o.choices.some((c) => c.id === id), 'Unknown choice'))
      .min(1)
      .refine((ids) => new Set(ids).size === ids.length, 'Duplicate choice'),
  coerce: (input, o) => matchAll(input, o.choices),
  toStorage: (value) => value,
  fromStorage: (raw, o) => {
    if (!Array.isArray(raw)) return null;
    const ids = raw.filter(
      (id, i): id is string =>
        typeof id === 'string' && raw.indexOf(id) === i && o.choices.some((c) => c.id === id)
    );
    return ids.length ? ids : null;
  },
  compare: (a, b, o) => compareNullable(a, b, (x, y) => compareIds(x, y, o.choices)),
  format: (value, o) => (value ?? []).map((id) => choiceName(id, o.choices)).join(', '),
  toPrimitive: (value, o) => {
    const names = (value ?? []).map((id) => choiceName(id, o.choices)).filter((n) => n !== '');
    return names.length ? names : null;
  },
  apiType: () => 'multipleSelects',
  apiValue: (value, o) => value.map((id) => choiceName(id, o.choices)).filter((n) => n !== ''),
  unknownChoices: (input, o) => unknownChoiceNames(partsOf(input, o.choices), o.choices),
  withChoices: withNewChoices,
});
