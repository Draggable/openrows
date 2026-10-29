/**
 * A view toolbar button's label. The toolbars are `toolbar` containers: narrower than
 * 960 px (beside the extension panel at 1280 px, say), the buttons show their icon and count only,
 * and the label stays the button's accessible name and its `title`.
 */
export function ToolbarLabel({ label, count }: { label: string; count?: number | undefined }) {
  return (
    <>
      <span className={TOOLBAR_LABEL}>{label}</span>
      {count ? ` (${count.toLocaleString()})` : null}
    </>
  );
}

/** The toolbar's container: put it on each view toolbar's root. */
export const TOOLBAR_CONTAINER = '@container/toolbar';
const TOOLBAR_LABEL = '@max-[960px]/toolbar:sr-only';

/**
 * The view toolbars' row: when even icon-only buttons don't fit, it scrolls sideways instead of
 * running under a side panel. `relative` keeps the hidden labels inside it.
 */
export const TOOLBAR_CLASS = `${TOOLBAR_CONTAINER} relative flex h-11 shrink-0 items-center gap-1 overflow-x-auto overscroll-x-contain border-b border-border px-3 pointer-coarse:h-[52px]`;

/** The find input's box: it gives up width (down to `min-w-36`) before anything is hidden. */
export const FIND_BOX_CLASS =
  'flex h-7 min-w-36 shrink items-center gap-1 rounded-sm border border-border bg-surface px-2 focus-within:border-brand focus-within:shadow-[0_0_0_1px_var(--brand)]';
