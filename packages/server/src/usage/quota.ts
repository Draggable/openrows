import {
  type EditPermission,
  fieldPermissionsOf,
  type PlanFeature,
  type PlanLimit,
  tablePermissionsOf,
  type UserRole,
} from '@openrows/shared';
import { sql } from 'drizzle-orm';
import { storageUsage } from '../attachments/service.js';
import type { Transaction } from '../db/index.js';
import type { Entitlements } from '../edition/types.js';
import { AppError } from '../lib/errors.js';

/**
 * Plan enforcement, Airtable's way: over a limit a workspace can still read and edit
 * everything, but adds no new data. Nothing is ever deleted or hidden because of a limit (the
 * revision history window only hides revisions, which an upgrade brings back). Every check reads
 * the workspace's entitlements through the edition's EntitlementsProvider; an unlimited limit
 * (the OSS edition's every limit) costs no query.
 *
 * Checks read the counters without a lock: two writers racing at the limit can both get in, so a
 * limit can be passed by one concurrent batch at most. Limits are soft caps, not a security
 * boundary.
 */

/** What people read for each limit, in refusals. */
export const LIMIT_NAMES: Record<PlanLimit, string> = {
  recordsPerBase: 'records per base',
  attachmentBytesPerWorkspace: 'attachment storage',
  automationRunsPerMonth: 'automation runs per month',
  apiCallsPerMonth: 'API calls per month',
  editorsPerWorkspace: 'editors',
  revisionHistoryDays: 'revision history',
  auditLogRetentionDays: 'audit log retention',
  aiCreditsPerMonth: 'AI credits per month',
};

/** What people read for each feature, in refusals. */
export const FEATURE_NAMES: Record<PlanFeature, string> = {
  removeBranding: 'Removing the OpenRows branding',
  personalViews: 'Personal views',
  lockedViews: 'Locked views',
  editPermissions: 'Table and field edit permissions',
  sso: 'Single sign-on',
  scim: 'SCIM provisioning',
  auditLogExport: 'Audit log',
  adminConsole: 'Admin console and policies',
  dataResidency: 'Data residency (choice of region)',
};

/**
 * The 403 QUOTA_EXCEEDED (problem type `quota-exceeded`) naming the limit: `limit`, `used` and
 * `max`, plus anything in `extra` (the base, the reset time).
 */
export function quotaExceeded(
  limit: PlanLimit,
  used: number,
  max: number,
  opts: { detail?: string; extra?: Record<string, unknown>; status?: number } = {}
): AppError {
  return new AppError('QUOTA_EXCEEDED', {
    detail:
      opts.detail ??
      `This workspace's plan allows ${max.toLocaleString('en-US')} ${LIMIT_NAMES[limit]}. Existing data can still be read and edited; upgrade the plan to add more.`,
    extensions: { limit, used, max, ...opts.extra },
    ...(opts.status ? { status: opts.status } : {}),
  });
}

/**
 * Runs `fn` for someone outside the workspace (a public form's visitor): a QUOTA_EXCEEDED from it
 * is answered with `detail` and the limit's name only, never the workspace's usage or ids.
 */
export async function withPublicQuota<T>(detail: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== 'QUOTA_EXCEEDED') throw err;
    throw new AppError('QUOTA_EXCEEDED', {
      detail,
      extensions: { limit: err.extensions?.['limit'] },
    });
  }
}

/** The 403 PLAN_FEATURE_REQUIRED naming the feature. */
export function featureRequired(feature: PlanFeature): AppError {
  return new AppError('PLAN_FEATURE_REQUIRED', {
    detail: `${FEATURE_NAMES[feature]}: not included in this workspace's plan. What is already set up keeps working; upgrade the plan to add more.`,
    extensions: { feature },
  });
}

/** Refuses a new setting that needs `feature` when the plan lacks it. */
export function assertFeature(entitlements: Entitlements, feature: PlanFeature): void {
  if (!entitlements.has(feature)) throw featureRequired(feature);
}

/** A permission as compared: lists sorted, so the same rule in another order is no change. */
function canonical(p: EditPermission): string {
  return JSON.stringify(
    p.level === 'specific'
      ? { level: p.level, userIds: [...p.userIds].sort(), roles: [...p.roles].sort() }
      : p
  );
}

/**
 * Whether `next` is a new restriction: anything but the default (`editors`) that differs from
 * `current`. Keeping a restriction and removing one (back to `editors`) never need the plan.
 */
function restricts(next: EditPermission | undefined, current: EditPermission): boolean {
  return next !== undefined && next.level !== 'editors' && canonical(next) !== canonical(current);
}

/**
 * Edit permissions need the plan's `editPermissions` to add or change a restriction; after
 * a downgrade the existing ones keep applying and can still be removed.
 */
export function assertTablePermissionsAllowed(
  entitlements: Entitlements,
  stored: unknown,
  next: Partial<Record<'addRecords' | 'deleteRecords' | 'editRecords', EditPermission>> | undefined
): void {
  if (!next || entitlements.has('editPermissions')) return;
  const current = tablePermissionsOf(stored);
  const keys = ['addRecords', 'deleteRecords', 'editRecords'] as const;
  if (keys.some((k) => restricts(next[k], current[k]))) throw featureRequired('editPermissions');
}

