import { syncOwnerOf } from '@openrows/shared';
import { asc, eq, sql } from 'drizzle-orm';
import { qualified, readExpression } from '../data/columns.js';
import { type Transaction, tableSyncs } from '../db/index.js';
import type { FieldRow, TableRow } from '../fields/service.js';
import { AppError } from '../lib/errors.js';
import { assertNoSyncedCells, assertNotSyncedTable, editRestricted } from './permissions.js';

/**
 * People's writes to a synced table (never the sync engine's, which has `ctx.sync`). Records
 * and synced fields are read-only, except on a two-way source's own records: their written-back
 * fields (the source's `write_back_field_ids`) can be edited, and the records deleted or
 * restored. Who owns a record is shared's syncOwnerOf, by its "Sync source" and "Sync source ID"
 * cells. Everything else keeps the rules of permissions.ts (403 EDIT_RESTRICTED).
 */

interface Source {
  id: string;
  sourceFieldId: string;
  ownerFieldId: string | null;
  ownsUnattributed: boolean;
  twoWay: boolean;
  fields: Set<string>;
}

/** The table's sources, oldest first, when one of them is two-way; else null. */
async function twoWaySources(tx: Transaction, table: TableRow): Promise<Source[] | null> {
  const rows = await tx
    .select()
    .from(tableSyncs)
    .where(eq(tableSyncs.tableId, table.id))
    .orderBy(asc(tableSyncs.createdAt), asc(tableSyncs.id));
  if (!rows.some((r) => r.twoWay)) return null;
  return rows.map((r) => ({
    id: r.id,
    sourceFieldId: r.sourceFieldId,
    ownerFieldId: r.ownerFieldId,
    ownsUnattributed: r.ownsUnattributed,
    twoWay: r.twoWay,
    fields: new Set(
      r.twoWay && Array.isArray(r.writeBackFieldIds)
        ? (r.writeBackFieldIds as unknown[]).filter((id): id is string => typeof id === 'string')
        : []
    ),
  }));
}

/**
 * Each record's two-way owner (live records, or with `deleted` trashed ones too); null: none, or
 * a one-way source.
 */
async function owners(
  tx: Transaction,
  table: TableRow,
  fields: readonly FieldRow[],
  sources: Source[],
  ids: readonly string[],
  deleted: boolean
): Promise<Map<string, Source | null>> {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const [first] = sources;
  const keyField = first ? byId.get(first.sourceFieldId) : undefined;
  const ownerFieldId = sources.find((s) => s.ownerFieldId)?.ownerFieldId;
  const ownerField = ownerFieldId ? byId.get(ownerFieldId) : undefined;
  // Records that aren't there are left out: the write's own check answers 404 for them.
  const out = new Map<string, Source | null>();
  if (!keyField || (ownerFieldId && !ownerField) || !ids.length) return out;
  const cell = (f: FieldRow | undefined) => (f ? readExpression(f) : sql`NULL::text`);
  const { rows } = await tx.execute<{ id: string; key: unknown; owner: unknown }>(sql`
    SELECT r.id, ${cell(keyField)} AS key, ${cell(ownerField)} AS owner
      FROM ${qualified(table)} AS r
     WHERE r.id = ANY(${`{${ids.join(',')}}`}::uuid[])
       ${deleted ? sql`` : sql`AND r.deleted_at IS NULL`}`);
  for (const r of rows) {
    const cells: Record<string, unknown> = { [keyField.id]: r.key };
    if (ownerField) cells[ownerField.id] = r.owner;
    const owner = syncOwnerOf(sources, cells);
    out.set(r.id, owner?.twoWay ? owner : null);
  }
  return out;
}

/**
 * 403 unless every synced cell of `patches` is a written-back field of the two-way source that
 * owns its record (a table without a two-way source: no synced cell at all). Records that aren't
 * there are left to the update's own 404.
 */
export async function assertSyncedCellsWritable(
  tx: Transaction,
  table: TableRow,
  fields: readonly { row: FieldRow }[],
  patches: readonly { id: string; path: string; cells: Record<string, unknown> }[]
): Promise<void> {
  const synced = new Map(fields.filter((f) => f.row.synced).map((f) => [f.row.id, f.row]));
  const touched = patches.filter((p) => Object.keys(p.cells).some((id) => synced.has(id)));
  if (!touched.length) return;
  const sources = table.synced ? await twoWaySources(tx, table) : null;
  if (!sources) return assertNoSyncedCells(fields, patches);
  const owned = await owners(
    tx,
    table,
    fields.map((f) => f.row),
    sources,
    touched.map((p) => p.id),
    false
  );
  const errors: { path: string; message: string }[] = [];
  const denied = new Map<string, FieldRow>();
  for (const p of touched) {
    if (!owned.has(p.id)) continue;
    const owner = owned.get(p.id);
    for (const fieldId of Object.keys(p.cells)) {
      const row = synced.get(fieldId);
      if (!row || owner?.fields.has(fieldId)) continue;
      errors.push({
        path: `${p.path}.${fieldId}`,
        message: `"${row.name}" is synced from another table and can't be edited here.`,
      });
      denied.set(fieldId, row);
    }
  }
  if (errors.length) editRestricted(errors, [...denied.values()]);
}

/**
 * 403 unless the table isn't synced or every record is a two-way source's own: deleting one
 * deletes its source record at the next run, restoring it (before then) cancels that.
 */
export async function assertSyncedRecordsRemovable(
  tx: Transaction,
  table: TableRow,
  fields: readonly FieldRow[],
  ids: readonly string[],
  verb: 'delete' | 'restore'
): Promise<void> {
  if (!table.synced) return;
  const sources = await twoWaySources(tx, table);
  if (!sources) return assertNotSyncedTable(table, verb);
  const owned = await owners(tx, table, fields, sources, ids, verb === 'restore');
  const unowned = ids.filter((id) => owned.has(id) && !owned.get(id));
  if (!unowned.length) return;
  throw new AppError('EDIT_RESTRICTED', {
    detail: `"${table.name}" is synced from another table: only records of a source that syncs both ways can be ${verb === 'delete' ? 'deleted' : 'restored'} here.`,
    extensions: { tableId: table.id, synced: true, recordIds: unowned },
  });
}
