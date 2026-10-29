import { z } from 'zod';
import { choiceColorSchema, getFieldType, isFieldTypeName } from '../fields/index.js';
import { FILTER_OPERATORS } from '../fields/types.js';

/**
 * The ViewQuery: what a view shows. A filter tree, sorts, up to three group levels, the
 * visible fields and a search term. The server compiles it to parameterized SQL over the table's
 * physical record table (ADR-001); field ids are checked against the table's live fields, and
 * each condition's operator against the field type's `filterOperators` in the registry.
 */

/** Deepest group-by (Airtable allows three levels). */
export const MAX_GROUP_LEVELS = 3;
/** Most sort keys and filter conditions a query may have. */
export const MAX_SORTS = 10;
export const MAX_FILTER_CONDITIONS = 50;
/** Most record ids one link condition (`hasAnyOf`, `hasNoneOf`) may name. */
export const MAX_FILTER_RECORDS = 100;
/** Default and largest window of `POST /api/tables/:tableId/records/query`. */
export const QUERY_PAGE_DEFAULT = 100;
export const QUERY_PAGE_MAX = 1000;
/** Longest `dateRange` window, in days (a calendar shows six weeks at most). */
export const MAX_DATE_RANGE_DAYS = 400;

/**
 * One condition. `value` depends on the operator and the field type:
 * - text: a string (`is` and `contains` ignore case);
 * - numbers (number, currency, percent as a fraction, duration in seconds, rating,
 *   autonumber): a number;
 * - checkbox `is`: a boolean;
 * - dates: `YYYY-MM-DD`, or `today`, `tomorrow`, `yesterday`; `isWithin` takes `pastWeek`,
 *   `pastMonth`, `pastYear`, `nextWeek`, `nextMonth`, `nextYear` or
 *   `{ pastDays | nextDays: n }`. Datetimes compare by their day in the field's time zone;
 * - single select and users: `is`/`isNot` one choice id (or name) / user id, `isAnyOf`/`isNoneOf`
 *   an array of them; for users, `me` stands for the signed-in user and stays `me` in a
 *   saved view, so it means whoever looks at it;
 * - multiple select: an array of choice ids (or names);
 * - attachments `contains`: text matched against file names;
 * - links: `contains`/`doesNotContain` text matched against the linked records' names,
 *   `hasAnyOf`/`hasNoneOf` an array of linked record ids (at most MAX_FILTER_RECORDS);
 * - `isEmpty`/`isNotEmpty`: no value.
 *
 * A condition whose value is missing or blank is ignored (as Airtable ignores an unfinished
 * filter), except for `isEmpty`/`isNotEmpty`.
 */
export const filterConditionSchema = z
  .object({
    fieldId: z.uuid(),
    operator: z.enum(FILTER_OPERATORS),
    value: z.unknown().optional(),
  })
  .strict();

export const conjunctionSchema = z.enum(['and', 'or']);

/** A nested group: conditions only (one level of nesting, as in Airtable). */
export const filterSubgroupSchema = z
  .object({
    conjunction: conjunctionSchema.default('and'),
    conditions: z.array(filterConditionSchema).max(MAX_FILTER_CONDITIONS),
  })
  .strict();

/** The top-level filter: conditions and nested groups, joined by `conjunction`. */
export const filterGroupSchema = z
  .object({
    conjunction: conjunctionSchema.default('and'),
    conditions: z
      .array(z.union([filterConditionSchema, filterSubgroupSchema]))
      .max(MAX_FILTER_CONDITIONS),
  })
  .strict();

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const dateRangeSchema = z
  .object({
    from: isoDay,
    to: isoDay,
    fields: z
      .array(
        z.object({ startFieldId: z.uuid(), endFieldId: z.uuid().nullable().optional() }).strict()
      )
      .min(1)
      .max(5),
  })
  .strict();

export const sortDirectionSchema = z.enum(['asc', 'desc']);

export const sortSchema = z
  .object({ fieldId: z.uuid(), direction: sortDirectionSchema.default('asc') })
  .strict();

