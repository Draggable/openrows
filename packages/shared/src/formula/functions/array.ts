import type { FunctionImpl } from './env.js';
import {
  FormulaDate,
  type FormulaValue,
  fail,
  flatten,
  MAX_FORMULA_ITEMS,
  toInteger,
  toList,
  truthy,
} from './values.js';

/** List and logical functions (IF, SWITCH and ISERROR are lazy: see evaluate.ts). */

const key = (v: FormulaValue) =>
  v instanceof FormulaDate ? `d${v.ms}` : `${typeof v}:${String(v)}`;

const checkItems = (items: FormulaValue[]) => {
  if (items.length > MAX_FORMULA_ITEMS) fail('The list is too long');
  return items;
};

export const ARRAY_FUNCTIONS: Record<string, FunctionImpl> = {
  ARRAYCOMPACT: ([list]) => toList(list ?? null).filter((v) => v !== null && v !== ''),
  ARRAYFLATTEN: ([list]) => checkItems(flatten(toList(list ?? null))),
  ARRAYUNIQUE: ([list]) => {
    const seen = new Set<string>();
    return toList(list ?? null).filter((v) => {
      const k = Array.isArray(v) ? `a${JSON.stringify(v)}` : key(v);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  },
  ARRAYSLICE: ([list, start, end]) => {
    // 1-based and inclusive; negative positions count from the end (-1 is the last item).
    const items = toList(list ?? null);
    const at = (v: FormulaValue) => {
      const n = toInteger(v);
      if (n === 0) fail('ARRAYSLICE positions start at 1 (or -1 from the end)');
      return n > 0 ? n - 1 : items.length + n;
    };
    const from = Math.max(0, at(start ?? null));
    const to = end === undefined || end === null ? items.length - 1 : at(end);
    return items.slice(from, to + 1);
  },
};

export const LOGICAL_FUNCTIONS: Record<string, FunctionImpl> = {
  AND: (args) => flatten(args).every(truthy),
  OR: (args) => flatten(args).some(truthy),
  XOR: (args) => flatten(args).filter(truthy).length % 2 === 1,
  NOT: ([v]) => !truthy(v ?? null),
  BLANK: () => null,
  ERROR: () => fail('ERROR()'),
  TRUE: () => true,
  FALSE: () => false,
};
