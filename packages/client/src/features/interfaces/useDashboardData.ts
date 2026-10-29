import type { FieldMeta, InterfaceElement, InterfacePageConfig } from '@openrows/shared';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { queryKeys } from '../../api/keys';
import { tableQueries, useInterfacePageData } from '../../api/queries';
import { onTableChanges } from '../realtime/apply';
import { useRealtimeTables } from '../realtime/RealtimeProvider';
import { asFieldMeta } from '../share/SharedCell';
import type { ElementData } from './Charts';
import { dataFilters, type FilterValues, isDataElement } from './model';

/** How long live changes gather before the page's numbers and charts refetch. */
export const LIVE_REFRESH_MS = 1000;

export interface PageSource {
  baseId: string;
  interfaceId: string;
  pageId: string;
  /** Read the saved draft (editors) rather than the published page. */
  draft: boolean;
  /**
   * An interface-only collaborator: no table metadata or live updates of the base (the
   * fields come with the data instead).
   */
  interfaceOnly?: boolean | undefined;
}

/**
 * The page's numbers and charts: one request for all of them, the fields of their tables
 * (to name groups and format values), and live updates: the element tables are subscribed to,
 * and record or field changes there refetch the data, at most once per LIVE_REFRESH_MS.
 */
export function useDashboardData(
  source: PageSource | undefined,
  config: InterfacePageConfig,
  filterValues: FilterValues,
  pageFields: FieldMeta[]
): ((element: InterfaceElement) => ElementData) | undefined {
  const elements = config.elements.filter(isDataElement);
  const tableIds = [
    ...new Set(
      elements.flatMap((e) => (e.type === 'number' || e.type === 'chart' ? [e.tableId] : []))
    ),
  ];
  const key = tableIds.join(',');
  const enabled = !!source && elements.length > 0;
  const live = enabled && !source?.interfaceOnly;
  const data = useInterfacePageData(
    source?.baseId ?? '',
    { interfaceId: source?.interfaceId ?? '', pageId: source?.pageId ?? '' },
    { draft: source?.draft ?? false, filters: dataFilters(filterValues) },
    enabled
  );
  const others = useQueries({
    queries: tableIds
      .filter((id) => live && id !== config.tableId)
      .map((id) => ({ ...tableQueries.detail(id) })),
  });

  const qc = useQueryClient();
  useRealtimeTables(live ? tableIds : []);
  const baseId = source?.baseId;
  const pageId = source?.pageId;
  useEffect(() => {
    if (!live || !baseId || !pageId) return;
    const ids = key.split(',');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = onTableChanges((changed) => {
      if (!ids.some((id) => changed.has(id)) || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void qc.invalidateQueries({ queryKey: queryKeys.interfaces.data(baseId, pageId) });
      }, LIVE_REFRESH_MS);
    });
    return () => {
      stop();
      if (timer) clearTimeout(timer);
    };
  }, [live, baseId, pageId, key, qc]);

  if (!enabled) return undefined;
  const fieldsOf = (tableId: string): FieldMeta[] | undefined => {
    if (tableId === config.tableId) return pageFields;
    return others.find((q) => q.data?.id === tableId)?.data?.fields;
  };
  return (element) => {
    const answer = data.data?.elements[element.id];
    const sent = answer && answer.type !== 'error' ? answer.fields : undefined;
    return {
      data: answer,
      fields:
        element.type === 'number' || element.type === 'chart'
          ? (fieldsOf(element.tableId) ?? sent?.map(asFieldMeta))
          : [],
      loading: data.isPending || data.isPlaceholderData,
    };
  };
}
