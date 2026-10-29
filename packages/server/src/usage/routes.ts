import { contracts, USAGE_WARNING_METRICS, usageWarnings } from '@openrows/shared';
import type { RouteRegistry } from '../authz/routes.js';
import { workspaceUsage } from './service.js';

/**
 * `GET /api/workspaces/:workspaceId/usage`: the workspace's plan, limits and usage, for
 * its members (any role). Base-only collaborators have no workspace role: 404.
 *
 * `GET /api/bases/:baseId/usage-warnings`: the base banner's warnings, for the base's
 * creators and owners (base-only ones too): the base's records and the workspace's other limits
 * at 80% or more. Other bases' names and counts stay out.
 */
export function usageRoutes(
  routes: RouteRegistry,
  /** Whether the server has an AI provider of its own, whose credits the page shows. */
  opts: { aiCredits: boolean } = { aiCredits: false }
) {
  routes.endpoint(
    contracts.workspaces.usage,
    { resource: 'workspace', action: 'workspace:read' },
    async (c) => {
      const workspaceId = c.var.resource.id;
      const entitlements = await c.var.edition.entitlements.forWorkspace(workspaceId, c.var.tx);
      const usage = await workspaceUsage(c.var.tx, workspaceId, entitlements, {
        aiCredits: opts.aiCredits,
      });
      return { ...usage, upgradeUrl: await c.var.edition.billing.upgradeUrl(workspaceId) };
    }
  );

  routes.endpoint(
    contracts.bases.usageWarnings,
    { resource: 'base', action: 'base:read_usage' },
    async (c) => {
      const { id: baseId, workspaceId } = c.var.resource;
      const entitlements = await c.var.edition.entitlements.forWorkspace(workspaceId, c.var.tx);
      const plan = { id: entitlements.plan, name: entitlements.planName };
      const upgradeUrl = await c.var.edition.billing.upgradeUrl(workspaceId);
      const limited = USAGE_WARNING_METRICS.some((l) => entitlements.limit(l) !== null);
      if (!limited) return { workspaceId, plan, warnings: [], upgradeUrl };
      const usage = await workspaceUsage(c.var.tx, workspaceId, entitlements, {
        aiCredits: opts.aiCredits,
      });
      const warnings = usageWarnings({
        ...usage,
        bases: usage.bases.filter((b) => b.baseId === baseId),
      });
      return { workspaceId, plan, warnings, upgradeUrl };
    }
  );
}
