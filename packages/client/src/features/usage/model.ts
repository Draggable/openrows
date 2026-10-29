import {
  AI_TOKENS_PER_CREDIT,
  type PlanFeature,
  type UsageLevel,
  type UsageMeterValue,
  type UsageWarning,
  type UserRole,
  usageLevel,
} from '@openrows/shared';
import { formatSize } from '../snapshots/model';

/** How full a meter is: under 80%, from 80%, or at or past its limit. */
export type MeterLevel = UsageLevel;

const count = (n: number) => n.toLocaleString('en-US');

/** "320 / 1,000", "1.2 MB / 1.0 GB", or "320" with no limit. */
export function meterText(m: UsageMeterValue, unit: 'count' | 'bytes' = 'count'): string {
  const show = unit === 'bytes' ? formatSize : count;
  return m.limit === null ? show(m.used) : `${show(m.used)} / ${show(m.limit)}`;
}

/** The share of the limit used, 0 to 1 (0 with no limit). */
export function meterShare(m: UsageMeterValue): number {
  if (m.limit === null) return 0;
  if (m.limit === 0) return m.used > 0 ? 1 : 0;
  return Math.min(1, m.used / m.limit);
}

export const meterLevel = (m: UsageMeterValue): MeterLevel => usageLevel(m);

/** "Unlimited", "2 weeks", "1 year", "3 years", "45 days". */
export function historyText(days: number | null): string {
  if (days === null) return 'Unlimited';
  if (days % 365 === 0) return days === 365 ? '1 year' : `${days / 365} years`;
  if (days % 7 === 0) return days === 7 ? '1 week' : `${days / 7} weeks`;
  return days === 1 ? '1 day' : `${days} days`;
}

export const FEATURE_LABELS: Record<PlanFeature, string> = {
  removeBranding: 'Forms and share links without OpenRows branding',
  personalViews: 'Personal views',
  lockedViews: 'Locked views',
  editPermissions: 'Table and field edit permissions',
  sso: 'Single sign-on (SSO)',
  scim: 'SCIM provisioning',
  auditLogExport: 'Audit log',
  adminConsole: 'Admin console and policies',
  dataResidency: 'Data residency (choice of region)',
};

/** "October 2026" for the period starting on that month's first day (UTC). */
export function monthName(start: string): string {
  return new Date(`${start}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Who sees the limit warnings in the app: owners and creators. */
export const seesUsageWarnings = (role: UserRole | null | undefined): boolean =>
  role === 'owner' || role === 'creator';

/**
 * What a dismissed banner remembers: the warnings it showed in this month (UTC). A new warning,
 * a level going up or a new month brings the banner back.
 */
export function bannerSignature(warnings: readonly UsageWarning[], now = new Date()): string {
  const month = now.toISOString().slice(0, 7);
  return [month, ...warnings.map((w) => `${w.metric}:${w.level}:${w.base?.id ?? ''}`)].join('|');
}

const DISMISSED = 'openrows.usage-banner.';

export function bannerDismissed(scope: string, signature: string): boolean {
  try {
    return localStorage.getItem(DISMISSED + scope) === signature;
  } catch {
    return false;
  }
}

export function dismissBanner(scope: string, signature: string): void {
  try {
    localStorage.setItem(DISMISSED + scope, signature);
  } catch {
    // Storage off: the banner comes back on the next page.
  }
}

/**
 * How AI credits count, under the Usage page's meter: on OpenRows' own AI provider, an
 * AI request is 1 credit per AI_TOKENS_PER_CREDIT tokens started; a workspace's own key is free.
 */
export function aiCreditsText(limit: number | null): string {
  const tokens = AI_TOKENS_PER_CREDIT.toLocaleString('en-US');
  const base = `AI credits: each AI request on OpenRows' AI provider uses 1 credit per ${tokens} tokens (prompt and answer) started. Requests on the workspace's own API key don't count.`;
  return limit === null ? base : `${base} At the limit, AI features pause until next month.`;
}
