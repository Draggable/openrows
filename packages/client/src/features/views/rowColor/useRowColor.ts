import type { RowColor, ViewMeta } from '@openrows/shared';
import { useEffect, useRef, useState } from 'react';
import { useUpdateView } from '../../../api/queries';
import { toast } from '../../../components/ui';

/** How long the colour menu waits after the last change before it saves to the view. */
const SAVE_DELAY = 400;

/**
 * The view's row colouring: what it saved, with the user's changes on top at once.
 * `change` saves to the view, debounced, when `canSave` (see `canConfigureView`); otherwise the
 * colours apply for this page only.
 */
export function useRowColor(tableId: string, view: ViewMeta | undefined, canSave: boolean) {
  const update = useUpdateView(tableId);
  const [local, setLocal] = useState<{ value: RowColor | null } | null>(null);
  const rowColor = local ? local.value : (view?.config.rowColor ?? null);

  const pending = useRef<{ value: RowColor | null } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flush = useRef<() => void>(() => {});
  flush.current = () => {
    clearTimeout(timer.current);
    const next = pending.current;
    pending.current = null;
    if (!view || !next) return;
    update.mutate(
      { viewId: view.id, rowColor: next.value },
      { onError: () => toast.error("Couldn't save the view's row colours") }
    );
  };
  useEffect(() => () => flush.current(), []);

  const change = (value: RowColor | null) => {
    setLocal({ value });
    if (!canSave || !view) return;
    pending.current = { value };
    clearTimeout(timer.current);
    timer.current = setTimeout(() => flush.current(), SAVE_DELAY);
  };
  return { rowColor, change };
}
