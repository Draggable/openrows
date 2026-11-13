import { SEARCH_QUERY_MAX, SEARCH_QUERY_MIN, type SearchHit } from '@openrows/shared';

/** How long the palette waits after the last keystroke before it searches records. */
export const RECORD_SEARCH_DEBOUNCE_MS = 250;

/**
 * The text the palette searches records for: the input trimmed, or null when it's too short
 * (the API refuses fewer than `SEARCH_QUERY_MIN` characters) or too long.
 */
export function recordSearchTerm(input: string): string | null {
  const term = input.trim();
  return term.length >= SEARCH_QUERY_MIN && term.length <= SEARCH_QUERY_MAX ? term : null;
}

/** A hit's title: its primary field's text, or a stand-in when that cell is empty. */
export function hitTitle(hit: SearchHit): string {
  return hit.name.trim() || 'Unnamed record';
}

/**
 * What tells two hits apart under their titles: where the record lives (base › table) and the
 * first other field that matched.
 */
export function hitContext(hit: SearchHit): { where: string; match: string | null } {
  const [first] = hit.matches;
  return {
    where: `${hit.baseName} › ${hit.tableName}`,
    match: first ? `${first.fieldName}: ${first.text}` : null,
  };
}
