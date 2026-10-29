import { z } from 'zod';
import { INTERFACE_ROLES, USER_ROLES } from '../constants/index.js';
import { getFieldType, isFieldTypeName } from '../fields/index.js';
import type { FilterOperator } from '../fields/types.js';
import { isFormFieldType } from '../forms/config.js';
import {
  aggregateSchema,
  type FilterCondition,
  filterGroupSchema,
  MAX_DATE_RANGE_DAYS,
  MAX_SORTS,
  sortSchema,
} from '../query/index.js';
import { SharedFieldSchema, SharedRecordSchema } from './share.js';
import { calendarLayoutSchema, kanbanLayoutSchema, timelineLayoutSchema } from './view.js';
import { InvitationSchema } from './workspace.js';

/**
 * Interfaces: app-like pages built on a base. An interface holds pages; a page has a
 * layout (a record list, or a record review: the list beside the selected record) over one table,
 * page-level filters and sorts, and elements placed on a 12-column grid. Each page keeps a draft,
 * which its creators edit, and the published copy, which is all anyone else sees: a page never
 * published is invisible to non-creators.
 *
 * Dashboards: number and chart elements summarize the records of a table (or one of its
 * views) on any page, computed by the server through the ViewQuery compiler; a `dashboard` page
 * has no record list, only its elements.
 *
 * More layouts: form (a new record from the fields it lists), kanban, calendar and
 * timeline (the views' layouts, `kanban`/`calendar`/`timeline`, drawn read-only from the page's
 * records route as share links draw views). Every page's records are read through that route,
 * projected to the fields the page shows, with the page filter applied on the server: interface-
 * only collaborators see nothing else of the base.
 */

export const INTERFACE_LAYOUTS = [
  'recordList',
  'recordReview',
  'dashboard',
  'form',
  'kanban',
  'calendar',
  'timeline',
] as const;
export type InterfaceLayout = (typeof INTERFACE_LAYOUTS)[number];

/** Layouts drawn like a view of the same type, from the page's records. */
export const VIEW_LIKE_LAYOUTS: readonly InterfaceLayout[] = ['kanban', 'calendar', 'timeline'];

export const INTERFACE_ELEMENT_TYPES = [
  'text',
  'filter',
  'button',
  'field',
  'number',
  'chart',
] as const;
export type InterfaceElementType = (typeof INTERFACE_ELEMENT_TYPES)[number];

/** Elements that show the selected record: only on a record review page. */
export const RECORD_ELEMENT_TYPES: readonly InterfaceElementType[] = ['field'];

export const MAX_INTERFACES_PER_BASE = 20;
export const MAX_PAGES_PER_INTERFACE = 30;
export const MAX_ELEMENTS_PER_PAGE = 50;
export const MAX_INTERFACE_LIST_FIELDS = 30;
/** Filter elements per page (their conditions are the query's `within`). */
export const MAX_FILTER_ELEMENTS = 5;
export const MAX_INTERFACE_TEXT_LENGTH = 10_000;
export const MAX_INTERFACE_URL_LENGTH = 2048;
/** The layout grid: columns, and the deepest row an element may start on. */
export const INTERFACE_GRID_COLUMNS = 12;
export const INTERFACE_GRID_MAX_ROWS = 200;
export const MAX_ELEMENT_HEIGHT = 40;
/** Number and chart elements per page: each is a query or two when the page loads. */
export const MAX_DATA_ELEMENTS = 20;
/** A chart's bars, points or slices (the rest are left out, or one "Other" slice). */
export const MAX_CHART_GROUPS = 50;
/** A chart's series (stacks or lines): the categorical palette's colours. */
export const MAX_CHART_SERIES = 6;

/** A form page's fields. */
export const MAX_INTERFACE_FORM_FIELDS = 30;
/** Cells one page write (an edit or a form submission) may carry. */
export const MAX_INTERFACE_WRITE_CELLS = 50;
/** Largest page of a page's records (record lists and reviews show the first). */
export const INTERFACE_RECORDS_PAGE_MAX = 200;
/** Interface-only collaborators per interface, and their pending invitations. */
export const MAX_INTERFACE_COLLABORATORS = 100;
export const MAX_INTERFACE_INVITATIONS = 50;

