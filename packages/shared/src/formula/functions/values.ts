// Runtime values of the formula evaluator and Airtable's implicit conversions between
// them. Pure: the server's recompute engine and (later) the client's formula preview share it.

import { parseInstant } from '../../fields/datetime.js';
import { parseNumberText } from '../../fields/util.js';

/**
 * A date or date-time. `ms` is the UTC instant (a date-only value is UTC midnight of its day).
 * `timeZone` and `locale` are what `SET_TIMEZONE`/`SET_LOCALE` attached: the date parts and
 * the format read the instant in that zone (UTC by default, as in Airtable).
 */
export class FormulaDate {
  constructor(
    readonly ms: number,
    readonly dateOnly = false,
    readonly timeZone?: string,
    readonly locale?: string
  ) {}

  with(changes: { ms?: number; dateOnly?: boolean; timeZone?: string; locale?: string }) {
    return new FormulaDate(
      changes.ms ?? this.ms,
      changes.dateOnly ?? this.dateOnly,
      changes.timeZone ?? this.timeZone,
      changes.locale ?? this.locale
    );
  }
}

/** What an expression evaluates to. `null` is blank. */
export type FormulaValue = string | number | boolean | null | FormulaDate | FormulaValue[];

/** The text a cell shows for an error (Airtable's `#ERROR!`). */
export const FORMULA_ERROR = '#ERROR!';

/**
 * An evaluation error (`ERROR()`, a bad argument, a division by zero...). It propagates up to
 * the nearest `ISERROR` or to the top, where the cell becomes `#ERROR!`.
 */
export class FormulaEvalError extends Error {
  override readonly name = 'FormulaEvalError';
}

/** The step or time budget ran out. Not catchable by `ISERROR`. */
export class FormulaBudgetError extends Error {
  override readonly name = 'FormulaBudgetError';
}

export function fail(message: string): never {
  throw new FormulaEvalError(message);
}

/** Longest text a formula may produce (the same cap as computed text). */
export const MAX_FORMULA_TEXT = 100_000;

/** Most items a formula list may hold. */
export const MAX_FORMULA_ITEMS = 10_000;

/** Largest magnitude a formula number may reach (number fields' limit). */
export const MAX_FORMULA_NUMBER = 1e15;

export function checkText(text: string): string {
  if (text.length > MAX_FORMULA_TEXT) fail('The text is too long');
  return text;
}

export function checkNumber(n: number): number {
  if (!Number.isFinite(n)) fail('The result is not a number');
  if (Math.abs(n) > MAX_FORMULA_NUMBER) fail('The number is too large');
  return n === 0 ? 0 : n;
}

export function isBlank(v: FormulaValue): boolean {
  return v === null || v === '' || (Array.isArray(v) && v.every(isBlank));
}

/** Lists flattened to their scalars (nested lists too). */
export function flatten(values: readonly FormulaValue[]): Exclude<FormulaValue, FormulaValue[]>[] {
  const out: Exclude<FormulaValue, FormulaValue[]>[] = [];
  const walk = (v: FormulaValue, depth: number) => {
    if (Array.isArray(v)) {
      if (depth > 32) fail('The list is nested too deeply');
      for (const x of v) walk(x, depth + 1);
    } else {
      out.push(v);
    }
  };
  for (const v of values) walk(v, 0);
  return out;
}

/** ISO text of a date: `YYYY-MM-DD` for a date-only value, else the UTC instant. */
export function dateText(d: FormulaDate): string {
  const iso = new Date(d.ms).toISOString();
  return d.dateOnly ? iso.slice(0, 10) : iso;
}

/** Text conversion (`&`, text arguments): numbers as written, booleans 1/0, lists with ", ". */
export function toText(v: FormulaValue): string {
  if (v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof FormulaDate) return dateText(v);
  return checkText(
    v
      .filter((x) => x !== null)
      .map(toText)
      .join(', ')
  );
}

/**
 * Number conversion (arithmetic, number arguments): blank is 0, booleans 1/0, numeric text is
 * read (`"1,000"`, `"$5"`, `"50%"`); anything else is an error.
 */
