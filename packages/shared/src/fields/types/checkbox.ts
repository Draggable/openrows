import { z } from 'zod';
import { choiceColorSchema, fieldIconSchema } from '../choices.js';
import { compareNullable, defineFieldType, first } from '../util.js';

const TRUE_TEXT = new Set(['true', 'yes', 'y', 'checked', 'check', 'on', '1', 'x', '✓', '✔']);

function toBool(input: unknown): boolean {
  const v = first(input);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) && v !== 0;
  if (typeof v === 'string') return TRUE_TEXT.has(v.trim().toLowerCase());
  return false;
}

/** On or off. Empty is `false`, and a `NULL` column reads as `false` (ADR-001). */
export const checkbox = defineFieldType({
  name: 'checkbox',
  label: 'Checkbox',
  category: 'basic',
  optionsSchema: z
    .object({ icon: fieldIconSchema.default('check'), color: choiceColorSchema.default('green') })
    .strict(),
  storage: { kind: 'column', sqlType: 'boolean' },
  filterOperators: ['is'],
  sort: 'boolean',
  formulaType: 'boolean',
  editor: { kind: 'checkbox', align: 'center', width: 72 },
  readOnly: false,
  computed: false,
  conversionInput: 'primitive',
  emptyValue: false,
  valueSchema: () => z.boolean(),
  coerce: (input): boolean => toBool(input),
  toStorage: (value) => value === true,
  fromStorage: (raw): boolean => raw === true,
  compare: (a, b) => compareNullable(a === true, b === true, (x, y) => Number(x) - Number(y)),
  format: (value) => (value ? 'checked' : ''),
  toPrimitive: (value) => value === true,
});