export function assertFieldPermissionsAllowed(
  entitlements: Entitlements,
  stored: unknown,
  next: { edit: EditPermission } | undefined
): void {
  if (!next || entitlements.has('editPermissions')) return;
  if (restricts(next.edit, fieldPermissionsOf(stored).edit)) {
    throw featureRequired('editPermissions');
  }
}

/** The base's live records: the counters of its live tables. */
export async function baseRecords(tx: Transaction, baseId: string): Promise<number> {
  const { rows } = await tx.execute<{ n: string | null }>(sql`
    SELECT coalesce(sum(c.records), 0) AS n
      FROM table_record_counts c
      JOIN tables t ON t.id = c.table_id AND t.deleted_at IS NULL
     WHERE c.base_id = ${baseId}::uuid`);
  return Number(rows[0]?.n ?? 0);
}

/**
 * Refuses `adding` new live records in the base past the plan's records per base: creates,
 * restores from the trash, duplicates, imports. A batch is refused whole (nothing is written);
 * `adding` 0 always passes, so a base over its limit can still be edited.
 */
export async function assertRecordRoom(
  tx: Transaction,
  entitlements: Entitlements,
  baseId: string,
  adding: number
): Promise<void> {
  const max = entitlements.limit('recordsPerBase');
  if (max === null || adding <= 0) return;
  const used = await baseRecords(tx, baseId);
  if (used + adding > max) {
    throw quotaExceeded('recordsPerBase', used, max, {
      detail: `This base has ${used.toLocaleString('en-US')} of the ${max.toLocaleString('en-US')} records its plan allows${adding > 1 ? `, so ${adding.toLocaleString('en-US')} more don't fit` : ''}. Existing records can still be read and edited; upgrade the plan to add more.`,
      extra: { baseId },
    });
  }
}

/**
 * Refuses a base filled in one go past records per base (a snapshot restored to a new base): run
 * after the rows went in and were counted, in the same transaction, so a refusal rolls it back.
 */
export async function assertBaseWithinLimit(
  tx: Transaction,
  entitlements: Entitlements,
  baseId: string
): Promise<void> {
  const max = entitlements.limit('recordsPerBase');
  if (max === null) return;
  const used = await baseRecords(tx, baseId);
  if (used > max) {
    throw quotaExceeded('recordsPerBase', used, max, {
      detail: `This snapshot holds ${used.toLocaleString('en-US')} records, more than the ${max.toLocaleString('en-US')} per base the plan allows. Upgrade the plan to restore it.`,
    });
  }
}

