import {
  pruneViewQuery,
  type SavedViewQuery,
  savedQueryOf,
  type TableMeta,
  type ViewMeta,
} from '@openrows/shared';
import { useEffect, useRef, useState } from 'react';
import { useUpdateView } from '../../../api/queries';
import { toast } from '../../../components/ui';
import { type ToolbarQuery, toolbarQuery } from './model';

/** How long the toolbar waits after the last change before it saves to the view. */
const SAVE_DELAY = 400;

/**
 * The view's filter, sorts and groups: what the view saved (minus entries of fields that
 * are gone), with the user's changes on top at once. `change` also saves to the view, debounced,
 * when the role may (`view:update`, editors and up); lower roles keep their changes for this
 * page only, and the grid still sends them with every query, so they apply on the server.
 */
export function useViewQuery(table: TableMeta, view: ViewMeta | undefined, canSave: boolean) {
  const update = useUpdateView(table.id);
  const [local, setLocal] = useState<SavedViewQuery>({});
  const saved = pruneViewQuery(savedQueryOf(view?.config), table.fields);
  const query: ToolbarQuery = toolbarQuery({ ...saved, ...local });

  const pending = useRef<SavedViewQuery>({});
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flush = useRef<() => void>(() => {});
  flush.current = () => {
    clearTimeout(timer.current);
    const patch = pending.current;
    pending.current = {};
    if (!view || Object.keys(patch).length === 0) return;
    update.mutate(
      { viewId: view.id, query: patch },
      { onError: () => toast.error("Couldn't save the view's filters") }
    );
  };
  // Save what is pending when the view goes away.
  useEffect(() => () => flush.current(), []);

  const change = (patch: SavedViewQuery) => {
    setLocal((l) => ({ ...l, ...patch }));
    if (!canSave || !view) return;
    pending.current = { ...pending.current, ...patch };
    clearTimeout(timer.current);
    timer.current = setTimeout(() => flush.current(), SAVE_DELAY);
  };
  return { query, change, canSave };
}

/** `value`, once it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const key = JSON.stringify(value);
  const [settled, setSettled] = useState(value);
  // biome-ignore lint/correctness/useExhaustiveDependencies: compared by content
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [key, ms]);
  return settled;
}