const name = z.string().trim().min(1).max(100);

/**
 * Whether a page may let its viewers write a field (an editable field element, a form field):
 * a field that takes typed values, never one that reaches another table, people or files (an
 * interface-only collaborator can't pick linked records, collaborators or upload).
 */
export function isInterfaceWritableType(type: string): boolean {
  return (
    isFormFieldType(type) &&
    type !== 'link' &&
    type !== 'attachment' &&
    type !== 'user' &&
    type !== 'button'
  );
}

/** A form page: the fields it asks for, in order, and what happens on submit. */
export const interfaceFormSchema = z
  .object({
    fields: z
      .array(
        z
          .object({
            fieldId: z.uuid(),
            label: z.string().trim().max(100).default(''),
            required: z.boolean().default(false),
          })
          .strict()
      )
      .max(MAX_INTERFACE_FORM_FIELDS)
      .default([]),
    submitLabel: z.string().trim().min(1).max(60).default('Submit'),
    successMessage: z.string().trim().max(500).default('Thanks, your response was recorded.'),
  })
  .strict();
export type InterfaceForm = z.infer<typeof interfaceFormSchema>;

const elementBase = {
  /** Unique within the page (the designer makes them). */
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'Letters, digits, - and _ only'),
  x: z
    .int()
    .min(0)
    .max(INTERFACE_GRID_COLUMNS - 1),
  y: z
    .int()
    .min(0)
    .max(INTERFACE_GRID_MAX_ROWS - 1),
  w: z.int().min(1).max(INTERFACE_GRID_COLUMNS),
  h: z.int().min(1).max(MAX_ELEMENT_HEIGHT),
};

/**
 * The operator a filter element on a field of this type uses: `is` a choice (single select) or
 * checked (checkbox), `contains` text where the type has it; null when it can't be a filter.
 */
export function filterElementOperator(fieldType: string): FilterOperator | null {
  if (fieldType === 'singleSelect' || fieldType === 'checkbox') return 'is';
  if (!isFieldTypeName(fieldType)) return null;
  return getFieldType(fieldType).filterOperators.includes('contains') ? 'contains' : null;
}

/** Markdown (the rich text subset), shown sanitized. */
export const textElementSchema = z
  .object({
    ...elementBase,
    type: z.literal('text'),
    content: z.string().max(MAX_INTERFACE_TEXT_LENGTH).default(''),
  })
  .strict();

/**
 * A filter the viewer sets: narrows the page's records by one field (`is` a choice for single
 * selects, `is` checked for checkboxes, `contains` text otherwise).
 */
export const filterElementSchema = z
  .object({
    ...elementBase,
    type: z.literal('filter'),
    fieldId: z.uuid(),
    label: z.string().trim().max(100).default(''),
  })
  .strict();

const httpUrl = z
  .string()
  .trim()
  .max(MAX_INTERFACE_URL_LENGTH)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' || u.protocol === 'http:';
    } catch {
      return false;
    }
  }, 'Enter an http(s) URL');

/**
 * A button: opens a URL in a new tab, or clicks a button field of the selected record (record
 * review pages), which runs the automations triggered by that button.
 */
export const buttonElementSchema = z
  .object({
    ...elementBase,
    type: z.literal('button'),
    label: z.string().trim().min(1).max(100).default('Open'),
    action: z.discriminatedUnion('type', [
      z.object({ type: z.literal('openUrl'), url: httpUrl }).strict(),
      z.object({ type: z.literal('runAutomation'), fieldId: z.uuid() }).strict(),
    ]),
  })
  .strict();

/** One field of the selected record, read-only or editable (the record's own rules apply). */
export const fieldElementSchema = z
  .object({
    ...elementBase,
    type: z.literal('field'),
    fieldId: z.uuid(),
    editable: z.boolean().default(false),
  })
  .strict();

/**
 * What a number or chart summarizes: the records of a table of the base, or of one of its
 * (collaborative) views, narrowed by the element's own filter. On the page's table the page's
 * filter and the viewer's filter elements narrow them too.
 */
