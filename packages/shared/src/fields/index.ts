// The field-type registry: one module per type in `types/`, listed once in `FIELD_TYPE_DEFS`.
// Everything that depends on a field's type (validation, coercion, storage, sorting, filtering,
// display, conversion, the cell editor) reads it from here.

import { MAX_CHOICE_NAME, MAX_CHOICES } from './choices.js';
import { ai } from './types/ai.js';
import { attachment } from './types/attachment.js';
import { autoNumber } from './types/auto-number.js';
import { barcode } from './types/barcode.js';
import { button } from './types/button.js';
import { checkbox } from './types/checkbox.js';
import { count } from './types/count.js';
import { createdBy } from './types/created-by.js';
import { createdTime } from './types/created-time.js';
import { currency } from './types/currency.js';
import { date } from './types/date.js';
import { dateTime } from './types/date-time.js';
import { duration } from './types/duration.js';
import { email } from './types/email.js';
import { formula } from './types/formula.js';
import { lastModifiedBy } from './types/last-modified-by.js';
import { lastModifiedTime } from './types/last-modified-time.js';
import { link } from './types/link.js';
import { longText } from './types/long-text.js';
import { lookup } from './types/lookup.js';
import { multipleSelect } from './types/multiple-select.js';
import { number } from './types/number.js';
import { percent } from './types/percent.js';
import { phone } from './types/phone.js';
import { rating } from './types/rating.js';
import { rollup } from './types/rollup.js';
import { singleLineText } from './types/single-line-text.js';
import { singleSelect } from './types/single-select.js';
import { syncSource } from './types/sync-source.js';
import { url } from './types/url.js';
import { user } from './types/user.js';
import type { ApiValueContext, FieldTypeDef, FormatContext } from './types.js';

/** Every field type, in field-type-picker order. */
export const FIELD_TYPE_DEFS = {
  singleLineText,
  longText,
  number,
  currency,
  percent,
  checkbox,
  date,
  dateTime,
  duration,
  rating,
  singleSelect,
  multipleSelect,
  email,
  url,
  phone,
  barcode,
  link,
  lookup,
  rollup,
  count,
  formula,
  ai,
  button,
  attachment,
  autoNumber,
  createdTime,
  lastModifiedTime,
  user,
  createdBy,
  lastModifiedBy,
  syncSource,
} as const;

export type FieldTypeName = keyof typeof FIELD_TYPE_DEFS;

export const FIELD_TYPE_NAMES = Object.keys(FIELD_TYPE_DEFS) as FieldTypeName[];

export function isFieldTypeName(name: unknown): name is FieldTypeName {
  return typeof name === 'string' && Object.hasOwn(FIELD_TYPE_DEFS, name);
}

/** The definition of a type, with options and values erased (parse options first). */
export function getFieldType(name: FieldTypeName): FieldTypeDef {
  return FIELD_TYPE_DEFS[name] as FieldTypeDef;
}

/**
 * The options of a field that a public share link shows: parsed (defaults applied, `{}`
 * when unreadable) and narrowed by the type's `publicOptions`.
 */
export function publicFieldOptions(name: FieldTypeName, options: unknown): unknown {
  const def = getFieldType(name);
  const parsed = def.optionsSchema.safeParse(options ?? {});
  if (!parsed.success) return {};
  return def.publicOptions ? def.publicOptions(parsed.data) : parsed.data;
}

/** A field's type with its parsed options. */
export interface TypedField {
  type: FieldTypeName;
  /** Parsed through the type's `optionsSchema` (defaults applied). */
  options: unknown;
}

/**
 * Converts a cell value from one field type to another (a field type change). Never throws;
 * whatever the target can't read becomes its empty value, so lossy conversions give empty cells,
 * not garbage. Between types, the source's `toPrimitive` (or display text, for text targets)
 * feeds the target's `coerce`. Read-only targets (computed fields) always give empty: their
 * values are derived.
 */
export function convertValue(
  value: unknown,
  from: TypedField,
  to: TypedField,
  ctx?: FormatContext
): unknown {
  const target = getFieldType(to.type);
  if (target.readOnly) return target.emptyValue;
  try {
    // Same type, new options (precision, choices, time zone): the value re-coerces as it is.
    if (from.type === to.type) return target.coerce(value, to.options);
    return target.coerce(conversionInput(value, from, to, ctx), to.options);
  } catch {
    return target.emptyValue;
  }
}

