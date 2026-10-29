import type { ListRevisionsQuery, Revision, RevisionChange, RevisionKind } from '@openrows/shared';
import { and, asc, desc, eq, type SQL, sql } from 'drizzle-orm';
import { recordRevisions } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import { missingTargets } from '../records/links.js';
import { selectByIds } from '../records/repo.js';
import {
  type FieldInfo,
  getRecord,
  type RecordContext,
  type RecordReadContext,
  tableFields,
  updateRecords,
} from '../records/service.js';
import { type Changes, sameValue } from './repo.js';

/**
 * Record revision history: the list behind the record's Activity tab and restores. Every
 * function runs in the authorized table's transaction and reaches only revisions of a live record
 * of that table. Fields the reader can't read (`hidden`: the same FieldVisibility the realtime
 * projection applies) and fields no longer in the table are left out, as REST reads leave them.
 */

export interface RevisionReadContext extends RecordReadContext {
  /** Fields of the table the caller may not read. */
  hidden: ReadonlySet<string>;
  /**
   * The plan's history window: revisions last changed before it are hidden (listed as if
   * they weren't there, 404 to restore), never deleted, so an upgrade brings them back. Null: all.
   */
  since: Date | null;
}

/** Revisions inside the plan's history window. */
const inWindow = (ctx: { since: Date | null }): SQL | undefined =>
  ctx.since
    ? sql`${recordRevisions.updatedAt} >= ${ctx.since.toISOString()}::timestamptz`
    : undefined;

type RevisionRow = typeof recordRevisions.$inferSelect;

async function assertLiveRecord(ctx: RecordReadContext, recordId: string) {
  const [row] = await selectByIds(ctx.tx, ctx.table, [], [recordId]);
  if (!row) throw new AppError('NOT_FOUND', { detail: 'No such record in this table.' });
}

const ofRecord = (ctx: RecordReadContext, recordId: string): SQL =>
  and(
    eq(recordRevisions.baseId, ctx.table.baseId),
    eq(recordRevisions.tableId, ctx.table.id),
    eq(recordRevisions.recordId, recordId)
  ) as SQL;

/** The opaque cursor: the last revision's `created_at` (microseconds, UTC) and id. */
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)_([0-9a-f-]{36})$/;

