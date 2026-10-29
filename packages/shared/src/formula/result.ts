import { getFieldType, isFieldTypeName } from '../fields/index.js';
import { MAX_NUMBER } from '../fields/util.js';
import type { EvaluateResult } from './evaluate.js';
import {
  dateText,
  FORMULA_ERROR,
  FormulaDate,
  type FormulaValue,
  MAX_FORMULA_TEXT,
  toText,
} from './functions/values.js';
import type { FormulaType } from './functions.js';

/**
 * A formula cell's stored value: a number or a text, like a rollup's (a `jsonb` scalar).
 * Booleans are 1/0, dates their ISO text (`YYYY-MM-DD` for a date-only value), lists their items
 * joined with ", ", errors `#ERROR!`. Blank (and "") is `null`.
 */
export type FormulaResult = number | string;

export function formulaResult(result: EvaluateResult): FormulaResult | null {
  if (!result.ok) return FORMULA_ERROR;
  const v = result.value;
  if (v === null) return null;
  if (typeof v === 'number')
    return Number.isFinite(v) && Math.abs(v) <= MAX_NUMBER ? v : FORMULA_ERROR;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof FormulaDate) return dateText(v);
  const text = toText(v);
  if (text.length > MAX_FORMULA_TEXT) return FORMULA_ERROR;
  return text === '' ? null : text;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/**
 * A field's value (as the registry's `fromStorage` gives it) as a formula sees it, by the field
 * type's `formulaType` (or `resultType` for a formula): numbers, booleans, dates, lists (each
 * item's display text) and otherwise the display text. Empty is `null`.
 */
export function fieldFormulaValue(
  field: { type: string; options: unknown; resultType?: FormulaType },
  value: unknown
): FormulaValue {
  if (value === null || value === undefined) return null;
  if (!isFieldTypeName(field.type)) return null;
  const def = getFieldType(field.type);
  const kind = field.resultType ?? def.formulaType;
  switch (kind) {
    case 'number':
      return typeof value === 'number' ? value : null;
    case 'boolean':
      return value === true || value === 1;
    case 'date': {
      if (typeof value !== 'string') return null;
      if (ISO_DATE_RE.test(value)) return new FormulaDate(Date.parse(`${value}T00:00:00Z`), true);
      if (ISO_INSTANT_RE.test(value)) return new FormulaDate(Date.parse(value));
      return value;
    }
    case 'array': {
      const p = def.toPrimitive(value as never, field.options);
      if (Array.isArray(p)) return p.filter((s) => s !== '');
      const text = def.format(value as never, field.options);
      return text === '' ? [] : [text];
    }
    default: {
      if (typeof value === 'number' || typeof value === 'boolean') return value;
      const text = def.format(value as never, field.options);
      return text === '' ? null : text;
    }
  }
}