const dataSource = {
  label: z.string().trim().max(100).default(''),
  tableId: z.uuid(),
  viewId: z.uuid().nullable().default(null),
  filter: filterGroupSchema.optional(),
};

/** One aggregate (the grid's summaries) of a field; `count` needs no field. */
export const numberElementSchema = z
  .object({
    ...elementBase,
    type: z.literal('number'),
    ...dataSource,
    fieldId: z.uuid().nullable().default(null),
    fn: aggregateSchema.default('count'),
  })
  .strict();

export const CHART_TYPES = ['bar', 'stackedBar', 'line', 'pie', 'donut'] as const;
export type ChartType = (typeof CHART_TYPES)[number];
/** What a chart plots per group: the count of records, or a number field's aggregate. */
export const CHART_AGGREGATES = ['count', 'sum', 'avg', 'min', 'max'] as const;
export type ChartAggregate = (typeof CHART_AGGREGATES)[number];
/** Bars and slices in the group field's order (as a view groups), or by their value. */
export const CHART_ORDERS = ['field', 'valueDesc', 'valueAsc'] as const;

/**
 * A chart of the records grouped by a field (the x axis, or the slices), optionally split into
 * series by a second one (stacked bars, one line per series).
 */
export const chartElementSchema = z
  .object({
    ...elementBase,
    type: z.literal('chart'),
    ...dataSource,
    chart: z.enum(CHART_TYPES).default('bar'),
    groupFieldId: z.uuid(),
    seriesFieldId: z.uuid().nullable().default(null),
    fieldId: z.uuid().nullable().default(null),
    fn: z.enum(CHART_AGGREGATES).default('count'),
    order: z.enum(CHART_ORDERS).default('field'),
  })
  .strict();

export const interfaceElementSchema = z.discriminatedUnion('type', [
  textElementSchema,
  filterElementSchema,
  buttonElementSchema,
  fieldElementSchema,
  numberElementSchema,
  chartElementSchema,
]);

/** Elements whose content the server computes (the page's data route). */
export const DATA_ELEMENT_TYPES: readonly InterfaceElementType[] = ['number', 'chart'];

