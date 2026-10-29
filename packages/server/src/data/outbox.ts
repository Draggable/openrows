import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { outbox, type Transaction } from '../db/index.js';

export type OutboxKind =
  | 'base.created'
  | 'base.updated'
  | 'base.deleted'
  | 'base.restored'
  | 'table.created'
  | 'table.updated'
  | 'table.deleted'
  | 'table.restored'
  | 'view.created'
  | 'view.updated'
  | 'view.deleted'
  | 'view.restored'
  | 'view.recordMoved'
  | 'viewSection.created'
  | 'viewSection.updated'
  | 'viewSection.deleted'
  | 'field.created'
  | 'field.updated'
  | 'field.deleted'
  | 'field.restored'
  /** Computed fields left for the worker's recompute, and the worker's recomputes. */
  | 'field.recomputing'
  | 'field.recomputed'
  | 'record.created'
  | 'record.updated'
  | 'record.deleted'
  | 'record.restored'
  | 'comment.created'
  | 'comment.updated'
  | 'comment.deleted'
  /** New mentions, for notifications; never sent to clients. */
  | 'comment.mentioned'
  /** A public form's submission (form-submitted automations); never sent to clients. */
  | 'form.submitted'
  /** AI field cells waiting for the worker (`ai.generate`); never sent to clients. */
  | 'ai.requested'
  /** An AI field's generation state changed: clients refetch it. */
  | 'ai.status';

/** Workspace-level events: access may have changed, so live subscriptions are checked again. */
export type AccessEventKind =
  | 'workspace.updated'
  | 'workspace.deleted'
  | 'member.added'
  | 'member.updated'
  | 'member.removed'
  | 'baseMember.added'
  | 'baseMember.updated'
  | 'baseMember.removed';

/** The NOTIFY channels: base events (payload: base id) and access changes (workspace id). */
export const OUTBOX_CHANNEL = 'outbox';
export const ACCESS_CHANNEL = 'outbox_access';

export interface OutboxEvent {
  workspaceId: string;
  baseId: string;
  tableId?: string;
  kind: OutboxKind;
  payload: Record<string, unknown>;
  /** Who made the change; null for a public form's submission or the trash purge. */
  actorId: string | null;
  /** The client's id for the operation, echoed to subscribers (ADR-003). */
  clientOpId?: string;
}

/**
 * Writes an event to the transactional outbox (ADR-003) and notifies `outbox` listeners with the
 * base id. Both happen in the caller's transaction, so a rolled-back change sends nothing.
 */
export async function emit(tx: Transaction, event: OutboxEvent): Promise<void> {
  await emitMany(tx, [event]);
}

const EMIT_BATCH = 1000;

/**
 * The advisory lock key of a base's event stream. Writers hold it shared from their first event
 * to commit; readers take it exclusively without waiting (`lockBaseStream`), so a reader only
 * reads when no transaction holding not-yet-committed ids of the base is in flight. Without it,
 * a transaction that took id 10 and commits after one that took id 11 would be skipped by a
 * reader that already moved past 11 (ADR-003 implementation notes).
 */
function streamKey(baseId: string) {
  return sql`hashtextextended(${`outbox:${baseId}`}, 0)`;
}

/**
 * Tries to lock the base's stream for reading, for the rest of `tx`. False while a writer of the
 * base is in flight: try again shortly (its commit also notifies).
 */
export async function lockBaseStream(tx: Transaction, baseId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ locked: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(${streamKey(baseId)}) AS locked`
  );
  return rows[0]?.locked === true;
}

/**
 * Writes several events (one per record of a bulk write) in as few statements as possible, then
 * notifies each base once. Same transaction as the change, like `emit`.
 */
export async function emitMany(tx: Transaction, events: readonly OutboxEvent[]): Promise<void> {
  if (events.length === 0) return;
  // Shared, so writers never wait for each other; only a reader's brief exclusive try holds them.
  for (const baseId of [...new Set(events.map((e) => e.baseId))].sort()) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${streamKey(baseId)})`);
  }
  for (let i = 0; i < events.length; i += EMIT_BATCH) {
    await tx.insert(outbox).values(
      events.slice(i, i + EMIT_BATCH).map((event) => ({
        workspaceId: event.workspaceId,
        baseId: event.baseId,
        tableId: event.tableId ?? null,
        kind: event.kind,
        payload: event.payload,
        actorId: event.actorId,
        clientOpId: event.clientOpId ?? null,
      }))
    );
  }
  for (const baseId of new Set(events.map((e) => e.baseId))) {
    await tx.execute(sql`SELECT pg_notify(${OUTBOX_CHANNEL}, ${baseId})`);
  }
}

/**
 * Writes a workspace-level event (membership, workspace deleted) and notifies the access channel
 * with the workspace id, so gateways check their live subscriptions in it again on commit.
 */
export async function emitAccessChange(
  tx: Transaction,
  event: {
    workspaceId: string;
    kind: AccessEventKind;
    payload: Record<string, unknown>;
    actorId: string;
  }
): Promise<void> {
  await tx.insert(outbox).values({
    workspaceId: event.workspaceId,
    baseId: null,
    tableId: null,
    kind: event.kind,
    payload: event.payload,
    actorId: event.actorId,
  });
  await tx.execute(sql`SELECT pg_notify(${ACCESS_CHANNEL}, ${event.workspaceId})`);
}

export type OutboxRow = typeof outbox.$inferSelect;

/**
 * A base's events after `since`, oldest first, up to `limit`. Needs a transaction scoped to the
 * base's workspace (RLS) that holds the stream lock (`lockBaseStream`).
 */
export function readBaseEvents(
  tx: Transaction,
  baseId: string,
  since: number,
  limit: number
): Promise<OutboxRow[]> {
  return tx
    .select()
    .from(outbox)
    .where(and(eq(outbox.baseId, baseId), gt(outbox.id, since)))
    .orderBy(asc(outbox.id))
    .limit(limit);
}

/**
 * Where a base's stream stands: its latest event id, or the retention floor when that is higher
 * (no event of the base exists between them), so a fresh subscriber's seq never reads as expired.
 */
export async function baseHead(tx: Transaction, baseId: string): Promise<number> {
  const [row] = await tx
    .select({ id: sql<string | null>`greatest(max(${outbox.id}), outbox_floor())` })
    .from(outbox)
    .where(eq(outbox.baseId, baseId));
  return Number(row?.id ?? 0);
}

/** The highest id the retention may have pruned (`outbox_floor`, drizzle/0015). */
export async function outboxFloor(tx: Transaction): Promise<number> {
  const { rows } = await tx.execute<{ floor: string | null }>(sql`SELECT outbox_floor() AS floor`);
  return Number(rows[0]?.floor ?? 0);
}

/** Deletes events older than `days` (`outbox_prune`); returns how many went. */
export async function pruneOutbox(
  db: { execute: Transaction['execute'] },
  days: number
): Promise<number> {
  const { rows } = await db.execute<{ pruned: string | null }>(
    sql`SELECT outbox_prune(make_interval(days => ${days})) AS pruned`
  );
  return Number(rows[0]?.pruned ?? 0);
}
