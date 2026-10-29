import { z } from 'zod';
import { compareIso, DATE_OPERATORS, dateFormatSchema } from '../date-like.js';
import { formatDate, isValidDate, parseDate } from '../datetime.js';
import { compareNullable, defineFieldType, first } from '../util.js';

export interface DateOptions {
  dateFormat: z.infer<typeof dateFormatSchema>;
}

function coerceDate(input: unknown, o: DateOptions): string | null {
  const v = first(input);
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const iso = v.toISOString();
    return isValidDate(iso.slice(0, 10)) ? iso.slice(0, 10) : null;
  }
  return typeof v === 'string' ? parseDate(v, o.dateFormat === 'european') : null;
}

/** A calendar day without a time or zone, as `YYYY-MM-DD` (column type `date`). */
export const date = defineFieldType({
  name: 'date',
  label: 'Date',
  category: 'basic',
  optionsSchema: z.object({ dateFormat: dateFormatSchema }).strict(),
  storage: { kind: 'column', sqlType: 'date' },
  filterOperators: DATE_OPERATORS,
  sort: 'chronological',
  formulaType: 'date',
  editor: { kind: 'date', align: 'left', width: 140 },
  readOnly: false,
  computed: false,
  conversionInput: 'primitive',
  emptyValue: null,
  valueSchema: () => z.string().refine(isValidDate, 'Not a YYYY-MM-DD date'),
  coerce: coerceDate,
  toStorage: (value) => value,
  // Drivers may hand back a Date at UTC midnight; read its UTC day.
  fromStorage: (raw) =>
    raw instanceof Date || typeof raw === 'string' ? coerceDate(raw, { dateFormat: 'iso' }) : null,
  compare: (a, b) => compareNullable(a, b, compareIso),
  format: (value, o, ctx) => (value === null ? '' : formatDate(value, o.dateFormat, ctx?.locale)),
  toPrimitive: (value) => value,
});
