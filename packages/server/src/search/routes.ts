import { contracts } from '@openrows/shared';
import type { RouteRegistry } from '../authz/routes.js';
import type { Database } from '../db/index.js';
import { allFieldsVisible, type FieldVisibility } from '../realtime/projection.js';
import { searchRecords } from './service.js';

/**
 * `GET /api/v1/search`: records across every table and base the caller may read, by text.
 * A session route (it names no base) that personal access tokens with `data.records:read`
 * may call too; each base and table is then authorized for `record:read` in the service, the
 * same decision as the record routes', so search never reaches further than listing records.
 *
 * The prototype's unmounted `GET /api/search` stays unmounted (app.test.ts): this is a new,
 * permission-aware endpoint under the versioned API, not that router.
 */
export function searchRoutes(
  routes: RouteRegistry,
  deps: { db: Database; visibility?: FieldVisibility | undefined }
) {
  const search = { db: deps.db, visibility: deps.visibility ?? allFieldsVisible };
  routes.endpoint(
    contracts.v1Search.records,
    'session',
    (c, { query }) => searchRecords(search, c.var.principal, query),
    { token: 'data.records:read' }
  );
}
