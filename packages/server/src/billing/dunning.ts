import { sql } from 'drizzle-orm';
import type { Database, Transaction } from '../db/index.js';
import type { BillingProvider, EntitlementsProvider } from '../edition/types.js';
import { paymentFailedEmail } from '../email/templates.js';
import type { EmailTransport } from '../email/transport.js';
import { withTenant } from '../jobs/tenant.js';
import type { Logger } from '../lib/logger.js';
import { billableEditors } from '../usage/service.js';
import { seatTarget } from './seats.js';
import { lockWorkspaceBilling, syncWorkspacePlan, workspaceSubscriptions } from './store.js';

/**
 * Dunning. A subscription the provider reports `past_due` keeps its plan for
 * BILLING_GRACE_DAYS (store.ts records `past_due_since`) while the provider retries the payment.
 * The worker's hourly `billing.dunning` sweep goes through every workspace with a live
 * subscription and, for one past due:
 * - emails its verified owners once per stage: the payment failed (stage 1), the grace period
 *   ends in DUNNING_REMINDER_DAYS (2), it ended (3), skipping to the latest stage it's at;
 * - at the grace period's end stores the subscription as not entitled and sets the plan from the
 *   subscriptions (`planFor`: the default plan without another), so the default plan's limits
 *   apply as soft blocks (read and edit, no new data; nothing deleted). The provider's
 *   next `active` event (paid) brings the plan back and resets the stages.
 * Emails go out in a savepoint that records the stage: a failed send rolls only that back and the
 * next run tries again (the plan's fallback doesn't wait for email). It also queues a seat sync for any workspace whose stored seats differ
 * from its billable editors.
 */
export const DUNNING_REMINDER_DAYS = 3;

const DAY_MS = 86_400_000;
/** Workspaces per page of the sweep. */
const PAGE = 200;
const STAGES = ['failed', 'reminder', 'ended'] as const;

export interface DunningDeps {
  db: Database;
  billing: BillingProvider;
  entitlements: EntitlementsProvider;
  logger: Pick<Logger, 'info' | 'warn'>;
  /** Without email (no SMTP in the worker) the stages still advance and the plan still falls back. */
  email?: { transport: EmailTransport; appUrl: string } | undefined;
  /** Queues the workspace's `billing.seats` job (deduplicated per workspace). */
  queueSeatSync?: (workspaceId: string) => Promise<unknown>;
}

export interface DunningResult {
  /** Stage emails sent (one per owner). */
  emails: number;
  /** Subscriptions whose grace period ended in this run. */
  ended: number;
  /** Whether the stored seats differ from the billable editors. */
  seatDrift: boolean;
}

/** The Billing page, where owners update the payment (the provider's portal). */
export function billingPageUrl(appUrl: string, workspaceId: string): string {
  return new URL(`/w/${workspaceId}/billing`, appUrl).href;
}

const longDay = (d: Date) =>
  new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(d);

/** The stage a subscription past due since `since` is at, at `now` (1, 2 or 3). */
export function dunningStage(graceEndsAt: Date, now: Date): 1 | 2 | 3 {
  if (now.getTime() >= graceEndsAt.getTime()) return 3;
  if (now.getTime() >= graceEndsAt.getTime() - DUNNING_REMINDER_DAYS * DAY_MS) return 2;
  return 1;
}

