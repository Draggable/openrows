import { contracts } from '@openrows/shared';
import type { Context } from 'hono';
import type { ResourceEnv } from '../authz/middleware.js';
import type { RouteRegistry } from '../authz/routes.js';
import { allFieldsVisible, type FieldVisibility } from '../realtime/projection.js';
import { loadTable } from '../tables/service.js';
import { revisionCutoff } from '../usage/quota.js';
import { listRevisions, restoreRevision } from './service.js';

/**
 * Record revision history, under the record: authorized on the table in the path. Reading
 * needs `record:read` (read-only and up; hidden fields are left out, as in events); a restore is
 * a record update (`record:update`, editors and up, then the edit permissions).
 */
export function revisionRoutes(routes: RouteRegistry, deps: { visibility?: FieldVisibility } = {}) {
  const r = contracts.revisions;
  const visibility = deps.visibility ?? allFieldsVisible;

  async function contextOf(c: Context<ResourceEnv<'table'>>, clientOpId?: string) {
    const { tx, resource, principal } = c.var;
    const entitlements = await c.var.edition.entitlements.forWorkspace(resource.workspaceId, tx);
    return {
      tx,
      workspaceId: resource.workspaceId,
      userId: principal.user.id,
      role: resource.role,
      table: await loadTable(tx, resource.id),
      clientOpId,
      // The plan's records per base and history window.
      entitlements,
      since: revisionCutoff(entitlements),
      hidden: visibility.hiddenFields(
        { userId: principal.user.id, role: resource.role },
        resource.id
      ),
    };
  }

  routes.endpoint(
    r.list,
    { resource: 'table', action: 'record:read' },
    async (c, { params, query }) => listRevisions(await contextOf(c), params.recordId, query)
  );

  routes.endpoint(
    r.restore,
    { resource: 'table', action: 'record:update' },
    async (c, { params, body }) =>
      restoreRevision(
        await contextOf(c, body.clientOpId),
        params.recordId,
        params.revisionId,
        body.fieldId
      )
  );
}
