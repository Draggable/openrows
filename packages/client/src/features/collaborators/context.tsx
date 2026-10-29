import type { Collaborator } from '@openrows/shared';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { useCollaborators } from '../../api/queries';

/**
 * The collaborator directory of the workspace on screen: user cells, the record view and
 * the filter's user picker read names, initials and colours from it. Fetched once per workspace
 * and cached by TanStack Query (`queryKeys.workspaces.collaborators`, refreshed by membership
 * changes).
 */
export interface Directory {
  /** Everyone, by name. Empty while loading. */
  list: readonly Collaborator[];
  byId: ReadonlyMap<string, Collaborator>;
  /** The signed-in user (the `me` filter value). */
  meId: string | undefined;
  loaded: boolean;
}

const EMPTY: Directory = { list: [], byId: new Map(), meId: undefined, loaded: false };

/** The context itself, for tests and callers that already hold a directory. */
export const DirectoryContext = createContext<Directory>(EMPTY);

export function CollaboratorsProvider({
  workspaceId,
  meId,
  children,
}: {
  workspaceId: string | undefined;
  meId: string | undefined;
  children: ReactNode;
}) {
  const query = useCollaborators(workspaceId);
  const value = useMemo<Directory>(() => {
    const list = query.data?.collaborators ?? [];
    return { list, byId: new Map(list.map((c) => [c.id, c])), meId, loaded: query.isSuccess };
  }, [query.data, query.isSuccess, meId]);
  return <DirectoryContext.Provider value={value}>{children}</DirectoryContext.Provider>;
}

export const useDirectory = () => useContext(DirectoryContext);
