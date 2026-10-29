import { z } from 'zod';
import { countOptionsSchema } from '../computed.js';
import { NUMBER_OPERATORS } from '../number-like.js';
import { compareNullable, compareNumber, defineFieldType, first } from '../util.js';

function readCount(input: unknown): number | null {
  const v = first(input);
  const n = typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : v;
  // -0 reads as 0, as storage gives it back.
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? (n === 0 ? 0 : n) : null;
}

/**
 * How many live records a link field of this table links to. Computed by the server and
 * stored in a `numeric` column; a record with no links counts 0.
 */
export const count = defineFieldType({
  name: 'count',
  label: 'Count',
  category: 'computed',
  optionsSchema: countOptionsSchema,
  publicOptions: () => ({}),
  storage: { kind: 'computed', sqlType: 'numeric' },
  filterOperators: NUMBER_OPERATORS,
  sort: 'number',
  formulaType: 'number',
  editor: { kind: 'none', align: 'right', width: 90 },
  readOnly: true,
  computed: true,
  conversionInput: 'primitive',
  emptyValue: null,
  valueSchema: () => z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  coerce: readCount,
  toStorage: (value) => (value === null ? null : String(value)),
  fromStorage: readCount,
  compare: (a, b) => compareNullable(a, b, compareNumber),
  format: (value) => (value === null ? '' : String(value)),
  toPrimitive: (value) => value,
});
