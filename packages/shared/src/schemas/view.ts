import { z } from 'zod';
import { VIEW_TYPES } from '../constants/index.js';
import { getFieldType, isFieldTypeName } from '../fields/index.js';
import { formLayoutOf, formLayoutSchema, pruneFormLayout } from '../forms/config.js';
import {
  MAX_ROW_COLOR_CONDITIONS,
  pruneViewQuery,
  rowColorConditionSchema,
  savedQueryOf,
  savedViewQuerySchema,
} from '../query/index.js';

const name = z.string().trim().min(1).max(255);

/**
 * `POST /api/tables/:tableId/views`. Grid, kanban, calendar, gallery, timeline and
 * list views have a screen; a form view has the form builder.
 */
export const createViewSchema = z
  .object({
    name,
    type: z.enum(VIEW_TYPES).default('grid'),
    /** A personal view is listed and readable only by its creator. */
    personal: z.boolean().default(false),
  })
  .strict();

/** Row heights of the grid (DESIGN.md §5: 28, 34, 56, 88 px). */
export const ROW_HEIGHTS = { compact: 28, default: 34, medium: 56, tall: 88 } as const;
export type RowHeight = keyof typeof ROW_HEIGHTS;

/** Narrowest and widest a grid column can be dragged. */
export const MIN_COLUMN_WIDTH = 60;
export const MAX_COLUMN_WIDTH = 1200;

/**
 * The grid's layout of a view, kept under `config.grid`, apart from the ViewQuery keys:
 * column order and widths, how many columns after the primary field are frozen, the row height
 * and the hidden fields. Fields missing from `fieldOrder` (added later) go at the end, in table
 * order.
 */
export const gridLayoutSchema = z
  .object({
    fieldOrder: z.array(z.uuid()).max(1000).optional(),
    columnWidths: z
      .record(z.uuid(), z.int().min(MIN_COLUMN_WIDTH).max(MAX_COLUMN_WIDTH))
      .optional(),
    /** Columns frozen after the primary field (which is always pinned). */
    frozenCount: z.int().min(0).max(10).optional(),
    rowHeight: z.enum(['compact', 'default', 'medium', 'tall']).optional(),
    /** Fields hidden in this view; the primary field can't be hidden. */
    hiddenFields: z.array(z.uuid()).max(1000).optional(),
  })
  .strict();

/** Field types a kanban view can stack by: one choice, or one person per record. */
export const KANBAN_STACK_TYPES = ['singleSelect', 'user'] as const;

/** Whether a field can be a kanban view's stack field (a user field only with one person). */
export function isStackableField(field: { type: string; options?: unknown }): boolean {
  if (field.type === 'singleSelect') return true;
  if (field.type !== 'user') return false;
  const o = field.options as { multiple?: unknown } | undefined;
  return o?.multiple !== true;
}

/**
 * The kanban layout of a view, kept under `config.kanban`: the field the cards stack by
 * (a single select or a one-person user field), the fields shown on cards in order (the primary
 * field is always the card's title), the attachment field whose first image is the card's
 * cover, and whether stacks without cards collapse to a narrow strip. Stacks follow the choice
 * order (single select) or the collaborator directory (user). Cards are in the view's manual
 * order (`POST /api/views/:viewId/order`) unless the view has sorts.
 */
export const kanbanLayoutSchema = z
  .object({
    stackFieldId: z.uuid().nullable().optional(),
    cardFields: z.array(z.uuid()).max(1000).optional(),
    coverFieldId: z.uuid().nullable().optional(),
    collapseEmpty: z.boolean().optional(),
  })
  .strict();

/** Most date field pairs a calendar view shows at once. */
export const MAX_CALENDAR_DATE_FIELDS = 5;

/** Whether a field can place records on a calendar: a date or a datetime of any kind. */
export function isCalendarDateField(field: { type: string }): boolean {
  return isFieldTypeName(field.type) && getFieldType(field.type).sort === 'chronological';
}

/**
 * Where a record sits on a calendar: its start date field and, for a date range, an end
 * date field. A record without an end (or with an end before its start) is one day long.
 */
export const calendarDateFieldsSchema = z
  .object({ startFieldId: z.uuid(), endFieldId: z.uuid().nullable().optional() })
  .strict();

