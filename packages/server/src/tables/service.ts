import {
  type CreateTableInput,
  type DuplicateTableInput,
  displayAiPrompt,
  formatFormula,
  hasFormula,
  type LinkOptions,
  nextChoiceColor,
  parseStoredFormula,
  TableSchema,
  tablePermissionsOf,
  type UpdateTableInput,
} from '@openrows/shared';
import { and, asc, eq, inArray, isNotNull, isNull, max, ne, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { qualified, storageOf } from '../data/columns.js';
import {
  createBaseSchema,
  createRecordTable,
  dropJunction,
  dropRecordTable,
  physicalName,
  setLockTimeout,
} from '../data/ddl.js';
import { emit, emitMany } from '../data/outbox.js';
import { bases, fields, type Transaction, tables, views } from '../db/index.js';
import {
  bumpSchemaVersion,
  createField,
  emitRestored,
  type FieldRow,
  fieldType,
  liveFields,
  restoreTrashedWith,
  type SchemaContext,
  type TableRow,
  toField,
} from '../fields/service.js';
import { AppError } from '../lib/errors.js';
import { assertPermissionUsers } from '../records/permissions.js';
import { recountTable } from '../usage/counters.js';
import { assertRecordRoom, requireEntitlements, tableRecords } from '../usage/quota.js';

/** Airtable's cap, and ADR-001's guard on catalog size. */
export const MAX_TABLES_PER_BASE = 1000;

type BaseRow = typeof bases.$inferSelect;

export function toTableSummary(row: TableRow) {
  return {
    id: row.id,
    baseId: row.baseId,
    name: row.name,
    description: row.description,
    icon: row.icon,
    position: row.position,
    schemaVersion: row.schemaVersion,
    permissions: tablePermissionsOf(row.permissions),
    ...(row.synced ? { synced: true as const } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toTable(row: TableRow, fieldRows: FieldRow[]) {
  return TableSchema.parse({ ...toTableSummary(row), fields: fieldRows.map(toField) });
}

export async function liveTables(tx: Transaction, baseId: string): Promise<TableRow[]> {
  return tx
    .select()
    .from(tables)
    .where(and(eq(tables.baseId, baseId), isNull(tables.deletedAt)))
    .orderBy(asc(tables.position), asc(tables.createdAt));
}

async function assertNameFree(tx: Transaction, baseId: string, name: string, except?: string) {
  const [clash] = await tx
    .select({ id: tables.id })
    .from(tables)
    .where(
      and(
        eq(tables.baseId, baseId),
        isNull(tables.deletedAt),
        sql`lower(${tables.name}) = lower(${name})`,
        except ? ne(tables.id, except) : undefined
      )
    )
    .limit(1);
  if (clash) throw new AppError('CONFLICT', { detail: `A table named "${name}" already exists.` });
}

/** A name not taken in the base: `name`, `name 2`, `name 3`… */
async function freeName(tx: Transaction, baseId: string, name: string): Promise<string> {
  const taken = new Set((await liveTables(tx, baseId)).map((t) => t.name.toLowerCase()));
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${name} ${n}`;
  return candidate;
}

/** Inserts the metadata row and creates its record table (and the base schema if missing). */
async function insertTable(
  ctx: SchemaContext,
  base: BaseRow,
  values: { name: string; description?: string | null; icon?: string | null; permissions?: unknown }
): Promise<TableRow> {
  const { tx } = ctx;
  const [stats] = await tx
    .select({ count: sql<number>`count(*)::int`, last: max(tables.position) })
    .from(tables)
    .where(and(eq(tables.baseId, base.id), isNull(tables.deletedAt)));
  if ((stats?.count ?? 0) >= MAX_TABLES_PER_BASE) {
    throw new AppError('CONFLICT', {
      detail: `A base can have at most ${MAX_TABLES_PER_BASE} tables.`,
    });
  }
  await assertNameFree(tx, base.id, values.name);
  const id = uuidv7();
  await setLockTimeout(tx);
  const [row] = await tx
    .insert(tables)
    .values({
      id,
      workspaceId: ctx.workspaceId,
      baseId: base.id,
      name: values.name,
      description: values.description ?? null,
      ...(values.permissions !== undefined ? { permissions: values.permissions } : {}),
      icon: values.icon ?? null,
      position: (stats?.last ?? 0) + 1,
      dbSchema: base.dbSchema,
      dbTable: physicalName.table(id),
      createdBy: ctx.userId,
    })
    .returning();
  if (!row) throw new Error('create table: no row returned');
  // Bases created before the DDL manager have no schema yet; this is idempotent.
  await createBaseSchema(tx, base.id);
  await createRecordTable(tx, row.id);
  await tx.insert(views).values({
    workspaceId: ctx.workspaceId,
    tableId: row.id,
    name: 'Grid view',
    type: 'grid',
    createdBy: ctx.userId,
  });
  return row;
}

async function reload(tx: Transaction, id: string): Promise<TableRow> {
  const [row] = await tx.select().from(tables).where(eq(tables.id, id));
  if (!row) throw new Error('table not visible under RLS');
  return row;
}

/**
 * Creates a table with the default fields Name (primary, single line text), Notes (long text)
 * and Status (single select: Todo, In progress, Done), and a grid view. `primaryFieldName`
 * gives it only the primary field, under that name (a table about to be imported into).
 */
export async function createTable(ctx: SchemaContext, base: BaseRow, input: CreateTableInput) {
  const { primaryFieldName, ...meta } = input;
  const row = await insertTable(ctx, base, meta);
  const starter = [
    { name: 'Name', type: 'singleLineText', isPrimary: true },
    { name: 'Notes', type: 'longText' },
    {
      name: 'Status',
      type: 'singleSelect',
      options: {
        choices: ['Todo', 'In progress', 'Done'].map((name, i) => ({
          id: `sel${uuidv7().replaceAll('-', '').slice(-12)}`,
          name,
          color: nextChoiceColor(i),
        })),
      },
    },
  ] as const;
  const defaults = primaryFieldName
    ? [{ name: primaryFieldName, type: 'singleLineText', isPrimary: true } as const]
    : starter;
  for (const f of defaults) await createField(ctx, row, f, { emit: false });
  await bumpSchemaVersion(ctx.tx, row.id);
  const table = toTable(await reload(ctx.tx, row.id), await liveFields(ctx.tx, row.id));
  await emit(ctx.tx, {
    workspaceId: ctx.workspaceId,
    baseId: base.id,
    tableId: row.id,
    kind: 'table.created',
    payload: { table },
    actorId: ctx.userId,
  });
  return table;
}

/** Renames, describes or reorders a table: metadata only. */
export async function updateTable(ctx: SchemaContext, table: TableRow, input: UpdateTableInput) {
  if (input.name !== undefined) await assertNameFree(ctx.tx, table.baseId, input.name, table.id);
  const { permissions: changed, ...meta } = input;
  let permissions: unknown;
  if (changed) {
    // The listed record permissions replace theirs; the others stay.
    await assertPermissionUsers(ctx.tx, table, changed, 'permissions');
    const defined = Object.fromEntries(Object.entries(changed).filter(([, p]) => p));
    permissions = { ...tablePermissionsOf(table.permissions), ...defined };
  }
  const [row] = await ctx.tx
    .update(tables)
    .set({ ...meta, ...(changed ? { permissions } : {}), updatedAt: new Date() })
    .where(eq(tables.id, table.id))
    .returning();
  if (!row) throw new Error('update table: no row returned');
  const result = toTable(row, await liveFields(ctx.tx, row.id));
  await emit(ctx.tx, {
    workspaceId: ctx.workspaceId,
    baseId: row.baseId,
    tableId: row.id,
    kind: 'table.updated',
    payload: { table: toTableSummary(row) },
    actorId: ctx.userId,
  });
  return result;
}

/** The other sides of a table's live links: inverse link fields in other tables. */
async function inverseFieldsOf(tx: Transaction, table: TableRow): Promise<FieldRow[]> {
  const ids = (await liveFields(tx, table.id))
    .filter((f) => f.type === 'link')
    .map((f) => (f.config as LinkOptions | null)?.inverseLinkFieldId)
    .filter((id): id is string => typeof id === 'string');
  if (!ids.length) return [];
  return tx
    .select()
    .from(fields)
    .where(and(inArray(fields.id, ids), ne(fields.tableId, table.id), isNull(fields.deletedAt)));
}

/**
 * Moves a table to the trash. Its record table stays until it is deleted permanently (or
 * purged). The inverse fields of its links in other tables go to the trash with it
 * (`trashedWith` the table), so no live field links to a trashed table, and come back with it.
 * Computed fields elsewhere that read those links make it a 409, as for deleting the link.
 */
export async function deleteTable(ctx: SchemaContext, table: TableRow): Promise<void> {
  const { tx } = ctx;
  const inverses = await inverseFieldsOf(tx, table);
  if (inverses.length) {
    const { dependentsOf } = await import('../data/computed/engine.js');
    const ids = inverses.map((f) => f.id);
    const dependents = (await dependentsOf(tx, table.baseId, ids)).filter(
      (f) => f.tableId !== table.id
    );
    if (dependents.length) {
      throw new AppError('CONFLICT', {
        detail: `${dependents.map((f) => `"${f.name}"`).join(', ')} ${dependents.length === 1 ? 'reads' : 'read'} this table's links. Change or delete ${dependents.length === 1 ? 'it' : 'them'} first.`,
        extensions: { fieldIds: dependents.map((f) => f.id) },
      });
    }
  }
  const now = new Date();
  await tx
    .update(tables)
    .set({ deletedAt: now, deletedBy: ctx.userId })
    .where(eq(tables.id, table.id));
  if (inverses.length) {
    await tx
      .update(fields)
      .set({ deletedAt: now, deletedBy: ctx.userId, trashedWith: table.id })
      .where(
        inArray(
          fields.id,
          inverses.map((f) => f.id)
        )
      );
  }
  for (const f of inverses) await bumpSchemaVersion(tx, f.tableId);
  await emitMany(tx, [
    {
      workspaceId: ctx.workspaceId,
      baseId: table.baseId,
      tableId: table.id,
      kind: 'table.deleted' as const,
      payload: { tableId: table.id },
      actorId: ctx.userId,
    },
    ...inverses.map((f) => ({
      workspaceId: ctx.workspaceId,
      baseId: table.baseId,
      tableId: f.tableId,
      kind: 'field.deleted' as const,
      payload: { fieldId: f.id },
      actorId: ctx.userId,
    })),
  ]);
}

