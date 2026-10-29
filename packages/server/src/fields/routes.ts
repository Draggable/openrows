import { contracts } from '@openrows/shared';
import { audit } from '../audit/record.js';
import { assertSession } from '../authz/policy.js';
import type { RouteRegistry } from '../authz/routes.js';
import { linkCandidates } from '../records/service.js';
import { loadField, loadTable } from '../tables/service.js';
import { assertFieldPermissionsAllowed } from '../usage/quota.js';
import {
  createField,
  deleteField,
  restoreField,
  toField,
  trashedFields,
  updateField,
} from './service.js';

/** Fields: add, change (rename, reorder, convert), delete to the trash and restore. */
export function fieldRoutes(routes: RouteRegistry) {
  const f = contracts.fields;

  routes.endpoint(
    f.create,
    { resource: 'table', action: 'field:create' },
    async (c, { body: input }) => {
      const { tx, resource, principal } = c.var;
      const ctx = { tx, workspaceId: resource.workspaceId, userId: principal.user.id };
      const row = await createField(ctx, await loadTable(tx, resource.id), input);
      return toField(row);
    }
  );

  routes.endpoint(f.trash, { resource: 'table', action: 'table:read' }, async (c) => {
    const rows = await trashedFields(c.var.tx, c.var.resource.id);
    return { fields: rows.map(toField) };
  });

  routes.endpoint(
    f.restore,
    { resource: 'table', action: 'field:restore' },
    async (c, { params }) => {
      const { tx, resource, principal } = c.var;
      const ctx = { tx, workspaceId: resource.workspaceId, userId: principal.user.id };
      const table = await loadTable(tx, resource.id);
      const row = await restoreField(ctx, table, params.deletedFieldId);
      return toField(row);
    }
  );

  routes.endpoint(
    f.update,
    { resource: 'field', action: 'field:update' },
    async (c, { body: input }) => {
      const { tx, resource, principal } = c.var;
      if (input.permissions) assertSession(principal, 'Changing edit permissions');
      const ctx = {
        tx,
        workspaceId: resource.workspaceId,
        userId: principal.user.id,
        role: resource.role,
        // A conversion to a link may create linked records (records per base).
        entitlements: await c.var.edition.entitlements.forWorkspace(resource.workspaceId, tx),
      };
      const field = await loadField(tx, resource.id);
      // New restrictions need the plan's edit permissions; existing ones keep working.
      assertFieldPermissionsAllowed(ctx.entitlements, field.permissions, input.permissions);
      const row = await updateField(ctx, field, input);
      return toField(row);
    }
  );

  routes.endpoint(f.delete, { resource: 'field', action: 'field:delete' }, async (c) => {
    const { tx, resource, principal } = c.var;
    const ctx = { tx, workspaceId: resource.workspaceId, userId: principal.user.id };
    const field = await loadField(tx, resource.id);
    await deleteField(ctx, field);
    await audit(c, tx, {
      workspaceId: resource.workspaceId,
      action: 'field.delete',
      target: { type: 'field', id: field.id, name: field.name },
      summary: { before: { tableId: field.tableId, type: field.type } },
    });
    return null;
  });

  routes.endpoint(
    f.linkCandidates,
    { resource: 'field', action: 'field:link_candidates', param: 'linkFieldId' },
    async (c, { query }) => {
      const { tx, resource, principal } = c.var;
      const field = await loadField(tx, resource.id);
      const table = await loadTable(tx, field.tableId);
      const ctx = { tx, workspaceId: resource.workspaceId, userId: principal.user.id, table };
      return linkCandidates(ctx, field.id, query);
    }
  );
}
