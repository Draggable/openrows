import { useCallback, useSyncExternalStore } from 'react';

/**
 * Breakpoints of the responsive shell: below `md` (768 px) the sidebar is a drawer; from
 * 768 to 1023 px it can collapse to a rail; from 1024 px nothing changes.
 */
export const MOBILE_QUERY = '(max-width: 767.98px)';
export const RAIL_QUERY = '(min-width: 768px) and (max-width: 1023.98px)';
/** A touch screen as the primary pointer: bigger targets, the record sheet instead of inline editing. */
export const TOUCH_QUERY = '(pointer: coarse)';

const mediaList = (query: string) =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query)
    : null;

/** Whether `query` matches, kept current; false where `matchMedia` doesn't exist (tests, SSR). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      const list = mediaList(query);
      list?.addEventListener?.('change', listener);
      return () => list?.removeEventListener?.('change', listener);
    },
    [query]
  );
  return useSyncExternalStore(
    subscribe,
    () => mediaList(query)?.matches ?? false,
    () => false
  );
}
