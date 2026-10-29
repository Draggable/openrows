import { contracts, roleAllows, type SharedInterfaceList } from '@openrows/shared';
import { sql } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ResourceEnv } from '../authz/middleware.js';
import { interfaceOnly } from '../authz/policy.js';
import type { RouteRegistry } from '../authz/routes.js';
import { inScope } from '../authz/scope.js';
import type { Database, Transaction } from '../db/index.js';
import type { EmailTransport } from '../email/transport.js';
import { AppError } from '../lib/errors.js';
import { allFieldsVisible, type FieldVisibility } from '../realtime/projection.js';
import {
  createInvitation,
  type InviteContext,
  listInvitations,
  revokeInvitation,
} from '../workspaces/service.js';
import {
  listInterfaceCollaborators,
  removeInterfaceRole,
  setInterfaceRole,
} from './collaborators.js';
import { pageData } from './data.js';
import {
  interfaceAccess,
  type PageContext,
  pageRecords,
  submitPageForm,
  updatePageRecord,
} from './runtime.js';
import {
  createInterface,
  createPage,
  deleteInterface,
  deletePage,
  type InterfaceContext,
  listInterfaces,
  loadPage,
  publishPage,
  toPage,
  unpublishPage,
  updateInterface,
  updatePage,
} from './service.js';

/**
 * Interfaces under the base. Anyone with a role on the base reads the published pages
 * (`base:read`); creators and owners (`base:manage_interfaces`) also see drafts and unpublished
 * pages, and build and publish them. Sessions only. Resource routes on the base in the path, so
 * ids of other bases and tenants are 404s.
 */
