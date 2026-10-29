import {
  type Choice,
  computedSourceOf,
  conversionOptions,
  convertValue,
  FIELD_TYPE_NAMES,
  type FieldCategory,
  type FieldMeta,
  type FieldTypeName,
  getFieldType,
  nextChoiceColor,
  type RollupFunction,
} from '@openrows/shared';

// Type-neutral logic of the field management UI. Everything type-specific comes from the
// field-type registry (labels, categories, option schemas, `convertValue`), never `field.type`.

export const CATEGORY_LABELS: Record<FieldCategory, string> = {
  basic: 'Basic',
  choice: 'Choice',
  contact: 'Contact',
  people: 'People & links',
  computed: 'Computed',
};

const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS) as FieldCategory[];

export type TypeGroup = { category: FieldCategory; label: string; types: FieldTypeName[] };

/** The type picker's groups, in registry order, filtered by a case-insensitive label search. */
export function typeGroups(search = '', exclude: readonly FieldTypeName[] = []): TypeGroup[] {
  const q = search.trim().toLowerCase();
  return CATEGORY_ORDER.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    types: FIELD_TYPE_NAMES.filter((t) => {
      const def = getFieldType(t);
      return (
        def.category === category &&
        !exclude.includes(t) &&
        // Only a table's sync adds a "Sync source" field.
        t !== 'syncSource' &&
        (!q || def.label.toLowerCase().includes(q))
      );
    }),
  })).filter((g) => g.types.length > 0);
}

/** A type's default options (`optionsSchema.parse({})`). */
export function defaultOptions(type: FieldTypeName): Record<string, unknown> {
  return getFieldType(type).optionsSchema.parse({}) as Record<string, unknown>;
}

/** Options parsed for `type`, or its defaults when they don't parse. */
export function parseOptions(type: FieldTypeName, options: unknown): Record<string, unknown> {
  const parsed = getFieldType(type).optionsSchema.safeParse(options ?? {});
  return parsed.success ? (parsed.data as Record<string, unknown>) : defaultOptions(type);
}

/**
 * Options after switching to `type`: the keys the new type shares with the old options carry
 * over when they are valid for it (choices between the two selects, precision between number
 * types), the rest are the new type's defaults.
 */
export function optionsForType(
  type: FieldTypeName,
  previous: Record<string, unknown>
): Record<string, unknown> {
  const defaults = defaultOptions(type);
  const schema = getFieldType(type).optionsSchema;
  const merged: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(defaults)) {
    if (!(key in previous)) continue;
    const attempt = { ...merged, [key]: previous[key] };
    if (schema.safeParse(attempt).success) merged[key] = previous[key];
  }
  return merged;
}

/**
 * What a lookup, rollup or count still needs before it can be saved: the link field, and
 * for a lookup or rollup the field of the linked table. The options schema allows them empty
 * (its defaults), the server doesn't. `null` when nothing is missing or the type isn't one.
 */
export function missingComputedOption(
  type: FieldTypeName,
  options: Record<string, unknown>
): string | null {
  const source = computedSourceOf(type, options);
  if (!source) return null;
  if (!source.linkFieldId) return 'Pick a linked record field';
  if ('fieldIdInLinkedTable' in defaultOptions(type) && !source.sourceFieldId) {
    return 'Pick a field of the linked table';
  }
  return null;
}

/** Rollup aggregations, with what they compute; numbers take a precision. */
export const ROLLUP_LABELS: Record<RollupFunction, string> = {
  SUM: 'Sum',
  AVG: 'Average',
  MIN: 'Minimum',
  MAX: 'Maximum',
  COUNT: 'Count numbers',
  COUNTA: 'Count non-empty values',
  COUNTALL: 'Count all values',
  AND: 'All true',
  OR: 'Any true',
  XOR: 'An odd number true',
  ARRAYJOIN: 'Join with a separator',
  ARRAYUNIQUE: 'Unique values',
  ARRAYCOMPACT: 'Non-empty values',
  CONCATENATE: 'Concatenate',
};

/** Rollups whose result is a rounded number, so "Decimal places" applies. */
export const ROUNDED_ROLLUPS: ReadonlySet<string> = new Set(['SUM', 'AVG', 'MIN', 'MAX']);

/** The message of a failed save: the server's 422 problems when it lists them. */
export function problemMessages(data: unknown): string[] {
  const errors = (data as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors)) return [];
  return errors.flatMap((e) =>
    typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string'
      ? [(e as { message: string }).message]
      : []
  );
}

export function sameOptions(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

type Typed = { type: FieldTypeName; options: unknown };

function isEmpty(value: unknown, type: FieldTypeName): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  return value === getFieldType(type).emptyValue;
}

function display(value: unknown, field: Typed): string {
  if (value === null || value === undefined) return '';
  const def = getFieldType(field.type);
  try {
    return def.format(def.coerce(value, field.options), field.options);
  } catch {
    return String(value);
  }
}

export type ConversionExample = { before: string; after: string; cleared: boolean };

export type ConversionPreview = {
  /** Non-empty values looked at. */
  sampled: number;
  /** Non-empty values that would become empty. */
  cleared: number;
  /** Values that would stay non-empty but read differently (rounding, dropped choices…). */
  changed: number;
  /** Up to `limit` before → after pairs, the lossy ones first. */
  examples: ConversionExample[];
  /** The target is computed: it fills its own values and the stored ones are discarded. */
  computedTarget: boolean;
};