export const interfacePageConfigSchema = z
  .object({
    layout: z.enum(INTERFACE_LAYOUTS),
    tableId: z.uuid(),
    /** Page-level filter: every record the page lists meets it ("me" is the viewer). */
    filter: filterGroupSchema.optional(),
    sorts: z.array(sortSchema).max(MAX_SORTS).default([]),
    /** The list's columns (record review: the primary field and these, under it). */
    fields: z.array(z.uuid()).max(MAX_INTERFACE_LIST_FIELDS).default([]),
    elements: z.array(interfaceElementSchema).max(MAX_ELEMENTS_PER_PAGE).default([]),
    /** The view-like layouts' settings, as the views of the same type keep them. */
    kanban: kanbanLayoutSchema.optional(),
    calendar: calendarLayoutSchema.optional(),
    timeline: timelineLayoutSchema.optional(),
    /** A form page's fields and messages. */
    form: interfaceFormSchema.optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const ids = new Set<string>();
    const formIds = new Set<string>();
    for (const [i, f] of (config.form?.fields ?? []).entries()) {
      if (formIds.has(f.fieldId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['form', 'fields', i, 'fieldId'],
          message: 'This field is on the form already',
        });
      }
      formIds.add(f.fieldId);
    }
    if (config.elements.filter((e) => e.type === 'filter').length > MAX_FILTER_ELEMENTS) {
      ctx.addIssue({
        code: 'custom',
        path: ['elements'],
        message: `A page has at most ${MAX_FILTER_ELEMENTS} filters`,
      });
    }
    if (
      config.elements.filter((e) => DATA_ELEMENT_TYPES.includes(e.type)).length > MAX_DATA_ELEMENTS
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['elements'],
        message: `A page has at most ${MAX_DATA_ELEMENTS} numbers and charts`,
      });
    }
    for (const [i, el] of config.elements.entries()) {
      if ((el.type === 'number' || el.type === 'chart') && el.fn !== 'count' && !el.fieldId) {
        ctx.addIssue({
          code: 'custom',
          path: ['elements', i, 'fieldId'],
          message: 'Pick the field to summarize',
        });
      }
      if (el.type === 'chart') {
        if (el.chart === 'stackedBar' && !el.seriesFieldId) {
          ctx.addIssue({
            code: 'custom',
            path: ['elements', i, 'seriesFieldId'],
            message: 'Pick the field that splits the stacks',
          });
        }
        if ((el.chart === 'pie' || el.chart === 'donut') && el.seriesFieldId) {
          ctx.addIssue({
            code: 'custom',
            path: ['elements', i, 'seriesFieldId'],
            message: 'A pie has no series',
          });
        }
        if (el.seriesFieldId && el.seriesFieldId === el.groupFieldId) {
          ctx.addIssue({
            code: 'custom',
            path: ['elements', i, 'seriesFieldId'],
            message: 'Split by another field than the groups',
          });
        }
      }
      if (ids.has(el.id)) {
        ctx.addIssue({ code: 'custom', path: ['elements', i, 'id'], message: 'Duplicate id' });
      }
      ids.add(el.id);
      if (el.x + el.w > INTERFACE_GRID_COLUMNS) {
        ctx.addIssue({
          code: 'custom',
          path: ['elements', i, 'w'],
          message: `Elements fit in ${INTERFACE_GRID_COLUMNS} columns`,
        });
      }
      const needsRecord =
        RECORD_ELEMENT_TYPES.includes(el.type) ||
        (el.type === 'button' && el.action.type === 'runAutomation');
      if (needsRecord && config.layout !== 'recordReview') {
        ctx.addIssue({
          code: 'custom',
          path: ['elements', i, 'type'],
          message: 'Only a record review page shows a selected record',
        });
      }
    }
  });

export const createInterfaceSchema = z.object({ name }).strict();
export const updateInterfaceSchema = z
  .object({ name: name.optional(), position: z.number().finite().optional() })
  .strict();

/** `POST /api/interfaces/:interfaceId/pages/:pageId/records`: a window of the page's records. */
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / 86_400_000;

/** The filter elements' values, by element id (the viewer's own narrowing). */
const filterValuesSchema = z
  .record(z.string().max(40), z.union([z.string().max(1000), z.boolean(), z.null()]))
  .refine((r) => Object.keys(r).length <= MAX_FILTER_ELEMENTS, 'Too many filters')
  .default({});

export const interfacePageRecordsQuerySchema = z
  .object({
    /** The saved draft instead of the published page (creators only). */
    draft: z.boolean().default(false),
    filters: filterValuesSchema,
    offset: z.int().min(0).max(100_000).default(0),
    limit: z.int().min(1).max(INTERFACE_RECORDS_PAGE_MAX).default(INTERFACE_RECORDS_PAGE_MAX),
    /** A calendar's or timeline's date window (both or neither). */
    from: isoDay.optional(),
    to: isoDay.optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    if ((q.from === undefined) !== (q.to === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'Give both from and to' });
    } else if (q.from !== undefined && q.to !== undefined) {
      const days = dayNumber(q.to) - dayNumber(q.from);
      if (!(days >= 0 && days <= MAX_DATE_RANGE_DAYS)) {
        ctx.addIssue({ code: 'custom', path: ['to'], message: 'Invalid date window' });
      }
    }
  });

/**
 * A page's records as its viewer may see them: only the fields the page shows (links and
 * people as names, as share links show them), the records its filter keeps for this viewer.
 */
export const InterfacePageRecordsSchema = z.object({
  table: z.object({ id: z.uuid(), name: z.string() }),
  fields: z.array(SharedFieldSchema),
  records: z.array(SharedRecordSchema),
  offset: z.int(),
  total: z.int(),
  /** Fields the viewer may edit through the page (a record review's editable field elements). */
  editable: z.array(z.uuid()),
  /** The viewer may submit the page's form. */
  canSubmit: z.boolean(),
  /** A view-like page's layout, resolved as a shared view's (fields it shows only). */
  kanban: kanbanLayoutSchema.optional(),
  calendar: calendarLayoutSchema.optional(),
  timeline: timelineLayoutSchema.optional(),
});