export const CALENDAR_MODES = ['month', 'week', 'day'] as const;
export type CalendarMode = (typeof CALENDAR_MODES)[number];

/**
 * The calendar layout of a view, kept under `config.calendar`: the date field pairs whose
 * events it shows (each in its own legend colour, or the colour of `colorFieldId`'s choice when
 * set) and the last layout shown (month, week or day).
 */
export const calendarLayoutSchema = z
  .object({
    dateFields: z.array(calendarDateFieldsSchema).max(MAX_CALENDAR_DATE_FIELDS).optional(),
    colorFieldId: z.uuid().nullable().optional(),
    mode: z.enum(CALENDAR_MODES).optional(),
  })
  .strict();

/** Card sizes of a gallery view: the card's width, the cover scales with it. */
export const GALLERY_CARD_SIZES = ['small', 'medium', 'large'] as const;
export type GalleryCardSize = (typeof GALLERY_CARD_SIZES)[number];

/**
 * The gallery layout of a view, kept under `config.gallery`: the fields shown on cards in
 * order (the primary field is always the title), the attachment field whose first image is the
 * cover, whether the cover is cropped to fill or fit whole, and the card size.
 */
export const galleryLayoutSchema = z
  .object({
    cardFields: z.array(z.uuid()).max(1000).optional(),
    coverFieldId: z.uuid().nullable().optional(),
    coverFit: z.enum(['crop', 'fit']).optional(),
    cardSize: z.enum(GALLERY_CARD_SIZES).optional(),
  })
  .strict();

/** Whether a field links records of its own table (a Gantt dependency or a list's parent). */
export function isSelfLinkField(
  field: { type: string; options?: unknown },
  tableId: string
): boolean {
  if (field.type !== 'link') return false;
  const o = field.options as { linkedTableId?: unknown } | undefined;
  return o?.linkedTableId === tableId;
}

export const TIMELINE_SCALES = ['day', 'week', 'month'] as const;
export type TimelineScale = (typeof TIMELINE_SCALES)[number];

/**
 * The timeline layout of a view, kept under `config.timeline`: the start and (optional)
 * end date fields of the bars, the zoom level, a single select that groups the rows and one
 * that colours the bars, and the dependency field that turns it into a Gantt chart: a link to
 * records of the same table that a record waits for (drawn as arrows from their ends to its
 * start).
 */
export const timelineLayoutSchema = z
  .object({
    startFieldId: z.uuid().nullable().optional(),
    endFieldId: z.uuid().nullable().optional(),
    scale: z.enum(TIMELINE_SCALES).optional(),
    groupFieldId: z.uuid().nullable().optional(),
    colorFieldId: z.uuid().nullable().optional(),
    dependencyFieldId: z.uuid().nullable().optional(),
  })
  .strict();

/**
 * The list layout of a view, kept under `config.list`: the link to records of the same
 * table that names a record's parent (its first linked record; records nest under it, indented)
 * and the fields shown beside the title, in order.
 */
export const listLayoutSchema = z
  .object({
    parentFieldId: z.uuid().nullable().optional(),
    rowFields: z.array(z.uuid()).max(1000).optional(),
  })
  .strict();

/**
 * A view's row colouring, kept under `config.rowColor`: by the colour of a single select
 * field's choice, or by conditions (ViewQuery filters, checked in order; the first match wins).
 * `null` turns it off.
 */
export const rowColorSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('select'), fieldId: z.uuid() }).strict(),
  z
    .object({
      mode: z.literal('conditions'),
      conditions: z.array(rowColorConditionSchema).max(MAX_ROW_COLOR_CONDITIONS),
    })
    .strict(),
]);

/**
 * `PATCH /api/views/:viewId`: rename, reorder, or change a layout (grid, kanban, calendar,
 * gallery, timeline, list, form) or the saved query. Layout keys replace the saved layout's; `query` keys
 * (`filter`, `sorts`, `groupBy`) replace the saved query's. Keys left out stay.
 */
