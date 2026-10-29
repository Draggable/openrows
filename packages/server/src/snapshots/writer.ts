import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { ObjectStore } from '../attachments/storage.js';
import { setScope } from '../authz/scope.js';
import { qualified } from '../data/columns.js';
import { physicalName } from '../data/ddl.js';
import {
  baseSnapshots,
  bases,
  type Database,
  fields,
  type Transaction,
  tables,
  viewSections,
  views,
} from '../db/index.js';
import { AppError } from '../lib/errors.js';
import {
  SNAPSHOT_CONTENT_TYPE,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  type SnapshotHeader,
  snapshotKey,
} from './format.js';

export type SnapshotRow = typeof baseSnapshots.$inferSelect;

/** Rows read per query: what the writer holds at a time, besides one gzip part in flight. */
export const PAGE_SIZE = 1000;

export interface Counts {
  tables: number;
  records: number;
}

/** The snapshot header of a live base (its live tables, fields, sections and views). */
export async function readHeader(tx: Transaction, workspaceId: string, baseId: string) {
  const [base] = await tx
    .select()
    .from(bases)
    .where(and(eq(bases.id, baseId), isNull(bases.deletedAt)));
  if (!base) throw new AppError('NOT_FOUND', { detail: 'No such base.' });
  const tableRows = await tx
    .select()
    .from(tables)
    .where(and(eq(tables.baseId, baseId), isNull(tables.deletedAt)))
    .orderBy(asc(tables.position), asc(tables.createdAt));
  const ids = tableRows.map((t) => t.id);
  const fieldRows = ids.length
    ? await tx
        .select()
        .from(fields)
        .where(and(inArray(fields.tableId, ids), isNull(fields.deletedAt)))
        .orderBy(asc(fields.position), asc(fields.createdAt))
    : [];
  const sectionRows = ids.length
    ? await tx.select().from(viewSections).where(inArray(viewSections.tableId, ids))
    : [];
  const viewRows = ids.length
    ? await tx
        .select()
        .from(views)
        .where(and(inArray(views.tableId, ids), isNull(views.deletedAt)))
        .orderBy(asc(views.position), asc(views.createdAt))
    : [];
  const head: SnapshotHeader = {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    workspaceId,
    takenAt: new Date().toISOString(),
    base: {
      id: base.id,
      name: base.name,
      description: base.description,
      icon: base.icon,
      color: base.color,
    },
    tables: tableRows.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      icon: t.icon,
      position: t.position,
      permissions: t.permissions,
      fields: fieldRows
        .filter((f) => f.tableId === t.id)
        .map((f) => ({
          id: f.id,
          name: f.name,
          description: f.description,
          type: f.type,
          dbColumn: f.dbColumn,
          isPrimary: f.isPrimary,
          position: f.position,
          config: f.config,
          permissions: f.permissions,
        })),
      sections: sectionRows
        .filter((s) => s.tableId === t.id)
        .map((s) => ({ id: s.id, name: s.name, position: s.position })),
      views: viewRows
        .filter((v) => v.tableId === t.id)
        .map((v) => ({
          id: v.id,
          name: v.name,
          type: v.type,
          position: v.position,
          config: v.config,
          personal: v.personal,
          locked: v.locked,
          sectionId: v.sectionId,
          createdBy: v.createdBy,
        })),
    })),
  };
  return { base, head, tableRows };
}

/** Keyset pages of `query(after)`, each row's `j` (a JSON text) as one line. */
async function* pages(
  tx: Transaction,
  query: (after: string | null) => ReturnType<typeof sql>
): AsyncGenerator<string> {
  let after: string | null = null;
  for (;;) {
    const result = await tx.execute<{ k: string; j: string }>(query(after));
    const rows: { k: string; j: string }[] = result.rows;
    for (const row of rows) yield `${row.j}\n`;
    const last: { k: string } | undefined = rows.at(-1);
    if (!last || rows.length < PAGE_SIZE) return;
    after = last.k;
  }
}

/** Every line of the snapshot, read page by page in `tx`. */
async function* lines(
  tx: Transaction,
  baseId: string,
  head: SnapshotHeader,
  tableRows: (typeof tables.$inferSelect)[],
  counts: Counts
): AsyncGenerator<string> {
  yield `${JSON.stringify(head)}\n`;
  yield* bodyLines(tx, baseId, head, tableRows, counts);
}

/**
 * The lines after the header, read page by page in `tx`. Without `records` (a base duplicated
 * without its records) only the files of views (a form's cover and logo) come along: no
 * record, link or record file.
 */