function encodeCursor(key: string, id: string): string {
  return Buffer.from(`${key}_${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { at: string; id: string } {
  const match = CURSOR.exec(Buffer.from(cursor, 'base64url').toString());
  if (!match?.[1] || !match[2]) {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'The query is invalid.',
      extensions: { errors: [{ path: 'cursor', message: 'Not a cursor of this list.' }] },
    });
  }
  return { at: match[1], id: match[2] };
}

/** A revision as `ctx`'s reader sees it: only live fields they may read, in field order. */
function toRevision(row: RevisionRow, visible: readonly FieldInfo[]): Revision {
  const changes = (row.changes ?? {}) as Changes;
  return {
    id: row.id,
    recordId: row.recordId,
    kind: row.kind as RevisionKind,
    actorId: row.actorId,
    via: row.via ?? null,
    at: row.updatedAt.toISOString(),
    changes: visible.flatMap((f): RevisionChange[] => {
      const c = changes[f.row.id];
      return c
        ? [{ fieldId: f.row.id, type: c.type, before: c.before ?? null, after: c.after ?? null }]
        : [];
    }),
    restoredFrom: row.restoredFrom,
  };
}

/**
 * A page of a live record's revisions, newest first. An update whose every changed cell the
 * reader can't see is left out of the page (the cursor still moves past it).
 */
export async function listRevisions(
  ctx: RevisionReadContext,
  recordId: string,
  query: ListRevisionsQuery
) {
  await assertLiveRecord(ctx, recordId);
  const after = query.cursor ? decodeCursor(query.cursor) : null;
  const rows = await ctx.tx
    .select({
      row: recordRevisions,
      key: sql<string>`to_char(${recordRevisions.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(recordRevisions)
    .where(
      and(
        ofRecord(ctx, recordId),
        inWindow(ctx),
        after
          ? sql`(${recordRevisions.createdAt}, ${recordRevisions.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`
          : undefined
      )
    )
    .orderBy(desc(recordRevisions.createdAt), desc(recordRevisions.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const visible = (await tableFields(ctx.tx, ctx.table)).filter((f) => !ctx.hidden.has(f.row.id));
  const last = page.at(-1);
  return {
    revisions: page.flatMap(({ row }) => {
      const revision = toRevision(row, visible);
      return revision.kind === 'updated' && revision.changes.length === 0 ? [] : [revision];
    }),
    nextCursor: rows.length > query.limit && last ? encodeCursor(last.key, last.row.id) : null,
  };
}

const isBlank = (v: unknown) =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

/** The ids of a link cell's API value (`[{ id, name }]`). */
const linkIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap((x) =>
        typeof x === 'object' && x !== null && typeof (x as { id?: unknown }).id === 'string'
          ? [(x as { id: string }).id]
          : []
      )
    : [];

/**
 * Restores a live record to how it was right after `revisionId`: each cell that revision
 * changed gets its value after it, and each cell changed only later gets its value from before
 * the first later change. With `fieldId`, only that cell. It is a normal write through
 * `updateRecords` (the base role and edit permissions apply, and it records its own
 * revision, marked `restoredFrom`).
 *
 * A whole-record restore skips cells it can't bring back: fields deleted, hidden from the caller,
 * computed, or of another type since, and values the field no longer accepts (an option deleted
 * since). Linked records deleted since are left out of link cells. A one-cell restore refuses
 * those with a 422 instead. Answers the record.
 */
export async function restoreRevision(
  ctx: RecordContext & { hidden: ReadonlySet<string>; since: Date | null },
  recordId: string,
  revisionId: string,
  fieldId?: string
) {
  const [target] = await ctx.tx
    .select()
    .from(recordRevisions)
    .where(and(ofRecord(ctx, recordId), inWindow(ctx), eq(recordRevisions.id, revisionId)));
  if (!target) throw new AppError('NOT_FOUND', { detail: 'No such revision of this record.' });
  await assertLiveRecord(ctx, recordId);

  const later = await ctx.tx
    .select({ changes: recordRevisions.changes })
    .from(recordRevisions)
    .where(
      and(
        ofRecord(ctx, recordId),
        eq(recordRevisions.kind, 'updated'),
        // The point's own time, at the database's precision (a JS Date has only milliseconds).
        sql`(${recordRevisions.createdAt}, ${recordRevisions.id}) > (SELECT p.created_at, p.id FROM record_revisions p WHERE p.id = ${target.id}::uuid)`
      )
    )
    .orderBy(asc(recordRevisions.createdAt), asc(recordRevisions.id));
  // Field id → its value at the point, with the field's type then.
  const state = new Map<string, { type: string; value: unknown }>();
  for (const [id, c] of Object.entries((target.changes ?? {}) as Changes)) {
    state.set(id, { type: c.type, value: c.after ?? null });
  }
  for (const { changes } of later) {
    for (const [id, c] of Object.entries((changes ?? {}) as Changes)) {
      if (!state.has(id)) state.set(id, { type: c.type, value: c.before ?? null });
    }
  }

  const fields = new Map((await tableFields(ctx.tx, ctx.table)).map((f) => [f.row.id, f]));
  const current = await getRecord(ctx, recordId);
  const refuse = (detail: string): never => {
    throw new AppError('VALIDATION_FAILED', {
      detail,
      extensions: { errors: [{ path: 'fieldId', message: detail }] },
    });
  };
  const wanted = fieldId ? [fieldId] : [...state.keys()];
  const cells: Record<string, unknown> = {};
  for (const id of wanted) {
    const at = state.get(id);
    const field = fields.get(id);
    if (!field || ctx.hidden.has(id)) {
      if (fieldId) refuse('That field is no longer in this table.');
      continue;
    }
    if (!at) continue;
    if (field.def.readOnly || field.def.computed || field.row.type !== at.type) {
      if (fieldId)
        refuse(`"${field.row.name}" changed type since; its old value can't be restored.`);
      continue;
    }
    let value = at.value;
    if (field.link) {
      const ids = linkIds(value);
      const gone = new Set(await missingTargets(ctx.tx, field.link, ids));
      const keep = ids.filter((x) => !gone.has(x));
      if (sameValue(keep, linkIds(current.fields[id]))) continue;
      cells[id] = keep;
      continue;
    }
    if (sameValue(value, current.fields[id])) continue;
    if (!fieldId && field.def.coerce(value, field.options) === null && !isBlank(value)) continue;
    if (isBlank(value)) value = null;
    cells[id] = value;
  }
  if (Object.keys(cells).length === 0) return current;
  const [record] = await updateRecords({ ...ctx, restoredFrom: target.id }, [
    { id: recordId, fields: cells },
  ]);
  if (!record) throw new Error('restore revision: no record returned');
  return record;
}
