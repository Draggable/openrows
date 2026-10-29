import { z } from 'zod';
import {
  DATE_FORMATS,
  formatInstant,
  instantFromDate,
  instantInZone,
  isValidInstant,
  parseDate,
  parseDisplayInstant,
  parseInstant,
  TIME_FORMATS,
  timeZoneSchema,
} from './datetime.js';
import type {
  EditorHint,
  FieldCategory,
  FieldStorage,
  FieldTypeDef,
  FilterOperator,
} from './types.js';
import { compareNullable, defineFieldType, first } from './util.js';

export const DATE_OPERATORS = [
  'is',
  'isNot',
  'isBefore',
  'isAfter',
  'isOnOrBefore',
  'isOnOrAfter',
  'isWithin',
  'isEmpty',
  'isNotEmpty',
] as const satisfies readonly FilterOperator[];

export const dateFormatSchema = z.enum(DATE_FORMATS).default('local');

export const dateTimeOptionsSchema = z
  .object({
    dateFormat: dateFormatSchema,
    timeFormat: z.enum(TIME_FORMATS).default('12h'),
    /** IANA zone used to display the value and to read input without an offset. */
    timeZone: timeZoneSchema.default('UTC'),
  })
  .strict();

export type DateTimeOptions = z.infer<typeof dateTimeOptionsSchema>;

/** Reads a datetime from a `Date`, an ISO string (with or without offset) or a slash date. */
export function coerceInstant(input: unknown, o: DateTimeOptions): string | null {
  const v = first(input);
  if (v instanceof Date) return instantFromDate(v);
  if (typeof v !== 'string') return null;
  const exact = parseInstant(v, o.timeZone);
  if (exact) return exact;
  const dayFirst = o.dateFormat === 'european';
  const shown = parseDisplayInstant(v, dayFirst, o.timeZone);
  if (shown) return shown;
  const day = parseDate(v, dayFirst);
  return day ? parseInstant(day, o.timeZone) : null;
}

const compareIso = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface DateTimeLikeSpec {
  name: string;
  label: string;
  category: FieldCategory;
  storage: FieldStorage;
  editor: EditorHint;
  readOnly: boolean;
  computed: boolean;
}

/** A field whose value is an instant: dateTime, createdTime, lastModifiedTime. */
export function dateTimeLike(spec: DateTimeLikeSpec): FieldTypeDef<DateTimeOptions, string> {
  return defineFieldType<DateTimeOptions, string>({
    ...spec,
    optionsSchema: dateTimeOptionsSchema,
    filterOperators: DATE_OPERATORS,
    sort: 'chronological',
    formulaType: 'date',
    conversionInput: 'primitive',
    emptyValue: null,
    valueSchema: () => z.string().refine(isValidInstant, 'Not a UTC ISO datetime'),
    coerce: coerceInstant,
    toStorage: (value) => value,
    fromStorage: (raw) =>
      raw instanceof Date
        ? instantFromDate(raw)
        : typeof raw === 'string'
          ? parseInstant(raw, 'UTC')
          : null,
    compare: (a, b) => compareNullable(a, b, compareIso),
    format: (value, o, ctx) =>
      value === null
        ? ''
        : formatInstant(value, o.timeZone, o.dateFormat, o.timeFormat, ctx?.locale),
    // Keeps the field's offset, so converting to a date keeps the local day.
    toPrimitive: (value, o) => (value === null ? null : instantInZone(value, o.timeZone)),
  });
}

export { compareIso };