export async function* bodyLines(
  tx: Transaction,
  baseId: string,
  head: SnapshotHeader,
  tableRows: (typeof tables.$inferSelect)[],
  counts: Counts,
  opts: { records: boolean } = { records: true }
): AsyncGenerator<string> {
  yield `${JSON.stringify({ section: 'attachments' })}\n`;
  yield* pages(
    tx,
    (after) => sql`
      SELECT a.id::text AS k, jsonb_build_object(
               'id', a.id, 'table_id', a.table_id, 'field_id', a.field_id, 'view_id', a.view_id,
               'storage_key', a.storage_key, 'filename', a.filename,
               'content_type', a.content_type, 'size', a.size, 'width', a.width,
               'height', a.height, 'thumbnail_key', a.thumbnail_key,
               'thumbnail_size', a.thumbnail_size, 'created_by', a.created_by,
               'created_at', a.created_at, 'confirmed_at', a.confirmed_at)::text AS j
        FROM attachments a
       WHERE a.base_id = ${baseId} AND a.status = 'ready'
         -- A form submitter's upload counts once it is in a record.
         AND (a.share_id IS NULL OR a.record_id IS NOT NULL)
         ${opts.records ? sql`` : sql`AND a.field_id IS NULL`}
         ${after ? sql`AND a.id > ${after}::uuid` : sql``}
       ORDER BY a.id LIMIT ${PAGE_SIZE}`
  );

  const location = new Map(tableRows.map((t) => [t.id, t]));
  counts.tables = head.tables.filter((t) => location.has(t.id)).length;
  if (!opts.records) return;
  for (const table of head.tables) {
    const t = location.get(table.id);
    if (!t) continue;
    yield `${JSON.stringify({ section: 'records', table: table.id })}\n`;
    for await (const line of pages(
      tx,
      (after) => sql`
        SELECT r.id::text AS k, to_jsonb(r)::text AS j FROM ${qualified(t)} AS r
         WHERE r.deleted_at IS NULL ${after ? sql`AND r.id > ${after}::uuid` : sql``}
         ORDER BY r.id LIMIT ${PAGE_SIZE}`
    )) {
      counts.records++;
      yield line;
    }
  }

  for (const table of head.tables) {
    for (const f of table.fields) {
      // The junction lives with the field that owns it (`l_<its id>`); its inverse shares it.
      if (f.type !== 'link' || f.dbColumn !== physicalName.junction(f.id)) continue;
      const linkedId = (f.config as { linkedTableId?: string } | null)?.linkedTableId;
      const from = location.get(table.id);
      const to = linkedId ? location.get(linkedId) : undefined;
      if (!from || !to) continue;
      const junction = sql`${sql.identifier(from.dbSchema)}.${sql.identifier(f.dbColumn)}`;
      yield `${JSON.stringify({ section: 'links', field: f.id })}\n`;
      yield* pages(
        tx,
        (after) => sql`
          SELECT j.from_id::text || ',' || j.to_id::text AS k,
                 jsonb_build_object('from_id', j.from_id, 'to_id', j.to_id,
                   'position', j.position, 'inverse_position', j.inverse_position)::text AS j
            FROM ${junction} AS j
           WHERE EXISTS (SELECT 1 FROM ${qualified(from)} s
                          WHERE s.id = j.from_id AND s.deleted_at IS NULL)
             AND EXISTS (SELECT 1 FROM ${qualified(to)} d
                          WHERE d.id = j.to_id AND d.deleted_at IS NULL)
             ${
               after
                 ? sql`AND (j.from_id, j.to_id) > (split_part(${after}, ',', 1)::uuid,
                                                    split_part(${after}, ',', 2)::uuid)`
                 : sql``
             }
           ORDER BY j.from_id, j.to_id LIMIT ${PAGE_SIZE}`
      );
    }
  }
}

export interface TakeSnapshotOptions {
  workspaceId: string;
  baseId: string;
  /** Who asked for it; null for the worker's automatic snapshots. */
  userId: string | null;
  kind: SnapshotRow['kind'];
}

/**
 * Takes a snapshot of a live base: reads it in one read-only REPEATABLE READ transaction
 * (a consistent picture across tables), page by page, gzips the lines and streams them to the
 * object store (a multipart upload past one part), then records the snapshot's row. Memory stays
 * bounded by a page of rows and an upload part, whatever the base's size.
 */
export async function takeSnapshot(
  db: Database,
  store: ObjectStore,
  opts: TakeSnapshotOptions
): Promise<SnapshotRow> {
  const scope = { userId: opts.userId ?? '', workspaceId: opts.workspaceId };
  const id = uuidv7();
  const key = snapshotKey(opts.workspaceId, opts.baseId, id);
  const counts: Counts = { tables: 0, records: 0 };
  const { size, baseName } = await db.transaction(
    async (tx) => {
      await setScope(tx, scope);
      const { base, head, tableRows } = await readHeader(tx, opts.workspaceId, opts.baseId);
      const gzip = createGzip();
      const source = Readable.from(lines(tx, base.id, head, tableRows, counts));
      const [size] = await Promise.all([
        store.putStream(key, gzip, SNAPSHOT_CONTENT_TYPE),
        pipeline(source, gzip),
      ]);
      return { size, baseName: base.name };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' }
  );
  try {
    return await db.transaction(async (tx) => {
      await setScope(tx, scope);
      const [row] = await tx
        .insert(baseSnapshots)
        .values({
          id,
          workspaceId: opts.workspaceId,
          baseId: opts.baseId,
          baseName,
          kind: opts.kind,
          storageKey: key,
          size,
          tableCount: counts.tables,
          recordCount: counts.records,
          createdBy: opts.userId,
        })
        .returning();
      if (!row) throw new Error('snapshot: no row returned');
      return row;
    });
  } catch (err) {
    await store.delete(key).catch(() => undefined);
    throw err;
  }
}