/** A table of the base in the trash, or 404. */
async function trashedTable(tx: Transaction, baseId: string, id: string): Promise<TableRow> {
  const [row] = await tx
    .select()
    .from(tables)
    .where(and(eq(tables.id, id), eq(tables.baseId, baseId), isNotNull(tables.deletedAt)));
  if (!row) throw new AppError('NOT_FOUND', { detail: 'No such table in the trash.' });
  return row;
}

/**
 * Brings a table back from the trash under its name (409 if a live table has it), with the
 * inverse link fields its deletion took. Its own links to a table that is still in the trash go
 * to the trash with that table instead. Its computed fields recompute (records elsewhere may
 * have changed meanwhile).
 */
export async function restoreTable(ctx: SchemaContext, baseId: string, id: string) {
  const { tx } = ctx;
  const row = await trashedTable(tx, baseId, id);
  await assertNameFree(tx, baseId, row.name);
  // Its records count against the plan's records per base again.
  await assertRecordRoom(tx, requireEntitlements(ctx), baseId, await tableRecords(tx, row.id));
  const [stats] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(tables)
    .where(and(eq(tables.baseId, baseId), isNull(tables.deletedAt)));
  if ((stats?.count ?? 0) >= MAX_TABLES_PER_BASE) {
    throw new AppError('CONFLICT', {
      detail: `A base can have at most ${MAX_TABLES_PER_BASE} tables.`,
    });
  }
  await tx
    .update(tables)
    .set({ deletedAt: null, deletedBy: null, updatedAt: new Date() })
    .where(eq(tables.id, row.id));
  const inverses = await restoreTrashedWith(tx, row.id);

  // Links of this table to tables deleted after it: they wait for those tables.
  for (const f of await liveFields(tx, row.id)) {
    if (f.type !== 'link') continue;
    const linkedId = (f.config as LinkOptions | null)?.linkedTableId;
    if (!linkedId || linkedId === row.id) continue;
    const [linked] = await tx.select().from(tables).where(eq(tables.id, linkedId));
    if (linked?.deletedAt) {
      await tx
        .update(fields)
        .set({ deletedAt: linked.deletedAt, deletedBy: linked.deletedBy, trashedWith: linked.id })
        .where(eq(fields.id, f.id));
    }
  }
  await (await import('../data/computed/engine.js')).refreshTable(tx, baseId, row.id);
  await bumpSchemaVersion(tx, row.id);
  const table = toTable(await reload(tx, row.id), await liveFields(tx, row.id));
  await emit(tx, {
    workspaceId: ctx.workspaceId,
    baseId,
    tableId: row.id,
    kind: 'table.restored',
    payload: { table },
    actorId: ctx.userId,
  });
  await emitRestored(
    ctx,
    inverses.filter((f) => f.tableId !== row.id),
    baseId
  );
  return table;
}

