import {
  DATA_ELEMENT_TYPES,
  type FieldMeta,
  type FilterCondition,
  filterElementConditions,
  filterElementOperator,
  INTERFACE_GRID_COLUMNS,
  INTERFACE_GRID_MAX_ROWS,
  type InterfaceElement,
  type InterfaceElementType,
  type InterfaceLayout,
  type InterfacePage,
  type InterfacePageConfig,
  MAX_ELEMENT_HEIGHT,
  RECORD_ELEMENT_TYPES,
} from '@openrows/shared';

/** Interfaces: the designer's and the page view's pure parts. */

export const LAYOUT_LABELS: Record<InterfaceLayout, string> = {
  recordList: 'Record list',
  recordReview: 'Record review',
  dashboard: 'Dashboard',
  form: 'Form',
  kanban: 'Kanban',
  calendar: 'Calendar',
  timeline: 'Timeline',
};

export const LAYOUT_DESCRIPTIONS: Record<InterfaceLayout, string> = {
  recordList: 'A filtered list of records, with text, filters and buttons above it.',
  recordReview: 'The list beside the selected record: review and edit one record at a time.',
  dashboard: 'Numbers and charts that summarize your records, updated live.',
  form: 'A form that adds a record to the table, for the people you share it with.',
  kanban: 'Records as cards in stacks, by a single select field.',
  calendar: 'Records on a month, week or day calendar, by their dates.',
  timeline: 'Records as bars between their start and end dates (a Gantt chart).',
};

export const ELEMENT_LABELS: Record<InterfaceElementType, string> = {
  text: 'Text',
  filter: 'Filter',
  button: 'Button',
  field: 'Field',
  number: 'Number',
  chart: 'Chart',
};

/** The elements a layout can hold: record elements need a selected record. */
export function elementTypesFor(layout: InterfaceLayout): InterfaceElementType[] {
  return (['text', 'filter', 'button', 'field', 'number', 'chart'] as const).filter(
    (t) => layout === 'recordReview' || !RECORD_ELEMENT_TYPES.includes(t)
  );
}

/** Numbers and charts: their content comes from the page's data route. */
export const isDataElement = (el: InterfaceElement) => DATA_ELEMENT_TYPES.includes(el.type);

const DEFAULT_SIZE: Record<InterfaceElementType, { w: number; h: number }> = {
  text: { w: 12, h: 2 },
  filter: { w: 4, h: 2 },
  button: { w: 3, h: 1 },
  field: { w: 6, h: 2 },
  number: { w: 3, h: 2 },
  chart: { w: 6, h: 6 },
};

/** A chart's first group field: a single select, else the primary field. */
export const defaultGroupField = (fields: readonly FieldMeta[]) =>
  fields.find((f) => f.type === 'singleSelect') ?? fields.find((f) => f.isPrimary) ?? fields[0];

/** The first row below every element. */
export function nextRow(elements: readonly InterfaceElement[]): number {
  return Math.min(INTERFACE_GRID_MAX_ROWS - 1, Math.max(0, ...elements.map((e) => e.y + e.h)));
}

function newId(elements: readonly InterfaceElement[], type: string): string {
  const taken = new Set(elements.map((e) => e.id));
  for (let n = 1; ; n++) {
    const id = `${type}-${n}`;
    if (!taken.has(id)) return id;
  }
}

/** Fields a filter element can be on. */
export const filterableFields = (fields: readonly FieldMeta[]) =>
  fields.filter((f) => filterElementOperator(f.type) !== null);

/** Button fields that run automations, for a button element's "run automation". */
export const automationButtons = (fields: readonly FieldMeta[]) =>
  fields.filter(
    (f) => f.type === 'button' && (f.options as { action?: string }).action === 'runAutomation'
  );

/**
 * A new element of `type` under the others, on the first suitable field; null when the table has
 * no field it could show.
 */
