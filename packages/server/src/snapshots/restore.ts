import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { type Base, getFieldType, isFieldTypeName, type UserRole } from '@openrows/shared';
import { eq, type SQL, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { storageKey, thumbnailKeyOf } from '../attachments/service.js';
import type { ObjectStore } from '../attachments/storage.js';
import { createBase } from '../bases/service.js';
import { castFromJson, qualified, type TableLocation } from '../data/columns.js';
import {
  addFieldColumn,
  createJunction,
  createRecordTable,
  physicalName,
  setLockTimeout,
} from '../data/ddl.js';
import {
  attachments,
  bases,
  fields,
  type Transaction,
  tables,
  viewSections,
  views,
} from '../db/index.js';
import type { SchemaContext } from '../fields/service.js';
import { AppError } from '../lib/errors.js';
import { recountTable } from '../usage/counters.js';
import {
  idOfPhysical,
  isSection,
  remapIds,
  type Section,
  SectionSchema,
  SnapshotAttachmentSchema,
  type SnapshotField,
  type SnapshotHeader,
  SnapshotHeaderSchema,
  uuidsIn,
} from './format.js';
import type { SnapshotRow } from './writer.js';

/** Rows written per statement. */
const BATCH = 1000;

const invalid = (detail: string) => new AppError('VALIDATION_FAILED', { detail });
const noStore = "File storage isn't configured.";

/** The ids of the restored base: every old id of the header to a new UUIDv7. */
function metadataMap(head: SnapshotHeader): Map<string, string> {
  const map = new Map<string, string>([[head.base.id, uuidv7()]]);
  for (const t of head.tables) {
    map.set(t.id, uuidv7());
    for (const f of t.fields) map.set(f.id, uuidv7());
    for (const s of t.sections) map.set(s.id, uuidv7());
    for (const v of t.views) map.set(v.id, uuidv7());
  }
  return map;
}

function need(map: ReadonlyMap<string, string>, id: string): string {
  const mapped = map.get(id);
  if (!mapped) throw invalid('The snapshot is inconsistent.');
  return mapped;
}

/** The new physical name of a field (`f_`/`l_` + the new id of the field it derives from). */
function newColumn(f: SnapshotField, map: ReadonlyMap<string, string>): string | null {
  const owner = map.get(idOfPhysical(f.dbColumn));
  if (f.dbColumn.startsWith('l_')) return owner ? physicalName.junction(owner) : null;
  // A column repointed by a type change keeps a name of its own: it follows the field.
  return physicalName.column(owner ?? need(map, f.id));
}

/** A record column: the SQL reading its value from the snapshot row `e`. */
interface Copy {
  to: string;
  from: SQL;
}

function copiesOf(t: SnapshotHeader['tables'][number], map: ReadonlyMap<string, string>): Copy[] {
  const copies: Copy[] = [];
  for (const f of t.fields) {
    if (!isFieldTypeName(f.type)) continue;
    const storage = getFieldType(f.type).storage;
    // Computed fields are recomputed and autonumbers renumbered by the new identity column;
    // generated ones (AI answers) are copied: they can't be computed again for free.
    if (storage.kind !== 'column' && !(storage.kind === 'computed' && storage.generated)) continue;
    const to = newColumn(f, map);
    if (!to) continue;
    const json = sql`e -> ${f.dbColumn}::text`;
    if (f.type === 'attachment') {
      // The cell names the new attachment rows; files whose row didn't come along drop out.
      copies.push({
        to,
        from: sql`(SELECT jsonb_agg(a.v || jsonb_build_object('id', m.new_id::text) ORDER BY a.i)
                     FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${json}) = 'array'
                                                    THEN ${json} END) WITH ORDINALITY AS a(v, i)
                     JOIN pg_temp.snapshot_attachment_ids m ON m.old_id::text = a.v ->> 'id')`,
      });
    } else {
      copies.push({ to, from: castFromJson(json, storage.sqlType) });
    }
  }
  return copies;
}

/** The snapshot's lines, read as they arrive (gunzipped). */
async function* readLines(store: ObjectStore, key: string): AsyncGenerator<string> {
  const body = Readable.from(await store.getStream(key)).pipe(createGunzip());
  const rl = createInterface({ input: body, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of rl) if (line) yield line;
  } catch (err) {
    throw new AppError('SERVICE_UNAVAILABLE', {
      detail: "The snapshot couldn't be read. Try again later.",
      cause: err,
    });
  } finally {
    rl.close();
    body.destroy();
  }
}

export interface RestoreOptions {
  name?: string | undefined;
  /** The restorer's workspace role, for the new base. */
  role: UserRole;
}

/**
 * Restores a snapshot to a new base of the workspace, never over the original: the base,
 * tables, fields, view sections and views under new ids (references in options, view configs
 * and formulas remapped), the records under new UUIDv7 ids in their original order, the link
 * junctions, and new attachment rows that share the original files' object keys. Then every
 * computed field is recomputed. Runs in the caller's transaction, so a failure leaves nothing.
 * Reads the snapshot as a stream, `BATCH` rows at a time; the id maps live in temp tables.
 */
export async function restoreSnapshot(
  ctx: SchemaContext,
  store: ObjectStore,
  snapshot: SnapshotRow,
  opts: RestoreOptions
): Promise<Base> {
  const input = readLines(store, snapshot.storageKey);
  const first = await input.next();
  if (first.done) throw invalid('The snapshot is empty.');
  const parsed = SnapshotHeaderSchema.safeParse(JSON.parse(first.value));
  if (!parsed.success || parsed.data.workspaceId !== ctx.workspaceId) {
    throw invalid('The snapshot is not readable.');
  }
  const head = parsed.data;
  const { base } = await restoreBase(ctx, store, head, input, {
    name: opts.name ?? `${head.base.name} (restored)`,
    role: opts.role,
  });
  return base;
}

export interface RestoreBaseOptions {
  name: string;
  /** The workspace role of whoever makes the base, for the new base. */
  role: UserRole;
  /** False: tables and fields come without their edit permissions. */
  keepPermissions?: boolean;
  /** Called after each batch of records with how many went in so far. */
  onRecords?: (records: number) => Promise<void>;
  /** Gets the object keys copied for another workspace's files, to clean up after a failure. */
  copiedKeys?: string[];
  /**
   * Runs once the rows are in, before computed fields are recomputed, with the old-to-new id
   * map and the new base: a template's install prepares its formulas there.
   */
  beforeRefresh?: (ids: ReadonlyMap<string, string>, base: Base) => Promise<void>;
}

export interface RestoredBase {
  base: Base;
  /** Every old id of the header (base, tables, fields, sections, views) to its new id. */
  ids: ReadonlyMap<string, string>;
}

/** Object copies in flight at once. */
const COPY_CONCURRENCY = 8;

async function eachLimited<T>(items: readonly T[], fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(COPY_CONCURRENCY, items.length) }, worker));
}

