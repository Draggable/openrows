import { z } from 'zod';
import {
  choiceIndex,
  choiceName,
  matchChoice,
  selectOptionsSchema,
  unknownChoiceNames,
  withNewChoices,
} from '../choices.js';
import { compareNullable, defineFieldType, first, readText } from '../util.js';

/**
 * One choice from `choices`; the column stores the choice id. Input matches a choice by id, then
 * by name (exact, then case-insensitive). Unknown names are empty: creating choices from input
 * (Airtable's `typecast`, `unknownChoices` + `withChoices`) is the caller's job, because it
 * changes the field's options.
 */
export const singleSelect = defineFieldType({
  name: 'singleSelect',
  label: 'Single select',
  category: 'choice',
  optionsSchema: selectOptionsSchema,
  storage: { kind: 'column', sqlType: 'text' },
  filterOperators: ['is', 'isNot', 'isAnyOf', 'isNoneOf', 'isEmpty', 'isNotEmpty'],
  sort: 'choiceOrder',
  formulaType: 'text',
  editor: { kind: 'singleSelect', align: 'left', width: 140 },
  readOnly: false,
  computed: false,
  conversionInput: 'primitive',
  emptyValue: null,
  valueSchema: (o) =>
    z.string().refine((id) => o.choices.some((c) => c.id === id), 'Unknown choice'),
  coerce: (input, o) => {
    const text = readText(first(input));
    return text === null ? null : matchChoice(text, o.choices);
  },
  toStorage: (value) => value,
  // A deleted choice reads as empty, as in Airtable.
  fromStorage: (raw, o) =>
    typeof raw === 'string' && o.choices.some((c) => c.id === raw) ? raw : null,
  compare: (a, b, o) =>
    compareNullable(
      a,
      b,
      (x, y) =>
        choiceIndex(x, o.choices) - choiceIndex(y, o.choices) || (x < y ? -1 : x > y ? 1 : 0)
    ),
  format: (value, o) => (value === null ? '' : choiceName(value, o.choices)),
  toPrimitive: (value, o) => (value === null ? null : choiceName(value, o.choices) || null),
  // Airtable's selects are choice names.
  apiValue: (value, o) => choiceName(value, o.choices),
  unknownChoices: (input, o) => {
    const text = readText(first(input));
    return text === null ? [] : unknownChoiceNames([text], o.choices);
  },
  withChoices: withNewChoices,
});
