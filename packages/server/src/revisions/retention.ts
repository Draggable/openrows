import { DEFAULT_REVISION_RETENTION_DAYS } from '@openrows/shared';

/** Longest retention the setting takes (100 years). */
export const MAX_REVISION_RETENTION_DAYS = 36_500;

/**
 * How long record revisions are kept, in days: `REVISION_RETENTION_DAYS` (a whole number
 * of days, 1 to 36,500), else 365. One value for every workspace of a self-hosted install;
 * hosted plans give workspaces their own through the prune's overrides.
 */
export function revisionRetentionDays(env: Record<string, string | undefined>): number {
  const raw = env['REVISION_RETENTION_DAYS']?.trim();
  if (!raw) return DEFAULT_REVISION_RETENTION_DAYS;
  const days = Number(raw);
  if (!/^\d+$/.test(raw) || days < 1 || days > MAX_REVISION_RETENTION_DAYS) {
    throw new Error(
      `REVISION_RETENTION_DAYS must be a whole number of days from 1 to ${MAX_REVISION_RETENTION_DAYS}`
    );
  }
  return days;
}
