import {
  type ChartElement,
  type FilterGroup,
  filterElementConditions,
  type InterfaceElement,
  type InterfaceElementData,
  type InterfacePageConfig,
  type InterfacePageData,
  isFilterSubgroup,
  MAX_CHART_GROUPS,
  MAX_CHART_SERIES,
  type NumberElement,
  type ProblemFieldError,
  publicFieldOptions,
  type SharedField,
  type UserRole,
} from '@openrows/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { fields, type Transaction, tables } from '../db/index.js';
import { fieldType, type TableRow } from '../fields/service.js';
import { AppError } from '../lib/errors.js';
import type { FieldVisibility } from '../realtime/projection.js';
import { aggregateRecords, groupRecordValues, type SummaryInput } from '../records/service.js';
import { viewFieldsOf } from '../views/service.js';

/**
 * Dashboards: the numbers and charts of a page, computed on the server through the
 * RecordService's summaries (the ViewQuery compiler, ADR-001: aggregates in SQL, never the
 * records). Each element answers its data or an error of its own, so one broken element (a field
 * deleted since the page was published) doesn't blank the page.
 */

export interface PageDataContext {
  tx: Transaction;
  workspaceId: string;
  baseId: string;
  userId: string;
  role: UserRole;
  visibility: FieldVisibility;
}

type DataElement = NumberElement | ChartElement;
type ChartRows = Omit<Extract<InterfaceElementData, { type: 'chart' }>, 'type' | 'records'>;

const isData = (el: InterfaceElement): el is DataElement =>
  el.type === 'number' || el.type === 'chart';

function filterFieldIds(filter: FilterGroup | undefined): string[] {
  if (!filter) return [];
  return filter.conditions.flatMap((c) =>
    isFilterSubgroup(c) ? c.conditions.map((x) => x.fieldId) : [c.fieldId]
  );
}

/** The fields an element reads: what it summarizes, groups by and filters on. */
function touchedFields(el: DataElement, page: { filter?: FilterGroup; within: string[] } | null) {
  return [
    ...(el.fieldId ? [el.fieldId] : []),
    ...(el.type === 'chart'
      ? [el.groupFieldId, ...(el.seriesFieldId ? [el.seriesFieldId] : [])]
      : []),
    ...filterFieldIds(el.filter),
    ...(page ? [...filterFieldIds(page.filter), ...page.within] : []),
  ];
}

/**
 * Chart rows from the grouped values: one row per group (the first key) with a value per series
 * (the second key; `null` when there's no series field), ordered as asked, capped at
 * MAX_CHART_SERIES series and MAX_CHART_GROUPS groups. A pie keeps MAX_CHART_SERIES slices: the
 * rest become one "Other" slice when their values add up (counts and sums), else are left out.
 */
export function chartRows(
  el: Pick<ChartElement, 'chart' | 'fn' | 'order'>,
  groups: readonly { key: unknown[]; value: number | null }[],
  allSeries: readonly unknown[] | null
): ChartRows {
  let truncated = false;
  const series = allSeries ? allSeries.slice(0, MAX_CHART_SERIES) : null;
  if (allSeries && allSeries.length > MAX_CHART_SERIES) truncated = true;
  const seriesIndex = new Map((series ?? []).map((k, i) => [JSON.stringify(k ?? null), i]));
  const width = series ? series.length : 1;
  const empty = el.fn === 'count' ? 0 : null;
  const rows: { key: unknown; values: (number | null)[]; other?: boolean }[] = [];
  const byKey = new Map<string, (typeof rows)[number]>();
  for (const g of groups) {
    const key = g.key[0] ?? null;
    const k = JSON.stringify(key);
    let row = byKey.get(k);
    if (!row) {
      row = { key, values: Array.from({ length: width }, () => empty) };
      byKey.set(k, row);
      rows.push(row);
    }
    const at = series ? seriesIndex.get(JSON.stringify(g.key[1] ?? null)) : 0;
    if (at !== undefined) row.values[at] = g.value;
  }
  const total = (r: (typeof rows)[number]) => r.values.reduce<number>((a, v) => a + (v ?? 0), 0);
  if (el.order !== 'field') {
    const sign = el.order === 'valueDesc' ? -1 : 1;
    rows.sort((a, b) => sign * (total(a) - total(b)));
  }
  const pie = el.chart === 'pie' || el.chart === 'donut';
  const cap = pie ? MAX_CHART_SERIES : MAX_CHART_GROUPS;
  if (rows.length <= cap) return { series, rows, truncated };
  if (pie && (el.fn === 'count' || el.fn === 'sum')) {
    const kept = rows.slice(0, cap - 1);
    const rest = rows.slice(cap - 1);
    kept.push({ key: null, values: [rest.reduce((a, r) => a + total(r), 0)], other: true });
    return { series, rows: kept, truncated };
  }
  return { series, rows: rows.slice(0, cap), truncated: true };
}

