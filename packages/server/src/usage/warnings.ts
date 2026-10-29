import {
  USAGE_WARNING_METRICS,
  type UsageWarning,
  usageWarnings,
  usageWarningText,
} from '@openrows/shared';
import { sql } from 'drizzle-orm';
import type { Database, Transaction } from '../db/index.js';
import type { EntitlementsProvider } from '../edition/types.js';
import { usageWarningEmail } from '../email/templates.js';
import type { EmailTransport } from '../email/transport.js';
import type { Jobs } from '../jobs/send.js';
import { withTenant } from '../jobs/tenant.js';
import type { Logger } from '../lib/logger.js';
import { workspaceUsage } from './service.js';

/**
 * Plan-limit warning emails. The worker's hourly `usage.warnings` checks every live
 * workspace (and `usage.check` one, sent when a public form refused a response at the limit):
 * each limit that newly reached 80% (`near`) or 100% (`full`) this UTC month, records per base
 * per base, is emailed once to the workspace's owners with a verified address, all new ones in one
 * email. `usage_warnings_sent` is written in the same transaction as the send: a failed send
 * rolls it back (the next run tries again) and a sent warning never repeats in the month. A limit
 * first seen full counts as near too, so falling back under 100% doesn't send an 80% one.
 */

export interface UsageWarningDeps {
  db: Database;
  entitlements: EntitlementsProvider;
  email: EmailTransport;
  appUrl: string;
  logger: Pick<Logger, 'info' | 'warn'>;
}

/** Workspaces per page of the hourly check. */
const PAGE = 200;

/** The workspace's Usage page, where its owners see the meters and the upgrade button. */
export function usagePageUrl(appUrl: string, workspaceId: string): string {
  return new URL(`/w/${workspaceId}/usage`, appUrl).href;
}

/** Records the warnings as sent; returns those that weren't yet (the ones to email). */
async function claimNew(
  tx: Transaction,
  workspaceId: string,
  month: string,
  warnings: readonly UsageWarning[]
): Promise<UsageWarning[]> {
  const fresh: UsageWarning[] = [];
  for (const w of warnings) {
    const levels = w.level === 'full' ? ['full', 'near'] : ['near'];
    const { rows } = await tx.execute<{ level: string }>(sql`
      INSERT INTO usage_warnings_sent (workspace_id, metric, subject, level, month)
      SELECT ${workspaceId}::uuid, ${w.metric}, ${w.base?.id ?? ''}, l, ${month}::date
        FROM unnest(${`{${levels.join(',')}}`}::text[]) AS l
      ON CONFLICT DO NOTHING
      RETURNING level`);
    if (rows.some((r) => r.level === w.level)) fresh.push(w);
  }
  return fresh;
}

/**
 * Checks one workspace and emails its owners about new warnings; returns how many emails went
 * out. A workspace without limits costs one entitlements lookup.
 */
export async function checkUsageWarnings(
  deps: UsageWarningDeps,
  workspaceId: string,
  now = new Date()
): Promise<number> {
  return withTenant(deps.db, workspaceId, async (tx) => {
    const entitlements = await deps.entitlements.forWorkspace(workspaceId, tx);
    if (USAGE_WARNING_METRICS.every((m) => entitlements.limit(m) === null)) return 0;
    const usage = await workspaceUsage(tx, workspaceId, entitlements, { now });
    const warnings = usageWarnings(usage);
    if (warnings.length === 0) return 0;
    const fresh = await claimNew(tx, workspaceId, usage.period.start, warnings);
    if (fresh.length === 0) return 0;
    const { rows: owners } = await tx.execute<{ email: string; name: string }>(sql`
      SELECT u.email, w.name
        FROM workspace_members m
        JOIN users u ON u.id = m.user_id AND u.email_verified AND u.deleted_at IS NULL
        JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.workspace_id = ${workspaceId}::uuid AND m.role = 'owner'`);
    const content = usageWarningEmail({
      workspaceName: owners[0]?.name ?? 'Your workspace',
      planName: usage.plan.name,
      full: fresh.some((w) => w.level === 'full'),
      lines: fresh.map(usageWarningText),
      usageUrl: usagePageUrl(deps.appUrl, workspaceId),
    });
    for (const owner of owners) await deps.email.send({ to: owner.email, ...content });
    deps.logger.info(
      { workspaceId, warnings: fresh.map((w) => `${w.metric}:${w.level}`), owners: owners.length },
      'plan limit warnings sent'
    );
    return owners.length;
  });
}

/**
 * The hourly `usage.warnings`: every live workspace, a page at a time, each in its own
 * transaction. A failing workspace is logged and skipped (the next run tries it again).
 */
export async function runUsageWarnings(
  deps: UsageWarningDeps,
  now = new Date(),
  page = PAGE
): Promise<{ workspaces: number; emails: number }> {
  const result = { workspaces: 0, emails: 0 };
  let after: string | null = null;
  for (;;) {
    const { rows }: { rows: { workspace_id: string }[] } = await deps.db.execute(
      sql`SELECT workspace_id FROM usage_warning_workspaces(${after}::uuid, ${page})`
    );
    for (const { workspace_id } of rows) {
      try {
        result.emails += await checkUsageWarnings(deps, workspace_id, now);
        result.workspaces++;
      } catch (err) {
        deps.logger.warn({ err, workspaceId: workspace_id }, 'plan limit warnings not checked');
      }
    }
    const last = rows.at(-1);
    if (!last || rows.length < page) break;
    after = last.workspace_id;
  }
  return result;
}

/**
 * Asks the worker to check the workspace soon (`usage.check`, one queued per workspace): a public
 * form just refused a response at the limit, so its owners hear about it without waiting for the
 * hourly run. Runs in its own transaction (the refused request's rolled back); never throws.
 */
export async function requestUsageCheck(
  db: Database,
  jobs: Jobs | undefined,
  workspaceId: string,
  logger: Pick<Logger, 'warn'>
): Promise<void> {
  if (!jobs) return;
  try {
    await withTenant(db, workspaceId, (tx) =>
      jobs.send(tx, 'usage.check', { workspaceId }, { singletonKey: workspaceId })
    );
  } catch (err) {
    logger.warn({ err, workspaceId }, 'plan limit check not queued');
  }
}
