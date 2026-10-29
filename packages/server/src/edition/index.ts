import { HookRegistry } from './hooks.js';
import { noAudit, noSso, ossEdition, singleRegion } from './oss.js';
import type { Edition, EditionHooks, EditionName, EditionProviders } from './types.js';

/**
 * The edition switch (ADR-005 implementation notes). `EDITION` (config.ts) says which
 * build runs; the entry point says which providers it brought:
 * - `oss` (the default): the core's own entry points, the OSS providers. Providers passed in
 *   anyway are refused: a hosted entry point with EDITION=oss is a misconfiguration.
 * - `cloud`: only through the hosted edition's composition root, which passes the hosted providers. The
 *   core's entry points refuse to start with EDITION=cloud.
 *
 * This is the public surface the hosted edition builds on (`@openrows/server/edition`).
 */
export class EditionError extends Error {
  override name = 'EditionError';
}

export function resolveEdition(name: EditionName, providers?: EditionProviders): Edition {
  if (name === 'oss') {
    if (providers) {
      throw new EditionError(
        'EDITION=oss, but this entry point registers hosted providers: set EDITION=cloud or start the core entry point (dist/index.js, dist/worker.js)'
      );
    }
    return ossEdition();
  }
  if (!providers) {
    throw new EditionError(
      "EDITION=cloud needs the hosted providers: start the hosted edition's entry points, not the core's"
    );
  }
  return {
    name,
    entitlements: providers.entitlements,
    billing: providers.billing,
    usage: providers.usage,
    audit: providers.audit ?? noAudit,
    sso: providers.sso ?? noSso,
    ...(providers.ai !== undefined ? { ai: providers.ai } : {}),
    syncConnectors: providers.syncConnectors ?? [],
    residency: providers.residency ?? singleRegion,
    hooks: providers.hooks ?? new HookRegistry<EditionHooks>(),
  };
}

/** Which providers run, for the startup log line. */
export function describeEdition(edition: Edition) {
  return {
    edition: edition.name,
    entitlements: edition.entitlements.id,
    billing: edition.billing.id,
    usage: edition.usage.id,
    audit: edition.audit.id,
    sso: edition.sso.id,
    ai: edition.ai === undefined ? 'instance' : (edition.ai?.id ?? 'none'),
    syncConnectors: edition.syncConnectors.map((c) => c.id),
    residency: `${edition.residency.id}:${edition.residency.current.id}`,
  };
}

export {
  type PlanOverrides,
  planIdSchema,
  planLimitValueSchema,
  planOverridesSchema,
} from '@openrows/shared';
export { type AdminAuditInput, appendAdminAudit, requestIp } from '../admin/audit.js';
export { endImpersonation, startImpersonation } from '../admin/impersonation.js';
export { audit, auditForUser, recordAudit, requestActor } from '../audit/record.js';
export { createCipher } from '../auth/crypto.js';
export type { SessionEnv } from '../auth/middleware.js';
export { rateLimit } from '../auth/rate-limit.js';
export { inScope, setScope } from '../authz/scope.js';
export { emitAccessChange } from '../data/outbox.js';
export { createDb, type Database, type Transaction } from '../db/index.js';
export {
  baseMembers,
  sessions,
  users,
  workspaceMemberActivity,
  workspaceMembers,
  workspacePolicies,
  workspaceScimGroupMembers,
  workspaceScimGroups,
  workspaceScimSettings,
  workspaceScimUsers,
  workspaceSsoConnections,
  workspaceSsoDomains,
  workspaces,
} from '../db/schema.js';
export type { QueueDefinition } from '../jobs/runtime.js';
export type { AppEnv } from '../lib/context.js';
export { AppError } from '../lib/errors.js';
export {
  createSafeFetch,
  createUrlCheck,
  outboundPolicy,
  type SafeFetch,
  SafeFetchError,
  type SafeFetchInit,
  type SafeResponse,
} from '../lib/safe-fetch/index.js';
export { readWorkspacePolicies } from '../policies/repo.js';
export {
  ConnectorAuthError,
  type ConnectorContext,
  type ConnectorItem,
  type ConnectorRead,
  type ConnectorSource,
  type ConnectorTokens,
  type SyncConnector,
} from '../syncs/sources/connectors.js';
export { columnNames, SourceError, TooManyRows } from '../syncs/sources/types.js';
export { assertEditorRoom, featureRequired } from '../usage/quota.js';
export { billableEditors, workspaceUsage } from '../usage/service.js';
export { generateWebhookSecret, signatureHeader } from '../webhooks/signature.js';
export { HookRegistry, MAX_HANDLERS_PER_HOOK } from './hooks.js';
export {
  CountingUsageMeter,
  noAudit,
  noBilling,
  noSso,
  ossEdition,
  ossEntitlements,
  singleRegion,
  unlimitedEntitlements,
} from './oss.js';
export {
  loadWorkspacePlan,
  PLAN_CHANNEL,
  readWorkspacePlan,
  setWorkspacePlan,
  type WorkspacePlan,
} from './plan.js';
export * from './types.js';
