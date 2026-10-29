/**
 * Windowed loading: the grid fetches the records it shows in pages of `PAGE_SIZE` rows
 * through the view query (`offset` + `limit`), plus a page of overscan on each side.
 * TanStack Query caches each page under its own key, so scrolling back is instant.
 */

export const PAGE_SIZE = 100;

/** Offsets of the pages covering rows `[start, end]` and `overscan` pages around them. */
export function pagesFor(
  start: number,
  end: number,
  total: number,
  pageSize = PAGE_SIZE,
  overscan = 1
): number[] {
  if (total <= 0 || end < start) return [0];
  const last = Math.floor((total - 1) / pageSize);
  const first = Math.max(0, Math.floor(start / pageSize) - overscan);
  const to = Math.min(last, Math.floor(end / pageSize) + overscan);
  const out: number[] = [];
  for (let p = first; p <= to; p++) out.push(p * pageSize);
  return out;
}