export const updateViewSchema = z
  .object({
    name: name.optional(),
    position: z.number().finite().optional(),
    grid: gridLayoutSchema.optional(),
    kanban: kanbanLayoutSchema.optional(),
    calendar: calendarLayoutSchema.optional(),
    gallery: galleryLayoutSchema.optional(),
    timeline: timelineLayoutSchema.optional(),
    list: listLayoutSchema.optional(),
    /** The form builder's layout; a form view only. */
    form: formLayoutSchema.optional(),
    rowColor: rowColorSchema.nullable().optional(),
    query: savedViewQuerySchema.optional(),
    /** Make the view personal or collaborative again; only its creator may. */
    personal: z.boolean().optional(),
    /** Lock or unlock the view's configuration; creators and owners only. */
    locked: z.boolean().optional(),
    /** Move the view into a section of its table, or out of any (`null`). */
    sectionId: z.uuid().nullable().optional(),
  })
  .strict();

/**
 * `POST /api/views/:viewId/order`: puts a record right after `afterId` in the view's manual
 * order (`null`: first). A kanban card dragged within or into a stack is placed after the card
 * above it there.
 */
export const moveViewRecordSchema = z
  .object({ recordId: z.uuid(), afterId: z.uuid().nullable() })
  .strict()
  .refine((m) => m.recordId !== m.afterId, {
    message: "A record can't be placed after itself.",
    path: ['afterId'],
  });

/** `POST /api/views/:viewId/duplicate`: the copy keeps the type and config. */
export const duplicateViewSchema = z.object({ name: name.optional() }).strict();

/**
 * A view's config as the API returns it: the saved query (`filter`, `sorts`, `groupBy`) and the
 * grid layout (`grid`), pruned of fields that aren't live in the table (`viewConfigOf`).
 */
export const viewConfigSchema = savedViewQuerySchema.extend({
  grid: gridLayoutSchema.optional(),
  kanban: kanbanLayoutSchema.optional(),
  calendar: calendarLayoutSchema.optional(),
  gallery: galleryLayoutSchema.optional(),
  timeline: timelineLayoutSchema.optional(),
  list: listLayoutSchema.optional(),
  form: formLayoutSchema.optional(),
  rowColor: rowColorSchema.nullable().optional(),
});

/** A view as the API returns it. */
export const ViewSchema = z.object({
  id: z.uuid(),
  tableId: z.uuid(),
  name: z.string(),
  type: z.enum(VIEW_TYPES),
  position: z.number(),
  config: viewConfigSchema,
  /** Listed and readable only by `createdBy`. */
  personal: z.boolean(),
  /** Only creators and owners may change the configuration. */
  locked: z.boolean(),
  /** The sidebar section the view sits in, or `null`. */
  sectionId: z.uuid().nullable(),
  createdBy: z.uuid().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});

/** Most view sections (sidebar folders) a table has. */
export const MAX_VIEW_SECTIONS_PER_TABLE = 100;

/** `POST /api/tables/:tableId/view-sections`: a sidebar folder, added at the end. */
export const createViewSectionSchema = z.object({ name }).strict();

/** `PATCH /api/tables/:tableId/view-sections/:sectionId`: rename or reorder a section. */
export const updateViewSectionSchema = z
  .object({ name: name.optional(), position: z.number().finite().optional() })
  .strict();

/** A view section (a folder of views in the sidebar). */
export const ViewSectionSchema = z.object({
  id: z.uuid(),
  tableId: z.uuid(),
  name: z.string(),
  position: z.number(),
});

/** The views a user sees in a table (personal views of others left out) and its sections. */
export const ViewListSchema = z.object({
  views: z.array(ViewSchema),
  sections: z.array(ViewSectionSchema),
});

export type CreateViewInput = z.input<typeof createViewSchema>;
export type UpdateViewInput = z.infer<typeof updateViewSchema>;
export type DuplicateViewInput = z.infer<typeof duplicateViewSchema>;
export type ViewMeta = z.infer<typeof ViewSchema>;
export type GridLayout = z.infer<typeof gridLayoutSchema>;
export type KanbanLayout = z.infer<typeof kanbanLayoutSchema>;
export type CalendarLayout = z.infer<typeof calendarLayoutSchema>;
export type CalendarDateFields = z.infer<typeof calendarDateFieldsSchema>;
export type GalleryLayout = z.infer<typeof galleryLayoutSchema>;
export type TimelineLayout = z.infer<typeof timelineLayoutSchema>;
export type ListLayout = z.infer<typeof listLayoutSchema>;
export type MoveViewRecordInput = z.infer<typeof moveViewRecordSchema>;
export type ViewConfig = z.infer<typeof viewConfigSchema>;
export type RowColor = z.infer<typeof rowColorSchema>;
export type ViewSection = z.infer<typeof ViewSectionSchema>;
export type CreateViewSectionInput = z.infer<typeof createViewSectionSchema>;
export type UpdateViewSectionInput = z.infer<typeof updateViewSectionSchema>;

