import { AUTOMATION_RUN_RETENTION_DAYS, nextScheduledRun, type Schedule } from '@openrows/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { JobInsert } from 'pg-boss';
import { automations, type Database } from '../db/index.js';
import { workspaceGroup } from '../jobs/defer.js';
import { namedJobId } from '../jobs/ids.js';
import type { OutboxSubscriber, RelayEvent } from '../jobs/relay.js';
import { withTenant } from '../jobs/tenant.js';
import { triggerOf } from './service.js';

/** The queue of automation runs (JOB_QUEUES): one job per (event or scheduled time, automation). */
export const AUTOMATION_QUEUE = 'automations.run';

/** The trigger types an outbox kind can start. */
const TRIGGERS_OF_KIND: Readonly<Record<string, readonly string[]>> = {
  'record.created': ['recordCreated', 'recordMatches'],
  'record.updated': ['recordUpdated', 'recordMatches'],
  'form.submitted': ['formSubmitted'],
};

interface Match extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  base_id: string;
  trigger_type: string;
  table_id: string | null;
  armed_at: string;
}

/**
 * Automations as an outbox subscriber: for a batch of record events, the enabled
 * record-triggered automations of each event's own base and table (`automations_matching`:
 * metadata only) armed before the event. The job (one per event and automation, singletonKey
 * `<outbox id>:<automation id>`) reads the event and decides: watched fields, the filter, depth.
 */
export const automationSubscriber: OutboxSubscriber = {
  queue: AUTOMATION_QUEUE,
  async match(events: readonly RelayEvent[], db: Database) {
    const wanted = events.filter((e) => e.baseId !== null && e.tableId && TRIGGERS_OF_KIND[e.kind]);
    const baseIds = [...new Set(wanted.map((e) => e.baseId as string))];
    if (baseIds.length === 0) return [];
    const { rows } = await db.execute<Match>(
      sql`SELECT * FROM automations_matching(${`{${baseIds.join(',')}}`}::uuid[])`
    );
    const byTable = new Map<string, Match[]>();
    for (const row of rows) {
      if (!row.table_id) continue;
      byTable.set(row.table_id, [...(byTable.get(row.table_id) ?? []), row]);
    }
    const out: { event: RelayEvent; subscriberId: string }[] = [];
    for (const event of wanted) {
      const types = TRIGGERS_OF_KIND[event.kind] ?? [];
      for (const a of byTable.get(event.tableId as string) ?? []) {
        if (a.workspace_id !== event.workspaceId || a.base_id !== event.baseId) continue;
        if (!types.includes(a.trigger_type)) continue;
        if (event.createdAt.getTime() < new Date(a.armed_at).getTime()) continue;
        out.push({ event, subscriberId: a.id });
      }
    }
    return out;
  },
};

/** What a run's job carries: the event (record triggers) or the scheduled time. */
export interface AutomationJobData extends Record<string, unknown> {
  workspaceId: string;
  subscriberId: string;
  outboxId?: number;
  scheduledAt?: string;
}

export type ScheduledInserter = (
  queue: string,
  jobs: JobInsert<AutomationJobData>[]
) => Promise<unknown>;

/** Due automations per scheduler run; the rest wait for the next minute. */
const DUE_BATCH = 500;

/**
 * The `automations.schedule` job (every minute): sends a run for each scheduled automation whose
 * next run is due, then moves its next run past now (a schedule that fell behind, the worker
 * being down, runs once, not once per missed time). The job id comes from (automation, time),
 * so a crash between the send and the move sends nothing new next time.
 */
export async function scheduleDueAutomations(
  db: Database,
  insert: ScheduledInserter,
  now: () => Date = () => new Date()
): Promise<{ sent: number }> {
  const { rows } = await db.execute<{ id: string; workspace_id: string; next_run_at: string }>(
    sql`SELECT id, workspace_id, next_run_at FROM automations_due(${DUE_BATCH})`
  );
  let sent = 0;
  for (const due of rows) {
    const at = new Date(due.next_run_at);
    const scheduledAt = at.toISOString();
    await insert(AUTOMATION_QUEUE, [
      {
        id: namedJobId(`openrows:automation-schedule:${due.id}:${scheduledAt}`),
        singletonKey: `schedule:${due.id}:${scheduledAt}`,
        data: { workspaceId: due.workspace_id, subscriberId: due.id, scheduledAt },
        group: workspaceGroup(due.workspace_id),
      },
    ]);
    sent++;
    await withTenant(db, due.workspace_id, async (tx) => {
      const [row] = await tx.select().from(automations).where(eq(automations.id, due.id));
      if (!row?.enabled || row.nextRunAt?.getTime() !== at.getTime()) return;
      const trigger = triggerOf(row);
      if (trigger.type !== 'scheduled') return;
      const current = now();
      const after = current.getTime() > at.getTime() ? current : at;
      await tx
        .update(automations)
        .set({ nextRunAt: nextScheduledRun(trigger.schedule as Schedule, after) })
        .where(and(eq(automations.id, row.id), eq(automations.nextRunAt, at)));
    });
  }
  return { sent };
}

/** Deletes runs past the 30-day retention; returns how many went. */
export async function pruneAutomationRuns(
  db: { execute: Database['execute'] },
  days = AUTOMATION_RUN_RETENTION_DAYS
): Promise<number> {
  const { rows } = await db.execute<{ pruned: string | null }>(
    sql`SELECT automation_runs_prune(${days}::integer) AS pruned`
  );
  return Number(rows[0]?.pruned ?? 0);
}
