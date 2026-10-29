import { useQuery } from '@tanstack/react-query';
import { workspaceQueries } from '../api/queries';

/** The signed-in user's workspaces, oldest first. */
export function useWorkspaceList() {
  return useQuery({ ...workspaceQueries.list(), select: (d) => d.workspaces });
}
