import { z } from 'zod';
import { NUMBER_OPERATORS } from '../number-like.js';
import {
  compareNullable,
  compareNumber,
  defineFieldType,
  first,
  MAX_NUMBER,
  parseNumberText,
  roundTo,
} from '../util.js';

export const DURATION_FORMATS = [
  'h:mm',
  'h:mm:ss',
  'h:mm:ss.s',
  'h:mm:ss.ss',
  'h:mm:ss.sss',
] as const;
export type DurationFormat = (typeof DURATION_FORMATS)[number];

export interface DurationOptions {
  format: DurationFormat;
}

/** Fraction digits of seconds a format keeps (`h:mm` keeps whole minutes: -1). */
const SECOND_DECIMALS: Record<DurationFormat, number> = {
  'h:mm': -1,
  'h:mm:ss': 0,
  'h:mm:ss.s': 1,
  'h:mm:ss.ss': 2,
  'h:mm:ss.sss': 3,
};

function secondDecimals(format: DurationFormat): number {
  return SECOND_DECIMALS[format];
}

function round(seconds: number, format: DurationFormat): number | null {
  const d = secondDecimals(format);
  if (d < 0) {
    const minutes = roundTo(seconds / 60, 0);
    return minutes === null || Math.abs(minutes * 60) > MAX_NUMBER ? null : minutes * 60 || 0;
  }
  return roundTo(seconds, d);
}

function parseDuration(text: string, format: DurationFormat): number | null {
  const t = text.trim();
  const clock = /^(-)?(\d+):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?$/.exec(t);
  if (clock) {
    const [h, m, s] = [Number(clock[2]), Number(clock[3]), Number(clock[4] ?? 0)];
    if (m > 59 || s >= 60) return null;
    return (clock[1] ? -1 : 1) * (h * 3600 + m * 60 + s);
  }
  const n = parseNumberText(t);
  if (!n || n.percent) return null;
  // A bare number is minutes in h:mm (Airtable: typing 90 gives 1:30), seconds otherwise.
  return format === 'h:mm' ? n.value * 60 : n.value;
}

function coerceDuration(input: unknown, o: DurationOptions): number | null {
  const v = first(input);
  const seconds =
    typeof v === 'number'
      ? Number.isFinite(v)
        ? v
        : null
      : typeof v === 'string'
        ? parseDuration(v, o.format)
        : null;
  return seconds === null ? null : round(seconds, o.format);
}

function formatDuration(seconds: number, format: DurationFormat): string {
  const d = Math.max(secondDecimals(format), 0);
  const scale = 10 ** d;
  let units = Math.round(Math.abs(seconds) * scale);
  if (format === 'h:mm') units = Math.round(Math.abs(seconds) / 60) * 60;
  const frac = units % scale;
  const total = (units - frac) / scale;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const sign = seconds < 0 && units > 0 ? '-' : '';
  const mm = String(m).padStart(2, '0');
  if (format === 'h:mm') return `${sign}${h}:${mm}`;
  const ss = String(s).padStart(2, '0');
  return `${sign}${h}:${mm}:${ss}${d > 0 ? `.${String(frac).padStart(d, '0')}` : ''}`;
}

/** A length of time in seconds, shown as `h:mm` or `h:mm:ss[.s…]` (`format`). */
export const duration = defineFieldType({
  name: 'duration',
  label: 'Duration',
  category: 'basic',
  optionsSchema: z.object({ format: z.enum(DURATION_FORMATS).default('h:mm') }).strict(),
  storage: { kind: 'column', sqlType: 'numeric' },
  filterOperators: NUMBER_OPERATORS,
  sort: 'number',
  formulaType: 'number',
  editor: { kind: 'duration', align: 'right', width: 110 },
  readOnly: false,
  computed: false,
  conversionInput: 'primitive',
  emptyValue: null,
  valueSchema: (o) => z.number().refine((v) => round(v, o.format) === v, 'Not a valid duration'),
  coerce: coerceDuration,
  toStorage: (value) => (value === null ? null : String(value)),
  fromStorage: (raw) => {
    const n =
      typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : typeof raw === 'number'
          ? raw
          : Number.NaN;
    return Number.isFinite(n) && Math.abs(n) <= MAX_NUMBER ? n || 0 : null;
  },
  compare: (a, b) => compareNullable(a, b, compareNumber),
  format: (value, o) => (value === null ? '' : formatDuration(value, o.format)),
  toPrimitive: (value) => value,
});
