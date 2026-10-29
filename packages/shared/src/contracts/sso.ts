import { z } from 'zod';
import {
  SsoDomainSchema,
  SsoStateSchema,
  ssoConnectionInputSchema,
  ssoDomainInputSchema,
} from '../schemas/sso.js';
import { defineEndpoint as e } from './endpoint.js';

/**
 * Per-workspace single sign-on's endpoints. Apart from `contracts`, like the audit log's:
 * only the hosted edition serves them, to the workspace's owners on a plan with
 * `sso` (403 PLAN_FEATURE_REQUIRED on others); the OSS edition answers 404.
 */
export const ssoContracts = {
  connection: {
    get: e({
      method: 'GET',
      path: '/api/workspaces/:workspaceId/sso',
      summary: "The workspace's single sign-on: its identity provider and domains (owners)",
      tag: 'sso',
      params: { workspaceId: z.uuid() },
      response: SsoStateSchema,
      status: 200,
    }),
    put: e({
      method: 'PUT',
      path: '/api/workspaces/:workspaceId/sso',
      summary: 'Connect or change the SAML or OIDC identity provider (owners)',
      tag: 'sso',
      params: { workspaceId: z.uuid() },
      body: ssoConnectionInputSchema,
      response: SsoStateSchema,
      status: 200,
    }),
    delete: e({
      method: 'DELETE',
      path: '/api/workspaces/:workspaceId/sso',
      summary: 'Remove the identity provider and the domains (owners)',
      tag: 'sso',
      params: { workspaceId: z.uuid() },
      response: null,
      status: 204,
    }),
  },
  domains: {
    add: e({
      method: 'POST',
      path: '/api/workspaces/:workspaceId/sso/domains',
      summary: 'Add an email domain; it counts once its DNS TXT record is verified (owners)',
      tag: 'sso',
      params: { workspaceId: z.uuid() },
      body: ssoDomainInputSchema,
      response: SsoDomainSchema,
      status: 201,
    }),
    verify: e({
      method: 'POST',
      path: '/api/workspaces/:workspaceId/sso/domains/:domainId/verify',
      summary: "Look up the domain's TXT record and verify it (owners)",
      tag: 'sso',
      params: { workspaceId: z.uuid(), domainId: z.uuid() },
      response: SsoDomainSchema,
      status: 200,
    }),
    delete: e({
      method: 'DELETE',
      path: '/api/workspaces/:workspaceId/sso/domains/:domainId',
      summary: 'Remove an email domain (owners)',
      tag: 'sso',
      params: { workspaceId: z.uuid(), domainId: z.uuid() },
      response: null,
      status: 204,
    }),
  },
};

/** Every single sign-on endpoint, for the matrix test. */
export function allSsoEndpoints() {
  return Object.entries(ssoContracts).flatMap(([resource, group]) =>
    Object.entries(group).map(([name, endpoint]) => ({ name: `${resource}.${name}`, endpoint }))
  );
}