/**
 * How a type or options change would convert `values` (the field's current cell values), with
 * the registry's `convertValue`, the same rule the server applies.
 */
export function conversionPreview(
  from: Typed,
  to: Typed,
  values: readonly unknown[],
  limit = 5
): ConversionPreview {
  const source = { type: from.type, options: parseOptions(from.type, from.options) };
  // Into a select, the server adds an option for every value the choices can't hold.
  const toOptions = conversionOptions(values, source, {
    type: to.type,
    options: parseOptions(to.type, to.options),
  });
  const target = { type: to.type, options: toOptions };
  const computedTarget = getFieldType(to.type).readOnly;
  let sampled = 0;
  let cleared = 0;
  let changed = 0;
  const lossy: ConversionExample[] = [];
  const kept: ConversionExample[] = [];
  for (const value of values) {
    if (isEmpty(value, from.type)) continue;
    sampled += 1;
    const before = display(value, source);
    if (computedTarget) {
      cleared += 1;
      if (lossy.length < limit) lossy.push({ before, after: '', cleared: true });
      continue;
    }
    const converted = convertValue(value, source, target);
    const after = isEmpty(converted, to.type) ? '' : display(converted, target);
    if (after === '') {
      cleared += 1;
      if (lossy.length < limit) lossy.push({ before, after, cleared: true });
    } else if (after !== before && JSON.stringify(converted) !== JSON.stringify(value)) {
      // A new display of the same value (3.00 shown as 3) isn't a change of the data.
      changed += 1;
      if (lossy.length < limit) lossy.push({ before, after, cleared: false });
    } else if (kept.length < limit) {
      kept.push({ before, after, cleared: false });
    }
  }
  return {
    sampled,
    cleared,
    changed,
    examples: [...lossy, ...kept].slice(0, limit),
    computedTarget,
  };
}

/** Whether a name is used by another field of the table (case-insensitive, like the server). */
export function nameTaken(name: string, fields: readonly FieldMeta[], exceptId?: string): boolean {
  const n = name.trim().toLowerCase();
  return fields.some((f) => f.id !== exceptId && f.name.toLowerCase() === n);
}

/** "Name copy", then "Name copy 2", … : the first one no other field uses. */
export function copyName(name: string, fields: readonly FieldMeta[]): string {
  const base = `${name} copy`;
  if (!nameTaken(base, fields)) return base;
  for (let i = 2; ; i++) if (!nameTaken(`${base} ${i}`, fields)) return `${base} ${i}`;
}

export type Side = 'left' | 'right';

/**
 * Table `position` for a field inserted next to `anchorId` (between it and its neighbour in
 * table order), so other views without a saved order show it there too.
 */
export function insertPosition(fields: readonly FieldMeta[], anchorId: string, side: Side) {
  const sorted = [...fields].sort((a, b) => a.position - b.position);
  const i = sorted.findIndex((f) => f.id === anchorId);
  const anchor = sorted[i];
  if (!anchor) return (sorted.at(-1)?.position ?? 0) + 1;
  const neighbour = sorted[side === 'left' ? i - 1 : i + 1];
  if (!neighbour) return anchor.position + (side === 'left' ? -1 : 1);
  return (anchor.position + neighbour.position) / 2;
}

/** A view's field order with `newId` placed next to `anchorId`. */
export function insertIntoOrder(
  order: readonly string[],
  newId: string,
  anchorId: string,
  side: Side
): string[] {
  const out = order.filter((id) => id !== newId);
  const i = out.indexOf(anchorId);
  if (i < 0) return [...out, newId];
  out.splice(side === 'left' ? i : i + 1, 0, newId);
  return out;
}

// Select choices.

/** A new choice id (`sel` + 12 hex digits, the server's shape for default choices). */
export function newChoiceId(): string {
  return `sel${crypto.randomUUID().replaceAll('-', '').slice(-12)}`;
}

/** Adds a choice with the next palette colour. */
export function addChoice(choices: readonly Choice[], name: string): Choice[] {
  return [...choices, { id: newChoiceId(), name, color: nextChoiceColor(choices.length) }];
}

export function updateChoice(
  choices: readonly Choice[],
  id: string,
  patch: Partial<Omit<Choice, 'id'>>
): Choice[] {
  return choices.map((c) => (c.id === id ? { ...c, ...patch } : c));
}

export function removeChoice(choices: readonly Choice[], id: string): Choice[] {
  return choices.filter((c) => c.id !== id);
}

/** Moves the choice at `from` to `to` (clamped). */
export function moveChoice(choices: readonly Choice[], from: number, to: number): Choice[] {
  const out = [...choices];
  const [moved] = out.splice(from, 1);
  if (!moved) return out;
  out.splice(Math.max(0, Math.min(out.length, to)), 0, moved);
  return out;
}

/** Choices ready to save: names trimmed, empty ones dropped. */
export function cleanChoices(choices: readonly Choice[]): Choice[] {
  return choices.map((c) => ({ ...c, name: c.name.trim() })).filter((c) => c.name !== '');
}
