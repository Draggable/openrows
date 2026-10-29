import { z } from 'zod';
import {
  AuditListSchema,
  AuditStreamSavedSchema,
  AuditStreamStateSchema,
  auditExportQuerySchema,
  auditListQuerySchema,
  auditStreamInputSchema,
} from '../schemas/audit.js';
import { defineEndpoint as e } from './endpoint.js';

/**
 * The workspace audit log's endpoints. Apart from `contracts`: only the hosted edition
 * serves them, to the workspace's owners on a plan with the audit log (403
 * PLAN_FEATURE_REQUIRED on others); only the hosted edition's OpenAPI document lists them. The
 * OSS edition answers 404.
 */
export const auditContracts = {
  log: {
    list: e({
      method: 'GET',
      path: '/api/workspaces/:workspaceId/audit-log',
      summary: "The workspace's audit log, newest first, with filters (owners, Enterprise)",
      tag: 'audit',
      params: { workspaceId: z.uuid() },
      query: auditListQuerySchema,
      response: AuditListSchema,
      status: 200,
    }),
  },
  stream: {
    get: e({
      method: 'GET',
      path: '/api/workspaces/:workspaceId/audit-log/stream',
      summary: "The audit log's SIEM stream: its endpoint and delivery state (owners, Enterprise)",
      tag: 'audit',
      params: { workspaceId: z.uuid() },
      response: AuditStreamStateSchema,
      status: 200,
    }),
    put: e({
      method: 'PUT',
      path: '/api/workspaces/:workspaceId/audit-log/stream',
      summary: 'Create or change the SIEM stream; the secret is returned once (owners, Enterprise)',
      tag: 'audit',
      params: { workspaceId: z.uuid() },
      body: auditStreamInputSchema,
      response: AuditStreamSavedSchema,
      status: 200,
    }),
    delete: e({
      method: 'DELETE',
      path: '/api/workspaces/:workspaceId/audit-log/stream',
      summary: 'Remove the SIEM stream (owners, Enterprise)',
      tag: 'audit',
      params: { workspaceId: z.uuid() },
      response: null,
      status: 204,
    }),
  },
};

/** The audit log's file download (streamed CSV or JSON lines), registered with routes.resource. */
export const auditDownloads = {
  export: {
    method: 'GET',
    path: '/api/workspaces/:workspaceId/audit-log/export',
    query: auditExportQuerySchema,
  },
} as const;

/** Every audit endpoint, for the matrix test. */
export function allAuditEndpoints() {
  return Object.entries(auditContracts).flatMap(([resource, group]) =>
    Object.entries(group).map(([name, endpoint]) => ({ name: `${resource}.${name}`, endpoint }))
  );
}