const cells = z
  .record(z.uuid(), z.unknown())
  .refine(
    (r) => Object.keys(r).length <= MAX_INTERFACE_WRITE_CELLS,
    `At most ${MAX_INTERFACE_WRITE_CELLS} fields`
  );

/** `PATCH .../pages/:pageId/records/:recordId`: cells of fields the page makes editable. */
export const interfacePageRecordUpdateSchema = z.object({ fields: cells }).strict();
/** `POST .../pages/:pageId/submissions`: a form page's answers, by field id. */
export const interfacePageSubmissionSchema = z.object({ fields: cells }).strict();
export const InterfacePageSubmittedSchema = z.object({ id: z.uuid() });

/** `GET /api/me/interfaces`: the interfaces shared with the caller alone. */
export const SharedInterfaceListSchema = z.object({
  interfaces: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      baseId: z.uuid(),
      baseName: z.string(),
      workspaceName: z.string(),
      role: z.enum(INTERFACE_ROLES),
    })
  ),
});

export const InterfaceCollaboratorSchema = z.object({
  userId: z.uuid(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  role: z.enum(INTERFACE_ROLES),
});

export const InterfaceCollaboratorListSchema = z.object({
  collaborators: z.array(InterfaceCollaboratorSchema),
  invitations: z.array(InvitationSchema),
});

export const inviteInterfaceCollaboratorSchema = z
  .object({
    email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
    role: z.enum(INTERFACE_ROLES).default('read_only'),
  })
  .strict();

export const updateInterfaceCollaboratorSchema = z
  .object({ role: z.enum(INTERFACE_ROLES) })
  .strict();

export const createInterfacePageSchema = z
  .object({
    name,
    layout: z.enum(INTERFACE_LAYOUTS),
    tableId: z.uuid(),
  })
  .strict();

/** A page's name, position or draft; publishing is its own route. */
export const updateInterfacePageSchema = z
  .object({
    name: name.optional(),
    position: z.number().finite().optional(),
    draft: interfacePageConfigSchema.optional(),
  })
  .strict();

export const InterfacePageSchema = z.object({
  id: z.uuid(),
  interfaceId: z.uuid(),
  name: z.string(),
  position: z.number(),
  /** The page's editors only (creators and up); `null` for everyone else. */
  draft: interfacePageConfigSchema.nullable(),
  /** What viewers see; `null` until published. */
  published: interfacePageConfigSchema.nullable(),
  publishedAt: z.iso.datetime({ offset: true }).nullable(),
  /** The draft differs from the published copy (editors only; false otherwise). */
  hasChanges: z.boolean(),
});

export const InterfaceSchema = z.object({
  id: z.uuid(),
  baseId: z.uuid(),
  name: z.string(),
  position: z.number(),
  pages: z.array(InterfacePageSchema),
});

/** `GET /api/interfaces/:interfaceId`: one interface as its viewer reaches it. */
export const InterfaceAccessSchema = z.object({
  interface: InterfaceSchema,
  baseName: z.string(),
  workspaceId: z.uuid(),
  canEdit: z.boolean(),
  /** `interface`: an interface-only collaborator, who has no access to the base itself. */
  access: z.enum(['base', 'interface']),
  role: z.enum(USER_ROLES),
});

export const InterfaceListSchema = z.object({
  interfaces: z.array(InterfaceSchema),
  /** The caller may build interfaces (creators and up). */
  canEdit: z.boolean(),
});

/**
 * The conditions of the page's filter elements the viewer has set (`values` by element id), by
 * the operator each field type uses (`filterElementOperator`): the query's `within`, beside the
 * page's own filter. Unknown fields and blank values are left out.
 */
export function filterElementConditions(
  elements: readonly InterfaceElement[],
  values: Readonly<Record<string, unknown>>,
  fields: readonly { id: string; type: string }[]
): FilterCondition[] {
  const blank = (v: unknown) => v === undefined || v === null || v === '' || v === false;
  const conditions: FilterCondition[] = [];
  for (const el of elements) {
    if (el.type !== 'filter') continue;
    const value = values[el.id];
    const field = fields.find((f) => f.id === el.fieldId);
    const operator = field ? filterElementOperator(field.type) : null;
    if (!operator || blank(value)) continue;
    conditions.push({ fieldId: el.fieldId, operator, value });
  }
  return conditions;
}

/** `POST .../pages/:pageId/data`: the draft (editors) or the published page, and the viewer's filters. */
export const interfacePageDataQuerySchema = z
  .object({
    draft: z.boolean().default(false),
    /** The filter elements' values, by element id. */
    filters: filterValuesSchema,
  })
  .strict();

/** A group or series key: a cell value as records carry it (`null`: empty). */
const chartKey = z.unknown();

export const InterfaceElementDataSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('number'),
    /** The aggregate (a number, or a date for min/max of dates; `null` without values). */
    value: z.unknown(),
    /** The records summarized. */
    records: z.int(),
    /** The settings of the field it reads, to format the value. */
    fields: z.array(SharedFieldSchema).optional(),
  }),
  z.object({
    type: z.literal('chart'),
    /** The series' keys, in order; `null` without a series field (one value per row). */
    series: z.array(chartKey).nullable(),
    /** One row per group, values by series; `other`: the groups past the cap, summed. */
    rows: z.array(
      z.object({
        key: chartKey,
        values: z.array(z.number().nullable()),
        other: z.boolean().optional(),
      })
    ),
    /** Groups or series were left out (past MAX_CHART_GROUPS / MAX_CHART_SERIES). */
    truncated: z.boolean(),
    records: z.int(),
    /** The settings of the fields it reads, to name groups and format values. */
    fields: z.array(SharedFieldSchema).optional(),
  }),
  z.object({
    type: z.literal('error'),
    /** `missing`: its table, view or a field is gone; `hidden`: a field you can't read. */
    code: z.enum(['missing', 'hidden', 'invalid']),
    message: z.string(),
  }),
]);

