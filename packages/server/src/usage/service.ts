import { PLAN_FEATURES, type WorkspaceUsage } from '@openrows/shared';
import { sql } from 'drizzle-orm';
import { storageUsage } from '../attachments/service.js';
import type { Transaction } from '../db/index.js';
import type { Entitlements } from '../edition/types.js';

/** The UTC calendar month around `now`: its first day and the next month's (YYYY-MM-DD). */
export function monthOf(now: Date): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

/** Roles that count as billable editors (REVIEW §6: editors and above). */
const BILLABLE_ROLES = ['owner', 'creator', 'editor'] as const;

/**
 * The workspace's billable editors (REVIEW §6): people with editor or a higher role on the
 * workspace or on one of its live bases, each counted once. In its scope (RLS). What the editor
 * limit and the subscription's seats count.
 */
export async function billableEditors(tx: Transaction, workspaceId: string): Promise<number> {
  const roles = sql.join(
    BILLABLE_ROLES.map((r) => sql`${r}`),
    sql`, `
  );
  const { rows } = await tx.execute<{ n: string }>(sql`
    SELECT count(*) AS n FROM (
      SELECT user_id FROM workspace_members
       WHERE workspace_id = ${workspaceId}::uuid AND role IN (${roles})
      UNION
      SELECT m.user_id FROM base_members m
        JOIN bases b ON b.id = m.base_id AND b.deleted_at IS NULL
       WHERE m.workspace_id = ${workspaceId}::uuid AND m.role IN (${roles})
    ) AS billable`);
  return Number(rows[0]?.n ?? 0);
}

/**
 * What the workspace uses against its plan, read in its scoped transaction (RLS):
 * live records per live base (the counters of its live tables), confirmed attachment bytes, this
 * UTC month's automation runs, REST API calls and AI credits, and its billable editors: people with editor
 * or a higher role on the workspace or on one of its live bases, each counted once.
 */
export async function workspaceUsage(
  tx: Transaction,
  workspaceId: string,
  entitlements: Entitlements,
  opts: {
    /**
     * Whether the server has an AI provider of its own; without one the credits are
     * null. Default: shown when the plan limits them.
     */
    aiCredits?: boolean;
    now?: Date;
  } = {}
): Promise<Omit<WorkspaceUsage, 'upgradeUrl'>> {
  const now = opts.now ?? new Date();
  const period = monthOf(now);
  const { rows: bases } = await tx.execute<{ id: string; name: string; records: string }>(sql`
    SELECT b.id, b.name, coalesce(sum(c.records) FILTER (WHERE t.id IS NOT NULL), 0) AS records
      FROM bases b
      LEFT JOIN tables t ON t.base_id = b.id AND t.deleted_at IS NULL
      LEFT JOIN table_record_counts c ON c.table_id = t.id
     WHERE b.workspace_id = ${workspaceId}::uuid AND b.deleted_at IS NULL
     GROUP BY b.id, b.name
     ORDER BY b.name, b.id`);
  const { rows: monthly } = await tx.execute<{
    runs: string | null;
    calls: string | null;
    credits: string | null;
  }>(sql`
    SELECT (SELECT runs FROM automation_run_counts
             WHERE workspace_id = ${workspaceId}::uuid AND month = ${period.start}::date) AS runs,
           (SELECT calls FROM api_call_counts
             WHERE workspace_id = ${workspaceId}::uuid AND month = ${period.start}::date) AS calls,
           (SELECT credits FROM ai_credit_counts
             WHERE workspace_id = ${workspaceId}::uuid AND month = ${period.start}::date) AS credits`);
  const editors = await billableEditors(tx, workspaceId);
  const storage = await storageUsage(tx, workspaceId);
  const limit = entitlements.limit.bind(entitlements);
  return {
    workspaceId,
    plan: { id: entitlements.plan, name: entitlements.planName },
    period,
    bases: bases.map((b) => ({
      baseId: b.id,
      name: b.name,
      records: Number(b.records),
      limit: limit('recordsPerBase'),
    })),
    attachmentBytes: { used: storage.bytes, limit: limit('attachmentBytesPerWorkspace') },
    automationRuns: { used: Number(monthly[0]?.runs ?? 0), limit: limit('automationRunsPerMonth') },
    apiCalls: { used: Number(monthly[0]?.calls ?? 0), limit: limit('apiCallsPerMonth') },
    editors: { used: editors, limit: limit('editorsPerWorkspace') },
    aiCredits:
      (opts.aiCredits ?? limit('aiCreditsPerMonth') !== null)
        ? { used: Number(monthly[0]?.credits ?? 0), limit: limit('aiCreditsPerMonth') }
        : null,
    revisionHistoryDays: limit('revisionHistoryDays'),
    features: Object.fromEntries(PLAN_FEATURES.map((f) => [f, entitlements.has(f)])) as Record<
      (typeof PLAN_FEATURES)[number],
      boolean
    >,
  };
}
