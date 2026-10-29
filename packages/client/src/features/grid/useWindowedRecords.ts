import type { ChoiceColor, RecordData, RowColorCondition, ViewQuery } from '@openrows/shared';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { recordQueries } from '../../api/queries';
import { PAGE_SIZE, pagesFor } from './windowing';

export type AggregateRequest = { fieldId: string; fn: 'filled' | 'sum' };

/**
 * The view's records for the rows on screen. The first page carries the total and the
 * summary aggregates (and the group counts when grouped); the pages covering `[start, end]` plus
 * overscan load beside it, each cached by TanStack Query under its offset and query. `query`
 * (the toolbar's filter, sorts, groups and find) goes with every request, so the server
 * filters and orders the records.
 */
export function useWindowedRecords(
  tableId: string,
  viewId: string,
  query: Partial<ViewQuery>,
  start: number,
  end: number,
  aggregates: AggregateRequest[],
  /** Row colour conditions: every page answers its records' colours. */
  rowColors: RowColorCondition[] = []
) {
  const qc = useQueryClient();
  const colors = rowColors.length > 0 ? { rowColors } : {};
  const head = useQuery(
    recordQueries.window(tableId, {
      viewId,
      query,
      offset: 0,
      limit: PAGE_SIZE,
      count: true,
      ...colors,
      ...((query.groupBy?.length ?? 0) > 0 ? { groups: true } : {}),
      ...(aggregates.length > 0 ? { aggregates } : {}),
    })
  );
  const total = head.data?.total ?? 0;
  const offsets = pagesFor(start, end, total).filter((o) => o !== 0);
  const pages = useQueries({
    queries: offsets.map((offset) =>
      recordQueries.window(tableId, {
        viewId,
        query,
        offset,
        limit: PAGE_SIZE,
        count: false,
        ...colors,
      })
    ),
  });

  // Pages by offset; a row is looked up in its page.
  const byOffset = new Map<number, RecordData[]>();
  const colorById: Record<string, ChoiceColor> = {};
  for (const data of [head.data, ...pages.map((p) => p.data)]) {
    if (data) byOffset.set(data.offset ?? 0, data.records);
    if (data?.rowColors) Object.assign(colorById, data.rowColors);
  }
  const getRow = (index: number): RecordData | undefined => {
    const offset = Math.floor(index / PAGE_SIZE) * PAGE_SIZE;
    return byOffset.get(offset)?.[index - offset];
  };

  /** The index of a loaded record in the view, `null` when no loaded page holds it. */
  const indexOf = (recordId: string): number | null => {
    for (const [offset, records] of byOffset) {
      const i = records.findIndex((r) => r.id === recordId);
      if (i >= 0) return offset + i;
    }
    return null;
  };

  /**
   * The records of rows `[from, to]`, loading the pages not in the cache (for copy, paste, fill
   * and clear over ranges larger than the rendered window). Answers a row lookup.
   */
  const loadRows = async (from: number, to: number) => {
    const rows = new Map<number, RecordData>();
    const offsets: number[] = [];
    for (let o = Math.floor(from / PAGE_SIZE) * PAGE_SIZE; o <= to; o += PAGE_SIZE) offsets.push(o);
    const pages = await Promise.all(
      offsets.map(async (offset) => {
        const cached = byOffset.get(offset);
        if (cached) return { offset, records: cached };
        const data = await qc.fetchQuery(
          recordQueries.window(tableId, {
            viewId,
            query,
            offset,
            limit: PAGE_SIZE,
            count: false,
            ...colors,
          })
        );
        return { offset, records: data.records };
      })
    );
    for (const { offset, records } of pages) {
      records.forEach((r, i) => {
        if (offset + i >= from && offset + i <= to) rows.set(offset + i, r);
      });
    }
    return (index: number): RecordData | undefined => rows.get(index);
  };

  return {
    total,
    loadRows,
    getRow,
    indexOf,
    aggregates: head.data?.aggregates,
    groups: head.data?.groups,
    /** Colours of loaded records matching a row colour condition. */
    rowColors: colorById,
    isPending: head.isPending,
    isError: head.isError || pages.some((p) => p.isError),
  };
}
