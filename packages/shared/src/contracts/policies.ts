import { z } from 'zod';
import {
  AdminMembersSchema,
  WorkspacePoliciesStateSchema,
  workspacePoliciesSchema,
} from '../schemas/policies.js';
import { defineEndpoint as e } from './endpoint.js';

/**
 * The workspace admin console. Apart from `contracts`, like single sign-on's: only the
 * hosted edition serves them, to the workspace's owners (sessions only); the
 * member list needs a plan with `adminConsole` (403 PLAN_FEATURE_REQUIRED on others), and on such
 * a plan the policies can only be turned back to the defaults. The OSS edition answers 404.
 */
export const workspaceAdminContracts = {
  policies: {
    get: e({
      method: 'GET',
      path: '/api/workspaces/:workspaceId/policies',
      summary: "The workspace's policies: sharing, embeds, tokens, invitations (owners)",
      tag: 'policies',
      params: { workspaceId: z.uuid() },
      response: WorkspacePoliciesStateSchema,
      status: 200,
    }),
    update: e({
      method: 'PUT',
      path: '/api/workspaces/:workspaceId/policies',
      summary: "Set the workspace's policies; audited (owners)",
      tag: 'policies',
      params: { workspaceId: z.uuid() },
      body: workspacePoliciesSchema,
      response: WorkspacePoliciesStateSchema,
      status: 200,
    }),
  },
  members: {
    list: e({
      method: 'GET',
      path: '/api/workspaces/:workspaceId/admin/members',
      summary: 'Everyone with access to the workspace or its bases, with last activity (owners)',
      tag: 'policies',
      params: { workspaceId: z.uuid() },
      response: AdminMembersSchema,
      status: 200,
    }),
  },
};

/** Every admin console endpoint, for the matrix test. */
export function allWorkspaceAdminEndpoints() {
  return Object.entries(workspaceAdminContracts).flatMap(([resource, group]) =>
    Object.entries(group).map(([name, endpoint]) => ({ name: `${resource}.${name}`, endpoint }))
  );
}
