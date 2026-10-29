import type { FieldTypeDef } from './types.js';

/** Identity helper that infers `O` and `V` for a field-type module. */
export function defineFieldType<O, V>(def: FieldTypeDef<O, V>): FieldTypeDef<O, V> {
  return def;
}

export const DEFAULT_LOCALE = 'en-US';

/** Empty values first, then `cmp`. */
export function compareNullable<V>(a: V | null, b: V | null, cmp: (x: V, y: V) => number): number {
  if (a === null) return b === null ? 0 : -1;
  if (b === null) return 1;
  return cmp(a, b);
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/** Case-insensitive, numeric-aware text order, with a code-point tiebreak so it's total. */
export function compareText(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

export function compareNumber(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Largest magnitude a number-like field accepts (Airtable's limit is in the same range). */
export const MAX_NUMBER = 1e15;

/**
 * Strict number parsing for text input: optional sign, currency symbol, thousands separators,
 * decimals, exponent and a trailing `%` (returned as a flag). `'2024-01-02'` or `'12abc'` is not a
 * number, so dates never turn into garbage numbers.
 */
export function parseNumberText(text: string): { value: number; percent: boolean } | null {
  const m =
    /^([-+])?\s*[$€£¥]?\s*([-+])?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)(e[-+]?\d+)?\s*(%)?$/i.exec(
      text.trim()
    );
  if (!m) return null;
  const sign = m[1] === '-' || m[2] === '-' ? -1 : 1;
  if (m[1] && m[2]) return null;
  const value = sign * Number(`${(m[3] ?? '').replace(/,/g, '')}${m[4] ?? ''}`);
  return Number.isFinite(value) ? { value, percent: m[5] === '%' } : null;
}

/** Rounds to `precision` decimals; idempotent, normalizes `-0`, `null` outside ±MAX_NUMBER. */
export function roundTo(value: number, precision: number): number | null {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_NUMBER) return null;
  const rounded = Number(value.toFixed(precision));
  return rounded === 0 ? 0 : rounded;
}

/** Reads a number from a number, numeric text or a boolean (1/0), else `null`. */
export function readNumber(input: unknown): { value: number; percent: boolean } | null {
  if (typeof input === 'number')
    return Number.isFinite(input) ? { value: input, percent: false } : null;
  if (typeof input === 'boolean') return { value: input ? 1 : 0, percent: false };
  if (typeof input === 'bigint') return readNumber(Number(input));
  if (typeof input === 'string') return parseNumberText(input);
  return null;
}

/** Text from any primitive, for text-like targets. Arrays join with `, `. */
export function readText(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (typeof input === 'number') return Number.isFinite(input) ? String(input) : null;
  if (typeof input === 'bigint') return input.toString();
  if (typeof input === 'boolean') return input ? 'checked' : null;
  if (Array.isArray(input)) {
    const parts = input.map(readText).filter((p): p is string => p !== null && p !== '');
    return parts.length ? parts.join(', ') : null;
  }
  return null;
}

/** First element of an array input (single-value targets), otherwise the input. */
export function first(input: unknown): unknown {
  return Array.isArray(input) ? input[0] : input;
}

export function formatNumber(
  value: number,
  locale: string | undefined,
  options: Intl.NumberFormatOptions
): string {
  return new Intl.NumberFormat(locale ?? DEFAULT_LOCALE, options).format(value);
}

/** Whether `text` has a C0 control character other than tab, line feed and carriage return. */
export function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) return true;
  }
  return false;
}

/** `text` without those control characters. */
export function stripControlChars(text: string): string {
  if (!hasControlChars(text)) return text;
  let out = '';
  for (const ch of text) if (!hasControlChars(ch)) out += ch;
  return out;
}
