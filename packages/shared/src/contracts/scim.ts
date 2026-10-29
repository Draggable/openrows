import { z } from 'zod';
import {
  ScimGroupSummarySchema,
  ScimStateSchema,
  ScimTokenCreatedSchema,
  scimGroupRoleInputSchema,
  scimSettingsInputSchema,
} from '../schemas/scim.js';
import { defineEndpoint as e } from './endpoint.js';

/**
 * SCIM provisioning's settings. Apart from `contracts`, like single sign-on's: only the
 * hosted edition serves them, to the workspace's owners on a plan with `scim`
 * (403 PLAN_FEATURE_REQUIRED on others); the OSS edition answers 404. The identity provider's
 * own `/scim/v2` API isn't JSON of ours (RFC 7644), so it has no contracts.
 */
export const scimContracts = {
  settings: {
    get: e({
      method: 'GET',
      path: '/api/workspaces/:workspaceId/scim',
      summary: "The workspace's SCIM provisioning: token, default role, groups (owners)",
      tag: 'scim',
      params: { workspaceId: z.uuid() },
      response: ScimStateSchema,
      status: 200,
    }),
    update: e({
      method: 'PATCH',
      path: '/api/workspaces/:workspaceId/scim',
      summary: 'Change the role provisioned people get without a mapped group (owners)',
      tag: 'scim',
      params: { workspaceId: z.uuid() },
      body: scimSettingsInputSchema,
      response: ScimStateSchema,
      status: 200,
    }),
  },
  token: {
    create: e({
      method: 'POST',
      path: '/api/workspaces/:workspaceId/scim/token',
      summary: 'Create or rotate the SCIM bearer token; the old one stops working (owners)',
      tag: 'scim',
      params: { workspaceId: z.uuid() },
      response: ScimTokenCreatedSchema,
      status: 201,
    }),
    revoke: e({
      method: 'DELETE',
      path: '/api/workspaces/:workspaceId/scim/token',
      summary: 'Revoke the SCIM bearer token (owners)',
      tag: 'scim',
      params: { workspaceId: z.uuid() },
      response: null,
      status: 204,
    }),
  },
  groups: {
    update: e({
      method: 'PATCH',
      path: '/api/workspaces/:workspaceId/scim/groups/:groupId',
      summary: 'Map a provisioned group to a role, or clear it (owners)',
      tag: 'scim',
      params: { workspaceId: z.uuid(), groupId: z.uuid() },
      body: scimGroupRoleInputSchema,
      response: ScimGroupSummarySchema,
      status: 200,
    }),
  },
};

/** Every SCIM settings endpoint, for the matrix test. */
export function allScimEndpoints() {
  return Object.entries(scimContracts).flatMap(([resource, group]) =>
    Object.entries(group).map(([name, endpoint]) => ({ name: `${resource}.${name}`, endpoint }))
  );
}
