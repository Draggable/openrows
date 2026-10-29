import { contracts } from '@openrows/shared';
import { eq } from 'drizzle-orm';
import { audit } from '../audit/record.js';
import { assertSession } from '../authz/policy.js';
import type { RouteRegistry } from '../authz/routes.js';
import { bases } from '../db/index.js';
import { liveFields } from '../fields/service.js';
import { assertTablePermissionsAllowed } from '../usage/quota.js';
import {
  createTable,
  deleteTable,
  duplicateTable,
  liveTables,
  loadTable,
  toTable,
  toTableSummary,
  updateTable,
} from './service.js';

/** Tables of a base: list, create (with default fields), read, update, delete, duplicate. */
export function tableRoutes(routes: RouteRegistry) {
  const t = contracts.tables;

  routes.endpoint(t.list, { resource: 'base', action: 'base:read' }, async (c) => {
    const rows = await liveTables(c.var.tx, c.var.resource.id);
    return { tables: rows.map(toTableSummary) };
  });

  routes.endpoint(
    t.create,
    { resource: 'base', action: 'table:create' },
    async (c, { body: input }) => {
      const { tx, resource, principal } = c.var;
      const [base] = await tx.select().from(bases).where(eq(bases.id, resource.id));
      if (!base) throw new Error('authorized base not visible under RLS');
      const ctx = { tx, workspaceId: resource.workspaceId, userId: principal.user.id };
      return await createTable(ctx, base, input);
    }
  );

  routes.endpoint(t.get, { resource: 'table', action: 'table:read' }, async (c) => {
    const { tx, resource } = c.var;
    const row = await loadTable(tx, resource.id);
    return toTable(row, await liveFields(tx, row.id));
  });

  routes.endpoint(
    t.update,
    { resource: 'table', action: 'table:update' },
    async (c, { body: input }) => {
      const { tx, resource, principal } = c.var;
      if (input.permissions) assertSession(principal, 'Changing edit permissions');
      const ctx = { tx, workspaceId: resource.workspaceId, userId: principal.user.id };
      const row = await loadTable(tx, resource.id);
      // New restrictions need the plan's edit permissions; existing ones keep working.
      if (input.permissions) {
        const plan = await c.var.edition.entitlements.forWorkspace(resource.workspaceId, tx);
        assertTablePermissionsAllowed(plan, row.permissions, input.permissions);
      }
      return await updateTable(ctx, row, input);
    }
  );

  routes.endpoint(t.delete, { resource: 'table', action: 'table:delete' }, async (c) => {
    const { tx, resource, principal } = c.var;
    const ctx = { tx, workspaceId: resource.workspaceId, userId: principal.user.id };
    const table = await loadTable(tx, resource.id);
    await deleteTable(ctx, table);
    await audit(c, tx, {
      workspaceId: resource.workspaceId,
      action: 'table.delete',
      target: { type: 'table', id: table.id, name: table.name },
      summary: { before: { baseId: table.baseId } },
    });
    return null;
  });

  routes.endpoint(
    t.duplicate,
    { resource: 'table', action: 'table:duplicate' },
    async (c, { body: input }) => {
      const { tx, resource, principal } = c.var;
      const ctx = {
        tx,
        workspaceId: resource.workspaceId,
        userId: principal.user.id,
        entitlements: await c.var.edition.entitlements.forWorkspace(resource.workspaceId, tx),
      };
      return await duplicateTable(ctx, await loadTable(tx, resource.id), input);
    }
  );
}
