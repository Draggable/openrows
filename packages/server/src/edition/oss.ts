import { HookRegistry } from './hooks.js';
import type {
  AuditSink,
  BillingProvider,
  DataResidency,
  Edition,
  EditionHooks,
  Entitlements,
  EntitlementsProvider,
  SingleSignOn,
  UsageDecision,
  UsageMeter,
  UsageMetric,
} from './types.js';

/**
 * The OSS edition's providers (ADR-005 §3-4): self-hosters get the whole product, so every
 * feature is on, nothing is limited, there is no billing and the meter never blocks.
 */

/** Every feature on, every limit unlimited, under `plan`. */
export function unlimitedEntitlements(
  plan = 'self-hosted',
  planName = 'Self-hosted'
): Entitlements {
  return { plan, planName, has: () => true, limit: () => null };
}

export const ossEntitlements: EntitlementsProvider = {
  id: 'oss',
  forWorkspace: async () => unlimitedEntitlements(),
};

export const noBilling: BillingProvider = {
  id: 'none',
  enabled: false,
  upgradeUrl: async () => null,
  offers: () => [],
};

/** No audit log: self-hosters' activity stays in the core's activity and revision logs. */
export const noAudit: AuditSink = {
  id: 'none',
  enabled: false,
  record: async () => {},
};

/** No per-workspace single sign-on: discovery finds nothing, every sign-in is allowed. */
export const noSso: SingleSignOn = {
  id: 'none',
  discover: async () => null,
  signIn: async () => ({ allowed: true, method: 'oidc' }),
};

/** One region, this stack: people create workspaces here themselves, nowhere else. */
export const singleRegion: DataResidency = {
  id: 'single',
  current: { id: 'default', name: 'This server', appUrl: null },
  regions: [{ id: 'default', name: 'This server', appUrl: null }],
  selfServe: true,
};

/** Workspaces a CountingUsageMeter keeps counts for before it forgets the oldest. */
export const COUNTING_METER_MAX_WORKSPACES = 10_000;

/**
 * Counts usage in this process's memory and never blocks (the OSS meter). The counts are per
 * process and lost on restart: nothing bills or limits on them. At most `maxWorkspaces`
 * workspaces are kept; past that the least recently counted one is dropped.
 */
export class CountingUsageMeter implements UsageMeter {
  readonly id = 'counting';
  readonly #counts = new Map<string, Map<UsageMetric, number>>();

  constructor(private readonly maxWorkspaces = COUNTING_METER_MAX_WORKSPACES) {}

  async record(workspaceId: string, metric: UsageMetric, amount = 1): Promise<void> {
    if (!Number.isFinite(amount) || amount <= 0) return;
    const counts = this.#counts.get(workspaceId) ?? new Map<UsageMetric, number>();
    // Re-inserted last: the Map's order is the eviction order.
    this.#counts.delete(workspaceId);
    this.#counts.set(workspaceId, counts);
    counts.set(metric, (counts.get(metric) ?? 0) + amount);
    if (this.#counts.size > this.maxWorkspaces) {
      const oldest = this.#counts.keys().next().value;
      if (oldest !== undefined) this.#counts.delete(oldest);
    }
  }

  async check(
    _workspaceId: string,
    _metric: UsageMetric,
    _amount?: number
  ): Promise<UsageDecision> {
    return { allowed: true };
  }

  /** What was counted for the workspace (0 when nothing). */
  used(workspaceId: string, metric: UsageMetric): number {
    return this.#counts.get(workspaceId)?.get(metric) ?? 0;
  }
}

/** The OSS edition: what `node dist/index.js` and `dist/worker.js` run with. */
export function ossEdition(): Edition {
  return {
    name: 'oss',
    entitlements: ossEntitlements,
    billing: noBilling,
    usage: new CountingUsageMeter(),
    audit: noAudit,
    sso: noSso,
    syncConnectors: [],
    residency: singleRegion,
    hooks: new HookRegistry<EditionHooks>(),
  };
}
