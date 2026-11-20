import { contracts, type UserRole } from '@openrows/shared';
import type { RouteRegistry } from '../authz/routes.js';
import type { Transaction } from '../db/index.js';
import type { Edition } from '../edition/index.js';
import type { Jobs } from '../jobs/send.js';
import {
  addSource,
  browseSync,
  createSync,
  listSources,
  loadSync,
  previewSync,
  removeSource,
  removeSync,
  requestRun,
  requestSourceRun,
  type SyncContext,
  toTableSync,
  updateSource,
  updateSync,
} from './service.js';
import type { SyncSources } from './sources/index.js';

/**
 * Synced tables. Creating one is on the base (creators: `table:create_sync`), reading the
 * source again on every run as the creator; the sync itself is on the synced table: anyone who
 * reads it sees its sources and their status, editors "Sync now", creators add sources and
 * change, pause or remove them. Sessions only, except reading the status. Resource routes, so
 * other tenants' ids are 404s; a source of another table is a 404 too.
 */
export function syncRoutes(
  routes: RouteRegistry,
  deps: { jobs?: Jobs | undefined; sources?: SyncSources | undefined }
) {
  const s = contracts.syncs;

  const context = async (c: {
    var: {
      tx: Transaction;
      resource: { id: string; workspaceId: string; baseId: string | null; role: UserRole };
      principal: { user: { id: string } };
      edition: Edition;
    };
  }): Promise<SyncContext> => {
    const { tx, resource, principal, edition } = c.var;
    const role = resource.role;
    return {
      tx,
      workspaceId: resource.workspaceId,
      baseId: resource.baseId ?? resource.id,
      userId: principal.user.id,
      role,
      jobs: deps.jobs,
      sources: deps.sources,
      entitlements: await edition.entitlements.forWorkspace(resource.workspaceId, tx),
    };
  };

  routes.endpoint(
    s.create,
    { resource: 'base', action: 'table:create_sync', token: null },
    async (c, { body }) => {
      const created = await createSync(await context(c), body);
      c.var.logger.info({ syncId: created.id, tableId: created.tableId }, 'sync created');
      return created;
    }
  );

  // a CSV URL's or database's columns before the sync is made (the mapping step).
  routes.endpoint(
    s.preview,
    { resource: 'base', action: 'table:create_sync', token: null },
    async (c, { body }) => {
      // The kind only: never the URL or the connection string.
      c.var.logger.info({ kind: body.source.kind }, 'sync source previewed');
      return previewSync(await context(c), body);
    }
  );

  // a sync connector's picker, with the caller's own connected account.
  routes.endpoint(
    s.browse,
    { resource: 'base', action: 'table:create_sync', token: null },
    async (c, { body }) => browseSync(await context(c), body)
  );

  routes.endpoint(s.get, { resource: 'table', action: 'table:read_sync' }, async (c) => {
    const { tx, resource } = c.var;
    return toTableSync(tx, await loadSync(tx, resource.id), resource.role);
  });

  routes.endpoint(
    s.update,
    { resource: 'table', action: 'table:manage_sync', token: null },
    async (c, { body }) => updateSync(await context(c), c.var.resource.id, body)
  );

  routes.endpoint(s.run, { resource: 'table', action: 'table:run_sync', token: null }, async (c) =>
    requestRun(await context(c), c.var.resource.id)
  );

  routes.endpoint(
    s.delete,
    { resource: 'table', action: 'table:manage_sync', token: null },
    async (c) => {
      await removeSync(await context(c), c.var.resource.id);
      c.var.logger.info({ tableId: c.var.resource.id }, 'sync removed');
      return null;
    }
  );

  routes.endpoint(s.sources, { resource: 'table', action: 'table:read_sync' }, async (c) =>
    listSources(c.var.tx, c.var.resource.id, c.var.resource.role)
  );

  routes.endpoint(
    s.addSource,
    { resource: 'table', action: 'table:manage_sync', token: null },
    async (c, { body }) => {
      const added = await addSource(await context(c), c.var.resource.id, body);
      // The kind only: never a URL or a connection string.
      c.var.logger.info(
        { syncId: added.id, tableId: added.tableId, kind: added.source.kind },
        'sync source added'
      );
      return added;
    }
  );

  routes.endpoint(
    s.updateSource,
    { resource: 'table', action: 'table:manage_sync', token: null },
    async (c, { params, body }) =>
      updateSource(await context(c), c.var.resource.id, params.syncId, body)
  );

  routes.endpoint(
    s.runSource,
    { resource: 'table', action: 'table:run_sync', token: null },
    async (c, { params }) => requestSourceRun(await context(c), c.var.resource.id, params.syncId)
  );

  routes.endpoint(
    s.removeSource,
    { resource: 'table', action: 'table:manage_sync', token: null },
    async (c, { params }) => {
      await removeSource(await context(c), c.var.resource.id, params.syncId);
      c.var.logger.info(
        { tableId: c.var.resource.id, syncId: params.syncId },
        'sync source removed'
      );
      return null;
    }
  );
}
