import { contracts, type ResourceKind } from '@openrows/shared';
import type { Context } from 'hono';
import { audit } from '../audit/record.js';
import type { ResourceEnv } from '../authz/middleware.js';
import { principalMay } from '../authz/policy.js';
import type { RouteRegistry } from '../authz/routes.js';

import { purgeBase, restoreBase } from '../bases/service.js';
import { purgeField } from '../fields/service.js';
import { purgeRecords, type RecordContext, trashedRecords } from '../records/service.js';
import { loadTable, purgeTable, restoreTable } from '../tables/service.js';
import { purgeView, restoreView } from '../views/service.js';
import { baseTrash, workspaceTrash } from './service.js';

/** The schema context of an authorized route. */
function schemaOf<K extends ResourceKind>(c: Context<ResourceEnv<K>>) {
  const { tx, resource, principal } = c.var;
  return { tx, workspaceId: resource.workspaceId, userId: principal.user.id };
}

/** The schema context of a restore that brings records back (records per base). */
async function restoringOf<K extends ResourceKind>(c: Context<ResourceEnv<K>>) {
  const { tx, resource } = c.var;
  return {
    ...schemaOf(c),
    entitlements: await c.var.edition.entitlements.forWorkspace(resource.workspaceId, tx),
  };
}

/**
 * The trash: what was deleted, by whom and when, with restore and "delete permanently".
 * Bases are listed and restored through their workspace and tables through their base, since a
 * trashed one doesn't resolve itself (`authz_resolve`); fields, views and records through their
 * live table. Restores go through the services (outbox events, realtime, revisions), and every
 * id is looked up in the authorized parent only.
 */
export function trashRoutes(routes: RouteRegistry) {
  const t = contracts.trash;

  routes.endpoint(t.workspace, { resource: 'workspace', action: 'workspace:read_trash' }, (c) =>
    workspaceTrash(c.var.tx, c.var.resource.id)
  );
  routes.endpoint(
    t.restoreBase,
    { resource: 'workspace', action: 'base:restore' },
    async (c, { params }) => {
      const base = await restoreBase(schemaOf(c), params.trashedBaseId, c.var.resource.role);
      await audit(c, c.var.tx, {
        workspaceId: c.var.resource.id,
        action: 'base.restore',
        target: { type: 'base', id: params.trashedBaseId, name: base.name },
      });
      return base;
    }
  );
  routes.endpoint(
    t.purgeBase,
    { resource: 'workspace', action: 'base:purge' },
    async (c, { params }) => {
      await purgeBase(schemaOf(c), params.trashedBaseId);
      c.var.logger.info({ baseId: params.trashedBaseId }, 'base deleted permanently');
      await audit(c, c.var.tx, {
        workspaceId: c.var.resource.id,
        action: 'base.destroy',
        target: { type: 'base', id: params.trashedBaseId },
      });
      return null;
    }
  );

  routes.endpoint(t.base, { resource: 'base', action: 'base:read_trash' }, (c) =>
    baseTrash(c.var.tx, c.var.resource.id, c.var.principal.user.id)
  );
  routes.endpoint(
    t.restoreTable,
    { resource: 'base', action: 'table:restore' },
    async (c, { params }) =>
      restoreTable(await restoringOf(c), c.var.resource.id, params.trashedTableId)
  );
  routes.endpoint(
    t.purgeTable,
    { resource: 'base', action: 'table:purge' },
    async (c, { params }) => {
      await purgeTable(schemaOf(c), c.var.resource.id, params.trashedTableId);
      c.var.logger.info({ tableId: params.trashedTableId }, 'table deleted permanently');
      return null;
    }
  );

  routes.endpoint(
    t.purgeField,
    { resource: 'table', action: 'field:purge' },
    async (c, { params }) => {
      await purgeField(
        schemaOf(c),
        await loadTable(c.var.tx, c.var.resource.id),
        params.trashedFieldId
      );
      return null;
    }
  );

  const viewRights = (c: Context<ResourceEnv<'table'>>) => ({
    canLock: principalMay(c.var.principal, c.var.resource.role, 'view:lock'),
  });
  routes.endpoint(t.restoreView, { resource: 'table', action: 'view:restore' }, (c, { params }) =>
    restoreView(schemaOf(c), c.var.resource.id, params.trashedViewId, viewRights(c))
  );
  routes.endpoint(
    t.purgeView,
    { resource: 'table', action: 'view:purge' },
    async (c, { params }) => {
      await purgeView(schemaOf(c), c.var.resource.id, params.trashedViewId, viewRights(c));
      return null;
    }
  );

  const recordContext = async (c: Context<ResourceEnv<'table'>>): Promise<RecordContext> => ({
    ...schemaOf(c),
    table: await loadTable(c.var.tx, c.var.resource.id),
    role: c.var.resource.role,
    entitlements: await c.var.edition.entitlements.forWorkspace(
      c.var.resource.workspaceId,
      c.var.tx
    ),
  });
  routes.endpoint(
    t.records,
    { resource: 'table', action: 'record:read_trash' },
    async (c, { query }) => trashedRecords(await recordContext(c), query)
  );
  routes.endpoint(
    t.purgeRecords,
    { resource: 'table', action: 'record:purge' },
    async (c, { body }) => purgeRecords(await recordContext(c), body.recordIds)
  );
}