/** The grid layout saved in a view's config, or `{}` when absent or unreadable. */
export function gridLayoutOf(config: Record<string, unknown> | undefined): GridLayout {
  const parsed = gridLayoutSchema.safeParse(config?.['grid'] ?? {});
  return parsed.success ? parsed.data : {};
}

/** Every field id a grid layout names, with its path under `grid` (for validation errors). */
export function gridLayoutFieldRefs(layout: GridLayout): { path: string; id: string }[] {
  return [
    ...(layout.fieldOrder ?? []).map((id, i) => ({ path: `fieldOrder.${i}`, id })),
    ...Object.keys(layout.columnWidths ?? {}).map((id) => ({ path: `columnWidths.${id}`, id })),
    ...(layout.hiddenFields ?? []).map((id, i) => ({ path: `hiddenFields.${i}`, id })),
  ];
}

/**
 * Drops the layout entries of fields that aren't live in the table (deleted since the view was
 * saved), and the primary field from `hiddenFields` (it always shows).
 */
export function pruneGridLayout(
  layout: GridLayout,
  fields: readonly { id: string; isPrimary?: boolean }[]
): GridLayout {
  const live = new Set(fields.map((f) => f.id));
  const primary = new Set(fields.filter((f) => f.isPrimary).map((f) => f.id));
  const out: GridLayout = { ...layout };
  if (layout.fieldOrder) out.fieldOrder = layout.fieldOrder.filter((id) => live.has(id));
  if (layout.columnWidths) {
    out.columnWidths = Object.fromEntries(
      Object.entries(layout.columnWidths).filter(([id]) => live.has(id))
    );
  }
  if (layout.hiddenFields) {
    out.hiddenFields = layout.hiddenFields.filter((id) => live.has(id) && !primary.has(id));
  }
  return out;
}

/** The kanban layout saved in a view's config, or `{}` when absent or unreadable. */
export function kanbanLayoutOf(config: Record<string, unknown> | undefined): KanbanLayout {
  const parsed = kanbanLayoutSchema.safeParse(config?.['kanban'] ?? {});
  return parsed.success ? parsed.data : {};
}

/** Every field id a kanban layout names, with its path under `kanban`. */
export function kanbanLayoutFieldRefs(layout: KanbanLayout): { path: string; id: string }[] {
  return [
    ...(layout.stackFieldId ? [{ path: 'stackFieldId', id: layout.stackFieldId }] : []),
    ...(layout.cardFields ?? []).map((id, i) => ({ path: `cardFields.${i}`, id })),
    ...(layout.coverFieldId ? [{ path: 'coverFieldId', id: layout.coverFieldId }] : []),
  ];
}

/**
 * Drops the kanban entries of fields that aren't live, and a stack or cover field whose type
 * can't serve any more (converted since).
 */
export function pruneKanbanLayout(
  layout: KanbanLayout,
  fields: readonly { id: string; type: string; options?: unknown }[]
): KanbanLayout {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const out: KanbanLayout = { ...layout };
  if (layout.stackFieldId) {
    const f = byId.get(layout.stackFieldId);
    if (!f || !isStackableField(f)) out.stackFieldId = null;
  }
  if (layout.cardFields) out.cardFields = layout.cardFields.filter((id) => byId.has(id));
  if (layout.coverFieldId && byId.get(layout.coverFieldId)?.type !== 'attachment') {
    out.coverFieldId = null;
  }
  return out;
}

/** The calendar layout saved in a view's config, or `{}` when absent or unreadable. */
export function calendarLayoutOf(config: Record<string, unknown> | undefined): CalendarLayout {
  const parsed = calendarLayoutSchema.safeParse(config?.['calendar'] ?? {});
  return parsed.success ? parsed.data : {};
}