export const InterfacePageDataSchema = z.object({
  elements: z.record(z.string(), InterfaceElementDataSchema),
});

export type InterfaceElementData = z.infer<typeof InterfaceElementDataSchema>;
export type InterfacePageData = z.infer<typeof InterfacePageDataSchema>;
export type InterfacePageRecordsQuery = z.input<typeof interfacePageRecordsQuerySchema>;
export type InterfacePageRecords = z.infer<typeof InterfacePageRecordsSchema>;
export type InterfaceAccess = z.infer<typeof InterfaceAccessSchema>;
export type SharedInterfaceList = z.infer<typeof SharedInterfaceListSchema>;
export type InterfaceCollaborator = z.infer<typeof InterfaceCollaboratorSchema>;
export type InterfaceCollaboratorList = z.infer<typeof InterfaceCollaboratorListSchema>;
export type InviteInterfaceCollaboratorInput = z.input<typeof inviteInterfaceCollaboratorSchema>;
export type InterfacePageDataQuery = z.infer<typeof interfacePageDataQuerySchema>;
export type NumberElement = z.infer<typeof numberElementSchema>;
export type ChartElement = z.infer<typeof chartElementSchema>;
export type InterfaceElement = z.infer<typeof interfaceElementSchema>;
export type InterfacePageConfig = z.infer<typeof interfacePageConfigSchema>;
export type InterfacePage = z.infer<typeof InterfacePageSchema>;
export type Interface = z.infer<typeof InterfaceSchema>;
export type InterfaceList = z.infer<typeof InterfaceListSchema>;
export type CreateInterfaceInput = z.infer<typeof createInterfaceSchema>;
export type UpdateInterfaceInput = z.infer<typeof updateInterfaceSchema>;
export type CreateInterfacePageInput = z.infer<typeof createInterfacePageSchema>;
export type UpdateInterfacePageInput = z.infer<typeof updateInterfacePageSchema>;
