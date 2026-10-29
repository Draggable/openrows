import { z } from 'zod';
import { lookupOptionsSchema, MAX_COMPUTED_TEXT, MAX_LOOKUP_ITEMS } from '../computed.js';
import { compareNullable, compareText, defineFieldType } from '../util.js';

function readItems(input: unknown): string[] | null {
  const items = Array.isArray(input) ? input : [input];
  const out: string[] = [];
  for (const raw of items) {
    if (out.length >= MAX_LOOKUP_ITEMS) break;
    const text = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : raw;
    if (typeof text === 'string' && text !== '' && text.length <= MAX_COMPUTED_TEXT) out.push(text);
  }
  return out.length ? out : null;
}

/**
 * The values of a field of the linked table, across a link field of this table: one item
 * per linked record's value (list values flattened), as display text, in link order. Computed
 * by the server and stored in a `text[]` column for sort, filter and search.
 */
export const lookup = defineFieldType({
  name: 'lookup',
  label: 'Lookup',
  category: 'computed',
  optionsSchema: lookupOptionsSchema,
  // Values are display text: nothing about the linked table is needed.
  publicOptions: () => ({}),
  storage: { kind: 'computed', sqlType: 'text[]' },
  filterOperators: ['contains', 'doesNotContain', 'isEmpty', 'isNotEmpty'],
  sort: 'text',
  formulaType: 'array',
  editor: { kind: 'none', align: 'left', width: 200 },
  readOnly: true,
  computed: true,
  conversionInput: 'primitive',
  emptyValue: null,
  valueSchema: () => z.array(z.string().min(1).max(MAX_COMPUTED_TEXT)).min(1).max(MAX_LOOKUP_ITEMS),
  coerce: readItems,
  toStorage: (value) => value,
  fromStorage: readItems,
  compare: (a, b) => compareNullable(a, b, (x, y) => compareText(x.join(', '), y.join(', '))),
  format: (value) => (value ?? []).join(', '),
  toPrimitive: (value) => value,
  apiType: () => 'multipleLookupValues',
});