/** Every field id a calendar layout names, with its path under `calendar`. */
export function calendarLayoutFieldRefs(layout: CalendarLayout): { path: string; id: string }[] {
  return [
    ...(layout.dateFields ?? []).flatMap((d, i) => [
      { path: `dateFields.${i}.startFieldId`, id: d.startFieldId },
      ...(d.endFieldId ? [{ path: `dateFields.${i}.endFieldId`, id: d.endFieldId }] : []),
    ]),
    ...(layout.colorFieldId ? [{ path: 'colorFieldId', id: layout.colorFieldId }] : []),
  ];
}

/**
 * Drops the date field pairs whose start field isn't a live date field any more, an end field
 * that isn't (the pair shows single days), and a colour field that isn't a single select.
 */
export function pruneCalendarLayout(
  layout: CalendarLayout,
  fields: readonly { id: string; type: string }[]
): CalendarLayout {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const isDate = (id: string | null | undefined) => {
    const f = id ? byId.get(id) : undefined;
    return f !== undefined && isCalendarDateField(f);
  };
  const out: CalendarLayout = { ...layout };
  if (layout.dateFields) {
    out.dateFields = layout.dateFields
      .filter((d) => isDate(d.startFieldId))
      .map((d) => (d.endFieldId && !isDate(d.endFieldId) ? { ...d, endFieldId: null } : d));
  }
  if (layout.colorFieldId && byId.get(layout.colorFieldId)?.type !== 'singleSelect') {
    out.colorFieldId = null;
  }
  return out;
}

/** The gallery layout saved in a view's config, or `{}` when absent or unreadable. */
export function galleryLayoutOf(config: Record<string, unknown> | undefined): GalleryLayout {
  const parsed = galleryLayoutSchema.safeParse(config?.['gallery'] ?? {});
  return parsed.success ? parsed.data : {};
}

/** Every field id a gallery layout names, with its path under `gallery`. */
export function galleryLayoutFieldRefs(layout: GalleryLayout): { path: string; id: string }[] {
  return [
    ...(layout.cardFields ?? []).map((id, i) => ({ path: `cardFields.${i}`, id })),
    ...(layout.coverFieldId ? [{ path: 'coverFieldId', id: layout.coverFieldId }] : []),
  ];
}

/** Drops the card fields that aren't live, and a cover that isn't an attachment field. */
export function pruneGalleryLayout(
  layout: GalleryLayout,
  fields: readonly { id: string; type: string }[]
): GalleryLayout {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const out: GalleryLayout = { ...layout };
  if (layout.cardFields) out.cardFields = layout.cardFields.filter((id) => byId.has(id));
  if (layout.coverFieldId && byId.get(layout.coverFieldId)?.type !== 'attachment') {
    out.coverFieldId = null;
  }
  return out;
}

/** The timeline layout saved in a view's config, or `{}` when absent or unreadable. */
export function timelineLayoutOf(config: Record<string, unknown> | undefined): TimelineLayout {
  const parsed = timelineLayoutSchema.safeParse(config?.['timeline'] ?? {});
  return parsed.success ? parsed.data : {};
}

export const TIMELINE_FIELD_KEYS = [
  'startFieldId',
  'endFieldId',
  'groupFieldId',
  'colorFieldId',
  'dependencyFieldId',
] as const;

/** Every field id a timeline layout names, with its path under `timeline`. */
export function timelineLayoutFieldRefs(layout: TimelineLayout): { path: string; id: string }[] {
  return TIMELINE_FIELD_KEYS.flatMap((key) => {
    const id = layout[key];
    return id ? [{ path: key, id }] : [];
  });
}

/**
 * Whether a field may fill a timeline layout key: dates for the start and end, single selects
 * to group and colour by, links to the same table for dependencies (checked on write; pruning
 * only checks the type).
 */
export function fitsTimelineKey(
  key: (typeof TIMELINE_FIELD_KEYS)[number],
  field: { type: string; options?: unknown },
  tableId?: string
): boolean {
  if (key === 'startFieldId' || key === 'endFieldId') return isCalendarDateField(field);
  if (key === 'dependencyFieldId') {
    return tableId === undefined ? field.type === 'link' : isSelfLinkField(field, tableId);
  }
  return field.type === 'singleSelect';
}