function failure(err: unknown): InterfaceElementData {
  if (err instanceof AppError && err.code === 'VALIDATION_FAILED') {
    const first = ((err.extensions?.['errors'] ?? []) as ProblemFieldError[])[0];
    return {
      type: 'error',
      code: 'invalid',
      message: first?.message ?? "This element's settings are invalid.",
    };
  }
  if (err instanceof AppError && err.code === 'NOT_FOUND') {
    return { type: 'error', code: 'missing', message: "This element's view is gone." };
  }
  throw err;
}

/**
 * The data of the page's number and chart elements for this viewer, by element id. On the
 * page's table the page filter and the viewer's filter elements (`filterValues`) apply too. An
 * element reading a field the viewer can't read (`FieldVisibility`) answers `hidden` rather
 * than a value computed from it.
 */
export async function pageData(
  ctx: PageDataContext,
  config: InterfacePageConfig,
  filterValues: Readonly<Record<string, unknown>>
): Promise<InterfacePageData> {
  const elements = config.elements.filter(isData);
  const out: InterfacePageData = { elements: {} };
  if (elements.length === 0) return out;
  const ids = [...new Set(elements.map((e) => e.tableId))];
  const rows = await ctx.tx
    .select()
    .from(tables)
    .where(and(inArray(tables.id, ids), eq(tables.baseId, ctx.baseId), isNull(tables.deletedAt)));
  const byId = new Map<string, TableRow>(rows.map((t) => [t.id, t]));
  const pageFields = (await viewFieldsOf(ctx.tx, config.tableId)).filter(
    (f) => f.deletedAt === null
  );
  const within = filterElementConditions(config.elements, filterValues, pageFields);
  const viewer = { userId: ctx.userId, role: ctx.role };
  // The settings of the fields each element reads (to name groups and format values for
  // viewers who can't read the tables' metadata, like interface-only collaborators).
  const read = [
    ...new Set(
      elements.flatMap((el) => [
        ...(el.fieldId ? [el.fieldId] : []),
        ...(el.type === 'chart'
          ? [el.groupFieldId, ...(el.seriesFieldId ? [el.seriesFieldId] : [])]
          : []),
      ])
    ),
  ];
  const fieldRows =
    read.length === 0
      ? []
      : await ctx.tx
          .select()
          .from(fields)
          .where(and(inArray(fields.id, read), isNull(fields.deletedAt)));
  const metas = (el: DataElement): { fields?: SharedField[] } => {
    const found = fieldsOf(el);
    return found.length > 0 ? { fields: found } : {};
  };
  const fieldsOf = (el: DataElement): SharedField[] =>
    fieldRows
      .filter(
        (f) =>
          f.tableId === el.tableId &&
          (f.id === el.fieldId ||
            (el.type === 'chart' && (f.id === el.groupFieldId || f.id === el.seriesFieldId)))
      )
      .map((f) => ({
        id: f.id,
        name: f.name,
        type: fieldType(f),
        options: publicFieldOptions(fieldType(f), f.config),
        isPrimary: f.isPrimary,
      }));

  for (const el of elements) {
    const table = byId.get(el.tableId);
    if (!table) {
      out.elements[el.id] = { type: 'error', code: 'missing', message: 'Its table was deleted.' };
      continue;
    }
    const onPage = el.tableId === config.tableId;
    const hidden = ctx.visibility.hiddenFields(viewer, table.id);
    const page = onPage ? { filter: config.filter, within: within.map((c) => c.fieldId) } : null;
    if (touchedFields(el, page).some((id) => hidden.has(id))) {
      out.elements[el.id] = {
        type: 'error',
        code: 'hidden',
        message: "It uses a field you don't have access to.",
      };
      continue;
    }
    const summary: SummaryInput = {
      viewId: el.viewId,
      filters: [
        ...(el.filter ? [{ filter: el.filter, path: 'filter' }] : []),
        ...(onPage && config.filter ? [{ filter: config.filter, path: 'pageFilter' }] : []),
      ],
      within: onPage ? within : [],
    };
    const reader = { tx: ctx.tx, workspaceId: ctx.workspaceId, userId: ctx.userId, table };
    try {
      if (el.type === 'number') {
        const r = await aggregateRecords(reader, { ...summary, fieldId: el.fieldId, fn: el.fn });
        out.elements[el.id] = {
          type: 'number',
          value: r.value,
          records: r.records,
          ...metas(el),
        };
      } else {
        const r = await groupRecordValues(reader, {
          ...summary,
          groupFieldId: el.groupFieldId,
          seriesFieldId: el.seriesFieldId,
          fieldId: el.fieldId,
          fn: el.fn,
        });
        out.elements[el.id] = {
          type: 'chart',
          ...chartRows(el, r.groups, r.series),
          records: r.records,
          ...metas(el),
        };
      }
    } catch (err) {
      out.elements[el.id] = failure(err);
    }
  }
  return out;
}
