import { parseNumberText } from '../../fields/util.js';
import type { FunctionImpl } from './env.js';
import {
  checkNumber,
  FormulaDate,
  type FormulaValue,
  fail,
  flatten,
  isBlank,
  toInteger,
  toNumber,
  toText,
} from './values.js';

/** Numeric functions (Airtable's, which follow the spreadsheet conventions). */

/** `value` rounded to `digits` decimals (negative: tens, hundreds...), with a rounding mode. */
function roundWith(value: number, digits: number, mode: (x: number) => number): number {
  if (digits > 15 || digits < -15) fail('The precision is out of range');
  const factor = 10 ** Math.abs(digits);
  const scaled = digits >= 0 ? value * factor : value / factor;
  // Correct binary noise (1.005 * 100 = 100.49999...) before rounding.
  const fixed = Number(scaled.toPrecision(15));
  const rounded = mode(fixed);
  return checkNumber(digits >= 0 ? rounded / factor : rounded * factor);
}

const halfAwayFromZero = (x: number) => Math.sign(x) * Math.round(Math.abs(x));
const awayFromZero = (x: number) => Math.sign(x) * Math.ceil(Math.abs(x));

/** The numbers among the arguments, lists flattened (text and blanks are skipped). */
function numbersOf(args: readonly FormulaValue[]): number[] {
  const out: number[] = [];
  for (const v of flatten(args)) {
    if (typeof v === 'number') out.push(v);
    else if (typeof v === 'boolean') out.push(v ? 1 : 0);
  }
  return out;
}

const num = (v: FormulaValue | undefined) => toNumber(v ?? null);

function toSignificance(value: number, significance: number, up: boolean): number {
  const s = Math.abs(significance);
  if (s === 0) return 0;
  const q = Number((value / s).toPrecision(15));
  return checkNumber((up ? Math.ceil(q) : Math.floor(q)) * s);
}

export const NUMERIC_FUNCTIONS: Record<string, FunctionImpl> = {
  ABS: ([x]) => Math.abs(num(x)),
  ROUND: ([x, digits]) => roundWith(num(x), toInteger(digits ?? 0), halfAwayFromZero),
  ROUNDUP: ([x, digits]) => roundWith(num(x), toInteger(digits ?? 0), awayFromZero),
  ROUNDDOWN: ([x, digits]) => roundWith(num(x), toInteger(digits ?? 0), Math.trunc),
  CEILING: ([x, significance]) =>
    toSignificance(num(x), significance === undefined ? 1 : num(significance), true),
  FLOOR: ([x, significance]) =>
    toSignificance(num(x), significance === undefined ? 1 : num(significance), false),
  INT: ([x]) => Math.floor(num(x)),
  EVEN: ([x]) => {
    const n = awayFromZero(num(x));
    return checkNumber(n % 2 === 0 ? n : n + Math.sign(n));
  },
  ODD: ([x]) => {
    const v = num(x);
    const n = awayFromZero(v);
    if (n === 0) return 1;
    return checkNumber(Math.abs(n) % 2 === 1 ? n : n + Math.sign(n));
  },
  MOD: ([a, b]) => {
    const x = num(a);
    const d = num(b);
    if (d === 0) fail('MOD divides by zero');
    // The sign of the divisor, as in spreadsheets: MOD(-3, 2) is 1.
    return checkNumber(x - d * Math.floor(x / d));
  },
  POWER: ([base, exponent]) => checkNumber(num(base) ** num(exponent)),
  SQRT: ([x]) => {
    const n = num(x);
    if (n < 0) fail('SQRT of a negative number');
    return Math.sqrt(n);
  },
  LOG: ([x, base]) => {
    const n = num(x);
    const b = base === undefined ? 10 : num(base);
    if (n <= 0 || b <= 0 || b === 1) fail('LOG needs positive numbers and a base other than 1');
    return checkNumber(b === 10 ? Math.log10(n) : Math.log(n) / Math.log(b));
  },
  EXP: ([x]) => checkNumber(Math.exp(num(x))),
  SUM: (args) => checkNumber(numbersOf(args).reduce((a, b) => a + b, 0)),
  AVERAGE: (args) => {
    const ns = numbersOf(args);
    return ns.length
      ? checkNumber(ns.reduce((a, b) => a + b, 0) / ns.length)
      : fail('AVERAGE of no numbers');
  },
  MAX: (args) => {
    const ns = numbersOf(args);
    return ns.length ? ns.reduce((a, b) => Math.max(a, b)) : 0;
  },
  MIN: (args) => {
    const ns = numbersOf(args);
    return ns.length ? ns.reduce((a, b) => Math.min(a, b)) : 0;
  },
  COUNT: (args) => flatten(args).filter((v) => typeof v === 'number').length,
  COUNTA: (args) => flatten(args).filter((v) => !isBlank(v)).length,
  COUNTALL: (args) => flatten(args).length,
  VALUE: ([text]) => {
    if (text instanceof FormulaDate) fail('VALUE needs text');
    if (typeof text === 'number') return text;
    const t = toText(text ?? null).trim();
    if (t === '') return null;
    const parsed = parseNumberText(t);
    if (!parsed) fail(`"${t.slice(0, 50)}" is not a number`);
    return checkNumber(parsed.percent ? parsed.value / 100 : parsed.value);
  },
};
