import { WEBHOOK_DELIVERY_RETENTION_DAYS, type WebhookEventType } from '@openrows/shared';
import { sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import type { OutboxSubscriber, RelayEvent } from '../jobs/relay.js';

/** The queue of webhook deliveries (JOB_QUEUES): one job per event and webhook. */
export const WEBHOOK_QUEUE = 'webhooks.deliver';

/** The webhook event types an outbox kind can become (record.created: a form's too). */
const TYPES_OF_KIND: Readonly<Record<string, readonly WebhookEventType[]>> = {
  'record.created': ['record.created', 'form.submitted'],
  'record.updated': ['record.updated'],
  'record.deleted': ['record.deleted'],
  'record.restored': ['record.restored'],
  'field.created': ['field.created'],
  'field.updated': ['field.updated'],
  'field.deleted': ['field.deleted'],
  'field.restored': ['field.restored'],
  'table.created': ['table.created'],
  'table.updated': ['table.updated'],
  'table.deleted': ['table.deleted'],
  'table.restored': ['table.restored'],
  'comment.created': ['comment.created'],
  'comment.updated': ['comment.updated'],
  'comment.deleted': ['comment.deleted'],
};

interface Match extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  base_id: string;
  events: string[];
  table_ids: string[] | null;
  created_at: string;
}

/**
 * Webhooks as an outbox subscriber: for a batch of events, the enabled webhooks of
 * each event's own base whose event types and table filter match (`webhooks_matching`: metadata
 * only). The finer checks (field filter, form submissions, computed updates, the creator's
 * access) happen when the job runs, against the event's payload.
 */
export const webhookSubscriber: OutboxSubscriber = {
  queue: WEBHOOK_QUEUE,
  async match(events: readonly RelayEvent[], db: Database) {
    const wanted = events.filter((e) => e.baseId !== null && TYPES_OF_KIND[e.kind]);
    const baseIds = [...new Set(wanted.map((e) => e.baseId as string))];
    if (baseIds.length === 0) return [];
    const { rows } = await db.execute<Match>(
      sql`SELECT * FROM webhooks_matching(${`{${baseIds.join(',')}}`}::uuid[])`
    );
    const byBase = new Map<string, Match[]>();
    for (const row of rows) byBase.set(row.base_id, [...(byBase.get(row.base_id) ?? []), row]);
    const out: { event: RelayEvent; subscriberId: string }[] = [];
    for (const event of wanted) {
      const types = TYPES_OF_KIND[event.kind] ?? [];
      for (const hook of byBase.get(event.baseId as string) ?? []) {
        if (hook.workspace_id !== event.workspaceId) continue;
        // Events from before the webhook existed aren't its business.
        if (event.createdAt.getTime() < new Date(hook.created_at).getTime()) continue;
        if (!types.some((t) => hook.events.includes(t))) continue;
        if (hook.table_ids && (!event.tableId || !hook.table_ids.includes(event.tableId))) continue;
        out.push({ event, subscriberId: hook.id });
      }
    }
    return out;
  },
};

/** Deletes delivery log entries past the 7-day retention; returns how many went. */
export async function pruneWebhookDeliveries(
  db: { execute: Database['execute'] },
  days = WEBHOOK_DELIVERY_RETENTION_DAYS
): Promise<number> {
  const { rows } = await db.execute<{ pruned: string | null }>(
    sql`SELECT webhook_deliveries_prune(${days}::integer) AS pruned`
  );
  return Number(rows[0]?.pruned ?? 0);
}