/** What a type change feeds the target's `coerce`: the source's primitive or display text. */
function conversionInput(value: unknown, from: TypedField, to: TypedField, ctx?: FormatContext) {
  const source = getFieldType(from.type);
  return getFieldType(to.type).conversionInput === 'display'
    ? source.format(value, from.options, ctx) || null
    : source.toPrimitive(value, from.options);
}

/**
 * The target options of a type change into a choice type: `to.options` plus one new choice
 * for every distinct value the conversion would otherwise drop (first occurrence first, names
 * longer than MAX_CHOICE_NAME skipped, up to MAX_CHOICES in all), so converting a text field to
 * a select keeps its values. Other targets, and option changes within a type, keep `to.options`.
 */
export function conversionOptions(
  values: Iterable<unknown>,
  from: TypedField,
  to: TypedField,
  ctx?: FormatContext
): unknown {
  const target = getFieldType(to.type);
  if (from.type === to.type || !target.unknownChoices || !target.withChoices) return to.options;
  const existing = (to.options as { choices?: unknown[] }).choices?.length ?? 0;
  const room = MAX_CHOICES - existing;
  const seen = new Set<string>();
  const names: string[] = [];
  for (const value of values) {
    if (names.length >= room) break;
    let unknown: string[];
    try {
      unknown = target.unknownChoices(conversionInput(value, from, to, ctx), to.options);
    } catch {
      continue;
    }
    for (const name of unknown) {
      const key = name.toLowerCase();
      if (name.length > MAX_CHOICE_NAME || seen.has(key) || names.length >= room) continue;
      seen.add(key);
      names.push(name);
    }
  }
  return names.length ? target.withChoices(to.options, names) : to.options;
}

export * from './ai.js';
export * from './choices.js';
export * from './collaborators.js';
export * from './computed.js';
export {
  DATE_FORMATS,
  type DateFormat,
  instantInZone,
  isValidTimeZone,
  parseInstant,
  TIME_FORMATS,
  type TimeFormat,
} from './datetime.js';
export * from './markdown.js';
export { type AttachmentValue, attachmentValueSchema } from './types/attachment.js';
export {
  BARCODE_TYPES,
  type BarcodeType,
  type BarcodeValue,
  barcodeValueSchema,
  guessBarcodeType,
  isValidBarcode,
} from './types/barcode.js';
export {
  BUTTON_ACTIONS,
  type ButtonAction,
  type ButtonOptions,
  buttonOptionsSchema,
  FORMULA_FIELD_TYPES,
  hasFormula,
} from './types/button.js';
export type { DurationFormat } from './types/duration.js';
export { DURATION_FORMATS } from './types/duration.js';
export { type FormulaOptions, formulaOptionsSchema } from './types/formula.js';
export {
  isRecordId,
  type LinkItem,
  type LinkOptions,
  type LinkValue,
  linkItemSchema,
  linkName,
  linkOptionsSchema,
  MAX_LINKS_PER_CELL,
} from './types/link.js';
export { MAX_SYNC_KEY_LENGTH } from './types/sync-source.js';
export {
  MAX_USERS_PER_CELL,
  type UserOptions,
  userOptionsSchema,
} from './types/user.js';
export * from './types.js';

/** A field's type name in the public REST API: Airtable's where they differ. */
export function apiTypeOf(field: TypedField): string {
  const def = getFieldType(field.type);
  return def.apiType ? def.apiType(field.options) : def.name;
}

/** A cell as the public REST API shows it, `null` when empty. */
export function apiValueOf(field: TypedField, value: unknown, ctx: ApiValueContext): unknown {
  const def = getFieldType(field.type);
  if (value === null || value === undefined || value === def.emptyValue) return null;
  return def.apiValue ? def.apiValue(value, field.options, ctx) : value;
}

/**
 * The field type a REST API caller names: ours (`link`) or Airtable's for the type's
 * default options (`multipleRecordLinks`). Null when it's neither.
 */
export function fieldTypeForApi(name: string): FieldTypeName | null {
  if (isFieldTypeName(name)) return name;
  return (
    FIELD_TYPE_NAMES.find((t) => {
      const def = getFieldType(t);
      return def.apiType?.(def.optionsSchema.parse({})) === name;
    }) ?? null
  );
}
