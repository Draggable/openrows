import { z } from 'zod';
import type { FieldTypeDef, FormatContext, Primitive } from './types.js';
import { MAX_NUMBER, roundTo } from './util.js';

/**
 * Lookup, rollup and count: fields computed from the records a link field of the same
 * table links to. The server's recompute engine (packages/server/src/data/computed/) reads the
 * linked records' values and calls the pure functions below, then stores the result in the
 * field's own column, so the query engine sorts and filters it like any other column.
 */

/** Longest text a lookup item or a text rollup result keeps. */
export const MAX_COMPUTED_TEXT = 100_000;

/** Most items one lookup cell keeps (the first ones, in link order). */
export const MAX_LOOKUP_ITEMS = 10_000;

/** Airtable's rollup aggregation functions (the formula over `values`). */
export const ROLLUP_FUNCTIONS = [
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'COUNT',
  'COUNTA',
  'COUNTALL',
  'AND',
  'OR',
  'XOR',
  'ARRAYJOIN',
  'ARRAYUNIQUE',
  'ARRAYCOMPACT',
  'CONCATENATE',
] as const;

export type RollupFunction = (typeof ROLLUP_FUNCTIONS)[number];

/** The link field (of the same table) a computed field reads through. */
const linkFieldId = z.uuid().nullable().default(null);

export const lookupOptionsSchema = z
  .object({
    recordLinkFieldId: linkFieldId,
    /** The field of the linked table whose values are looked up. */
    fieldIdInLinkedTable: z.uuid().nullable().default(null),
  })
  .strict();

export const rollupOptionsSchema = z
  .object({
    recordLinkFieldId: linkFieldId,
    fieldIdInLinkedTable: z.uuid().nullable().default(null),
    function: z.enum(ROLLUP_FUNCTIONS).default('SUM'),
    /** ARRAYJOIN's separator. */
    separator: z.string().max(100).default(', '),
    /** Decimals of a number result (`null`: as computed, up to 8). */
    precision: z.int().min(0).max(8).nullable().default(null),
  })
  .strict();

export const countOptionsSchema = z.object({ recordLinkFieldId: linkFieldId }).strict();

export type LookupOptions = z.infer<typeof lookupOptionsSchema>;
export type RollupOptions = z.infer<typeof rollupOptionsSchema>;
export type CountOptions = z.infer<typeof countOptionsSchema>;

/** The fields a computed field's options name (the dependency graph's edges). */
export interface ComputedSource {
  /** The link field of the same table. */
  linkFieldId: string | null;
  /** The field of the linked table it reads (`null` for count). */
  sourceFieldId: string | null;
}

/** A field's linked source when its type is computed from links (lookup, rollup, count). */
export function computedSourceOf(type: string, options: unknown): ComputedSource | null {
  if (type !== 'lookup' && type !== 'rollup' && type !== 'count') return null;
  const o = (options ?? {}) as Partial<LookupOptions>;
  return {
    linkFieldId: typeof o.recordLinkFieldId === 'string' ? o.recordLinkFieldId : null,
    sourceFieldId:
      type !== 'count' && typeof o.fieldIdInLinkedTable === 'string'
        ? o.fieldIdInLinkedTable
        : null,
  };
}

/** A field of the linked table as the functions below read it. */
export interface SourceField {
  def: FieldTypeDef;
  options: unknown;
}

const clip = (text: string) =>
  text.length > MAX_COMPUTED_TEXT ? text.slice(0, MAX_COMPUTED_TEXT) : text;

/**
 * The items one linked record's value contributes to a lookup: each item of a list value
 * (multiple select names, link names, attachment file names, another lookup's items), else
 * the value's display text. Empty values contribute nothing.
 */
export function lookupItems(source: SourceField, value: unknown, ctx?: FormatContext): string[] {
  if (value === null || value === undefined || value === source.def.emptyValue) return [];
  const primitive = source.def.toPrimitive(value, source.options);
  if (Array.isArray(primitive)) return primitive.filter((s) => s !== '').map(clip);
  const text = source.def.format(value, source.options, ctx);
  return text === '' ? [] : [clip(text)];
}

