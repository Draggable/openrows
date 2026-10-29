// The record expand view: pure helpers for navigation, keyboard and the record URL.

/** How the expanded record is shown: a centred modal or a panel docked on the right. */
export type ExpandLayout = 'modal' | 'panel';

const LAYOUT_KEY = 'openrows.recordLayout';

/** The layout the user picked last (modal by default). */
export function storedLayout(storage: Pick<Storage, 'getItem'> | undefined): ExpandLayout {
  try {
    return storage?.getItem(LAYOUT_KEY) === 'panel' ? 'panel' : 'modal';
  } catch {
    return 'modal';
  }
}

export function storeLayout(storage: Pick<Storage, 'setItem'> | undefined, layout: ExpandLayout) {
  try {
    storage?.setItem(LAYOUT_KEY, layout);
  } catch {
    // Private mode or storage disabled: the choice lasts for this page only.
  }
}

/** The index of the neighbouring record, or `null` at either end (or when the index is unknown). */
export function neighbour(index: number | null, total: number, step: -1 | 1): number | null {
  if (index === null) return null;
  const next = index + step;
  return next >= 0 && next < total ? next : null;
}

/** "Record 3 of 128" (one-based), or just "Record" when the position isn't known. */
export function positionLabel(index: number | null, total: number): string {
  return index === null
    ? 'Record'
    : `Record ${(index + 1).toLocaleString()} of ${total.toLocaleString()}`;
}

/**
 * The navigation a key asks for inside the expanded record: up/down (or K/J) step through the
 * view's records. Keys typed into an input, a textarea, a listbox or an editor never navigate.
 */
export function navigationKey(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
}): -1 | 1 | null {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;
  const el = e.target as HTMLElement | null;
  if (
    el?.closest?.(
      'input, textarea, select, [contenteditable="true"], [role="dialog"] [role="dialog"], [data-editing]'
    )
  )
    return null;
  if (e.key === 'ArrowUp' || e.key === 'k' || e.key === 'K') return -1;
  if (e.key === 'ArrowDown' || e.key === 'j' || e.key === 'J') return 1;
  return null;
}

/** The shareable link of a record: the view's URL with `?record=<id>`. */
export function recordUrl(origin: string, pathname: string, recordId: string): string {
  const url = new URL(pathname, origin);
  url.searchParams.set('record', recordId);
  return url.toString();
}

/** "Oct 21, 2026" in the user's locale. */
export function shortDate(iso: string, locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "just now", "5 min ago", "2h ago", "3 days ago", then the date. */
export function relativeTime(iso: string, now: number = Date.now(), locale?: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  return shortDate(iso, locale);
}