/** One workspace: its past-due subscriptions' stages and grace periods, and its seat drift. */
export async function checkDunning(
  deps: DunningDeps,
  workspaceId: string,
  now = new Date()
): Promise<DunningResult> {
  const result: DunningResult = { emails: 0, ended: 0, seatDrift: false };
  await withTenant(deps.db, workspaceId, async (tx) => {
    await lockWorkspaceBilling(tx, workspaceId);
    const subscriptions = await workspaceSubscriptions(tx, workspaceId);
    for (const sub of subscriptions) {
      if (sub.status !== 'past_due' || !sub.graceEndsAt) continue;
      const graceEndsAt = new Date(sub.graceEndsAt);
      const stage = dunningStage(graceEndsAt, now);
      if (stage === 3 && sub.entitled) {
        await tx.execute(sql`
          UPDATE billing_subscriptions SET entitled = false, updated_at = now()
           WHERE workspace_id = ${workspaceId}::uuid AND subscription_id = ${sub.subscriptionId}`);
        sub.entitled = false;
        const webhooks = deps.billing.webhooks;
        const change = webhooks ? await syncWorkspacePlan(tx, webhooks, workspaceId) : null;
        // Seen at once by this process; the others drop the cache on workspace_plan_set's NOTIFY.
        deps.entitlements.invalidate?.(workspaceId);
        result.ended++;
        deps.logger.info(
          { workspaceId, subscriptionId: sub.subscriptionId, planChange: change },
          'billing: grace period ended, default plan limits apply'
        );
      }
      if (stage <= sub.dunningStage) continue;
      // In a savepoint: a failed send leaves the stage for the next run, not the fallback.
      try {
        result.emails += await tx.transaction(async (sp) => {
          await sp.execute(sql`
            UPDATE billing_subscriptions SET dunning_stage = ${stage}, updated_at = now()
             WHERE workspace_id = ${workspaceId}::uuid AND subscription_id = ${sub.subscriptionId}`);
          return emailOwners(sp, deps, workspaceId, {
            stage: STAGES[stage - 1] ?? 'failed',
            plan: sub.plan,
            graceEndsAt,
          });
        });
      } catch (err) {
        deps.logger.warn({ err, workspaceId, stage }, 'billing: dunning email not sent');
      }
    }
    const live = subscriptions.find((s) => s.entitled);
    if (live && deps.billing.updateSeats) {
      result.seatDrift = live.seats !== seatTarget(await billableEditors(tx, workspaceId));
    }
  });
  if (result.seatDrift) await deps.queueSeatSync?.(workspaceId);
  return result;
}

async function emailOwners(
  tx: Transaction,
  deps: DunningDeps,
  workspaceId: string,
  p: { stage: (typeof STAGES)[number]; plan: string; graceEndsAt: Date }
): Promise<number> {
  if (!deps.email) return 0;
  const { rows: owners } = await tx.execute<{ email: string; name: string }>(sql`
    SELECT u.email, w.name
      FROM workspace_members m
      JOIN users u ON u.id = m.user_id AND u.email_verified AND u.deleted_at IS NULL
      JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.workspace_id = ${workspaceId}::uuid AND m.role = 'owner'`);
  if (owners.length === 0) return 0;
  const offer = deps.billing.offers().find((o) => o.plan === p.plan);
  // The plan the workspace has now: the default one once the grace period ended.
  const fallback = await deps.entitlements.forWorkspace(workspaceId, tx);
  const content = paymentFailedEmail({
    stage: p.stage,
    workspaceName: owners[0]?.name ?? 'Your workspace',
    planName: offer?.name ?? p.plan,
    fallbackPlanName: p.stage === 'ended' ? fallback.planName : 'Free',
    graceEnds: longDay(p.graceEndsAt),
    billingUrl: billingPageUrl(deps.email.appUrl, workspaceId),
  });
  for (const owner of owners) await deps.email.transport.send({ to: owner.email, ...content });
  deps.logger.info(
    { workspaceId, stage: p.stage, owners: owners.length },
    'billing: dunning email'
  );
  return owners.length;
}

/**
 * The hourly `billing.dunning`: every workspace with a live subscription, a page at a time, each
 * in its own transaction. A failing workspace is logged and skipped (the next run tries again).
 */
export async function runDunning(
  deps: DunningDeps,
  now = new Date(),
  page = PAGE
): Promise<{ workspaces: number; emails: number; ended: number; seatSyncs: number }> {
  const total = { workspaces: 0, emails: 0, ended: 0, seatSyncs: 0 };
  if (!deps.billing.enabled) return total;
  let after: string | null = null;
  for (;;) {
    const { rows }: { rows: { workspace_id: string }[] } = await deps.db.execute(
      sql`SELECT workspace_id FROM billing_sweep_workspaces(${after}::uuid, ${page})`
    );
    for (const { workspace_id } of rows) {
      try {
        const r = await checkDunning(deps, workspace_id, now);
        total.workspaces++;
        total.emails += r.emails;
        total.ended += r.ended;
        if (r.seatDrift) total.seatSyncs++;
      } catch (err) {
        deps.logger.warn({ err, workspaceId: workspace_id }, 'billing: dunning not checked');
      }
    }
    const last = rows.at(-1);
    if (!last || rows.length < page) break;
    after = last.workspace_id;
  }
  return total;
}