/**
 * Deletes a table in the trash for good: the junctions of its links (and the inverse
 * fields sharing them, wherever they are), its record table, then its metadata row, which takes
 * its fields, views, comments, revisions and shares with it (foreign keys cascade). Stored files
 * of its attachments are left for the purge job.
 */
export async function purgeTable(ctx: SchemaContext, baseId: string, id: string) {
  const { tx } = ctx;
  const row = await trashedTable(tx, baseId, id);
  const links = await tx
    .select()
    .from(fields)
    .where(and(eq(fields.tableId, row.id), eq(fields.type, 'link')));
  const junctions = [...new Set(links.map((f) => f.dbColumn))];
  await setLockTimeout(tx);
  if (junctions.length) {
    // Inverse fields in other tables share the junction names; any still live (tables deleted
    // before left them) go too, with an event for their table.
    const others = await tx
      .select()
      .from(fields)
      .where(
        and(
          inArray(fields.dbColumn, junctions),
          ne(fields.tableId, row.id),
          eq(fields.type, 'link'),
          sql`${fields.tableId} IN (SELECT id FROM ${tables} WHERE base_id = ${baseId})`
        )
      );
    await tx.delete(fields).where(
      inArray(
        fields.id,
        [...links, ...others].map((f) => f.id)
      )
    );
    for (const junction of junctions) await dropJunction(tx, row.id, junction);
    const live = others.filter((f) => f.deletedAt === null);
    for (const f of live) await bumpSchemaVersion(tx, f.tableId);
    await emitMany(
      tx,
      live.map((f) => ({
        workspaceId: ctx.workspaceId,
        baseId,
        tableId: f.tableId,
        kind: 'field.deleted' as const,
        payload: { fieldId: f.id },
        actorId: ctx.userId || null, // the trash purge has no actor
      }))
    );
  }
  await dropRecordTable(tx, row.id);
  await tx.delete(tables).where(eq(tables.id, row.id));
}

