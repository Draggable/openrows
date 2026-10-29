import {
  AI_STATUS_CELLS_MAX,
  type AiCellStatus,
  type AiFieldStatus,
  type AiGenerateInput,
  type AiOptions,
  storeAiPrompt,
} from '@openrows/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { qualified, readExpression } from '../../data/columns.js';
import { loadGraph } from '../../data/computed/engine.js';
import { aiFieldCells, type Transaction } from '../../db/index.js';
import type { FieldRow, TableRow } from '../../fields/service.js';
import { AppError } from '../../lib/errors.js';
import { aiOptionsOf, emitAiStatus, requestAiCells } from './repo.js';

/**
 * AI fields on the request side: checking a field's options before it's saved, the
 * backfill when it's created or its prompt changes, and the routes' status, generate and cancel.
 */

function invalid(path: string, message: string): never {
  throw new AppError('VALIDATION_FAILED', {
    detail: 'The field options are invalid.',
    extensions: { errors: [{ path, message }] },
  });
}

/**
 * The options to store: the prompt in its stored form (fields by id) and the fields it reads.
 * A prompt may read any live field of its table except AI fields and the computed fields reading
 * one (an answer never feeds another prompt, so answers can't set each other off), and a select
 * output needs options.
 */
export async function prepareAiOptions(
  tx: Transaction,
  table: Pick<TableRow, 'id' | 'baseId'>,
  candidate: { id: string; options: AiOptions; isPrimary: boolean }
): Promise<AiOptions> {
  if (candidate.isPrimary) invalid('type', "The primary field can't be an AI field.");
  const g = await loadGraph(tx, table.baseId);
  const own = [...g.rows.values()].filter((r) => r.tableId === table.id && r.id !== candidate.id);
  const stored = storeAiPrompt(candidate.options.prompt, own);
  if (!stored.ok) invalid('options.prompt', stored.message);
  const aiIds = [...g.rows.values()].filter((r) => r.type === 'ai').map((r) => r.id);
  const fromAi = new Set([...aiIds, candidate.id, ...g.graph.downstream([...aiIds, candidate.id])]);
  for (const id of stored.referencedFieldIds) {
    if (fromAi.has(id)) {
      const name = g.rows.get(id)?.name ?? 'that field';
      invalid('options.prompt', `A prompt can't read ${name}: it is or reads an AI field.`);
    }
  }
  if (candidate.options.output === 'singleSelect' && candidate.options.choices.length === 0) {
    invalid('options.choices', 'Add the options the answer picks from.');
  }
  return {
    ...candidate.options,
    prompt: stored.prompt,
    referencedFieldIds: stored.referencedFieldIds,
  };
}

/** Whether a change of options asks every record for a new answer (prompt or output changed). */
export function promptChanged(before: AiOptions, after: AiOptions): boolean {
  return before.prompt !== after.prompt || before.output !== after.output;
}

const idList = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

