import { z } from 'zod';
import { choiceColorSchema, fieldIconSchema } from '../choices.js';
import { NUMBER_OPERATORS } from '../number-like.js';
import { compareNullable, compareNumber, defineFieldType, first, readNumber } from '../util.js';

export interface RatingOptions {
  max: number;
}

function coerceRating(input: unknown, o: RatingOptions): number | null {
  const n = readNumber(first(input));
  if (!n || n.percent) return null;
  const v = Math.round(n.value);
  return v >= 1 && v <= o.max ? v : null;
}

/** 1 to `max` (1-10) icons. 0 is empty; out-of-range values are empty, not clamped. */
export const rating = defineFieldType({
  name: 'rating',
  label: 'Rating',
  category: 'basic',
  optionsSchema: z
    .object({
      max: z.int().min(1).max(10).default(5),
      icon: fieldIconSchema.default('star'),
      color: choiceColorSchema.default('amber'),
    })
    .strict(),
  storage: { kind: 'column', sqlType: 'smallint' },
  filterOperators: NUMBER_OPERATORS,
  sort: 'number',
  formulaType: 'number',
  editor: { kind: 'rating', align: 'left', width: 110 },
  readOnly: false,
  computed: false,
  conversionInput: 'primitive',
  emptyValue: null,
  valueSchema: (o) => z.int().min(1).max(o.max),
  coerce: coerceRating,
  toStorage: (value) => value,
  // A lowered `max` keeps higher stored ratings readable.
  fromStorage: (raw) => {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
    return Number.isInteger(n) && n >= 1 && n <= 10 ? n : null;
  },
  compare: (a, b) => compareNullable(a, b, compareNumber),
  format: (value) => (value === null ? '' : String(value)),
  toPrimitive: (value) => value,
});