/** Clears the timeline keys whose field isn't live, or isn't of a type that fits any more. */
export function pruneTimelineLayout(
  layout: TimelineLayout,
  fields: readonly { id: string; type: string; options?: unknown }[]
): TimelineLayout {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const out: TimelineLayout = { ...layout };
  for (const key of TIMELINE_FIELD_KEYS) {
    const id = layout[key];
    if (!id) continue;
    const f = byId.get(id);
    if (!f || !fitsTimelineKey(key, f)) out[key] = null;
  }
  return out;
}

/** The list layout saved in a view's config, or `{}` when absent or unreadable. */
export function listLayoutOf(config: Record<string, unknown> | undefined): ListLayout {
  const parsed = listLayoutSchema.safeParse(config?.['list'] ?? {});
  return parsed.success ? parsed.data : {};
}

/** Every field id a list layout names, with its path under `list`. */
export function listLayoutFieldRefs(layout: ListLayout): { path: string; id: string }[] {
  return [
    ...(layout.parentFieldId ? [{ path: 'parentFieldId', id: layout.parentFieldId }] : []),
    ...(layout.rowFields ?? []).map((id, i) => ({ path: `rowFields.${i}`, id })),
  ];
}

/** Drops the row fields that aren't live, and a parent field that isn't a link any more. */
export function pruneListLayout(
  layout: ListLayout,
  fields: readonly { id: string; type: string }[]
): ListLayout {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const out: ListLayout = { ...layout };
  if (layout.parentFieldId && byId.get(layout.parentFieldId)?.type !== 'link') {
    out.parentFieldId = null;
  }
  if (layout.rowFields) out.rowFields = layout.rowFields.filter((id) => byId.has(id));
  return out;
}

/** The row colouring saved in a view's config, or `null` when off, absent or unreadable. */
export function rowColorOf(config: Record<string, unknown> | undefined): RowColor | null {
  const parsed = rowColorSchema.safeParse(config?.['rowColor']);
  return parsed.success ? parsed.data : null;
}

/**
 * Turns off colouring by a field that isn't a live single select any more, and prunes the
 * condition filters as saved filters are (`pruneViewQuery`); a condition left without any filter
 * condition is dropped (it would match every record).
 */
export function pruneRowColor(
  rowColor: RowColor | null,
  fields: readonly { id: string; type: string }[]
): RowColor | null {
  if (!rowColor) return null;
  if (rowColor.mode === 'select') {
    const f = fields.find((x) => x.id === rowColor.fieldId);
    return f?.type === 'singleSelect' ? rowColor : null;
  }
  const conditions = rowColor.conditions.flatMap((c) => {
    const filter = pruneViewQuery({ filter: c.filter }, fields).filter;
    return filter && filter.conditions.length > 0 ? [{ ...c, filter }] : [];
  });
  return { mode: 'conditions', conditions };
}

/**
 * A stored view config as the API returns it: only the keys of `viewConfigSchema` (anything else,
 * or a key this version can't read, is left out), pruned of the fields that aren't live in the
 * table (`pruneViewQuery`, `pruneGridLayout`). The stored config keeps them, so restoring a
 * deleted field brings its filters and layout back.
 */
export function viewConfigOf(
  config: Record<string, unknown> | undefined,
  fields: readonly { id: string; type: string; isPrimary?: boolean; options?: unknown }[]
): ViewConfig {
  const out: ViewConfig = pruneViewQuery(savedQueryOf(config), fields);
  if (config?.['grid'] !== undefined) out.grid = pruneGridLayout(gridLayoutOf(config), fields);
  if (config?.['kanban'] !== undefined) {
    out.kanban = pruneKanbanLayout(kanbanLayoutOf(config), fields);
  }
  if (config?.['calendar'] !== undefined) {
    out.calendar = pruneCalendarLayout(calendarLayoutOf(config), fields);
  }
  if (config?.['gallery'] !== undefined) {
    out.gallery = pruneGalleryLayout(galleryLayoutOf(config), fields);
  }
  if (config?.['timeline'] !== undefined) {
    out.timeline = pruneTimelineLayout(timelineLayoutOf(config), fields);
  }
  if (config?.['list'] !== undefined) out.list = pruneListLayout(listLayoutOf(config), fields);
  if (config?.['form'] !== undefined) out.form = pruneFormLayout(formLayoutOf(config), fields);
  if (config?.['rowColor'] !== undefined) {
    out.rowColor = pruneRowColor(rowColorOf(config), fields);
  }
  return out;
}
