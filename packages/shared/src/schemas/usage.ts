import { z } from 'zod';

/**
 * Plans, entitlements and usage (REVIEW §6). The catalog of hosted plans (their limits and
 * prices) is the hosted edition's configuration; the core only knows which features a plan can turn off and
 * which limits it can set. The OSS edition has every feature and no limit.
 */

/** Features a plan can turn off. */
export const PLAN_FEATURES = [
  // Forms and share links without the OpenRows branding.
  'removeBranding',
  // Personal views.
  'personalViews',
  // Locked views.
  'lockedViews',
  // Table and field edit permissions.
  'editPermissions',
  'sso',
  'scim',
  // The workspace audit log with its export and SIEM stream. The key predates the log.
  'auditLogExport',
  // The admin console: workspace policies and the member list across bases.
  'adminConsole',
  // Data residency: workspaces in another region's stack, chosen at creation.
  'dataResidency',
] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

/** Limits a plan can set. `null`: unlimited. */
export const PLAN_LIMITS = [
  'recordsPerBase',
  'attachmentBytesPerWorkspace',
  'automationRunsPerMonth',
  'apiCallsPerMonth',
  'editorsPerWorkspace',
  'revisionHistoryDays',
  // How long the audit log keeps entries, purged daily by the hosted worker.
  'auditLogRetentionDays',
  // AI credits per UTC month on the instance's AI provider (the hosted service's managed
  // AI); requests on a workspace's own key never count. The workspace's total: hosted plans give
  // it per editor.
  'aiCreditsPerMonth',
] as const;
export type PlanLimit = (typeof PLAN_LIMITS)[number];

/** A limit: a whole number, or null for unlimited. */
export const planLimitValueSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();

/**
 * A workspace's admin-set overrides of its plan (`workspaces.plan_overrides`): any limit or
 * feature, on top of the plan's own. Only system operators set them (never a route).
 */
export const planOverridesSchema = z
  .object({
    limits: z.partialRecord(z.enum(PLAN_LIMITS), planLimitValueSchema).optional(),
    features: z.partialRecord(z.enum(PLAN_FEATURES), z.boolean()).optional(),
  })
  .strict();
export type PlanOverrides = z.infer<typeof planOverridesSchema>;

/** A plan id: lowercase letters, digits and dashes. */
export const planIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,39}$/, 'lowercase letters, digits and dashes, at most 40');

const meterSchema = z.object({
  used: z.number().int().min(0),
  /** null: unlimited. */
  limit: z.number().int().nullable(),
});
export type UsageMeterValue = z.infer<typeof meterSchema>;

export const WorkspaceUsageSchema = z.object({
  workspaceId: z.uuid(),
  plan: z.object({ id: z.string(), name: z.string() }),
  /** The calendar month (UTC) the monthly counters cover: its first day and the next month's. */
  period: z.object({ start: z.iso.date(), end: z.iso.date() }),
  /** Live records (not in the trash) of each live table, per live base. */
  bases: z.array(
    z.object({
      baseId: z.uuid(),
      name: z.string(),
      records: z.number().int().min(0),
      limit: z.number().int().nullable(),
    })
  ),
  /** Confirmed files and their thumbnails. */
  attachmentBytes: meterSchema,
  automationRuns: meterSchema,
  /** REST API v1 requests on the workspace's bases. */
  apiCalls: meterSchema,
  /** People with editor or a higher role on the workspace or one of its bases. */
  editors: meterSchema,
  /**
   * This month's AI credits on the instance's provider; null when the server has no AI
   * provider of its own (AI then runs only on a workspace's own key, which is never counted).
   */
  aiCredits: meterSchema.nullable(),
  /** How far back record history goes; null: no limit. */
  revisionHistoryDays: z.number().int().nullable(),
  features: z.object(
    Object.fromEntries(PLAN_FEATURES.map((f) => [f, z.boolean()])) as Record<
      PlanFeature,
      z.ZodBoolean
    >
  ),
  /** Where owners upgrade the plan (the pricing page until checkout); null: nowhere. */
  upgradeUrl: z.string().nullable(),
});
export type WorkspaceUsage = z.infer<typeof WorkspaceUsageSchema>;

/** How full a limit is: under 80%, from 80% (`near`), or at or past it (`full`). */
export type UsageLevel = 'ok' | 'near' | 'full';

/** From this share of a limit on, people are warned. */
export const USAGE_WARNING_SHARE = 0.8;

export function usageLevel(m: UsageMeterValue): UsageLevel {
  if (m.limit === null) return 'ok';
  if (m.used >= m.limit) return 'full';
  return m.used >= m.limit * USAGE_WARNING_SHARE ? 'near' : 'ok';
}

/** The limits people are warned about; the history window isn't a meter. */
export const USAGE_WARNING_METRICS = [
  'recordsPerBase',
  'attachmentBytesPerWorkspace',
  'automationRunsPerMonth',
  'apiCallsPerMonth',
  'editorsPerWorkspace',
  'aiCreditsPerMonth',
] as const satisfies readonly PlanLimit[];
export type UsageWarningMetric = (typeof USAGE_WARNING_METRICS)[number];

/** Limits that start again each UTC month (the others are standing totals). */
export const MONTHLY_METRICS: readonly UsageWarningMetric[] = [
  'automationRunsPerMonth',
  'apiCallsPerMonth',
  'aiCreditsPerMonth',
];

