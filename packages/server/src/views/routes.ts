import { contracts, formLayoutOf, type UpdateViewInput, type UserRole } from '@openrows/shared';
import { audit } from '../audit/record.js';
import type { Principal } from '../auth/sessions.js';
import { principalMay } from '../authz/policy.js';
import type { RouteRegistry } from '../authz/routes.js';
import type { Transaction } from '../db/index.js';
import type { Edition, Entitlements } from '../edition/types.js';
import { loadTable } from '../tables/service.js';
import { assertFeature } from '../usage/quota.js';
import { createSection, deleteSection, listSections, updateSection } from './sections.js';
import {
  createView,
  deleteView,
  duplicateView,
  liveViews,
  loadView,
  moveViewRecord,
  toView,
  updateView,
  type ViewRights,
  type ViewRow,
  viewFieldsOf,
} from './service.js';

// Locking is a permission change: never with a personal access token.
const rightsOf = (principal: Principal, role: UserRole): ViewRights => ({
  canLock: principalMay(principal, role, 'view:lock'),
});

/** The workspace's plan, in the request's transaction. */
const planOf = (c: { var: { tx: Transaction; edition: Edition } }, workspaceId: string) =>
  c.var.edition.entitlements.forWorkspace(workspaceId, c.var.tx);

/**
 * Plan features of a view change: turning a view personal, locking it and removing a
 * form's branding need the plan; what a view already is keeps working after a downgrade, and
 * unlocking, making it collaborative or showing the branding again never need it.
 */
function assertViewFeatures(plan: Entitlements, row: ViewRow, input: UpdateViewInput) {
  if (input.personal === true && !row.personal) assertFeature(plan, 'personalViews');
  if (input.locked === true && !row.locked) assertFeature(plan, 'lockedViews');
  if (
    input.form?.showBranding === false &&
    formLayoutOf((row.config ?? {}) as Record<string, unknown>).showBranding !== false
  ) {
    assertFeature(plan, 'removeBranding');
  }
}

/**
 * Views of a table: list, create, read, rename/reorder, duplicate, delete, the manual
 * record order of kanban cards, and personal and locked views and sidebar sections.
 * A personal view of someone else doesn't resolve (`authz_resolve`), so its routes answer 404.
 */
export function viewRoutes(routes: RouteRegistry) {
  const v = contracts.views;

  routes.endpoint(v.list, { resource: 'table', action: 'table:read' }, async (c) => {
    const { tx, resource, principal } = c.var;
    const tableFields = await viewFieldsOf(tx, resource.id);
    const rows = await liveViews(tx, resource.id, principal.user.id);
    return {
      views: rows.map((row) => toView(row, tableFields)),
      sections: await listSections(tx, resource.id),
    };
  });

  routes.endpoint(
    v.create,
    { resource: 'table', action: 'view:create' },
    async (c, { body: input }) => {
      const { tx, resource, principal } = c.var;
      const ctx = { tx, workspaceId: resource.workspaceId, userId: principal.user.id };
      if (input.personal) {
        assertFeature(await planOf(c, resource.workspaceId), 'personalViews');
      }
      return await createView(ctx, await loadTable(tx, resource.id), input);
    }
  );

  routes.endpoint(v.get, { resource: 'view', action: 'view:read' }, async (c) => {
    const row = await loadView(c.var.tx, c.var.resource.id);
    return toView(row, await viewFieldsOf(c.var.tx, row.tableId));
  });

  routes.endpoint(
    v.update,
    { resource: 'view', action: 'view:update' },
    async (c, { body: input }) => {
      const { tx, resource, principal } = c.var;
      const ctx = { tx, workspaceId: resource.workspaceId, userId: principal.user.id };
      const row = await loadView(tx, resource.id);
      assertViewFeatures(await planOf(c, resource.workspaceId), row, input);
      return await updateView(ctx, row, input, rightsOf(principal, resource.role));
    }
  );

  routes.endpoint(v.delete, { resource: 'view', action: 'view:delete' }, async (c) => {
    const { tx, resource, principal } = c.var;
    const ctx = { tx, workspaceId: resource.workspaceId, userId: principal.user.id };
    const view = await loadView(tx, resource.id);
    await deleteView(ctx, view, rightsOf(principal, resource.role));
    await audit(c, tx, {
      workspaceId: resource.workspaceId,
      action: 'view.delete',
      target: { type: 'view', id: view.id, name: view.name },
      summary: { before: { tableId: view.tableId, type: view.type } },
    });
    return null;
  });

  routes.endpoint(
    v.duplicate,
    { resource: 'view', action: 'view:duplicate' },
    async (c, { body: input }) => {
      const { tx, resource, principal } = c.var;
      const ctx = { tx, workspaceId: resource.workspaceId, userId: principal.user.id };
      const row = await loadView(tx, resource.id);
      // The copy of a personal view is a new personal view.
      if (row.personal) assertFeature(await planOf(c, resource.workspaceId), 'personalViews');
      return await duplicateView(ctx, row, input);
    }
  );

  routes.endpoint(
    v.moveRecord,
    { resource: 'view', action: 'view:update' },
    async (c, { body: input }) => {
      const { tx, resource, principal } = c.var;
      const ctx = { tx, workspaceId: resource.workspaceId, userId: principal.user.id };
      await moveViewRecord(
        ctx,
        await loadView(tx, resource.id),
        input,
        rightsOf(principal, resource.role)
      );
      return null;
    }
  );

  routes.endpoint(
    v.createSection,
    { resource: 'table', action: 'viewSection:create' },
    async (c, { body: input }) => {
      const { tx, resource, principal } = c.var;
      const ctx = { tx, workspaceId: resource.workspaceId, userId: principal.user.id };
      return await createSection(ctx, await loadTable(tx, resource.id), input);
    }
  );

  routes.endpoint(
    v.updateSection,
    { resource: 'table', action: 'viewSection:update' },
    async (c, { params, body: input }) => {
      const { tx, resource, principal } = c.var;
      const ctx = { tx, workspaceId: resource.workspaceId, userId: principal.user.id };
      return await updateSection(ctx, await loadTable(tx, resource.id), params.sectionId, input);
    }
  );

  routes.endpoint(
    v.deleteSection,
    { resource: 'table', action: 'viewSection:delete' },
    async (c, { params }) => {
      const { tx, resource, principal } = c.var;
      const ctx = { tx, workspaceId: resource.workspaceId, userId: principal.user.id };
      await deleteSection(ctx, await loadTable(tx, resource.id), params.sectionId);
      return null;
    }
  );
}