export function newElement(
  type: InterfaceElementType,
  elements: readonly InterfaceElement[],
  fields: readonly FieldMeta[],
  tableId = ''
): InterfaceElement | null {
  const place = { id: newId(elements, type), x: 0, y: nextRow(elements), ...DEFAULT_SIZE[type] };
  switch (type) {
    case 'text':
      return { ...place, type, content: 'New text' };
    case 'button':
      return {
        ...place,
        type,
        label: 'Open link',
        action: { type: 'openUrl', url: 'https://openrows.io' },
      };
    case 'filter': {
      const field = filterableFields(fields)[0];
      return field ? { ...place, type, fieldId: field.id, label: '' } : null;
    }
    case 'field': {
      const field = fields.find((f) => !f.isPrimary) ?? fields[0];
      return field ? { ...place, type, fieldId: field.id, editable: false } : null;
    }
    case 'number':
      return {
        ...place,
        type,
        label: '',
        tableId,
        viewId: null,
        fieldId: null,
        fn: 'count',
      };
    case 'chart': {
      const group = defaultGroupField(fields);
      return group
        ? {
            ...place,
            type,
            label: '',
            tableId,
            viewId: null,
            chart: 'bar',
            groupFieldId: group.id,
            seriesFieldId: null,
            fieldId: null,
            fn: 'count',
            order: 'field',
          }
        : null;
    }
  }
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** `el` moved by whole grid cells, kept inside the grid. */
export function moveElement<T extends InterfaceElement>(el: T, dx: number, dy: number): T {
  return {
    ...el,
    x: clamp(el.x + dx, 0, INTERFACE_GRID_COLUMNS - el.w),
    y: clamp(el.y + dy, 0, INTERFACE_GRID_MAX_ROWS - 1),
  };
}

/** `el` grown or shrunk by whole cells, kept inside the grid. */
export function resizeElement<T extends InterfaceElement>(el: T, dw: number, dh: number): T {
  return {
    ...el,
    w: clamp(el.w + dw, 1, INTERFACE_GRID_COLUMNS - el.x),
    h: clamp(el.h + dh, 1, MAX_ELEMENT_HEIGHT),
  };
}

/** Pixels dragged → whole cells (rounded to the nearest). */
export const cellsMoved = (pixels: number, cellSize: number) =>
  cellSize > 0 ? Math.round(pixels / cellSize) : 0;

/** Elements in reading order: top to bottom, then left to right (the canvas's tab order). */
export const readingOrder = (elements: readonly InterfaceElement[]) =>
  [...elements].sort((a, b) => a.y - b.y || a.x - b.x);

/** What a viewer has set in the page's filter elements, by element id. */
export type FilterValues = Readonly<Record<string, unknown>>;

/**
 * The conditions of the filter elements the viewer has set, by the operator each field type
 * uses (`filterElementOperator`): the query's `within`, beside the page's own filter. The server
 * builds the same ones for the page's numbers and charts.
 */
export function elementConditions(
  config: InterfacePageConfig,
  values: FilterValues,
  fields: readonly FieldMeta[]
): FilterCondition[] {
  return filterElementConditions(config.elements, values, fields);
}

/** The filter values the page's data route takes: set ones only, as strings or booleans. */
export function dataFilters(values: FilterValues): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const [id, v] of Object.entries(values)) {
    if (typeof v === 'string' ? v !== '' : v === true) out[id] = v as string | boolean;
  }
  return out;
}

/** The fields a page needs records to carry: the primary, the list's and its elements'. */
export function pageFieldIds(config: InterfacePageConfig, fields: readonly FieldMeta[]): string[] {
  const live = new Set(fields.map((f) => f.id));
  const primary = fields.find((f) => f.isPrimary)?.id;
  const ids = [
    ...(primary ? [primary] : []),
    ...config.fields,
    ...config.elements.flatMap((e) =>
      e.type === 'field'
        ? [e.fieldId]
        : e.type === 'button' && e.action.type === 'runAutomation'
          ? [e.action.fieldId]
          : []
    ),
  ];
  return [...new Set(ids)].filter((id) => live.has(id));
}

/** Where a page stands, for its editors. */
export function publishState(page: InterfacePage): 'never' | 'changes' | 'published' {
  if (page.published === null) return 'never';
  return page.hasChanges ? 'changes' : 'published';
}

/** What a page shows: editors preview the draft, everyone else sees the published copy. */
export const visibleConfig = (page: InterfacePage, canEdit: boolean) =>
  canEdit ? (page.draft ?? page.published) : page.published;