export function interfaceRoutes(
  routes: RouteRegistry,
  deps: {
    db: Database;
    appUrl: string;
    email: EmailTransport;
    visibility?: FieldVisibility | undefined;
  }
) {
  const visibility = deps.visibility ?? allFieldsVisible;
  const i = contracts.interfaces;
  const read = { resource: 'base', action: 'base:read', token: null } as const;
  const manage = { resource: 'base', action: 'base:manage_interfaces', token: null } as const;

  const context = (c: {
    var: {
      tx: Transaction;
      resource: { id: string; workspaceId: string };
      principal: { user: { id: string } };
    };
  }): InterfaceContext => ({
    tx: c.var.tx,
    workspaceId: c.var.resource.workspaceId,
    baseId: c.var.resource.id,
    userId: c.var.principal.user.id,
  });
  const canEdit = (role: Parameters<typeof roleAllows>[0]) =>
    roleAllows(role, 'base:manage_interfaces');

  routes.endpoint(i.list, read, async (c) => {
    const edit = canEdit(c.var.resource.role);
    return {
      interfaces: await listInterfaces(c.var.tx, c.var.resource.id, edit),
      canEdit: edit,
    };
  });

  routes.endpoint(i.create, manage, async (c, { body }) => {
    const created = await createInterface(context(c), body);
    c.var.logger.info({ interfaceId: created.id }, 'interface created');
    return created;
  });

  routes.endpoint(i.update, manage, async (c, { params, body }) =>
    updateInterface(context(c), params.interfaceId, body)
  );

  routes.endpoint(i.delete, manage, async (c, { params }) => {
    await deleteInterface(context(c), params.interfaceId);
    c.var.logger.info({ interfaceId: params.interfaceId }, 'interface deleted');
    return null;
  });

  routes.endpoint(i.createPage, manage, async (c, { params, body }) => {
    const page = await createPage(context(c), params.interfaceId, body);
    c.var.logger.info(
      { interfaceId: params.interfaceId, pageId: page.id },
      'interface page created'
    );
    return page;
  });

  routes.endpoint(i.getPage, read, async (c, { params }) => {
    const edit = canEdit(c.var.resource.role);
    const row = await loadPage(
      c.var.tx,
      c.var.resource.id,
      params.interfaceId,
      params.pageId,
      edit
    );
    return toPage(row, edit);
  });

  routes.endpoint(i.updatePage, manage, async (c, { params, body }) =>
    updatePage(context(c), params.interfaceId, params.pageId, body)
  );

  routes.endpoint(i.deletePage, manage, async (c, { params }) => {
    await deletePage(context(c), params.interfaceId, params.pageId);
    c.var.logger.info({ pageId: params.pageId }, 'interface page deleted');
    return null;
  });

  routes.endpoint(i.publishPage, manage, async (c, { params }) => {
    const page = await publishPage(context(c), params.interfaceId, params.pageId);
    c.var.logger.info({ pageId: page.id }, 'interface page published');
    return page;
  });

  routes.endpoint(i.unpublishPage, manage, async (c, { params }) => {
    const page = await unpublishPage(context(c), params.interfaceId, params.pageId);
    c.var.logger.info({ pageId: page.id }, 'interface page unpublished');
    return page;
  });

  // ---- the interface itself: its viewers, interface-only collaborators included ----

  const view = { resource: 'interface', action: 'interface:read', token: null } as const;
  const write = { resource: 'interface', action: 'interface:write', token: null } as const;
  const members = {
    resource: 'interface',
    action: 'interface:manage_members',
    token: null,
  } as const;
  type IfaceContext = Context<ResourceEnv<'interface'>>;
  const baseOf = (c: IfaceContext): string => {
    const { baseId } = c.var.resource;
    if (!baseId) throw new Error('interface without a base');
    return baseId;
  };
  /** Interface-only collaborators never see drafts, whatever their role. */
  const edits = (c: IfaceContext) => !interfaceOnly(c.var.resource) && canEdit(c.var.resource.role);
  const pageContext = (c: IfaceContext): PageContext => ({
    tx: c.var.tx,
    workspaceId: c.var.resource.workspaceId,
    baseId: baseOf(c),
    userId: c.var.principal.user.id,
    role: c.var.resource.role,
    visibility,
  });
  /** The page's published copy, or (editors, `draft`) its saved draft; 404 otherwise. */
  const pageConfig = async (c: IfaceContext, pageId: string, draft: boolean) => {
    const edit = edits(c);
    const row = await loadPage(c.var.tx, baseOf(c), c.var.resource.id, pageId, edit);
    const page = toPage(row, edit);
    const config = draft ? page.draft : page.published;
    if (!config) {
      throw new AppError('NOT_FOUND', {
        detail: draft ? 'No such draft.' : 'This page is not published.',
      });
    }
    return config;
  };

  routes.endpoint(i.get, view, async (c) => {
    const { resource } = c.var;
    return interfaceAccess(
      c.var.tx,
      {
        id: resource.id,
        workspaceId: resource.workspaceId,
        baseId: baseOf(c),
        role: resource.role,
      },
      interfaceOnly(resource)
    );
  });

  routes.endpoint(i.pageRecords, view, async (c, { params, body }) =>
    pageRecords(pageContext(c), await pageConfig(c, params.pageId, body.draft), body)
  );

  routes.endpoint(i.updatePageRecord, write, async (c, { params, body }) => {
    const ctx = pageContext(c);
    await updatePageRecord(
      {
        ...ctx,
        entitlements: await c.var.edition.entitlements.forWorkspace(ctx.workspaceId, ctx.tx),
      },
      await pageConfig(c, params.pageId, false),
      params.recordId,
      body.fields
    );
    return null;
  });

  routes.endpoint(i.submitPageForm, write, async (c, { params, body }) => {
    const ctx = pageContext(c);
    const created = await submitPageForm(
      {
        ...ctx,
        entitlements: await c.var.edition.entitlements.forWorkspace(ctx.workspaceId, ctx.tx),
      },
      await pageConfig(c, params.pageId, false),
      body.fields
    );
    c.var.logger.info({ pageId: params.pageId, recordId: created.id }, 'interface form submitted');
    return created;
  });

  // A page's numbers and charts, as the caller may read them: the published copy, or for
  // editors the saved draft (`draft`); a draft asked for by anyone else is missing.
  routes.endpoint(i.pageData, view, async (c, { params, body }) =>
    pageData(pageContext(c), await pageConfig(c, params.pageId, body.draft), body.filters)
  );

  routes.endpoint(i.sharedWithMe, 'session', async (c) => {
    const userId = c.var.principal.user.id;
    const rows = await inScope(deps.db, { userId }, async (tx) => {
      const { rows } = await tx.execute<{
        id: string;
        name: string;
        base_id: string;
        base_name: string;
        workspace_name: string;
        role: 'editor' | 'read_only';
      }>(sql`SELECT * FROM interfaces_shared_with(${userId}::uuid)`);
      return rows;
    });
    const list: SharedInterfaceList = {
      interfaces: rows.map((r) => ({
        id: r.id,
        name: r.name,
        baseId: r.base_id,
        baseName: r.base_name,
        workspaceName: r.workspace_name,
        role: r.role,
      })),
    };
    return list;
  });

  const inviteContext = (c: IfaceContext): InviteContext => ({
    tx: c.var.tx,
    workspaceId: c.var.resource.workspaceId,
    baseId: baseOf(c),
    interfaceId: c.var.resource.id,
    actor: c.var.principal.user,
    actorRole: c.var.resource.role,
    appUrl: deps.appUrl,
    email: deps.email,
    logger: c.var.logger,
  });

  routes.endpoint(i.collaborators, members, async (c) => ({
    collaborators: await listInterfaceCollaborators(c.var.tx, c.var.resource.id),
    invitations: await listInvitations(
      c.var.tx,
      c.var.resource.workspaceId,
      baseOf(c),
      c.var.resource.id
    ),
  }));

  routes.endpoint(i.inviteCollaborator, members, async (c, { body }) => {
    const invitation = await createInvitation(inviteContext(c), body);
    c.var.logger.info(
      { interfaceId: c.var.resource.id, invitationId: invitation.id },
      'interface invitation sent'
    );
    return invitation;
  });

  routes.endpoint(i.updateCollaborator, members, async (c, { params, body }) =>
    setInterfaceRole(c.var.tx, c.var.resource.id, params.userId, body.role)
  );

  routes.endpoint(i.removeCollaborator, members, async (c, { params }) => {
    await removeInterfaceRole(c.var.tx, c.var.resource.id, params.userId);
    return null;
  });

  routes.endpoint(i.revokeInvitation, members, async (c, { params }) => {
    const { tx, resource } = c.var;
    await revokeInvitation(
      tx,
      resource.workspaceId,
      resource.role,
      params.invitationId,
      baseOf(c),
      resource.id
    );
    return null;
  });
}
