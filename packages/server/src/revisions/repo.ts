import { isDeepStrictEqual } from 'node:util';
import { REVISION_COALESCE_SECONDS, type RevisionKind } from '@openrows/shared';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { recordRevisions, type Transaction } from '../db/index.js';

/**
 * Writes record revisions in the caller's transaction: the RecordService calls this next
 * to its outbox events, so a rolled-back change leaves no history either.
 */

/** One changed cell: API values before and after, and the field's type at the time. */
export interface CellChange {
  type: string;
  before: unknown;
  after: unknown;
}

export type Changes = Record<string, CellChange>;

export interface RevisionScope {
  workspaceId: string;
  baseId: string;
  tableId: string;
  /** Null for a change no person made (`via`). */
  actorId: string | null;
  /**
   * How a change without a person was made: a public form's submission, or an
   * automation's step (`actorId` is then the person it ran as).
   */
  via?: 'form' | 'automation' | undefined;
  clientOpId?: string | undefined;
  /** Set on a restore: never coalesced, and the feed says what it brought back. */
  restoredFrom?: string | undefined;
}

export interface RevisionInput {
  recordId: string;
  kind: RevisionKind;
  changes?: Changes;
}

/** Null and undefined are the same empty cell; everything else compares structurally. */
export function sameValue(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(a ?? null, b ?? null);
}

/** The cells of `changes` whose value really changed. */
export function realChanges(changes: Changes): Changes {
  return Object.fromEntries(
    Object.entries(changes).filter(([, c]) => !sameValue(c.before, c.after))
  );
}

const sameKeys = (a: Changes, b: Changes) => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
};

interface Latest extends Record<string, unknown> {
  id: string;
  record_id: string;
  actor_id: string | null;
  via: string | null;
  kind: string;
  changes: Changes;
  restored_from: string | null;
  recent: boolean;
}

/**
 * Records revisions for `inputs`. An `updated` revision whose cells didn't really change is
 * skipped. Edits of the same cells of a record by the same actor within
 * `REVISION_COALESCE_SECONDS` of the record's latest revision (and nothing in between) merge
 * into it: its first `before`, the new `after`; when that round-trips to the original values,
 * the revision goes away.
 */
export async function writeRevisions(
  tx: Transaction,
  scope: RevisionScope,
  inputs: readonly RevisionInput[]
): Promise<void> {
  const items = inputs.flatMap((i) => {
    if (i.kind !== 'updated') return [{ ...i, changes: {} }];
    const changes = realChanges(i.changes ?? {});
    return Object.keys(changes).length > 0 ? [{ ...i, changes }] : [];
  });
  if (items.length === 0) return;

  const coalescable = scope.restoredFrom
    ? []
    : items.filter((i) => i.kind === 'updated').map((i) => i.recordId);
  const latest = new Map<string, Latest>();
  if (coalescable.length > 0) {
    const { rows } = await tx.execute<Latest>(sql`
      SELECT DISTINCT ON (record_id) id, record_id, actor_id, via, kind, changes, restored_from,
             updated_at > now() - make_interval(secs => ${REVISION_COALESCE_SECONDS}) AS recent
        FROM record_revisions
       WHERE base_id = ${scope.baseId}
         AND record_id = ANY(${`{${coalescable.join(',')}}`}::uuid[])
       ORDER BY record_id, created_at DESC, id DESC`);
    for (const row of rows) latest.set(row.record_id, row);
  }

  const fresh: (typeof recordRevisions.$inferInsert)[] = [];
  for (const item of items) {
    const prev = latest.get(item.recordId);
    if (
      prev &&
      item.kind === 'updated' &&
      prev.kind === 'updated' &&
      prev.recent &&
      prev.actor_id === scope.actorId &&
      prev.via === (scope.via ?? null) &&
      prev.restored_from === null &&
      sameKeys(prev.changes, item.changes)
    ) {
      const merged = realChanges(
        Object.fromEntries(
          Object.entries(item.changes).map(([fieldId, c]) => [
            fieldId,
            { type: c.type, before: prev.changes[fieldId]?.before ?? null, after: c.after },
          ])
        )
      );
      if (Object.keys(merged).length === 0) {
        await tx.delete(recordRevisions).where(eq(recordRevisions.id, prev.id));
      } else {
        await tx
          .update(recordRevisions)
          .set({
            changes: merged,
            updatedAt: sql`now()`,
            clientOpId: scope.clientOpId ?? null,
          })
          .where(eq(recordRevisions.id, prev.id));
      }
      continue;
    }
    fresh.push({
      id: uuidv7(),
      workspaceId: scope.workspaceId,
      baseId: scope.baseId,
      tableId: scope.tableId,
      recordId: item.recordId,
      actorId: scope.actorId,
      kind: item.kind,
      changes: item.changes,
      clientOpId: scope.clientOpId ?? null,
      restoredFrom: scope.restoredFrom ?? null,
      via: scope.via ?? null,
    });
  }
  for (let i = 0; i < fresh.length; i += 1000) {
    await tx.insert(recordRevisions).values(fresh.slice(i, i + 1000));
  }
}

/**
 * Deletes revisions past their workspace's retention (`record_revisions_prune`, drizzle/0022):
 * `defaultDays` for every workspace, unless `overrides` (workspace id → days; hosted plans)
 * says otherwise. Returns how many went.
 */
export async function pruneRevisions(
  db: { execute: Transaction['execute'] },
  defaultDays: number,
  overrides: Readonly<Record<string, number>> = {}
): Promise<number> {
  const { rows } = await db.execute<{ pruned: string | null }>(
    sql`SELECT record_revisions_prune(${defaultDays}::integer, ${JSON.stringify(overrides)}::jsonb) AS pruned`
  );
  return Number(rows[0]?.pruned ?? 0);
}