async function liveRecordIds(tx: Transaction, table: TableRow, ids?: readonly string[]) {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM ${qualified(table)}
     WHERE deleted_at IS NULL ${ids ? sql`AND id = ANY(${idList(ids)})` : sql``}
     ORDER BY id`);
  return rows.map((r) => r.id);
}

/** Asks every live record of the table for an answer (a new field, a changed prompt). */
export async function backfillAiField(
  tx: Transaction,
  table: TableRow,
  field: FieldRow,
  actorId: string | null
): Promise<number> {
  const options = aiOptionsOf(field.config);
  if (!options.prompt.trim()) return 0;
  return requestAiCells(tx, field, table.baseId, await liveRecordIds(tx, table), actorId);
}

/**
 * `POST /api/fields/:fieldId/ai/generate`: records by id (live records of the table, else 404),
 * or the whole field (`all`), or the records with no value or a failed or canceled answer
 * (`missing`). Answers how many records were queued.
 */
export async function generateAiField(
  tx: Transaction,
  table: TableRow,
  field: FieldRow,
  input: AiGenerateInput,
  actorId: string
): Promise<number> {
  assertAiField(field);
  const options = aiOptionsOf(field.config);
  if (!options.prompt.trim()) {
    throw new AppError('VALIDATION_FAILED', { detail: 'Write the prompt of this field first.' });
  }
  let ids: string[];
  if ('recordIds' in input) {
    const unique = [...new Set(input.recordIds)];
    ids = await liveRecordIds(tx, table, unique);
    if (ids.length !== unique.length) {
      throw new AppError('NOT_FOUND', { detail: 'No such record in this table.' });
    }
  } else if (input.scope === 'all') {
    ids = await liveRecordIds(tx, table);
  } else {
    const value = readExpression(field);
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT r.id FROM ${qualified(table)} r
        LEFT JOIN ai_field_cells c ON c.field_id = ${field.id}::uuid AND c.record_id = r.id
       WHERE r.deleted_at IS NULL
         AND (c.status IS NULL OR c.status IN ('error', 'canceled')
              OR (c.status = 'done' AND ${value} IS NULL))
       ORDER BY r.id`);
    ids = rows.map((r) => r.id);
  }
  return requestAiCells(tx, field, table.baseId, ids, actorId);
}

/** `POST /api/fields/:fieldId/ai/cancel`: the pending cells become `canceled` (values kept). */
export async function cancelAiField(
  tx: Transaction,
  table: TableRow,
  field: FieldRow,
  actorId: string
): Promise<number> {
  assertAiField(field);
  const rows = await tx
    .update(aiFieldCells)
    .set({ status: 'canceled', updatedAt: new Date() })
    .where(and(eq(aiFieldCells.fieldId, field.id), eq(aiFieldCells.status, 'pending')))
    .returning({ recordId: aiFieldCells.recordId });
  if (rows.length) await emitAiStatus(tx, field, table.baseId, actorId);
  return rows.length;
}

/** `GET /api/fields/:fieldId/ai`: counts, and the records not done (live ones). */
export async function aiFieldStatus(
  tx: Transaction,
  table: TableRow,
  field: FieldRow,
  available: boolean
): Promise<AiFieldStatus> {
  assertAiField(field);
  const counts = { pending: 0, done: 0, error: 0, canceled: 0 };
  const { rows } = await tx.execute<{ status: AiCellStatus; n: string }>(sql`
    SELECT c.status, count(*) AS n FROM ai_field_cells c
      JOIN ${qualified(table)} r ON r.id = c.record_id AND r.deleted_at IS NULL
     WHERE c.field_id = ${field.id}::uuid GROUP BY c.status`);
  for (const r of rows) counts[r.status] = Number(r.n);
  const cells = await tx.execute<{
    record_id: string;
    status: AiCellStatus;
    error: string | null;
    updated_at: Date | string;
  }>(sql`
    SELECT c.record_id, c.status, c.error, c.updated_at FROM ai_field_cells c
      JOIN ${qualified(table)} r ON r.id = c.record_id AND r.deleted_at IS NULL
     WHERE c.field_id = ${field.id}::uuid AND c.status <> 'done'
     ORDER BY c.requested_at, c.record_id LIMIT ${AI_STATUS_CELLS_MAX}`);
  return {
    fieldId: field.id,
    available,
    counts,
    cells: cells.rows.map((c) => ({
      recordId: c.record_id,
      status: c.status,
      error: c.error,
      updatedAt: new Date(c.updated_at).toISOString(),
    })),
  };
}

/** Drops the cells' state of records (a field converted away from AI keeps none). */
export async function clearAiCells(tx: Transaction, fieldId: string, recordIds?: string[]) {
  await tx
    .delete(aiFieldCells)
    .where(
      recordIds
        ? and(eq(aiFieldCells.fieldId, fieldId), inArray(aiFieldCells.recordId, recordIds))
        : eq(aiFieldCells.fieldId, fieldId)
    );
}

function assertAiField(field: FieldRow) {
  if (field.type !== 'ai') {
    throw new AppError('VALIDATION_FAILED', { detail: 'This field is not an AI field.' });
  }
}