const COPY_BATCH = 10_000;

/** A Postgres array literal of uuids (Drizzle would expand a JS array into a row). */
const pgArray = (uuids: string[]) => `{${uuids.join(',')}}`;

/**
 * A field's options for the copy of its table: a self-link links the copy to itself; any
 * other link gets a new inverse field in its linked table (createField sets it).
 */
function copiedOptions(
  f: FieldRow,
  sourceId: string,
  copyId: string,
  sourceFields: readonly FieldRow[]
): Record<string, unknown> {
  const options = { ...(f.config as Record<string, unknown>) };
  if (f.type === 'link' && options['linkedTableId'] === sourceId) options['linkedTableId'] = copyId;
  // Formulas and AI prompts name the source's fields by id: by name, the copy's fields
  // of those names.
  if (f.type === 'ai' && typeof options['prompt'] === 'string') {
    options['prompt'] = displayAiPrompt(options['prompt'], sourceFields);
  }
  if (hasFormula(f.type) && typeof options['formula'] === 'string' && options['formula'] !== '') {
    const parsed = parseStoredFormula(options['formula']);
    if (parsed.ok) options['formula'] = formatFormula(parsed.ast, sourceFields);
  }
  return options;
}

/** The fields of the table a formula or an AI prompt reads (their server-set references). */
function readsOf(f: FieldRow, ids: ReadonlySet<string>): string[] {
  const refs = (f.config as { referencedFieldIds?: unknown } | null)?.referencedFieldIds;
  return Array.isArray(refs) ? refs.filter((r): r is string => ids.has(r as string)) : [];
}

/** Fields in an order where each comes after the fields of its table it reads (else as is). */
function dependencyOrder(list: readonly FieldRow[]): FieldRow[] {
  const ids = new Set(list.map((f) => f.id));
  const out: FieldRow[] = [];
  const done = new Set<string>();
  let rest = [...list];
  while (rest.length) {
    const ready = rest.filter((f) => readsOf(f, ids).every((r) => done.has(r) || r === f.id));
    const next = ready.length ? ready : rest;
    for (const f of next) {
      out.push(f);
      done.add(f.id);
    }
    rest = rest.filter((f) => !done.has(f.id));
  }
  return out;
}

