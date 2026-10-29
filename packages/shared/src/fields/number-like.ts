import { z } from 'zod';
import type { EditorHint, FieldTypeDef, FilterOperator, FormatContext } from './types.js';
import {
  compareNullable,
  compareNumber,
  defineFieldType,
  first,
  MAX_NUMBER,
  readNumber,
  roundTo,
} from './util.js';

export const NUMBER_OPERATORS = [
  '=',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'isEmpty',
  'isNotEmpty',
] as const satisfies readonly FilterOperator[];

export const precisionSchema = (fallback: number) => z.int().min(0).max(8).default(fallback);

interface NumberLikeOptions {
  precision: number;
  allowNegative: boolean;
}

interface NumberLikeSpec<O extends NumberLikeOptions> {
  name: string;
  label: string;
  optionsSchema: z.ZodType<O>;
  editor: EditorHint;
  /** Decimals actually stored for a `precision` (percent stores 2 more, as fractions). */
  storedDecimals(options: O): number;
  /** Reads typed text or numbers into the stored number, before rounding. */
  read(input: unknown, options: O): number | null;
  format(value: number, options: O, ctx?: FormatContext): string;
}

/** A field stored as `numeric`: number, currency, percent. */
export function numberLike<O extends NumberLikeOptions>(
  spec: NumberLikeSpec<O>
): FieldTypeDef<O, number> {
  const valid = (value: number, options: O) =>
    roundTo(value, spec.storedDecimals(options)) === value && (options.allowNegative || value >= 0);
  const coerce = (input: unknown, options: O): number | null => {
    const raw = spec.read(first(input), options);
    if (raw === null) return null;
    const value = roundTo(raw, spec.storedDecimals(options));
    return value !== null && valid(value, options) ? value : null;
  };
  return defineFieldType<O, number>({
    name: spec.name,
    label: spec.label,
    category: 'basic',
    optionsSchema: spec.optionsSchema,
    storage: { kind: 'column', sqlType: 'numeric' },
    filterOperators: NUMBER_OPERATORS,
    sort: 'number',
    formulaType: 'number',
    editor: spec.editor,
    readOnly: false,
    computed: false,
    conversionInput: 'primitive',
    emptyValue: null,
    valueSchema: (options) =>
      z.number().refine((v) => valid(v, options), `Not a valid ${spec.label} value`),
    coerce,
    toStorage: (value) => (value === null ? null : String(value)),
    // Stored values keep their decimals even if `precision` was lowered later.
    fromStorage: (raw) => {
      const n =
        typeof raw === 'string' && raw.trim() !== ''
          ? Number(raw)
          : typeof raw === 'number'
            ? raw
            : Number.NaN;
      if (!Number.isFinite(n) || Math.abs(n) > MAX_NUMBER) return null;
      return n === 0 ? 0 : n;
    },
    compare: (a, b) => compareNullable(a, b, compareNumber),
    format: (value, options, ctx) => (value === null ? '' : spec.format(value, options, ctx)),
    toPrimitive: (value) => value,
  });
}

/** Plain number input: numbers, numeric text, checkbox 1/0. A typed `%` means hundredths. */
export function readPlainNumber(input: unknown): number | null {
  const n = readNumber(input);
  if (!n) return null;
  return n.percent ? n.value / 100 : n.value;
}
