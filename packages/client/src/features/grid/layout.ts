import {
  type FieldMeta,
  type GridLayout,
  getFieldType,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  ROW_HEIGHTS,
} from '@openrows/shared';

/** The row-number gutter (DESIGN.md §5). */
export const GUTTER_WIDTH = 56;
export const HEADER_HEIGHT = 36;
export const FOOTER_HEIGHT = 36;
/** Width of the "+" (add field) column at the end of the header. */
export const ADD_COLUMN_WIDTH = 48;
export const PRIMARY_WIDTH = 240;

export type GridColumn = {
  field: FieldMeta;
  width: number;
  /** Pinned to the left while scrolling sideways (the primary field and `frozenCount` more). */
  frozen: boolean;
  /** Left edge, relative to the start of its pane (frozen or scrolling). */
  left: number;
  align: 'left' | 'right' | 'center';
};

export function defaultWidth(field: FieldMeta): number {
  if (field.isPrimary) return PRIMARY_WIDTH;
  return getFieldType(field.type).editor.width;
}

export function clampWidth(width: number): number {
  return Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width)));
}

/**
 * The view's field order: the primary field first, then the saved `fieldOrder`, then fields it
 * doesn't know yet (added since) in table order. Unknown ids (deleted fields) are dropped.
 */
export function orderedFields(fields: FieldMeta[], layout: GridLayout): FieldMeta[] {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const primary = fields.filter((f) => f.isPrimary);
  const seen = new Set(primary.map((f) => f.id));
  const out = [...primary];
  for (const id of layout.fieldOrder ?? []) {
    const f = byId.get(id);
    if (f && !seen.has(id)) {
      seen.add(id);
      out.push(f);
    }
  }
  for (const f of fields) if (!seen.has(f.id)) out.push(f);
  return out;
}

/** The grid's columns, with widths, frozen flags and left offsets per pane. */
export function gridColumns(fields: FieldMeta[], layout: GridLayout): GridColumn[] {
  const ordered = orderedFields(fields, layout);
  const frozenCount = 1 + (layout.frozenCount ?? 0);
  let frozenLeft = GUTTER_WIDTH;
  let scrollLeft = 0;
  return ordered.map((field, i) => {
    const width = clampWidth(layout.columnWidths?.[field.id] ?? defaultWidth(field));
    const frozen = i < frozenCount;
    const left = frozen ? frozenLeft : scrollLeft;
    if (frozen) frozenLeft += width;
    else scrollLeft += width;
    return { field, width, frozen, left, align: getFieldType(field.type).editor.align };
  });
}

/**
 * The new `fieldOrder` after moving `fieldId` to `toIndex` (an index in the ordered columns).
 * The primary field stays first; nothing else can move before it.
 */
export function moveField(columns: GridColumn[], fieldId: string, toIndex: number): string[] {
  const ids = columns.map((c) => c.field.id);
  const from = ids.indexOf(fieldId);
  if (from < 0 || columns[from]?.field.isPrimary) return ids;
  const minIndex = columns.findIndex((c) => !c.field.isPrimary);
  const to = Math.max(minIndex, Math.min(ids.length - 1, toIndex));
  ids.splice(from, 1);
  ids.splice(to, 0, fieldId);
  return ids;
}

export function rowHeightOf(layout: GridLayout): number {
  return ROW_HEIGHTS[layout.rowHeight ?? 'default'];
}

/** Rows on touch screens are at least this tall, so a row is a comfortable tap target. */
export const TOUCH_ROW_HEIGHT = 44;
/** On phones the frozen primary column is at most this wide, so other columns stay in view. */
export const PHONE_PRIMARY_WIDTH = 140;

/**
 * The layout as shown below 768 px: only the primary field stays frozen, at most
 * `PHONE_PRIMARY_WIDTH` wide. Display only; the saved layout is untouched.
 */
export function phoneLayout(fields: FieldMeta[], layout: GridLayout): GridLayout {
  const primary = fields.find((f) => f.isPrimary);
  if (!primary) return { ...layout, frozenCount: 0 };
  const width = clampWidth(layout.columnWidths?.[primary.id] ?? defaultWidth(primary));
  return {
    ...layout,
    frozenCount: 0,
    columnWidths: { ...layout.columnWidths, [primary.id]: Math.min(width, PHONE_PRIMARY_WIDTH) },
  };
}

/**
 * A full field order (hidden fields included) with its visible fields rearranged as
 * `visibleOrder`: hidden fields keep their slots, visible ones fill the rest in the new order.
 */
export function mergeOrder(fullOrder: readonly string[], visibleOrder: readonly string[]) {
  const visible = new Set(visibleOrder);
  const next = [...visibleOrder];
  const out = fullOrder.map((id) => (visible.has(id) ? (next.shift() ?? id) : id));
  return [...out, ...next];
}