export const viewQuerySchema = z
  .object({
    filter: filterGroupSchema.optional(),
    /** Applied after the group levels; record id (creation order) breaks ties. */
    sorts: z.array(sortSchema).max(MAX_SORTS).default([]),
    /** Records are ordered by these first, outermost level first. */
    groupBy: z.array(sortSchema).max(MAX_GROUP_LEVELS).default([]),
    /** Visible fields, in order. Omitted: every live field. Records carry only these. */
    fields: z.array(z.uuid()).max(1000).optional(),
    /** Case-insensitive match against the visible text, select and number fields. */
    search: z.string().trim().max(1000).optional(),
    /** IANA zone for `today` in date filters on date-only fields (default UTC). */
    timeZone: z.string().max(64).optional(),
    /**
     * Conditions every record must also meet, beside `filter` (never saved): a kanban stack's
     * records are the view's filter plus "stack field is this choice".
     */
    within: z.array(filterConditionSchema).max(5).optional(),
    /**
     * Records whose date range meets the days `from` to `to` (inclusive) for at least one of the
     * date field pairs (never saved): what a calendar shows. A pair without an end field,
     * or a record with an empty end, is one day long; datetimes count by their day in the
     * field's time zone.
     */
    dateRange: dateRangeSchema.optional(),
  })
  .strict();

/**
 * The query keys a view saves, beside its grid layout in `config`: the filter, the sorts
 * and the group levels. The search (find in view) and the visible fields aren't saved here: find
 * is per user, and the grid layout keeps the hidden fields.
 */
export const savedViewQuerySchema = z
  .object({
    filter: filterGroupSchema.optional(),
    sorts: z.array(sortSchema).max(MAX_SORTS).optional(),
    groupBy: z.array(sortSchema).max(MAX_GROUP_LEVELS).optional(),
  })
  .strict();

/** Per-field summaries (the grid's summary bar). */
export const AGGREGATES = [
  'count',
  'empty',
  'filled',
  'unique',
  'sum',
  'avg',
  'min',
  'max',
] as const;
export const aggregateSchema = z.enum(AGGREGATES);

/** Most colour conditions a view's row colouring has. */
export const MAX_ROW_COLOR_CONDITIONS = 20;

/** A row colour condition: records matching `filter` get `color` (the first match wins). */
export const rowColorConditionSchema = z
  .object({ color: choiceColorSchema, filter: filterGroupSchema })
  .strict();
export type RowColorCondition = z.infer<typeof rowColorConditionSchema>;

/**
 * `POST /api/tables/:tableId/records/query`. The query is the saved view's (`viewId`), with the
 * keys of `query` replacing the view's; or `query` alone. Paging is either a window
 * (`offset` + `limit`, for the grid) or keyset (`cursor` = the previous page's `nextCursor`, for
 * the API); not both.
 */
export const queryRecordsSchema = z
  .object({
    viewId: z.uuid().optional(),
    // Without the defaults: keys left out keep the saved view's (sorts and groups too).
    query: viewQuerySchema
      .extend({
        sorts: z.array(sortSchema).max(MAX_SORTS).optional(),
        groupBy: z.array(sortSchema).max(MAX_GROUP_LEVELS).optional(),
      })
      .partial()
      .optional(),
    offset: z.int().min(0).max(10_000_000).optional(),
    limit: z.int().min(0).max(QUERY_PAGE_MAX).default(QUERY_PAGE_DEFAULT),
    cursor: z.string().max(10_000).optional(),
    /** Count the matching records (`total`). Default on; the grid asks once per query. */
    count: z.boolean().default(true),
    /** Group header counts (leaf groups, in display order). Needs `groupBy`. */
    groups: z.boolean().default(false),
    /** Summary aggregates over every matching record. */
    aggregates: z
      .array(z.object({ fieldId: z.uuid(), fn: aggregateSchema }).strict())
      .max(500)
      .optional(),
    /**
     * Row colour conditions (a view's `config.rowColor.conditions`): answers `rowColors`,
     * the colour of the first condition each record of the page matches.
     */
    rowColors: z.array(rowColorConditionSchema).max(MAX_ROW_COLOR_CONDITIONS).optional(),
  })
  .strict()
  .refine((q) => q.offset === undefined || q.cursor === undefined, {
    message: 'Use either offset or cursor',
    path: ['cursor'],
  });

