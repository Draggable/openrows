import { type GridLayout, gridLayoutOf, type ViewMeta } from '@openrows/shared';
import { useState } from 'react';
import { useUpdateView } from '../../api/queries';
import { toast } from '../../components/ui';

/**
 * The view's grid layout: what the view saved, with the user's changes on top at once.
 * `preview` changes it on screen only (while dragging a column edge); `save` also persists it
 * to the view when the role may (`view:update`, editors and up); lower roles keep the change
 * for this page only, as their own arrangement.
 */
export function useGridLayout(tableId: string, view: ViewMeta | undefined, canSave: boolean) {
  const update = useUpdateView(tableId);
  const [local, setLocal] = useState<GridLayout>({});
  const layout: GridLayout = { ...gridLayoutOf(view?.config), ...local };

  const preview = (patch: GridLayout) => setLocal((l) => ({ ...l, ...patch }));
  const save = (patch: GridLayout) => {
    preview(patch);
    if (!canSave || !view) return;
    update.mutate(
      { viewId: view.id, grid: patch },
      { onError: () => toast.error("Couldn't save the view's layout") }
    );
  };
  return { layout, preview, save };
}
