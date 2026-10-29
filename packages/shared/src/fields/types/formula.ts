import { z } from 'zod';
import { MAX_FORMULA_LENGTH } from '../../formula/ast.js';
import { FORMULA_TYPES } from '../../formula/functions.js';
import { MAX_COMPUTED_TEXT } from '../computed.js';
import { formatDate, formatInstant, isValidDate, isValidInstant } from '../datetime.js';
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

/** A formula cell: a number or a text (booleans 1/0, dates ISO text, errors `#ERROR!`). */
type FormulaCell = number | string;

function readCell(input: unknown): FormulaCell | null {
  const v = first(input);
  // `-0` reads as 0: jsonb storage drops the sign, so the cell round-trips.
  if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v) <= MAX_NUMBER ? v || 0 : null;
  if (typeof v === 'string' && v !== '' && v.length <= MAX_COMPUTED_TEXT) return v;
  return null;
}

const compareCell = (a: FormulaCell, b: FormulaCell) => {
  if (typeof a === 'number' && typeof b === 'number') return compareNumber(a, b);
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return compareText(a, b);
};

export const formulaOptionsSchema = z
  .object({
    /**
     * The formula. Clients send it as written (fields by name, or in the stored form); the server
     * stores it in the stored form (`serializeFormula`, fields by id).
     */
    formula: z.string().max(MAX_FORMULA_LENGTH).default(''),
    /** Set by the server from the formula: its result type, ... */
    resultType: z.enum(FORMULA_TYPES).default('any'),
    /** ... the fields it reads, ... */
    referencedFieldIds: z.array(z.uuid()).max(1000).default([]),
    /** ... and whether it parses and type-checks (an invalid formula computes `#ERROR!`). */
    isValid: z.boolean().default(false),
    /** Decimals of a number result (`null`: as computed, up to 8). */
    precision: z.int().min(0).max(8).nullable().default(null),
    /** The zone a date-time result is shown in (as in Airtable, UTC by default). */
    timeZone: z.string().max(64).default('UTC'),
  })
  .strict();

export type FormulaOptions = z.infer<typeof formulaOptionsSchema>;

const OPERATORS: readonly FilterOperator[] = [...NUMBER_OPERATORS, 'contains', 'doesNotContain'];

/**
 * A formula over the record's other fields (Airtable's formula field). The server evaluates
 * it on every change of a field it reads and stores the result as a
 * `jsonb` number or text, so views sort and filter it like a rollup.
 */
export const formula = defineFieldType({
  name: 'formula',
  label: 'Formula',
  category: 'computed',
  optionsSchema: formulaOptionsSchema,
  // The result's format, not the formula or the fields it reads.
  publicOptions: (o) => ({
    resultType: o.resultType,
    isValid: o.isValid,
    precision: o.precision,
    timeZone: o.timeZone,
  }),
  storage: { kind: 'computed', sqlType: 'jsonb' },
  filterOperators: OPERATORS,
  sort: 'number',
  formulaType: 'any',
  editor: { kind: 'none', align: 'left', width: 180 },
  readOnly: true,
  computed: true,
  conversionInput: 'primitive',
  emptyValue: null,
  valueSchema: () =>
    z.union([
      z.number().refine((n) => Number.isFinite(n) && Math.abs(n) <= MAX_NUMBER),
      z.string().min(1).max(MAX_COMPUTED_TEXT),
    ]),
  coerce: readCell,
  toStorage: (value) => value,
  fromStorage: readCell,
  compare: (a, b) => compareNullable(a, b, compareCell),
  format: (value, o, ctx) => {
    if (value === null) return '';
    if (typeof value === 'string') {
      if (o.resultType !== 'date') return value;
      if (isValidDate(value)) return formatDate(value, 'local', ctx?.locale);
      if (isValidInstant(value)) {
        const tz = o.timeZone || 'UTC';
        try {
          return formatInstant(value, tz, 'local', '12h', ctx?.locale);
        } catch {
          return formatInstant(value, 'UTC', 'local', '12h', ctx?.locale);
        }
      }
      return value;
    }
    if (o.resultType === 'boolean') return value ? '1' : '0';
    return formatNumber(value, ctx?.locale, {
      minimumFractionDigits: o.precision ?? 0,
      maximumFractionDigits: o.precision ?? 8,
    });
  },
  toPrimitive: (value) => value,
});
