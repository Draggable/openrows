/** `base`, `base 2`, `base 3`…: the first name not in `taken` (case-insensitive). */
export function nextFreeName(base: string, taken: readonly string[]): string {
  const lower = new Set(taken.map((n) => n.toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

/** `Table 2`, `Table 3`…: numbered from the count after `taken`, skipping names in use. */
export function nextNumberedName(base: string, taken: readonly string[]): string {
  const lower = new Set(taken.map((n) => n.toLowerCase()));
  for (let n = taken.length + 1; ; n++) {
    const candidate = `${base} ${n}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

/** A position between two neighbours, for reordering lists sorted by `position`. */
export function positionBetween(before?: number, after?: number): number {
  if (before === undefined && after === undefined) return 1;
  if (before === undefined) return (after as number) - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}

/** The browser's IANA time zone, or undefined when it doesn't say. */
export function browserTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && zone !== 'Etc/Unknown' ? zone : undefined;
  } catch {
    return undefined;
  }
}

/**
 * "Good morning/afternoon/evening" for the home greeting, by the hour in the user's time zone
 * ; "Welcome back" when the time zone isn't known or isn't valid.
 */
export function greeting(
  date = new Date(),
  timeZone: string | null | undefined = browserTimeZone()
): string {
  if (!timeZone) return 'Welcome back';
  let h: number;
  try {
    h = Number(
      new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(date)
    );
  } catch {
    return 'Welcome back';
  }
  if (!Number.isInteger(h)) return 'Welcome back';
  if (h < 5 || h >= 18) return 'Good evening';
  if (h < 12) return 'Good morning';
  return 'Good afternoon';
}

/** Up to two initials for an avatar. */
export function initials(name: string): string {
  const parts = name
    .trim()
    .split(/[\s@._-]+/)
    .filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

/** The move of item `index` one step `dir` (-1 up, 1 down) as a new position, or null. */
export function movedPosition(
  items: readonly { position: number }[],
  index: number,
  dir: -1 | 1
): number | null {
  const target = index + dir;
  if (target < 0 || target >= items.length) return null;
  const neighbour = items[target + dir];
  return dir === -1
    ? positionBetween(neighbour?.position, items[target]?.position)
    : positionBetween(items[target]?.position, neighbour?.position);
}

/** How each workspace role reads in the UI. */
export const ROLE_LABELS = {
  owner: 'Owner',
  creator: 'Creator',
  editor: 'Editor',
  commenter: 'Commenter',
  read_only: 'Read only',
} as const;
