import { type AiOptions, aiOptionsSchema } from '@openrows/shared';
import { sql } from 'drizzle-orm';
import { emit } from '../../data/outbox.js';
import type { Transaction } from '../../db/index.js';

/**
 * AI fields' generation requests, written in the transaction of the change that asked for
 * them: the cells become `pending` (requested now), and one `ai.requested` outbox event takes the
 * field to the worker's `ai.generate` job (the relay's aiFieldSubscriber, debounced per field).
 */

/** An AI field as the requests need it. */
export interface AiFieldRef {
  id: string;
  workspaceId: string;
  tableId: string;
}

/** Ids per INSERT (a uuid[] parameter). */
const CHUNK = 5000;

/** The field's options, defaults applied (the defaults when unreadable). */
export function aiOptionsOf(config: unknown): AiOptions {
  const parsed = aiOptionsSchema.safeParse(config ?? {});
  return parsed.success ? parsed.data : aiOptionsSchema.parse({});
}

/** Marks `recordIds` of `field` pending (requested now), without waking the worker. */
export async function markAiPending(
  tx: Transaction,
  field: AiFieldRef,
  recordIds: readonly string[]
): Promise<number> {
  for (let i = 0; i < recordIds.length; i += CHUNK) {
    const ids = recordIds.slice(i, i + CHUNK);
    await tx.execute(sql`
      INSERT INTO ai_field_cells (workspace_id, field_id, record_id, status, requested_at)
      SELECT ${field.workspaceId}::uuid, ${field.id}::uuid, r, 'pending', clock_timestamp()
        FROM unnest(${`{${ids.join(',')}}`}::uuid[]) AS r
      ON CONFLICT (field_id, record_id) DO UPDATE
        SET status = 'pending', error = NULL, requested_at = clock_timestamp(),
            updated_at = now()`);
  }
  return recordIds.length;
}

/** Wakes the worker for a table's pending AI cells: one `ai.requested` event. */
export async function wakeAiWorker(
  tx: Transaction,
  table: { workspaceId: string; baseId: string; id: string },
  actorId: string | null
): Promise<void> {
  await emit(tx, {
    workspaceId: table.workspaceId,
    baseId: table.baseId,
    tableId: table.id,
    kind: 'ai.requested',
    payload: {},
    actorId,
  });
}

/** Marks `recordIds` of `field` pending and wakes the worker. Returns how many were marked. */
export async function requestAiCells(
  tx: Transaction,
  field: AiFieldRef,
  baseId: string,
  recordIds: readonly string[],
  actorId: string | null
): Promise<number> {
  if (!recordIds.length) return 0;
  await markAiPending(tx, field, recordIds);
  await wakeAiWorker(tx, { workspaceId: field.workspaceId, baseId, id: field.tableId }, actorId);
  await emitAiStatus(tx, field, baseId, actorId);
  return recordIds.length;
}

/** Tells the table's clients that a field's generation state changed (they refetch it). */
export async function emitAiStatus(
  tx: Transaction,
  field: AiFieldRef,
  baseId: string,
  actorId: string | null
): Promise<void> {
  await emit(tx, {
    workspaceId: field.workspaceId,
    baseId,
    tableId: field.tableId,
    kind: 'ai.status',
    payload: { fieldId: field.id },
    actorId,
  });
}
