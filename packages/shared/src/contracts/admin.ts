import { z } from 'zod';
import {
  AdminAuditListSchema,
  AdminUserDetailSchema,
  AdminUserListSchema,
  AdminWorkspaceDetailSchema,
  AdminWorkspaceListSchema,
  adminAuditQuerySchema,
  adminListQuerySchema,
  adminSetPlanSchema,
  adminSuspensionSchema,
  ImpersonationStartedSchema,
  impersonateSchema,
} from '../schemas/admin.js';
import { defineEndpoint as e } from './endpoint.js';

/**
 * The hosted ops console's endpoints. Apart from `contracts`: only the hosted edition
 * serves them, to system admins with a fresh sign-in, and they aren't in the public
 * OpenAPI document. Everyone else gets 404 from every one.
 */
export const adminContracts = {
  workspaces: {
    list: e({
      method: 'GET',
      path: '/api/admin/workspaces',
      summary: 'Workspaces with plan, usage, created and last active (system admins)',
      tag: 'admin',
      query: adminListQuerySchema,
      response: AdminWorkspaceListSchema,
      status: 200,
    }),
    get: e({
      method: 'GET',
      path: '/api/admin/workspaces/:workspaceId',
      summary: "A workspace's plan, usage, members, tokens and webhooks (system admins)",
      tag: 'admin',
      params: { workspaceId: z.uuid() },
      response: AdminWorkspaceDetailSchema,
      status: 200,
    }),
    setPlan: e({
      method: 'PUT',
      path: '/api/admin/workspaces/:workspaceId/plan',
      summary: "Set a workspace's plan and overrides (system admins)",
      tag: 'admin',
      params: { workspaceId: z.uuid() },
      body: adminSetPlanSchema,
      response: null,
      status: 204,
    }),
    setSuspension: e({
      method: 'PUT',
      path: '/api/admin/workspaces/:workspaceId/suspension',
      summary:
        'Suspend a workspace (read-only for members, share links and forms off) or lift it (system admins)',
      tag: 'admin',
      params: { workspaceId: z.uuid() },
      body: adminSuspensionSchema,
      response: null,
      status: 204,
    }),
    revokeWebhook: e({
      method: 'DELETE',
      path: '/api/admin/workspaces/:workspaceId/webhooks/:webhookId',
      summary: 'Delete a webhook of the workspace (system admins)',
      tag: 'admin',
      params: { workspaceId: z.uuid(), webhookId: z.uuid() },
      response: null,
      status: 204,
    }),
  },
  users: {
    list: e({
      method: 'GET',
      path: '/api/admin/users',
      summary: 'Users with created and last active (system admins)',
      tag: 'admin',
      query: adminListQuerySchema,
      response: AdminUserListSchema,
      status: 200,
    }),
    get: e({
      method: 'GET',
      path: '/api/admin/users/:userId',
      summary: "A user's memberships and personal access tokens (system admins)",
      tag: 'admin',
      params: { userId: z.uuid() },
      response: AdminUserDetailSchema,
      status: 200,
    }),
    setSuspension: e({
      method: 'PUT',
      path: '/api/admin/users/:userId/suspension',
      summary: 'Suspend a user (signed out, sign-in and tokens refused) or lift it (system admins)',
      tag: 'admin',
      params: { userId: z.uuid() },
      body: adminSuspensionSchema,
      response: null,
      status: 204,
    }),
    revokeToken: e({
      method: 'DELETE',
      path: '/api/admin/users/:userId/tokens/:tokenId',
      summary: "Revoke a user's personal access token (system admins)",
      tag: 'admin',
      params: { userId: z.uuid(), tokenId: z.uuid() },
      response: null,
      status: 204,
    }),
    impersonate: e({
      method: 'POST',
      path: '/api/admin/users/:userId/impersonation',
      summary:
        'View the app as the user, read-only, for 15 minutes; the user sees it in their account activity (system admins)',
      tag: 'admin',
      params: { userId: z.uuid() },
      body: impersonateSchema,
      response: ImpersonationStartedSchema,
      status: 201,
    }),
  },
  audit: {
    list: e({
      method: 'GET',
      path: '/api/admin/audit',
      summary: "The console's append-only audit log, newest first (system admins)",
      tag: 'admin',
      query: adminAuditQuerySchema,
      response: AdminAuditListSchema,
      status: 200,
    }),
  },
};

/** Every console endpoint, for the server's registration check and the matrix test. */
export function allAdminEndpoints() {
  return Object.entries(adminContracts).flatMap(([resource, group]) =>
    Object.entries(group).map(([name, endpoint]) => ({ name: `${resource}.${name}`, endpoint }))
  );
}
