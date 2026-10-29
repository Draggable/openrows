import { BILLING_GRACE_DAYS, planOverridesSchema } from '@openrows/shared';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { setScope } from '../authz/scope.js';
import type { Database, Transaction } from '../db/index.js';
import type { BillingEvent, BillingWebhooks, StoredSubscription } from '../edition/types.js';

/**
 * Applies a verified billing provider event in one transaction: the event id is claimed
 * first (`billing_event_claim`: a replay or retry of an applied event changes nothing), the
 * subscription is stored unless the stored one is newer (or ended: a canceled subscription is
 * never revived), and the workspace's plan follows its subscriptions (`workspace_plan_set`,
 * which notifies every process to drop its cached entitlements). Its operator overrides stay.
 * Any error rolls everything back, the claim included, so the provider's retry applies it.
 *
 * Dunning: a `past_due` subscription records when it went past due (`past_due_since`) and
 * keeps its plan for BILLING_GRACE_DAYS; an event past the grace period stores it as not
 * entitled (the hourly `billing.dunning` sweep does the same without an event, dunning.ts).
 * Leaving `past_due` (paid, or ended) clears both.
 */
export type BillingOutcome = 'applied' | 'duplicate' | 'ignored' | 'stale' | 'unmatched';

export interface ApplyResult {
  outcome: BillingOutcome;
  workspaceId: string | null;
  /** Set when the workspace's stored plan changed (null: the default plan). */
  planChange?: { from: string | null; to: string | null };
  /** Why an event was unmatched, for the log. */
  reason?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Statuses a subscription doesn't come back from. */
const ENDED = new Set(['canceled', 'incomplete_expired']);

export function applyBillingEvent(
  db: Database,
  webhooks: BillingWebhooks,
  event: BillingEvent
): Promise<ApplyResult> {
  const { provider } = webhooks;
  return db.transaction(async (tx) => {
    await setScope(tx, { userId: '' });
    const { rows: claimed } = await tx.execute<{ ok: boolean }>(
      sql`SELECT billing_event_claim(${provider}, ${event.id}, ${event.type}) AS ok`
    );
    if (claimed[0]?.ok !== true) return { outcome: 'duplicate', workspaceId: null };
    const result = await apply(tx, webhooks, event);
    await tx.execute(
      sql`SELECT billing_event_settle(${provider}, ${event.id}, ${result.outcome}, ${result.workspaceId}::uuid)`
    );
    return result;
  });
}

async function apply(
  tx: Transaction,
  webhooks: BillingWebhooks,
  event: BillingEvent
): Promise<ApplyResult> {
  const { provider } = webhooks;
  const sub = event.subscription;
  if (!sub) return { outcome: 'ignored', workspaceId: null };

  const { rows: owners } = await tx.execute<{ workspace_id: string | null }>(
    sql`SELECT billing_subscription_workspace(${provider}, ${sub.id}) AS workspace_id`
  );
  const owner = owners[0]?.workspace_id ?? null;
  const named = sub.workspaceId && UUID_RE.test(sub.workspaceId) ? sub.workspaceId : null;
  const workspaceId = named ?? owner;
  if (!workspaceId) return { outcome: 'unmatched', workspaceId: null, reason: 'no workspace' };
  if (owner && owner !== workspaceId) {
    return {
      outcome: 'unmatched',
      workspaceId: owner,
      reason: 'subscription of another workspace',
    };
  }

  // One event at a time per workspace, so the plan follows the last one applied.
  await lockWorkspaceBilling(tx, workspaceId);
  await setScope(tx, { userId: '', workspaceId });
  const { rows: workspaces } = await tx.execute<{ plan: string | null; plan_overrides: unknown }>(
    sql`SELECT plan, plan_overrides FROM workspaces WHERE id = ${workspaceId}::uuid`
  );
  const workspace = workspaces[0];
  if (!workspace) return { outcome: 'unmatched', workspaceId: null, reason: 'unknown workspace' };

  const { rows: existing } = await tx.execute<{ status: string; newer: boolean }>(
    sql`SELECT status, changed_at > ${sub.changedAt}::timestamptz AS newer
          FROM billing_subscriptions
         WHERE provider = ${provider} AND subscription_id = ${sub.id}
           FOR UPDATE`
  );
  const stored = existing[0];
  if (stored && (stored.newer || (ENDED.has(stored.status) && !ENDED.has(sub.status)))) {
    return { outcome: 'stale', workspaceId };
  }

  // An event without a seat count (the provider doesn't say) keeps the stored one.
  const reportsSeats = sub.seats !== undefined;
  await tx.execute(sql`
    INSERT INTO billing_subscriptions
      (id, workspace_id, provider, subscription_id, customer_id, plan, interval, status, entitled,
       cancel_at_period_end, current_period_end, changed_at, seats, past_due_since)
    VALUES (${uuidv7()}::uuid, ${workspaceId}::uuid, ${provider}, ${sub.id}, ${sub.customerId},
            ${sub.plan}, ${sub.interval}, ${sub.status}, ${sub.entitled}, ${sub.cancelAtPeriodEnd},
            ${sub.currentPeriodEnd}::timestamptz, ${sub.changedAt}::timestamptz,
            ${sub.seats ?? null}::integer,
            CASE WHEN ${sub.status} = 'past_due' THEN now() END)
    ON CONFLICT (provider, subscription_id) DO UPDATE SET
      customer_id = excluded.customer_id, plan = excluded.plan, interval = excluded.interval,
      status = excluded.status,
      entitled = excluded.entitled AND NOT (
        excluded.status = 'past_due'
        AND coalesce(billing_subscriptions.past_due_since, now())
            + make_interval(days => ${BILLING_GRACE_DAYS}) <= now()),
      cancel_at_period_end = excluded.cancel_at_period_end,
      current_period_end = excluded.current_period_end, changed_at = excluded.changed_at,
      seats = CASE WHEN ${reportsSeats} THEN excluded.seats ELSE billing_subscriptions.seats END,
      past_due_since = CASE WHEN excluded.status = 'past_due'
        THEN coalesce(billing_subscriptions.past_due_since, now()) END,
      dunning_stage = CASE WHEN excluded.status = 'past_due'
        THEN billing_subscriptions.dunning_stage ELSE 0 END,
      updated_at = now()`);

  const planChange = await syncWorkspacePlan(tx, webhooks, workspaceId, workspace);
  return { outcome: 'applied', workspaceId, ...(planChange ? { planChange } : {}) };
}

/**
 * Sets the workspace's plan to what its stored subscriptions give it (`planFor`), keeping its
 * overrides; returns the change, or null when the plan already was that. Needs the workspace's
 * scope and its billing lock.
 */
export async function syncWorkspacePlan(
  tx: Transaction,
  webhooks: Pick<BillingWebhooks, 'planFor'>,
  workspaceId: string,
  workspace?: { plan: string | null; plan_overrides: unknown }
): Promise<{ from: string | null; to: string | null } | null> {
  let current = workspace;
  if (!current) {
    const { rows } = await tx.execute<{ plan: string | null; plan_overrides: unknown }>(
      sql`SELECT plan, plan_overrides FROM workspaces WHERE id = ${workspaceId}::uuid`
    );
    current = rows[0];
    if (!current) return null;
  }
  const subscriptions = await workspaceSubscriptions(tx, workspaceId);
  const target = webhooks.planFor(subscriptions);
  if (target === current.plan) return null;
  const overrides = planOverridesSchema.safeParse(current.plan_overrides);
  await tx.execute(
    sql`SELECT workspace_plan_set(${workspaceId}::uuid, ${target}::text, ${JSON.stringify(overrides.success ? overrides.data : {})}::jsonb)`
  );
  return { from: current.plan, to: target };
}

/** One billing change at a time per workspace (events, the dunning sweep, the seat sync). */
export async function lockWorkspaceBilling(tx: Transaction, workspaceId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`billing:${workspaceId}`}, 0))`
  );
}

/** The workspace's subscriptions, newest first, in its scope (RLS). */
export async function workspaceSubscriptions(
  tx: Transaction,
  workspaceId: string
): Promise<(StoredSubscription & StoredSubscriptionDetails)[]> {
  const { rows } = await tx.execute<{
    subscription_id: string;
    customer_id: string;
    plan: string;
    interval: StoredSubscription['interval'];
    status: StoredSubscription['status'];
    entitled: boolean;
    cancel_at_period_end: boolean;
    current_period_end: string | Date | null;
    seats: number | null;
    past_due_since: string | Date | null;
    dunning_stage: number;
  }>(sql`
    SELECT subscription_id, customer_id, plan, interval, status, entitled, cancel_at_period_end,
           current_period_end, seats, past_due_since, dunning_stage
      FROM billing_subscriptions
     WHERE workspace_id = ${workspaceId}::uuid
     ORDER BY changed_at DESC, id DESC`);
  const iso = (v: string | Date | null) => (v === null ? null : new Date(v).toISOString());
  return rows.map((r) => ({
    subscriptionId: r.subscription_id,
    customerId: r.customer_id,
    plan: r.plan,
    interval: r.interval,
    status: r.status,
    entitled: r.entitled,
    cancelAtPeriodEnd: r.cancel_at_period_end,
    currentPeriodEnd: iso(r.current_period_end),
    seats: r.seats,
    pastDueSince: iso(r.past_due_since),
    graceEndsAt:
      r.past_due_since === null ? null : graceEnd(new Date(r.past_due_since)).toISOString(),
    dunningStage: r.dunning_stage,
  }));
}

/** When the grace period of a subscription past due since `since` ends. */
export function graceEnd(since: Date): Date {
  return new Date(since.getTime() + BILLING_GRACE_DAYS * 86_400_000);
}

/** The subscription a workspace's billing shows and acts on: the entitled one, else the latest. */
export function currentSubscription<T extends StoredSubscription>(subscriptions: readonly T[]) {
  return subscriptions.find((s) => s.entitled) ?? subscriptions[0] ?? null;
}

/** Statuses a subscription doesn't come back from. */
export function hasEnded(status: string): boolean {
  return ENDED.has(status);
}

interface StoredSubscriptionDetails {
  customerId: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  seats: number | null;
  pastDueSince: string | null;
  graceEndsAt: string | null;
  dunningStage: number;
}