/** A lookup cell: the linked records' items in link order (first MAX_LOOKUP_ITEMS), or empty. */
export function lookupValue(
  source: SourceField,
  values: readonly unknown[],
  ctx?: FormatContext
): string[] | null {
  const out: string[] = [];
  for (const v of values) {
    for (const item of lookupItems(source, v, ctx)) {
      if (out.length >= MAX_LOOKUP_ITEMS) return out;
      out.push(item);
    }
  }
  return out.length ? out : null;
}

/** One rollup input: a scalar, or `null` for an empty linked value. */
export type RollupItem = string | number | boolean | null;

/**
 * The `values` a rollup aggregates: one item per linked record, list values flattened (as
 * Airtable flattens a multiple select or a lookup), empty values kept as `null` (COUNTALL
 * counts them). Numbers stay numbers; other scalars are their primitive (dates as ISO text).
 */
export function rollupItems(source: SourceField, values: readonly unknown[]): RollupItem[] {
  const out: RollupItem[] = [];
  for (const v of values) {
    const p: Primitive =
      v === null || v === undefined ? null : source.def.toPrimitive(v, source.options);
    if (Array.isArray(p)) {
      if (p.length === 0) out.push(null);
      for (const item of p) out.push(lookupNumber(source, item));
    } else {
      out.push(p === '' ? null : p);
    }
  }
  return out;
}

/** A lookup's items are display text: numeric ones roll up as numbers. */
function lookupNumber(source: SourceField, item: string): RollupItem {
  if (source.def.name !== 'lookup' && source.def.name !== 'rollup') return item;
  const n = Number(item.replace(/,/g, ''));
  return item.trim() !== '' && Number.isFinite(n) ? n : item;
}

const isNumber = (x: RollupItem): x is number => typeof x === 'number' && Number.isFinite(x);
const truthy = (x: RollupItem) => x !== null && x !== false && x !== 0 && x !== '';
const asText = (x: RollupItem) =>
  x === null ? '' : x === true ? '1' : x === false ? '0' : String(x);

function finish(n: number, precision: number | null): number | null {
  if (!Number.isFinite(n) || Math.abs(n) > MAX_NUMBER) return null;
  const rounded = roundTo(n, precision ?? 8);
  return rounded === null ? null : rounded === 0 ? 0 : rounded;
}

/**
 * A rollup's result over its items (Airtable semantics): SUM of no numbers is 0, AVG/MIN/MAX of
 * none are empty; COUNT counts numbers, COUNTA non-empty values, COUNTALL every value; AND, OR
 * and XOR give 1 or 0; the ARRAY functions and CONCATENATE give text (lists joined with the
 * separator, ", " by default).
 */
export function rollupValue(
  items: readonly RollupItem[],
  o: RollupOptions
): number | string | null {
  const numbers = items.filter(isNumber);
  switch (o.function) {
    case 'SUM':
      return finish(
        numbers.reduce((a, b) => a + b, 0),
        o.precision
      );
    case 'AVG':
      return numbers.length
        ? finish(numbers.reduce((a, b) => a + b, 0) / numbers.length, o.precision)
        : null;
    case 'MIN':
      return numbers.length ? finish(Math.min(...numbers), o.precision) : null;
    case 'MAX':
      return numbers.length ? finish(Math.max(...numbers), o.precision) : null;
    case 'COUNT':
      return numbers.length;
    case 'COUNTA':
      return items.filter((x) => x !== null && x !== '').length;
    case 'COUNTALL':
      return items.length;
    case 'AND':
      return items.length > 0 && items.every(truthy) ? 1 : 0;
    case 'OR':
      return items.some(truthy) ? 1 : 0;
    case 'XOR':
      return items.filter(truthy).length % 2 === 1 ? 1 : 0;
    case 'ARRAYJOIN':
      return text(items.map(asText).join(o.separator));
    case 'ARRAYCOMPACT':
      return text(
        items
          .filter((x) => x !== null && x !== '')
          .map(asText)
          .join(', ')
      );
    case 'ARRAYUNIQUE':
      return text([...new Set(items.filter((x) => x !== null).map(asText))].join(', '));
    case 'CONCATENATE':
      return text(items.map(asText).join(''));
  }
}

const text = (s: string) => (s === '' ? null : clip(s));