export const UsageWarningSchema = z.object({
  metric: z.enum(USAGE_WARNING_METRICS),
  level: z.enum(['near', 'full']),
  used: z.number().int().min(0),
  limit: z.number().int().min(0),
  /** The base of a records-per-base warning, else null. */
  base: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  /** When a monthly limit starts again (the next month's first day, UTC); null otherwise. */
  resetsOn: z.iso.date().nullable(),
});
export type UsageWarning = z.infer<typeof UsageWarningSchema>;

/**
 * The warnings of a workspace's usage: each limit at 80% or more, records per base once
 * per base; full ones first.
 */
export function usageWarnings(usage: Omit<WorkspaceUsage, 'upgradeUrl'>): UsageWarning[] {
  const out: UsageWarning[] = [];
  const add = (
    metric: UsageWarningMetric,
    m: UsageMeterValue,
    base: UsageWarning['base'] = null
  ) => {
    const level = usageLevel(m);
    if (level === 'ok' || m.limit === null) return;
    out.push({
      metric,
      level,
      used: m.used,
      limit: m.limit,
      base,
      resetsOn: MONTHLY_METRICS.includes(metric) ? usage.period.end : null,
    });
  };
  for (const b of usage.bases) {
    add('recordsPerBase', { used: b.records, limit: b.limit }, { id: b.baseId, name: b.name });
  }
  add('attachmentBytesPerWorkspace', usage.attachmentBytes);
  add('automationRunsPerMonth', usage.automationRuns);
  add('apiCallsPerMonth', usage.apiCalls);
  add('editorsPerWorkspace', usage.editors);
  if (usage.aiCredits) add('aiCreditsPerMonth', usage.aiCredits);
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'full' ? -1 : 1));
}

/**
 * `GET /api/bases/:baseId/usage-warnings`, for the base's banner (creators and owners):
 * the warnings that touch the base (its records, and the workspace's other limits).
 */
export const BaseUsageWarningsSchema = z.object({
  workspaceId: z.uuid(),
  plan: z.object({ id: z.string(), name: z.string() }),
  warnings: z.array(UsageWarningSchema),
  /** Where owners upgrade the plan (the pricing page until checkout); null: nowhere. */
  upgradeUrl: z.string().nullable(),
});
export type BaseUsageWarnings = z.infer<typeof BaseUsageWarningsSchema>;

/**
 * AI credits: one AI request of up to AI_TOKENS_PER_CREDIT tokens (input and output
 * together) is 1 credit, plus 1 for each further AI_TOKENS_PER_CREDIT started.
 */
export const AI_TOKENS_PER_CREDIT = 2000;

/** The credits an AI request of `totalTokens` costs: at least 1. */
export function aiCreditsFor(totalTokens: number): number {
  const tokens = Number.isFinite(totalTokens) ? Math.max(0, Math.floor(totalTokens)) : 0;
  return Math.max(1, Math.ceil(tokens / AI_TOKENS_PER_CREDIT));
}

/** "1.2 MB", "1 GB", "512 bytes" (binary units). */
export function formatUsageBytes(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value} bytes` : `${Number(value.toFixed(1))} ${units[unit]}`;
}

/** "November 1" for 2026-11-01. */
export function usageResetDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** What a warning says, the same in the banners and the owners' email. */
export function usageWarningText(w: UsageWarning): string {
  const n = (x: number) => x.toLocaleString('en-US');
  const pct = `${Math.floor((w.used / Math.max(w.limit, 1)) * 100)}%`;
  const resets = w.resetsOn ? usageResetDay(w.resetsOn) : null;
  const full = w.level === 'full';
  switch (w.metric) {
    case 'recordsPerBase': {
      const base = w.base?.name ?? 'A base';
      return full
        ? `${base} has reached its plan's ${n(w.limit)} records. No new records can be added and its forms aren't accepting responses; existing records can still be edited.`
        : `${base} has ${n(w.used)} of the ${n(w.limit)} records its plan allows (${pct}).`;
    }
    case 'attachmentBytesPerWorkspace':
      return full
        ? `Attachment storage is full (${formatUsageBytes(w.limit)}). New files can't be uploaded; existing files stay available.`
        : `Attachments use ${formatUsageBytes(w.used)} of ${formatUsageBytes(w.limit)} (${pct}).`;
    case 'automationRunsPerMonth':
      return full
        ? `This month's ${n(w.limit)} automation runs are used up. Automations won't run until ${resets}.`
        : `${n(w.used)} of this month's ${n(w.limit)} automation runs are used (${pct}); they reset on ${resets}.`;
    case 'apiCallsPerMonth':
      return full
        ? `This month's ${n(w.limit)} API calls are used up. The API refuses requests until ${resets}; the app keeps working.`
        : `${n(w.used)} of this month's ${n(w.limit)} API calls are used (${pct}); they reset on ${resets}.`;
    case 'editorsPerWorkspace':
      return full
        ? `All ${n(w.limit)} editor seats are taken. New editors can't be added; commenters and read-only people are free.`
        : `${n(w.used)} of the ${n(w.limit)} editor seats are taken.`;
    case 'aiCreditsPerMonth':
      return full
        ? `This month's ${n(w.limit)} AI credits are used up. AI features pause until ${resets}, unless an owner adds the workspace's own API key in Settings → AI.`
        : `${n(w.used)} of this month's ${n(w.limit)} AI credits are used (${pct}); they reset on ${resets}.`;
  }
}