const recordShape = z.object({
  id: z.uuid(),
  tableId: z.uuid(),
  version: z.int(),
  fields: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime({ offset: true }),
  createdBy: z.uuid().nullable(),
  updatedAt: z.iso.datetime({ offset: true }),
  updatedBy: z.uuid().nullable(),
});

export const QueryGroupSchema = z.object({
  /** One value per group level (field values as records carry them; `null` is empty). */
  key: z.array(z.unknown()),
  count: z.int(),
});

export const QueryRecordsResultSchema = z.object({
  records: z.array(recordShape),
  /** Index of the first record in the full result (window paging), else `null`. */
  offset: z.int().nullable(),
  /** Matching records, when `count` was asked for. */
  total: z.int().nullable(),
  /** Cursor for the next keyset page, `null` at the end. */
  nextCursor: z.string().nullable(),
  groups: z.array(QueryGroupSchema).optional(),
  /** `{ [fieldId]: { [fn]: value } }`. */
  aggregates: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  /** `{ [recordId]: color }` for the records of the page matching a `rowColors` condition. */
  rowColors: z.record(z.string(), choiceColorSchema).optional(),
});

export type FilterCondition = z.infer<typeof filterConditionSchema>;
export type FilterSubgroup = z.infer<typeof filterSubgroupSchema>;
export type FilterGroup = z.infer<typeof filterGroupSchema>;
export type Sort = z.infer<typeof sortSchema>;
export type ViewQuery = z.infer<typeof viewQuerySchema>;
export type DateRange = z.infer<typeof dateRangeSchema>;
export type SavedViewQuery = z.infer<typeof savedViewQuerySchema>;
export type Aggregate = z.infer<typeof aggregateSchema>;
export type QueryRecordsInput = z.infer<typeof queryRecordsSchema>;
export type QueryRecordsResult = z.infer<typeof QueryRecordsResultSchema>;

/** Is this filter entry a nested group (as opposed to a condition)? */
export function isFilterSubgroup(entry: FilterCondition | FilterSubgroup): entry is FilterSubgroup {
  return 'conditions' in entry;
}

/** The query a view's `config` saved, or `{}` when absent or unreadable. */
export function savedQueryOf(config: Record<string, unknown> | undefined): SavedViewQuery {
  const parsed = savedViewQuerySchema.safeParse({
    filter: config?.['filter'],
    sorts: config?.['sorts'],
    groupBy: config?.['groupBy'],
  });
  return parsed.success ? parsed.data : {};
}

/**
 * Drops what a saved query can no longer apply (as Airtable does when a field goes away): the
 * conditions, sorts and group levels of fields that aren't live in the table, conditions whose
 * operator the field's type no longer offers (after a type conversion), and nested groups left
 * empty. Works on the client and the server alike.
 */
export function pruneViewQuery(
  query: SavedViewQuery,
  fields: readonly { id: string; type: string }[]
): SavedViewQuery {
  const types = new Map(fields.map((f) => [f.id, f.type]));
  const live = (s: Sort) => types.has(s.fieldId);
  const keeps = (c: FilterCondition) => {
    const type = types.get(c.fieldId);
    if (type === undefined || !isFieldTypeName(type)) return false;
    return getFieldType(type).filterOperators.includes(c.operator);
  };
  const out: SavedViewQuery = {};
  if (query.filter) {
    const conditions = query.filter.conditions.flatMap(
      (entry): (FilterCondition | FilterSubgroup)[] => {
        if (!isFilterSubgroup(entry)) return keeps(entry) ? [entry] : [];
        const kept = entry.conditions.filter(keeps);
        return kept.length > 0 ? [{ ...entry, conditions: kept }] : [];
      }
    );
    out.filter = { ...query.filter, conditions };
  }
  if (query.sorts) out.sorts = query.sorts.filter(live);
  if (query.groupBy) out.groupBy = query.groupBy.filter(live);
  return out;
}
