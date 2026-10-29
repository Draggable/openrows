import { sql } from 'drizzle-orm';
import { viewRecordPositions } from '../db/index.js';
import type { SortKey } from './query/compile.js';

/** Space between positions when a view's manual order is numbered. */
export const POSITION_GAP = 1024;

/**
 * The ORDER BY key of a view's manual record order (kanban cards), for the query engine:
 * the record's position, records without one last (then oldest first, by the id key).
 */
export function manualOrderKey(viewId: string): SortKey {
  return {
    expr: sql`coalesce((SELECT p.position FROM ${viewRecordPositions} AS p
       WHERE p.view_id = ${viewId} AND p.record_id = r.id), 'Infinity'::float8)`,
    direction: 'asc',
    cast: 'float8',
  };
}
