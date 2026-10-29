import { useQuery } from '@tanstack/react-query';
import { baseQueries, tableQueries, useAiAvailability } from '../../api/queries';

/**
 * Whether the table's workspace has an AI provider: AI fields are offered only then. The
 * table and its base are read from the cache (the base page has them), never fetched here.
 */
export function useAiFieldsAvailable(tableId: string): boolean {
  const table = useQuery({ ...tableQueries.detail(tableId), enabled: false });
  const baseId = table.data?.baseId ?? '';
  const base = useQuery({ ...baseQueries.detail(baseId), enabled: false });
  return useAiAvailability(base.data?.workspaceId).data?.available === true;
}