/** A table's live records by its counter (also a trashed table's: the counter stays). */
export async function tableRecords(tx: Transaction, tableId: string): Promise<number> {
  const { rows } = await tx.execute<{ n: string }>(
    sql`SELECT records AS n FROM table_record_counts WHERE table_id = ${tableId}::uuid`
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * The entitlements a schema change that adds records needs (a duplicate with records, a table
 * restore, a conversion to a link that creates linked records). A route that can get there
 * passes them; a missing one is a bug, never "unlimited".
 */
export function requireEntitlements(ctx: {
  entitlements?: Entitlements | undefined;
}): Entitlements {
  if (!ctx.entitlements) throw new Error('a write that adds records without the plan');
  return ctx.entitlements;
}

/** Refuses a new upload of `bytes` past the plan's attachment storage. */
export async function assertAttachmentRoom(
  tx: Transaction,
  entitlements: Entitlements,
  workspaceId: string,
  bytes: number
): Promise<void> {
  const max = entitlements.limit('attachmentBytesPerWorkspace');
  if (max === null) return;
  const { bytes: used } = await storageUsage(tx, workspaceId);
  if (used + Math.max(bytes, 0) > max) {
    throw quotaExceeded('attachmentBytesPerWorkspace', used, max, {
      detail: `This workspace has used ${formatBytes(used)} of the ${formatBytes(max)} of attachments its plan allows. Existing files stay available; upgrade the plan to upload more.`,
    });
  }
}

/** Roles that take an editor seat (REVIEW §6; usage/service.ts counts the same). */
const SEAT_ROLES: readonly UserRole[] = ['owner', 'creator', 'editor'];

export function takesSeat(role: UserRole): boolean {
  return SEAT_ROLES.includes(role);
}

/**
 * Refuses giving `role` to someone (an invitation by email, a role change by user id) when it
 * takes a new editor seat past the plan's editors. Seats are the billable editors (editor
 * or higher on the workspace or a live base) plus pending, unexpired invitations with such a role
 * to anyone else. Someone who already holds a seat (or a pending invitation for one) takes no
 * new one; commenters and read-only people are always free.
 */
export async function assertEditorRoom(
  tx: Transaction,
  entitlements: Entitlements,
  workspaceId: string,
  who: { userId?: string; email?: string },
  role: UserRole
): Promise<void> {
  const max = entitlements.limit('editorsPerWorkspace');
  if (max === null || !takesSeat(role)) return;
  const roles = sql.join(
    SEAT_ROLES.map((r) => sql`${r}`),
    sql`, `
  );
  const userId = who.userId ?? null;
  const email = who.email?.toLowerCase() ?? null;
  const { rows } = await tx.execute<{ editors: string; pending: string; held: boolean }>(sql`
    WITH billable AS (
      SELECT m.user_id FROM workspace_members m
       WHERE m.workspace_id = ${workspaceId}::uuid AND m.role IN (${roles})
      UNION
      SELECT m.user_id FROM base_members m
        JOIN bases b ON b.id = m.base_id AND b.deleted_at IS NULL
       WHERE m.workspace_id = ${workspaceId}::uuid AND m.role IN (${roles})
    ), billable_emails AS (
      SELECT lower(u.email) AS email, u.id FROM billable JOIN users u ON u.id = billable.user_id
    ), pending AS (
      SELECT DISTINCT lower(i.email) AS email FROM workspace_invitations i
        LEFT JOIN bases b ON b.id = i.base_id
       WHERE i.workspace_id = ${workspaceId}::uuid AND i.role IN (${roles})
         AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
         AND (i.base_id IS NULL OR b.deleted_at IS NULL)
         AND lower(i.email) NOT IN (SELECT email FROM billable_emails)
    )
    SELECT (SELECT count(*) FROM billable) AS editors,
           (SELECT count(*) FROM pending) AS pending,
           (EXISTS (SELECT 1 FROM billable_emails
                     WHERE id = ${userId}::uuid OR email = ${email})
            OR EXISTS (SELECT 1 FROM pending WHERE email = ${email})) AS held`);
  const row = rows[0];
  if (!row || row.held) return;
  const used = Number(row.editors) + Number(row.pending);
  if (used >= max) {
    throw quotaExceeded('editorsPerWorkspace', used, max, {
      detail: `This workspace's plan allows ${max.toLocaleString('en-US')} editors (editor, creator or owner, invitations included) and has ${used.toLocaleString('en-US')}. Invite them as a commenter or read-only (always free), or upgrade the plan.`,
    });
  }
}

/** The first instant of the next UTC month: when monthly quotas reset. */
export function nextMonthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * Whether the workspace's automation runs this month (the counter of counted runs) used up the
 * plan's: null while there is room (always, unlimited), else how far it is and when it resets.
 */
export async function monthlyRunRoom(
  tx: Transaction,
  entitlements: Entitlements,
  workspaceId: string,
  now = new Date()
): Promise<{ used: number; max: number; resetsAt: Date } | null> {
  const max = entitlements.limit('automationRunsPerMonth');
  if (max === null) return null;
  // The same month as the counter's (run.ts, finish).
  const { rows } = await tx.execute<{ runs: string }>(sql`
    SELECT runs FROM automation_run_counts
     WHERE workspace_id = ${workspaceId}::uuid AND month = date_trunc('month', now())::date`);
  const used = Number(rows[0]?.runs ?? 0);
  return used >= max ? { used, max, resetsAt: nextMonthStart(now) } : null;
}

/**
 * Whether the workspace's REST API calls this month (api_call_counts) used up the plan's:
 * null while there is room, else the 429 QUOTA_EXCEEDED to answer (with `resetsAt`) and the
 * seconds until the next UTC month, for Retry-After.
 */
export async function apiCallRoom(
  tx: Transaction,
  entitlements: Entitlements,
  workspaceId: string,
  now = new Date()
): Promise<{ error: AppError; retryAfterSeconds: number } | null> {
  const max = entitlements.limit('apiCallsPerMonth');
  if (max === null) return null;
  // The same month as api_call_count's.
  const { rows } = await tx.execute<{ calls: string }>(sql`
    SELECT calls FROM api_call_counts
     WHERE workspace_id = ${workspaceId}::uuid
       AND month = date_trunc('month', now() AT TIME ZONE 'UTC')::date`);
  const used = Number(rows[0]?.calls ?? 0);
  if (used < max) return null;
  const resetsAt = nextMonthStart(now);
  return {
    retryAfterSeconds: Math.max(1, Math.ceil((resetsAt.getTime() - now.getTime()) / 1000)),
    error: quotaExceeded('apiCallsPerMonth', used, max, {
      detail: `This workspace's plan allows ${max.toLocaleString('en-US')} API calls per month and they are used up; they reset at ${resetsAt.toISOString()}. The app keeps working; upgrade the plan for more.`,
      extra: { resetsAt: resetsAt.toISOString() },
      status: 429,
    }),
  };
}

/**
 * The oldest revision the plan's history window shows, or null for all. Older revisions
 * are hidden, never deleted: the retention prune (REVISION_RETENTION_DAYS) is separate.
 */
export function revisionCutoff(entitlements: Entitlements, now = new Date()): Date | null {
  const days = entitlements.limit('revisionHistoryDays');
  if (days === null) return null;
  return new Date(now.getTime() - days * 86_400_000);
}

export function formatBytes(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value} bytes` : `${Number(value.toFixed(1))} ${units[unit]}`;
}
