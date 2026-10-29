import {
  type BarcodeType,
  type Choice,
  type EditorKind,
  type FieldMeta,
  type FieldTypeDef,
  getFieldType,
  type Primitive,
} from '@openrows/shared';

// Type-neutral helpers the grid cells use. Everything type-specific comes from the field-type
// registry (`def.editor.kind`, `coerce`, `format`), never from `field.type`.

/** The field's type definition and parsed options (defaults when the options don't parse). */
export function fieldDef(field: FieldMeta): { def: FieldTypeDef; options: unknown } {
  const def = getFieldType(field.type);
  const parsed = def.optionsSchema.safeParse(field.options ?? {});
  return { def, options: parsed.success ? parsed.data : def.optionsSchema.parse({}) };
}

/** Display text of a value through the field-type registry. */
export function cellText(field: FieldMeta, value: unknown): string {
  if (value === null || value === undefined) return '';
  const { def, options } = fieldDef(field);
  try {
    return def.format(def.coerce(value, options as never), options as never);
  } catch {
    return String(value);
  }
}

/** The editor a user can open on the field's cells; `none` for read-only and computed fields. */
export function editorKind(field: FieldMeta): EditorKind {
  const { def } = fieldDef(field);
  if (def.readOnly || def.computed) return 'none';
  return def.editor.kind;
}

/** Editor kinds edited with a single-line input inside the cell. */
export const INLINE_TEXT_EDITORS: ReadonlySet<EditorKind> = new Set([
  'text',
  'number',
  'duration',
  'email',
  'url',
  'phone',
]);

/** The stored value of what the user typed, `null` when it can't be read. */
export function parseInput(field: FieldMeta, text: string): unknown {
  const { def, options } = fieldDef(field);
  if (text.trim() === '') return null;
  return def.coerce(text, options as never);
}

/** The value through the registry's `coerce` (`null` when unreadable or empty). */
export function coerceValue(field: FieldMeta, input: unknown): unknown {
  if (input === null || input === undefined) return null;
  const { def, options } = fieldDef(field);
  try {
    return def.coerce(input, options as never);
  } catch {
    return null;
  }
}

/** Two cell values are the same write (`undefined` counts as empty). */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The choices of a select field (empty for other types). */
export function choicesOf(field: FieldMeta): Choice[] {
  const { options } = fieldDef(field);
  const choices = (options as { choices?: unknown }).choices;
  return Array.isArray(choices) ? (choices as Choice[]) : [];
}

/** The selected choice ids of a select value (one for single select). */
export function selectedIds(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** "Invalid" message for text that a field can't read. */
export function invalidMessage(field: FieldMeta, text: string): string {
  return `"${text}" isn't a valid ${fieldDef(field).def.label.toLowerCase()}`;
}

/** The type-neutral form of a value (`toPrimitive`), what another field's `coerce` reads. */
export function cellPrimitive(field: FieldMeta, value: unknown): Primitive {
  if (value === null || value === undefined) return null;
  const { def, options } = fieldDef(field);
  try {
    return def.toPrimitive(def.coerce(value, options as never), options as never);
  } catch {
    return null;
  }
}

/** One linked record as a cell shows it. */
export type LinkCellItem = { id: string; name: string };

/**
 * The linked records of a link value, `{ id, name }` each. A value the server hasn't answered
 * yet (names pasted or typed, before the write comes back) shows its names.
 */
export function linkItems(value: unknown): LinkCellItem[] {
  const items = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  return items.flatMap((item, i): LinkCellItem[] => {
    if (typeof item === 'string') return item.trim() ? [{ id: `pending-${i}`, name: item }] : [];
    if (typeof item !== 'object' || item === null || !('id' in item)) return [];
    const { id, name } = item as { id: unknown; name?: unknown };
    return typeof id === 'string' ? [{ id, name: typeof name === 'string' ? name : '' }] : [];
  });
}

/** Symbology names as scanners and labels print them. */
export const BARCODE_TYPE_LABELS: Record<BarcodeType, string> = {
  ean13: 'EAN-13',
  ean8: 'EAN-8',
  upca: 'UPC-A',
  upce: 'UPC-E',
  code128: 'Code 128',
  code39: 'Code 39',
  itf: 'ITF',
  qr: 'QR code',
  dataMatrix: 'Data Matrix',
};
