import { z } from 'zod';
import { MAX_COMPUTED_TEXT, rollupOptionsSchema } from '../computed.js';
import { NUMBER_OPERATORS } from '../number-like.js';
import type { FilterOperator } from '../types.js';
import {
  compareNullable,
  compareNumber,
  compareText,
  defineFieldType,
  first,
  formatNumber,
  MAX_NUMBER,
} from '../util.js';

type RollupResult = number | string;

function readResult(input: unknown): RollupResult | null {
  const v = first(input);
  // `-0` reads as 0: jsonb storage drops the sign, so the cell round-trips.
  if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v) <= MAX_NUMBER ? v || 0 : null;
  if (typeof v === 'string' && v !== '' && v.length <= MAX_COMPUTED_TEXT) return v;
  return null;
}

const compareResult = (a: RollupResult, b: RollupResult) => {
  if (typeof a === 'number' && typeof b === 'number') return compareNumber(a, b);
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return compareText(a, b);
};

const OPERATORS: readonly FilterOperator[] = [...NUMBER_OPERATORS, 'contains', 'doesNotContain'];

/**
 * An aggregation over the values of a field of the linked table, across a link field of this
 * table (Airtable's rollup: SUM(values), ARRAYJOIN(values)…). The result is a number or
 * text (by function), computed by the server and stored as a `jsonb` scalar; numbers sort before
 * text.
 */
export const rollup = defineFieldType({
  name: 'rollup',
  label: 'Rollup',
  category: 'computed',
  optionsSchema: rollupOptionsSchema,
  publicOptions: (o) => ({ function: o.function, separator: o.separator, precision: o.precision }),
  storage: { kind: 'computed', sqlType: 'jsonb' },
  filterOperators: OPERATORS,
  sort: 'number',
  formulaType: 'any',
  editor: { kind: 'none', align: 'right', width: 120 },
  readOnly: true,
  computed: true,
  conversionInput: 'primitive',
  emptyValue: null,
  valueSchema: () =>
    z.union([
      z.number().refine((n) => Number.isFinite(n) && Math.abs(n) <= MAX_NUMBER),
      z.string().min(1).max(MAX_COMPUTED_TEXT),
    ]),
  coerce: readResult,
  toStorage: (value) => value,
  fromStorage: readResult,
  compare: (a, b) => compareNullable(a, b, compareResult),
  format: (value, o, ctx) => {
    if (value === null) return '';
    if (typeof value === 'string') return value;
    return formatNumber(value, ctx?.locale, {
      minimumFractionDigits: o.precision ?? 0,
      maximumFractionDigits: o.precision ?? 8,
    });
  },
  toPrimitive: (value) => value,
});
