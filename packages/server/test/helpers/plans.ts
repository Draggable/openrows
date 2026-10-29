import { CountingUsageMeter, noBilling, resolveEdition } from '../../src/edition/index.js';
import type { Edition, Entitlements, Feature, Limit } from '../../src/edition/types.js';

/** A workspace's test plan: limits (missing: unlimited) and features (missing: on). */
export interface TestPlan {
  limits?: Partial<Record<Limit, number | null>>;
  features?: Partial<Record<Feature, boolean>>;
}

export function entitlementsOf(plan: TestPlan, id = 'test'): Entitlements {
  return {
    plan: id,
    planName: id,
    has: (feature) => plan.features?.[feature] ?? true,
    limit: (limit) => plan.limits?.[limit] ?? null,
  };
}

/**
 * A hosted-like edition for quota tests: each workspace's plan is what `set` gave it (an
 * upgrade or downgrade takes effect at once, no cache); workspaces without one are unlimited.
 * Pass `edition` to testApp({ edition }).
 */
export function planEdition(): {
  edition: Edition;
  set(workspaceId: string, plan: TestPlan): void;
} {
  const plans = new Map<string, TestPlan>();
  const edition = resolveEdition('cloud', {
    entitlements: {
      id: 'test-plans',
      forWorkspace: async (workspaceId) => entitlementsOf(plans.get(workspaceId) ?? {}),
    },
    billing: noBilling,
    usage: new CountingUsageMeter(),
  });
  return { edition, set: (workspaceId, plan) => void plans.set(workspaceId, plan) };
}
