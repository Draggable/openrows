import type { z } from 'zod';
import type { FormulaType } from '../formula/functions.js';

/**
 * Postgres column type of a field's physical column (ADR-001), as data. The DDL manager in the
 * server turns it into SQL; nothing here talks to a database.
 */
export type SqlColumnType =
  | 'text'
  | 'text[]'
  | 'numeric'
  | 'smallint'
  | 'bigint'
  | 'boolean'
  | 'date'
  | 'timestamptz'
  | 'uuid'
  | 'jsonb';

/** The record table's system columns (ADR-001) that computed fields read. */
export type SystemColumn = 'created_at' | 'updated_at' | 'created_by' | 'updated_by';

/**
 * Where a field's value lives:
 * - `column`: its own `f_<field id>` column of `sqlType`;
 * - `identity`: its own `bigint GENERATED ALWAYS AS IDENTITY` column (autonumber);
 * - `system`: no column of its own, it reads a system column;
 * - `link`: no column of its own, the links live in a junction table (`l_<field id hex>`, shared
 *   with the inverse field); reads aggregate them into a `jsonb` array of `{ id, name }`;
 * - `computed`: its own `f_<field id>` column of `sqlType`, written only by the server's
 *   recompute engine (lookup, rollup, count) or the AI field worker (`generated`),
 *   never from input, so it sorts and filters like any column.
 */
export type FieldStorage =
  | {
      kind: 'column';
      sqlType: SqlColumnType;
      /** A `text[]` of user ids (the user field): filters match ids, sorts read names. */
      items?: 'userIds';
      /** A `jsonb` object whose `textKey` is its text for filters, search and sorting. */
      textKey?: string;
    }
  | {
      kind: 'computed';
      sqlType: SqlColumnType;
      /**
       * Written by the server from outside the record (an AI field's answers), not derived
       * again from the record: snapshots, restores and duplicates copy its values.
       */
      generated?: boolean;
    }
  | { kind: 'link'; sqlType: 'jsonb' }
  | { kind: 'identity'; sqlType: 'bigint' }
  | { kind: 'system'; column: SystemColumn; sqlType: SqlColumnType };

/** Airtable's filter operators. Each field type lists the ones it supports. */
export const FILTER_OPERATORS = [
  'is',
  'isNot',
  'contains',
  'doesNotContain',
  'isEmpty',
  'isNotEmpty',
  '=',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'isBefore',
  'isAfter',
  'isOnOrBefore',
  'isOnOrAfter',
  'isWithin',
  'isAnyOf',
  'isNoneOf',
  'hasAnyOf',
  'hasAllOf',
  'hasNoneOf',
  'isExactly',
] as const;

export type FilterOperator = (typeof FILTER_OPERATORS)[number];

/**
 * How the query engine orders a field. `choiceOrder` sorts by the option's position in
 * `choices` (multi-select: by its first choice), `none` means the field can't be sorted.
 * Empty values sort first ascending, as in Airtable.
 */
export type SortKind = 'text' | 'number' | 'boolean' | 'chronological' | 'choiceOrder' | 'none';

/** The cell editor the client should mount. `none` means read-only (computed) cells. */
export type EditorKind =
  | 'text'
  | 'longText'
  | 'number'
  | 'checkbox'
  | 'date'
  | 'dateTime'
  | 'duration'
  | 'rating'
  | 'singleSelect'
  | 'multipleSelect'
  | 'email'
  | 'url'
  | 'phone'
  | 'attachment'
  | 'link'
  | 'user'
  | 'barcode'
  | 'button'
  | 'none';

export interface EditorHint {
  kind: EditorKind;
  align: 'left' | 'right' | 'center';
  /** Default grid column width in px (docs/design/DESIGN.md). */
  width: number;
}

/** Groups in the field-type picker (DESIGN.md "Field config popover"). */
export type FieldCategory = 'basic' | 'choice' | 'contact' | 'people' | 'computed';

/** Display context. `locale` defaults to `en-US`. */
export interface FormatContext {
  locale?: string;
  /** Resolves a user id to a display name (createdBy, lastModifiedBy, user). */
  userName?: (userId: string) => string | undefined;
}