export function toNumber(v: FormulaValue): number {
  if (v === null || v === '') return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const parsed = parseNumberText(v);
    if (!parsed) fail(`"${v.slice(0, 50)}" is not a number`);
    return parsed.percent ? parsed.value / 100 : parsed.value;
  }
  if (Array.isArray(v)) {
    const items = flatten(v).filter((x) => x !== null);
    if (items.length === 0) return 0;
    if (items.length === 1) return toNumber(items[0] ?? null);
  }
  return fail('Expected a number');
}

/** Truthiness (IF, AND, OR, NOT): blank, 0, "" and an empty list are false. */
export function truthy(v: FormulaValue): boolean {
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return v !== '';
  if (v instanceof FormulaDate) return true;
  return flatten(v).some(truthy);
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Date conversion (date arguments): a date, or ISO text (a bare date is UTC midnight, a
 * date-time without an offset is UTC). Blank is `null` (date functions give blank).
 */
export function toDate(v: FormulaValue): FormulaDate | null {
  if (v === null || v === '') return null;
  if (v instanceof FormulaDate) return v;
  if (typeof v === 'string') {
    const text = v.trim();
    const instant = parseInstant(text, 'UTC');
    if (instant === null) fail(`"${text.slice(0, 50)}" is not a date`);
    return new FormulaDate(Date.parse(instant), DATE_ONLY_RE.test(text));
  }
  if (Array.isArray(v)) {
    const items = flatten(v).filter((x) => x !== null);
    if (items.length === 0) return null;
    if (items.length === 1) return toDate(items[0] ?? null);
  }
  return fail('Expected a date');
}

/** A date argument that must be present. */
export function requireDate(v: FormulaValue): FormulaDate {
  return toDate(v) ?? fail('Expected a date');
}

/** A list argument: lists as they are, blank as an empty list, a scalar as a list of one. */
export function toList(v: FormulaValue): FormulaValue[] {
  if (Array.isArray(v)) return v;
  return v === null ? [] : [v];
}

/** A whole-number argument (counts, positions): truncated toward zero. */
export function toInteger(v: FormulaValue): number {
  const n = toNumber(v);
  if (!Number.isFinite(n)) fail('Expected a number');
  return Math.trunc(n);
}

/** `=`: numbers and booleans numerically, dates by instant, text exactly; blank equals "" and 0. */
export function equals(a: FormulaValue, b: FormulaValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return toText(a) === toText(b);
  if (a === null || b === null) {
    const other = a === null ? b : a;
    return other === null || other === '' || other === 0 || other === false;
  }
  if (a instanceof FormulaDate || b instanceof FormulaDate) {
    const x = a instanceof FormulaDate ? a : tryDate(a);
    const y = b instanceof FormulaDate ? b : tryDate(b);
    return x !== null && y !== null && x.ms === y.ms;
  }
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  if (typeof a === 'string' || typeof b === 'string') return toText(a) === toText(b);
  return toNumber(a) === toNumber(b);
}

function tryDate(v: FormulaValue): FormulaDate | null {
  try {
    return toDate(v);
  } catch (e) {
    if (e instanceof FormulaEvalError) return null;
    throw e;
  }
}

/** `<`, `>` and friends: -1, 0 or 1 (numbers, dates, or text by code point). */
export function compareValues(a: FormulaValue, b: FormulaValue): number {
  const cmp = (x: number | string, y: number | string) => (x < y ? -1 : x > y ? 1 : 0);
  if (a instanceof FormulaDate || b instanceof FormulaDate) {
    const x = toDate(a);
    const y = toDate(b);
    if (x === null || y === null) return x === y ? 0 : x === null ? -1 : 1;
    return cmp(x.ms, y.ms);
  }
  if (typeof a === 'string' && typeof b === 'string') return cmp(a, b);
  if ((typeof a === 'string' && b === null) || (a === null && typeof b === 'string'))
    return cmp(toText(a), toText(b));
  return cmp(toNumber(a), toNumber(b));
}