/**
 * Makes a new base of the context's workspace from a snapshot's header and the lines after it
 * (a snapshot file, or a live base read by the duplicate). Attachment rows only come
 * along for files of the header's workspace (their key says whose they are); in another
 * workspace (a duplicate across workspaces) each file is copied to the new base's own key in the
 * object store, so neither workspace's purge or garbage collection touches the other's files.
 * Leaves the temp id tables (`withRowIds`) to the end of the transaction.
 */
export async function restoreBase(
  ctx: SchemaContext,
  store: ObjectStore | undefined,
  head: SnapshotHeader,
  input: AsyncIterable<string>,
  opts: RestoreBaseOptions
): Promise<RestoredBase> {
  const { tx } = ctx;
  const map = metadataMap(head);
  const keepPermissions = opts.keepPermissions ?? true;
  const copyFiles = head.workspaceId !== ctx.workspaceId;

  const base = await createBase(
    ctx,
    {
      name: opts.name.slice(0, 255),
      ...(head.base.description ? { description: head.base.description } : {}),
      ...(head.base.icon ? { icon: head.base.icon } : {}),
      ...(head.base.color ? { color: head.base.color } : {}),
    },
    opts.role
  );
  const [baseRow] = await tx.select().from(bases).where(eq(bases.id, base.id));
  if (!baseRow) throw new Error('restore: base not visible');
  await setLockTimeout(tx);

  // Tables, then fields (columns), then the junctions of link fields, which need both tables.
  const locations = new Map<string, TableLocation>();
  for (const t of head.tables) {
    const id = need(map, t.id);
    await tx.insert(tables).values({
      id,
      workspaceId: ctx.workspaceId,
      baseId: base.id,
      name: t.name,
      description: t.description,
      icon: t.icon,
      position: t.position,
      permissions: keepPermissions ? (t.permissions ?? {}) : {},
      dbSchema: baseRow.dbSchema,
      dbTable: physicalName.table(id),
      schemaVersion: 1,
      createdBy: ctx.userId,
    });
    await createRecordTable(tx, id);
    locations.set(t.id, { id, dbSchema: baseRow.dbSchema, dbTable: physicalName.table(id) });
  }
  const junctions: { owner: string; table: string; linked: string; name: string }[] = [];
  for (const t of head.tables) {
    for (const f of t.fields) {
      if (!isFieldTypeName(f.type)) continue;
      const column = newColumn(f, map);
      if (!column) continue;
      const id = need(map, f.id);
      const config = remapIds(f.config ?? {}, map) as Record<string, unknown>;
      const linkedOld = String((f.config as { linkedTableId?: unknown } | null)?.linkedTableId);
      // A link to a table that isn't in the snapshot can't come back.
      if (f.type === 'link' && !locations.has(linkedOld)) continue;
      await tx.insert(fields).values({
        id,
        workspaceId: ctx.workspaceId,
        tableId: need(map, t.id),
        name: f.name,
        description: f.description,
        type: f.type,
        dbColumn: column,
        isPrimary: f.isPrimary,
        position: f.position,
        config,
        permissions: keepPermissions ? (f.permissions ?? {}) : {},
        createdBy: ctx.userId,
      });
      await addFieldColumn(tx, need(map, t.id), column, getFieldType(f.type).storage);
      if (f.type === 'link' && f.dbColumn === physicalName.junction(f.id)) {
        junctions.push({ owner: f.id, table: t.id, linked: linkedOld, name: column });
      }
    }
  }
  for (const j of junctions) await createJunction(tx, need(map, j.owner));

  // Sections and views before the rows: files may belong to a view (a form's cover).
  for (const t of head.tables) {
    const tableId = need(map, t.id);
    if (t.sections.length) {
      await tx.insert(viewSections).values(
        t.sections.map((s) => ({
          id: need(map, s.id),
          workspaceId: ctx.workspaceId,
          tableId,
          name: s.name,
          position: s.position,
        }))
      );
    }
    await tx.insert(views).values(
      t.views.length
        ? t.views.map((v) => ({
            id: need(map, v.id),
            workspaceId: ctx.workspaceId,
            tableId,
            name: v.name,
            type: v.type,
            position: v.position,
            config: remapIds(v.config ?? {}, map),
            personal: v.personal,
            locked: v.locked,
            sectionId: v.sectionId ? (map.get(v.sectionId) ?? null) : null,
            createdBy: v.createdBy,
          }))
        : [{ workspaceId: ctx.workspaceId, tableId, name: 'Grid view', createdBy: ctx.userId }]
    );
  }

  await tx.execute(sql`
    CREATE TEMP TABLE snapshot_record_ids (
      table_id uuid NOT NULL, old_id uuid NOT NULL, new_id uuid NOT NULL,
      PRIMARY KEY (table_id, old_id)) ON COMMIT DROP`);
  await tx.execute(sql`
    CREATE TEMP TABLE snapshot_attachment_ids (old_id uuid PRIMARY KEY, new_id uuid NOT NULL)
      ON COMMIT DROP`);

  const tablesById = new Map(head.tables.map((t) => [t.id, t]));
  const owners = new Map(junctions.map((j) => [j.owner, j]));
  const filePrefix = `ws/${head.workspaceId}/`;
  let records = 0;
  let section: Section | null = null;
  let batch: string[] = [];

  const flush = async () => {
    if (!section || !batch.length) return;
    const lines = batch;
    batch = [];
    if (section.section === 'attachments') {
      const rows = lines.flatMap((line) => {
        const a = SnapshotAttachmentSchema.parse(JSON.parse(line));
        const table = map.get(a.table_id);
        const field = a.field_id ? map.get(a.field_id) : undefined;
        const view = a.view_id ? map.get(a.view_id) : undefined;
        // Only this workspace's files (the key says whose they are), of fields or views that
        // came along.
        if (!table || !(field || view) || !a.storage_key.startsWith(filePrefix)) return [];
        if (a.thumbnail_key && !a.thumbnail_key.startsWith(filePrefix)) return [];
        return [{ a, id: uuidv7(), table, field: field ?? null, view: field ? null : view }];
      });
      if (!rows.length) return;
      // Another workspace's files: copied under the new rows' own keys first.
      const keys = new Map<string, { file: string; thumbnail: string | null }>();
      if (copyFiles) {
        if (!store) throw new AppError('SERVICE_UNAVAILABLE', { detail: noStore });
        for (const r of rows) {
          const file = storageKey({
            workspaceId: ctx.workspaceId,
            baseId: base.id,
            tableId: r.table,
            id: r.id,
          });
          keys.set(r.id, { file, thumbnail: r.a.thumbnail_key ? thumbnailKeyOf(file) : null });
        }
        await eachLimited(rows, async (r) => {
          const to = keys.get(r.id);
          if (!to) return;
          opts.copiedKeys?.push(to.file);
          await store.copy(r.a.storage_key, to.file);
          if (r.a.thumbnail_key && to.thumbnail) {
            opts.copiedKeys?.push(to.thumbnail);
            await store.copy(r.a.thumbnail_key, to.thumbnail);
          }
        });
      }
      await tx.insert(attachments).values(
        rows.map(({ a, id, table, field, view }) => ({
          id,
          workspaceId: ctx.workspaceId,
          baseId: base.id,
          tableId: table,
          fieldId: field,
          viewId: view ?? null,
          storageKey: keys.get(id)?.file ?? a.storage_key,
          filename: a.filename,
          contentType: a.content_type,
          size: a.size,
          status: 'ready' as const,
          width: a.width,
          height: a.height,
          thumbnailKey: keys.has(id) ? (keys.get(id)?.thumbnail ?? null) : a.thumbnail_key,
          thumbnailSize: a.thumbnail_size,
          createdBy: a.created_by,
          createdAt: new Date(a.created_at),
          confirmedAt: a.confirmed_at ? new Date(a.confirmed_at) : new Date(),
        }))
      );
      const pairs = JSON.stringify(rows.map((r) => [r.a.id, r.id]));
      await tx.execute(sql`
        INSERT INTO pg_temp.snapshot_attachment_ids (old_id, new_id)
        SELECT (p ->> 0)::uuid, (p ->> 1)::uuid FROM jsonb_array_elements(${pairs}::jsonb) AS p`);
      return;
    }
    const rows = `[${lines.join(',')}]`;
    if (section.section === 'records') {
      const t = tablesById.get(section.table);
      const location = locations.get(section.table);
      if (!t || !location) return;
      const copies = copiesOf(t, map);
      const ids = `{${lines.map(() => uuidv7()).join(',')}}`;
      const columns = sql.join(
        ['id', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by']
          .concat(copies.map((c) => c.to))
          .map((c) => sql.identifier(c)),
        sql`, `
      );
      const values = sql.join(
        [
          sql`n.id`,
          sql`coalesce((e ->> 'version')::int, 1)`,
          sql`coalesce((e ->> 'created_at')::timestamptz, now())`,
          sql`(e ->> 'created_by')::uuid`,
          sql`coalesce((e ->> 'updated_at')::timestamptz, now())`,
          sql`(e ->> 'updated_by')::uuid`,
          ...copies.map((c) => c.from),
        ],
        sql`, `
      );
      await tx.execute(sql`
        WITH src AS (SELECT e, i FROM jsonb_array_elements(${rows}::jsonb) WITH ORDINALITY AS x(e, i)),
             n AS (SELECT id, i FROM unnest(${ids}::uuid[]) WITH ORDINALITY AS y(id, i)),
             mapped AS (
               INSERT INTO pg_temp.snapshot_record_ids (table_id, old_id, new_id)
               SELECT ${section.table}::uuid, (src.e ->> 'id')::uuid, n.id FROM src JOIN n USING (i))
        INSERT INTO ${qualified(location)} (${columns})
        SELECT ${values} FROM src JOIN n USING (i) ORDER BY i`);
      records += lines.length;
      await opts.onRecords?.(records);
      return;
    }
    const j = owners.get(section.field);
    const location = j ? locations.get(j.table) : undefined;
    if (!j || !location) return;
    const junction = sql`${sql.identifier(location.dbSchema)}.${sql.identifier(j.name)}`;
    await tx.execute(sql`
      INSERT INTO ${junction} (from_id, to_id, position, inverse_position)
      SELECT f.new_id, t.new_id, coalesce((e ->> 'position')::float8, 0),
             coalesce((e ->> 'inverse_position')::float8, 0)
        FROM jsonb_array_elements(${rows}::jsonb) AS e
        JOIN pg_temp.snapshot_record_ids f
          ON f.table_id = ${j.table}::uuid AND f.old_id = (e ->> 'from_id')::uuid
        JOIN pg_temp.snapshot_record_ids t
          ON t.table_id = ${j.linked}::uuid AND t.old_id = (e ->> 'to_id')::uuid
      ON CONFLICT DO NOTHING`);
  };

  // `for await` closes the input (the snapshot's stream) when the restore fails midway.
  for await (const line of input) {
    if (isSection(line)) {
      await flush();
      const next = SectionSchema.safeParse(JSON.parse(line));
      if (!next.success) throw invalid('The snapshot is not readable.');
      section = next.data;
      continue;
    }
    if (!section) throw invalid('The snapshot is not readable.');
    batch.push(line);
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  // View configs may name records (link filters) and files (a form's cover), which
  // have new ids now too.
  const configs = head.tables.flatMap((t) => t.views.map((v) => ({ v, config: v.config })));
  const viewMap = await withRowIds(
    tx,
    map,
    configs.map((c) => c.config)
  );
  if (viewMap !== map) {
    for (const { v, config } of configs) {
      if (!uuidsIn(config).some((id) => !map.has(id))) continue;
      await tx
        .update(views)
        .set({ config: remapIds(config ?? {}, viewMap) })
        .where(eq(views.id, need(map, v.id)));
    }
  }

  await opts.beforeRefresh?.(map, base);
  // Formulas, lookups, rollups and counts: computed again from the restored values.
  const { refreshTable } = await import('../data/computed/engine.js');
  for (const location of locations.values()) await refreshTable(tx, base.id, location.id);
  // The plan's record counts: the rows went in around the RecordService.
  for (const location of locations.values()) {
    await recountTable(tx, { ...location, workspaceId: ctx.workspaceId, baseId: base.id });
  }
  return { base, ids: map };
}

/**
 * `map` plus the record and attachment ids of a restore so far (its temp tables) that appear in
 * `values` and aren't in `map`: for configs that name records or files. `map` itself when none
 * do.
 */
export async function withRowIds(
  tx: Transaction,
  map: ReadonlyMap<string, string>,
  values: readonly unknown[]
): Promise<ReadonlyMap<string, string>> {
  const unknown = [...new Set(values.flatMap((v) => uuidsIn(v)))].filter((id) => !map.has(id));
  if (!unknown.length) return map;
  const list = `{${unknown.join(',')}}`;
  const { rows } = await tx.execute<{ old_id: string; new_id: string }>(sql`
    SELECT old_id::text, new_id::text FROM pg_temp.snapshot_record_ids
     WHERE old_id = ANY(${list}::uuid[])
    UNION ALL
    SELECT old_id::text, new_id::text FROM pg_temp.snapshot_attachment_ids
     WHERE old_id = ANY(${list}::uuid[])`);
  if (!rows.length) return map;
  const extended = new Map(map);
  for (const r of rows) extended.set(r.old_id, r.new_id);
  return extended;
}