/**
 * A plain, type-neutral form of a value that other types' `coerce` understand. Conversions go
 * `from.toPrimitive` → `to.coerce`. Dates and datetimes are ISO strings (datetimes carry their
 * field's UTC offset, so a date conversion keeps the local day).
 */
export type Primitive = string | number | boolean | string[] | null;

/** What a driver sends to or gets from the column. JSON for `jsonb`. */
export type StorageValue =
  | string
  | number
  | boolean
  | string[]
  | readonly unknown[]
  | { readonly [key: string]: unknown }
  | null;

/** What the public REST API needs to show a cell in Airtable's format. */
export interface ApiValueContext {
  /** A person as Airtable's collaborator object (`{ id, email, name }`). */
  user(id: string): { id: string; email?: string; name?: string };
  /** Where an API caller downloads a file of the record's table. */
  fileUrl(attachmentId: string): string;
}

/**
 * One field type. `O` is the parsed options type (defaults applied: always pass options through
 * `optionsSchema.parse` first), `V` the non-empty value type. Empty is `null`, except where
 * `emptyValue` says otherwise (checkbox: `false`).
 *
 * The methods are declared as methods (not function properties) on purpose: that keeps every
 * `FieldTypeDef<O, V>` assignable to the erased `FieldTypeDef` the registry hands out.
 */
export interface FieldTypeDef<O = unknown, V = unknown> {
  readonly name: string;
  readonly label: string;
  readonly category: FieldCategory;
  /** Options with defaults: `optionsSchema.parse({})` gives a valid default config. */
  readonly optionsSchema: z.ZodType<O>;
  readonly storage: FieldStorage;
  readonly filterOperators: readonly FilterOperator[];
  readonly sort: SortKind;
  /** The type a formula sees when it references the field. */
  readonly formulaType: FormulaType;
  readonly editor: EditorHint;
  /** Users can't write it (system-generated or computed). */
  readonly readOnly: boolean;
  /** The value is derived (system columns, identity), not stored from input. */
  readonly computed: boolean;
  /**
   * What a conversion into this type feeds `coerce`: the source's `toPrimitive` value, or its
   * display text (`format`, as Airtable does when converting to text).
   */
  readonly conversionInput: 'primitive' | 'display';
  /** The empty value: `null` for every type except checkbox. */
  readonly emptyValue: V | null;

  /** Schema of a non-empty value under these options. */
  valueSchema(options: O): z.ZodType<V>;
  /**
   * Turns user or API input (or another type's primitive) into a valid value, or the empty value
   * when it can't be read. Never throws, and `coerce(coerce(x)) === coerce(x)`.
   */
  coerce(input: unknown, options: O): V | null;
  /** Value → column value. `fromStorage(toStorage(v))` round-trips. */
  toStorage(value: V | null, options: O): StorageValue;
  /** Column value (as a Postgres driver returns it) → value. Never throws. */
  fromStorage(raw: unknown, options: O): V | null;
  /** Total order for client-side sorting; empty first. */
  compare(a: V | null, b: V | null, options: O): number;
  /** Display text for a cell. Empty is `''`. */
  format(value: V | null, options: O, ctx?: FormatContext): string;
  /** Type-neutral form used to convert to another type. */
  toPrimitive(value: V | null, options: O): Primitive;
  /**
   * Choice types only (Airtable's `typecast`): the names in `input` that `coerce` would
   * not match, trimmed, deduplicated case-insensitively, first occurrence first.
   */
  unknownChoices?(input: unknown, options: O): string[];
  /** Choice types only: `options` with `names` appended as new choices. */
  withChoices?(options: O, names: readonly string[]): O;
  /**
   * The options a public share link may show, enough to display values. Default: all of
   * them. Types whose options name other tables or fields, or hold a formula, leave those out.
   */
  publicOptions?(options: O): Partial<O>;
  /**
   * The type's name in the public REST API: Airtable's (`multipleRecordLinks`,
   * `phoneNumber`, ...). Default: `name`.
   */
  apiType?(options: O): string;
  /**
   * A non-empty value as the public REST API shows it (Airtable's `cellFormat=json`):
   * choice names, linked record ids, collaborator objects, files with a URL. Default: the value.
   */
  apiValue?(value: V, options: O, ctx: ApiValueContext): unknown;
}
