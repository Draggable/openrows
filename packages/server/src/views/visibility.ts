import { eq, or, type SQL } from 'drizzle-orm';
import { views } from '../db/index.js';

/**
 * The views `userId` may see: collaborative ones and their own personal ones. Every query
 * that reads views by id or lists them for a user filters by it, as `authz_resolve` does.
 */
export function visibleTo(userId: string): SQL {
  return or(eq(views.personal, false), eq(views.createdBy, userId)) as SQL;
}
