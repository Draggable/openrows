import { contracts, roleAllows } from '@openrows/shared';
import type { RouteRegistry } from '../authz/routes.js';
import type { Transaction } from '../db/index.js';
import {
  createScript,
  deleteScript,
  getScript,
  listScripts,
  type ScriptContext,
  updateScript,
} from './service.js';

/**
 * Saved scripts under the base: editors and up read them (`base:read_scripts`, they run
 * them in the browser), creators and owners write them (`base:manage_scripts`). Sessions only.
 * Resource routes on the base in the path, so other bases' and tenants' ids are 404s.
 */
export function scriptRoutes(routes: RouteRegistry) {
  const s = contracts.scripts;
  const read = { resource: 'base', action: 'base:read_scripts', token: null } as const;
  const manage = { resource: 'base', action: 'base:manage_scripts', token: null } as const;

  const context = (c: {
    var: {
      tx: Transaction;
      resource: { id: string; workspaceId: string };
      principal: { user: { id: string } };
    };
  }): ScriptContext => ({
    tx: c.var.tx,
    workspaceId: c.var.resource.workspaceId,
    baseId: c.var.resource.id,
    userId: c.var.principal.user.id,
  });

  routes.endpoint(s.list, read, async (c) => ({
    scripts: await listScripts(c.var.tx, c.var.resource.id),
    canEdit: roleAllows(c.var.resource.role, 'base:manage_scripts'),
  }));

  routes.endpoint(s.get, read, async (c, { params }) =>
    getScript(c.var.tx, c.var.resource.id, params.scriptId)
  );

  routes.endpoint(s.create, manage, async (c, { body }) => {
    const created = await createScript(context(c), body);
    c.var.logger.info({ scriptId: created.id }, 'script created');
    return created;
  });

  routes.endpoint(s.update, manage, async (c, { params, body }) =>
    updateScript(context(c), params.scriptId, body)
  );

  routes.endpoint(s.delete, manage, async (c, { params }) => {
    await deleteScript(context(c), params.scriptId);
    c.var.logger.info({ scriptId: params.scriptId }, 'script deleted');
    return null;
  });
}
