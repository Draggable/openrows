import { z } from 'zod';
import { NUMBER_OPERATORS } from '../number-like.js';
import { compareNullable, compareNumber, defineFieldType, first } from '../util.js';

function readPositiveInt(input: unknown): number | null {
  const v = first(input);
  const n =
    typeof v === 'number'
      ? v
      : typeof v === 'bigint'
        ? Number(v)
        : typeof v === 'string' && /^\s*\d+\s*$/.test(v)
          ? Number(v)
          : Number.NaN;
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/**
 * A unique, increasing number per record: its own `bigint GENERATED ALWAYS AS IDENTITY` column
 * (ADR-001), so nobody writes it. Drivers return `bigint` as a string.
 */
export const autoNumber = defineFieldType({
  name: 'autoNumber',
  label: 'Autonumber',
  category: 'computed',
  optionsSchema: z.object({}).strict(),
  storage: { kind: 'identity', sqlType: 'bigint' },
  filterOperators: NUMBER_OPERATORS,
  sort: 'number',
  formulaType: 'number',
  editor: { kind: 'none', align: 'right', width: 90 },
  readOnly: true,
  computed: true,
  conversionInput: 'primitive',
  emptyValue: null,
  valueSchema: () => z.int().min(1).max(Number.MAX_SAFE_INTEGER),
  coerce: readPositiveInt,
  toStorage: (value) => (value === null ? null : String(value)),
  fromStorage: readPositiveInt,
  compare: (a, b) => compareNullable(a, b, compareNumber),
  format: (value) => (value === null ? '' : String(value)),
  toPrimitive: (value) => value,
});
