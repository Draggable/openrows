import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import type { BillingProvider } from '../edition/types.js';
import type { OutboxSubscriber } from '../jobs/relay.js';
import { withTenant } from '../jobs/tenant.js';
import type { Logger } from '../lib/logger.js';
import { billableEditors } from '../usage/service.js';
import { lockWorkspaceBilling, workspaceSubscriptions } from './store.js';

/**
 * Seat sync: a per-seat subscription's quantity follows the workspace's billable editors
 * (editor and above on the workspace or one of its live bases, usage/service.ts). Membership
 * changes write outbox events; the relay turns them into one `billing.seats` job per workspace,
 * started SEAT_SYNC_DELAY_SECONDS later, and the queue's `stately` policy keeps one queued per
 * workspace, so a burst of changes (an invite list, a cleanup) costs one provider call. The job
 * reads the count when it runs, sets it at the provider (which prorates) only when it differs
 * from the stored seats, then stores it. The hourly dunning sweep queues the job for any drift
 * (a missed event, a failed call past its retries).
 */
export const SEATS_QUEUE = 'billing.seats';
/** How long after a membership change the seats are synced (the debounce window). */
export const SEAT_SYNC_DELAY_SECONDS = 60;

/** Outbox events that can change the billable editors. */
const SEAT_EVENTS = new Set([
  'member.added',
  'member.updated',
  'member.removed',
  'baseMember.added',
  'baseMember.updated',
  'baseMember.removed',
  // A base in the trash takes its base-only collaborators' seats with it.
  'base.deleted',
  'base.restored',
]);

export const seatSubscriber: OutboxSubscriber = {
  queue: SEATS_QUEUE,
  async match(events) {
    const seen = new Set<string>();
    return events.flatMap((event) => {
      if (!SEAT_EVENTS.has(event.kind) || seen.has(event.workspaceId)) return [];
      seen.add(event.workspaceId);
      return [
        {
          event,
          subscriberId: 'seats',
          singletonKey: seatsSingletonKey(event.workspaceId),
          startAfter: SEAT_SYNC_DELAY_SECONDS,
        },
      ];
    });
  },
};

export const seatsSingletonKey = (workspaceId: string) => `seats:${workspaceId}`;

export const seatsJobData = z.object({ workspaceId: z.uuid() });

export interface SeatSyncDeps {
  db: Database;
  billing: BillingProvider;
  logger: Pick<Logger, 'info' | 'warn'>;
}

export type SeatSyncResult =
  | { synced: true; subscriptionId: string; from: number | null; to: number }
  | { synced: false; reason: 'no seats' | 'no subscription' | 'in sync' };

/** The seats a workspace's subscription should have: its billable editors, at least 1. */
export const seatTarget = (editors: number) => Math.max(1, editors);

/**
 * Syncs one workspace's seats. The provider call is outside any transaction (it may take
 * seconds); a failure throws, so pg-boss retries the job. Idempotent: run twice, it calls the
 * provider once.
 */
export async function syncSeats(deps: SeatSyncDeps, workspaceId: string): Promise<SeatSyncResult> {
  const { db, billing } = deps;
  if (!billing.enabled || !billing.updateSeats) return { synced: false, reason: 'no seats' };
  const plan = await withTenant(db, workspaceId, async (tx) => {
    const { rows } = await tx.execute<{ live: boolean }>(
      sql`SELECT deleted_at IS NULL AS live FROM workspaces WHERE id = ${workspaceId}::uuid`
    );
    if (rows[0]?.live !== true) return null;
    const sub = (await workspaceSubscriptions(tx, workspaceId)).find((s) => s.entitled);
    if (!sub) return null;
    return { sub, seats: seatTarget(await billableEditors(tx, workspaceId)) };
  });
  if (!plan) return { synced: false, reason: 'no subscription' };
  const { sub, seats } = plan;
  if (sub.seats === seats) return { synced: false, reason: 'in sync' };

  await billing.updateSeats({ subscriptionId: sub.subscriptionId, seats });
  await withTenant(db, workspaceId, async (tx) => {
    await lockWorkspaceBilling(tx, workspaceId);
    await tx.execute(sql`
      UPDATE billing_subscriptions SET seats = ${seats}, seats_synced_at = now(), updated_at = now()
       WHERE workspace_id = ${workspaceId}::uuid AND subscription_id = ${sub.subscriptionId}`);
  });
  deps.logger.info(
    { workspaceId, subscriptionId: sub.subscriptionId, from: sub.seats, to: seats },
    'billing: seats synced'
  );
  return { synced: true, subscriptionId: sub.subscriptionId, from: sub.seats, to: seats };
}