/**
 * Duplicates a table's live fields (names, types, options, order, primary) and, with
 * `includeRecords`, its live records under new UUIDv7 ids. Created/modified times and users
 * are kept; autonumbers are renumbered in the original order.
 */
export async function duplicateTable(
  ctx: SchemaContext,
  source: TableRow,
  input: DuplicateTableInput
) {
  const { tx } = ctx;
  const [base] = await tx.select().from(bases).where(eq(bases.id, source.baseId));
  if (!base) throw new Error('table without a visible base');
  // The copied records count against the plan's records per base.
  if (input.includeRecords) {
    await assertRecordRoom(
      tx,
      requireEntitlements(ctx),
      base.id,
      await tableRecords(tx, source.id)
    );
  }
  const name = await freeName(tx, base.id, input.name ?? `${source.name} copy`);
  const copy = await insertTable(ctx, base, {
    name,
    description: source.description,
    icon: source.icon,
    // Edit permissions carry over: a copy isn't a way around them.
    permissions: source.permissions,
  });
  const pairs: { from: string; to: string }[] = [];
  const sourceFields = await liveFields(tx, source.id);
  // Formulas and AI fields after the fields of the table they read.
  const ordered = dependencyOrder(sourceFields);
  for (const f of ordered) {
    const created = await createField(
      ctx,
      copy,
      {
        name: f.name,
        type: fieldType(f),
        description: f.description ?? undefined,
        options: copiedOptions(f, source.id, copy.id, sourceFields),
        position: f.position,
        isPrimary: f.isPrimary,
      },
      { emit: false, copy: true }
    );
    if (Object.keys((f.permissions ?? {}) as object).length) {
      await tx.update(fields).set({ permissions: f.permissions }).where(eq(fields.id, created.id));
    }
    // System-column fields (created time…) have no column of their own, and autonumbers are
    // renumbered by the new table's identity column, in the original order. AI answers (
    // `generated`) are copied: they can't be computed again for free.
    const storage = storageOf(f.type);
    if (storage.kind === 'column' || (storage.kind === 'computed' && storage.generated)) {
      pairs.push({ from: f.dbColumn, to: created.dbColumn });
    }
  }

  if (input.includeRecords) {
    const ids = await tx.execute<{ id: string }>(
      sql`SELECT id FROM ${qualified(source)} WHERE deleted_at IS NULL ORDER BY id`
    );
    const system = ['version', 'created_at', 'created_by', 'updated_at', 'updated_by'];
    const target = sql.join(
      [...system, ...pairs.map((p) => p.to)].map((c) => sql.identifier(c)),
      sql`, `
    );
    const select = sql.join(
      [...system, ...pairs.map((p) => p.from)].map((c) => sql`o.${sql.identifier(c)}`),
      sql`, `
    );
    for (let i = 0; i < ids.rows.length; i += COPY_BATCH) {
      const oldIds = ids.rows.slice(i, i + COPY_BATCH).map((r) => r.id);
      const newIds = oldIds.map(() => uuidv7());
      await tx.execute(sql`
        INSERT INTO ${qualified(copy)} (id, ${target})
        SELECT m.new_id, ${select}
          FROM ${qualified(source)} AS o
          JOIN unnest(${pgArray(oldIds)}::uuid[], ${pgArray(newIds)}::uuid[]) AS m(old_id, new_id)
            ON o.id = m.old_id
         ORDER BY m.new_id`);
    }
    // The plan's record count: the rows went in around the RecordService.
    await recountTable(tx, copy);
  }

  await bumpSchemaVersion(tx, copy.id);
  const table = toTable(await reload(tx, copy.id), await liveFields(tx, copy.id));
  await emit(tx, {
    workspaceId: ctx.workspaceId,
    baseId: base.id,
    tableId: copy.id,
    kind: 'table.created',
    payload: { table, duplicatedFrom: source.id, includeRecords: input.includeRecords ?? false },
    actorId: ctx.userId,
  });
  return table;
}

/** The authorized table of a request. */
export async function loadTable(tx: Transaction, id: string): Promise<TableRow> {
  return reload(tx, id);
}

/** The authorized field of a request. */
export async function loadField(tx: Transaction, id: string): Promise<FieldRow> {
  const [row] = await tx.select().from(fields).where(eq(fields.id, id));
  if (!row) throw new Error('field not visible under RLS');
  return row;
}
