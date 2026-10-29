import {
  type AiOptions,
  aiOptionsSchema,
  type CreateFieldInput,
  computedSourceOf,
  conversionOptions,
  convertValue,
  FieldSchema,
  type FieldTypeName,
  fieldPermissionsOf,
  getFieldType,
  hasFormula,
  isFieldTypeName,
  type LinkOptions,
  MAX_CHOICES,
  MAX_TYPECAST_CHOICES,
  type UpdateFieldInput,
  type UserRole,
} from '@openrows/shared';
import { and, asc, eq, inArray, isNotNull, isNull, max, ne, or, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { qualified, readExpression, type TableLocation, writeColumn } from '../data/columns.js';
import {
  addFieldColumn,
  createJunction,
  dropColumn,
  dropJunction,
  physicalName,
  setLockTimeout,
} from '../data/ddl.js';
import { emit, emitMany } from '../data/outbox.js';
import { fields, type Transaction, tables, views } from '../db/index.js';
import type { Entitlements } from '../edition/types.js';
import { AppError } from '../lib/errors.js';
import { assertPermissionUsers } from '../records/permissions.js';

/** Airtable's cap; Postgres allows 1,600 columns, dropped ones included (ADR-001). */
export const MAX_FIELDS_PER_TABLE = 500;

export type FieldRow = typeof fields.$inferSelect;

/** A button without a URL formula yet: nothing to check, it computes nothing. */
function emptyButton(type: string, options: unknown): boolean {
  const formula = (options as { formula?: unknown } | null)?.formula;
  return type === 'button' && (typeof formula !== 'string' || formula.trim() === '');
}
export type TableRow = typeof tables.$inferSelect;

/** Who is changing the schema, and in which (already authorized, RLS-scoped) transaction. */
export interface SchemaContext {
  tx: Transaction;
  workspaceId: string;
  userId: string;
  /**
   * The changer's role, where a schema change writes records (a conversion to a link creates
   * the linked records, under the table and field edit permissions).
   */
  role?: UserRole;
  /**
   * The workspace's plan, where a schema change adds records (a duplicate with records, a
   * table restore, a conversion to a link): checked against records per base.
   */
  entitlements?: Entitlements | undefined;
}

export function fieldType(row: FieldRow): FieldTypeName {
  if (!isFieldTypeName(row.type)) throw new Error(`field ${row.id} has unknown type ${row.type}`);
  return row.type;
}

export function toField(row: FieldRow) {
  return FieldSchema.parse({
    id: row.id,
    tableId: row.tableId,
    name: row.name,
    description: row.description,
    type: fieldType(row),
    options: row.config,
    isPrimary: row.isPrimary,
    position: row.position,
    permissions: fieldPermissionsOf(row.permissions),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
    ...(row.recomputeRequestedAt ? { recomputing: true } : {}),
    ...(row.synced ? { synced: true } : {}),
  });
}

/** "Sync source" fields are made and changed only by a table's sync. */
function syncOnly(): never {
  throw new AppError('VALIDATION_FAILED', {
    detail: 'The field options are invalid.',
    extensions: {
      errors: [{ path: 'type', message: 'Sync source fields are added by syncing a table.' }],
    },
  });
}

/** Parses options through the type's schema (defaults applied); ZodError → 422. */
export function parseOptions(type: FieldTypeName, options: unknown): unknown {
  return getFieldType(type).optionsSchema.parse(options ?? {});
}

export async function liveFields(tx: Transaction, tableId: string): Promise<FieldRow[]> {
  return tx
    .select()
    .from(fields)
    .where(and(eq(fields.tableId, tableId), isNull(fields.deletedAt)))
    .orderBy(asc(fields.position), asc(fields.createdAt));
}

async function assertNameFree(tx: Transaction, tableId: string, name: string, except?: string) {
  const [clash] = await tx
    .select({ id: fields.id })
    .from(fields)
    .where(
      and(
        eq(fields.tableId, tableId),
        isNull(fields.deletedAt),
        sql`lower(${fields.name}) = lower(${name})`,
        except ? ne(fields.id, except) : undefined
      )
    )
    .limit(1);
  if (clash) {
    throw new AppError('CONFLICT', { detail: `A field named "${name}" already exists.` });
  }
}

/** Bumps the table's schema version (ADR-001), so clients notice structural changes. */
export async function bumpSchemaVersion(tx: Transaction, tableId: string): Promise<void> {
  await tx
    .update(tables)
    .set({ schemaVersion: sql`${tables.schemaVersion} + 1`, updatedAt: new Date() })
    .where(eq(tables.id, tableId));
}

/** The next position in a table, after checking it has room for another field. */
async function nextPosition(tx: Transaction, tableId: string): Promise<number> {
  const [stats] = await tx
    .select({ count: sql<number>`count(*)::int`, last: max(fields.position) })
    .from(fields)
    .where(eq(fields.tableId, tableId));
  if ((stats?.count ?? 0) >= MAX_FIELDS_PER_TABLE) {
    throw new AppError('CONFLICT', {
      detail: `A table can have at most ${MAX_FIELDS_PER_TABLE} fields.`,
    });
  }
  return (stats?.last ?? 0) + 1;
}

/** The recompute engine, loaded on demand: it reads links through records/links.ts. */
const computedEngine = () => import('../data/computed/engine.js');
/** AI fields, loaded on demand like the engine. */
const aiFields = () => import('../ai/fields/service.js');

/** 409 when lookups, rollups or counts read one of `ids` (delete or unlink them first). */
async function assertNoDependents(tx: Transaction, baseId: string, ids: string[], what: string) {
  const { dependentsOf } = await computedEngine();
  const dependents = await dependentsOf(tx, baseId, ids);
  if (!dependents.length) return;
  const names = dependents.map((f) => `"${f.name}"`).join(', ');
  throw new AppError('CONFLICT', {
    detail: `${names} ${dependents.length === 1 ? 'reads' : 'read'} this field. Change or delete ${dependents.length === 1 ? 'it' : 'them'} before you ${what} it.`,
    extensions: { fieldIds: dependents.map((f) => f.id) },
  });
}

export function linkInvalid(path: string, message: string): never {
  throw new AppError('VALIDATION_FAILED', {
    detail: 'The link options are invalid.',
    extensions: { errors: [{ path, message }] },
  });
}

/**
 * The linked table of new link options: a live table of the same base (404 otherwise, so a
 * table of another base or workspace looks like no table at all), and the view it's limited to,
 * which must be one of that table's (422).
 */
export async function linkTarget(tx: Transaction, table: TableRow, options: LinkOptions) {
  if (!options.linkedTableId) linkInvalid('options.linkedTableId', 'Choose a table to link to.');
  const [target] = await tx
    .select()
    .from(tables)
    .where(
      and(
        eq(tables.id, options.linkedTableId),
        eq(tables.baseId, table.baseId),
        isNull(tables.deletedAt)
      )
    );
  if (!target) throw new AppError('NOT_FOUND', { detail: 'No such table in this base.' });
  await assertLinkView(tx, target.id, options);
  return target;
}

async function assertLinkView(tx: Transaction, targetId: string, options: LinkOptions) {
  const viewId = options.viewIdForRecordSelection;
  if (!viewId) return;
  const [view] = await tx
    .select({ id: views.id })
    .from(views)
    .where(
      and(
        eq(views.id, viewId),
        eq(views.tableId, targetId),
        isNull(views.deletedAt),
        eq(views.personal, false)
      )
    );
  if (!view) {
    linkInvalid(
      'options.viewIdForRecordSelection',
      'Not a collaborative view of the linked table.'
    );
  }
}

/** `name`, or `name 2`, `name 3`… : the first one no live field of the table has. */
async function freeFieldName(tx: Transaction, tableId: string, name: string): Promise<string> {
  const taken = new Set(
    (
      await tx
        .select({ name: fields.name })
        .from(fields)
        .where(and(eq(fields.tableId, tableId), isNull(fields.deletedAt)))
    ).map((f) => f.name.toLowerCase())
  );
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${name} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Adds the inverse of the link field `row` (of `table`) to the linked table `target`: a link
 * field back to `table`, named after it, sharing the junction. The id is the one `row` names.
 */
export async function addInverse(
  ctx: SchemaContext,
  table: TableRow,
  row: FieldRow,
  target: TableRow
): Promise<FieldRow> {
  const { inverseLinkFieldId } = parseOptions('link', row.config) as LinkOptions;
  if (!inverseLinkFieldId) throw new Error('add inverse: the link names no inverse field');
  // A trashed (never restorable) inverse of an earlier link with this junction name lets go of it.
  await ctx.tx
    .update(fields)
    .set({ dbColumn: sql`'l_' || replace(${fields.id}::text, '-', '')` })
    .where(
      and(
        eq(fields.tableId, target.id),
        eq(fields.dbColumn, row.dbColumn),
        isNotNull(fields.deletedAt)
      )
    );
  const inverseOptions: LinkOptions = {
    linkedTableId: table.id,
    inverseLinkFieldId: row.id,
    prefersSingleRecordLink: false,
    viewIdForRecordSelection: null,
  };
  const [inverse] = await ctx.tx
    .insert(fields)
    .values({
      id: inverseLinkFieldId,
      workspaceId: ctx.workspaceId,
      tableId: target.id,
      name: await freeFieldName(ctx.tx, target.id, table.name),
      description: null,
      type: 'link',
      dbColumn: row.dbColumn,
      isPrimary: false,
      position: await nextPosition(ctx.tx, target.id),
      config: inverseOptions,
      createdBy: ctx.userId,
    })
    .returning();
  if (!inverse) throw new Error('create inverse field: no row returned');
  return inverse;
}

/**
 * Adds a field: the metadata row and its column (nullable, no default: instant at any size) in
 * the caller's transaction, under lock_timeout, plus an outbox event.
 *
 * A link field gets no column: its junction `l_<field hex>` is created between the two
 * tables, and unless it links to its own table, an inverse link field is added to the linked
 * table (named after this table), sharing the junction. Both fields, the junction and both
 * events commit together.
 */
export async function createField(
  ctx: SchemaContext,
  table: TableRow,
  input: CreateFieldInput & { isPrimary?: boolean },
  /**
   * `sync`: a synced table's field, made by its sync: read-only, `synced`. `copy`: a
   * table duplicate's copy of a field, which may be a "Sync source" field (left as text).
   */
  opts: { emit?: boolean; sync?: boolean; copy?: boolean } = {}
): Promise<FieldRow> {
  const { tx } = ctx;
  if (input.type === 'syncSource' && !opts.sync && !opts.copy) syncOnly();
  let options = parseOptions(input.type, input.options);
  const isLink = input.type === 'link';
  let target: TableRow | null = null;
  if (isLink) {
    if (input.isPrimary) linkInvalid('type', "The primary field can't be a link.");
    target = await linkTarget(tx, table, options as LinkOptions);
  }
  const next = await nextPosition(tx, table.id);
  const position = input.position ?? next;
  await assertNameFree(tx, table.id, input.name);
  const id = uuidv7();
  const isFormula = hasFormula(input.type);
  const computed = computedSourceOf(input.type, options) !== null || isFormula;
  if (isFormula) {
    if (input.isPrimary) {
      // Airtable allows a formula primary field; ours waits for the recompute of record names.
      throw new AppError('VALIDATION_FAILED', {
        detail: 'The field options are invalid.',
        extensions: {
          errors: [{ path: 'type', message: `The primary field can't be a ${input.type}.` }],
        },
      });
    }
  }
  if (isFormula && !emptyButton(input.type, options)) {
    const { prepareFormula } = await computedEngine();
    options = await prepareFormula(tx, table.baseId, {
      id,
      tableId: table.id,
      type: input.type,
      options,
      name: input.name,
    });
  } else if (computed) {
    const { assertValidComputed } = await computedEngine();
    await assertValidComputed(tx, table.baseId, {
      id,
      tableId: table.id,
      type: input.type,
      options,
      isPrimary: input.isPrimary ?? false,
    });
  }
  if (input.type === 'ai') {
    options = await (await aiFields()).prepareAiOptions(tx, table, {
      id,
      options: options as AiOptions,
      isPrimary: input.isPrimary ?? false,
    });
  }
  const inverseId = target && target.id !== table.id ? uuidv7() : null;
  if (isLink) options = { ...(options as LinkOptions), inverseLinkFieldId: inverseId };
  await setLockTimeout(tx);
  const [inserted] = await tx
    .insert(fields)
    .values({
      id,
      workspaceId: ctx.workspaceId,
      tableId: table.id,
      name: input.name,
      description: input.description ?? null,
      type: input.type,
      dbColumn: isLink ? physicalName.junction(id) : physicalName.column(id),
      isPrimary: input.isPrimary ?? false,
      position,
      config: options,
      synced: opts.sync === true,
      createdBy: ctx.userId,
    })
    .returning();
  if (!inserted) throw new Error('create field: no row returned');
  let row = inserted;

  const inverse = target && inverseId ? await addInverse(ctx, table, row, target) : undefined;
  if (isLink) await createJunction(tx, row.id);
  else await addFieldColumn(tx, table.id, row.dbColumn, getFieldType(input.type).storage);
  // A computed field over more records than the sync limit is left to the worker: the
  // row read again carries its `recomputing` flag.
  if (computed) await (await computedEngine()).refreshField(tx, table.baseId, row.id);
  if (computed) row = (await tx.select().from(fields).where(eq(fields.id, row.id)))[0] ?? row;
  // An AI field answers every existing record, in the worker.
  if (input.type === 'ai') await (await aiFields()).backfillAiField(tx, table, row, ctx.userId);

  const created = [
    ...(opts.emit !== false ? [{ table, field: row }] : []),
    ...(inverse && target ? [{ table: target, field: inverse }] : []),
  ];
  for (const c of created) await bumpSchemaVersion(tx, c.table.id);
  await emitMany(
    tx,
    created.map((c) => ({
      workspaceId: ctx.workspaceId,
      baseId: c.table.baseId,
      tableId: c.table.id,
      kind: 'field.created' as const,
      payload: { field: toField(c.field) },
      actorId: ctx.userId,
    }))
  );
  return row;
}

/**
 * Converts every value of `field` to `toType`/`toOptions` through the registry's `convertValue`
 * and returns the column the field should point at.
 *
 * - Same type, new options (choices, precision…): values are re-coerced in place and only rows
 *   whose value changes are written, so adding a choice costs one read.
 * - Another type: a new column of the target type is filled with converted values, the field is
 *   repointed, and the old column is dropped. Computed targets (autonumber, created time…) read
 *   an identity or system column instead and keep no converted values, as in Airtable.
 *
 * A type change into a select first adds a choice for every distinct value the conversion would
 * otherwise drop (`conversionOptions`), so the answer carries the options to save.
 *
 * Conversion runs in JS, inside the request's transaction. Above about 100k rows it should move
 * to a pg-boss job with the ADR-001 online path (deferred).
 */
async function convertField(
  ctx: SchemaContext,
  table: TableRow,
  field: FieldRow,
  toType: FieldTypeName,
  requested: unknown
): Promise<{ column: string; options: unknown }> {
  const { tx } = ctx;
  const fromType = fieldType(field);
  const from = getFieldType(fromType);
  const to = getFieldType(toType);
  const loc: TableLocation = table;
  const sameColumn = fromType === toType && to.storage.kind === 'column';

  const { rows } = await tx.execute<{ id: string; v: unknown }>(
    // In id (creation) order, so options made from values follow their first record.
    sql`SELECT id, ${readExpression(field)} AS v FROM ${qualified(loc)} ORDER BY id`
  );
  const fromTyped = { type: fromType, options: field.config };
  const values = rows.map((r) => from.fromStorage(r.v, field.config));
  const toOptions = conversionOptions(values, fromTyped, { type: toType, options: requested });
  const toTyped = { type: toType, options: toOptions };
  const converted: { id: string; v: unknown }[] = [];
  rows.forEach((r, i) => {
    const value = values[i];
    const next = convertValue(value, fromTyped, toTyped);
    const stored = to.toStorage(next as never, toOptions);
    if (sameColumn) {
      // Unchanged values aren't rewritten; unreadable ones (a deleted choice) are cleared.
      const before = from.toStorage(value as never, field.config);
      const unchanged = JSON.stringify(before) === JSON.stringify(stored);
      if (unchanged && (stored !== null || r.v === null)) return;
    }
    converted.push({ id: r.id, v: stored });
  });

  if (sameColumn) {
    await writeColumn(tx, loc, field.dbColumn, to.storage.sqlType, converted);
    return { column: field.dbColumn, options: toOptions };
  }

  const column = physicalName.column(uuidv7());
  await setLockTimeout(tx);
  await addFieldColumn(tx, table.id, column, to.storage);
  if (to.storage.kind === 'column' && !to.readOnly) {
    await writeColumn(
      tx,
      loc,
      column,
      to.storage.sqlType,
      converted.filter((c) => c.v !== null)
    );
  }
  return { column, options: toOptions };
}

/** Renames, describes, reorders, or changes the type or options of a field. */
export async function updateField(
  ctx: SchemaContext,
  current: FieldRow,
  input: UpdateFieldInput
): Promise<FieldRow> {
  const { tx } = ctx;
  // The field row first, then the records: the order a typecast write takes them in.
  const field = (await lockFields(tx, [current.id]))[0] ?? current;
  const [table] = await tx.select().from(tables).where(eq(tables.id, field.tableId));
  if (!table) throw new Error('field without a visible table');
  if (input.name !== undefined) await assertNameFree(tx, table.id, input.name, field.id);
  if (input.permissions) {
    await assertPermissionUsers(tx, table, { edit: input.permissions.edit }, 'permissions');
  }

  const toType = input.type ?? fieldType(field);
  const typeChanged = toType !== field.type;
  const optionsChanged = input.options !== undefined || typeChanged;
  // Synced fields take their type and options from the source; "Sync source" is the sync's.
  if (typeChanged && toType === 'syncSource') syncOnly();
  if (
    field.synced &&
    (typeChanged ||
      (input.options !== undefined &&
        JSON.stringify(parseOptions(toType, input.options)) !==
          JSON.stringify(parseOptions(toType, field.config))))
  ) {
    throw new AppError('CONFLICT', {
      detail: `"${field.name}" is synced from another table: its type and options come from there.`,
    });
  }
  if (typeChanged && field.type === 'link') {
    await assertNoDependents(tx, table.baseId, [field.id], 'convert');
  }
  if (typeChanged && (toType === 'link' || field.type === 'link')) {
    // Loaded on demand: link conversions go through the RecordService, which imports this module.
    const { convertLinkField } = await import('./link-conversion.js');
    const converted = await convertLinkField(ctx, table, field, toType, input);
    await (await computedEngine()).refreshField(tx, table.baseId, field.id);
    return converted;
  }
  let options = optionsChanged
    ? parseOptions(toType, typeChanged ? (input.options ?? {}) : input.options)
    : field.config;
  if (toType === 'link' && optionsChanged) {
    // The linked table and the inverse field are fixed when the link is created; "allow
    // multiple" and "limit to a view" only change how writes are checked, not the links.
    const current = parseOptions('link', field.config) as LinkOptions;
    const next = options as LinkOptions;
    if (next.linkedTableId !== null && next.linkedTableId !== current.linkedTableId) {
      linkInvalid('options.linkedTableId', "A link field's table can't be changed.");
    }
    options = {
      ...next,
      linkedTableId: current.linkedTableId,
      inverseLinkFieldId: current.inverseLinkFieldId,
    };
    if (current.linkedTableId)
      await assertLinkView(tx, current.linkedTableId, options as LinkOptions);
  }
  const structural =
    toType !== 'link' &&
    (typeChanged || (optionsChanged && JSON.stringify(options) !== JSON.stringify(field.config)));

  if (structural && hasFormula(toType)) {
    if (field.isPrimary) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'The field options are invalid.',
        extensions: {
          errors: [{ path: 'type', message: `The primary field can't be a ${toType}.` }],
        },
      });
    }
  }
  if (structural && hasFormula(toType) && !emptyButton(toType, options)) {
    const { prepareFormula } = await computedEngine();
    options = await prepareFormula(tx, table.baseId, {
      id: field.id,
      tableId: table.id,
      type: toType,
      options,
      name: input.name ?? field.name,
    });
  }
  if (structural && computedSourceOf(toType, options)) {
    const { assertValidComputed } = await computedEngine();
    await assertValidComputed(tx, table.baseId, {
      id: field.id,
      tableId: table.id,
      type: toType,
      options,
      isPrimary: field.isPrimary,
    });
  }

  // AI fields: the prompt is checked and stored by id; an AI field stays an AI field in
  // its column (its answers aren't computed again for free), renamed choices follow.
  const aiToAi = field.type === 'ai' && toType === 'ai';
  let regenerate = false;
  if (structural && toType === 'ai') {
    const ai = await aiFields();
    options = await ai.prepareAiOptions(tx, table, {
      id: field.id,
      options: options as AiOptions,
      isPrimary: field.isPrimary,
    });
    const before = aiOptionsSchema.safeParse(field.config ?? {}).data;
    regenerate = !aiToAi || !before || ai.promptChanged(before, options as AiOptions);
    if (aiToAi && before) await renameAiChoices(tx, table, field, before, options as AiOptions);
  }
  if (typeChanged && field.type === 'ai') await (await aiFields()).clearAiCells(tx, field.id);

  let dbColumn = field.dbColumn;
  if (structural && !aiToAi) {
    const converted = await convertField(ctx, table, field, toType, options);
    dbColumn = converted.column;
    options = parseOptions(toType, converted.options);
  }

  const [updated] = await tx
    .update(fields)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.position !== undefined ? { position: input.position } : {}),
      ...(input.permissions ? { permissions: input.permissions } : {}),
      type: toType,
      config: options,
      dbColumn,
      updatedAt: new Date(),
    })
    .where(eq(fields.id, field.id))
    .returning();
  if (!updated) throw new Error('update field: no row returned');
  let row = updated;
  if (dbColumn !== field.dbColumn) await dropColumn(tx, table.id, field.dbColumn);
  if (structural) {
    const engine = await computedEngine();
    // The formulas reading it get their result type again, then everything recomputes:
    // the field if it's computed, and the lookups, rollups and formulas reading it.
    for (const formula of await engine.rederiveFormulas(tx, table.baseId, field.id)) {
      await emit(tx, {
        workspaceId: ctx.workspaceId,
        baseId: table.baseId,
        tableId: table.id,
        kind: 'field.updated',
        payload: { field: toField(formula), typeChanged: false },
        actorId: ctx.userId,
      });
    }
    await engine.refreshField(tx, table.baseId, field.id);
    row = (await tx.select().from(fields).where(eq(fields.id, field.id)))[0] ?? row;
  }
  if (regenerate) await (await aiFields()).backfillAiField(tx, table, row, ctx.userId);
  await bumpSchemaVersion(tx, table.id);
  await emit(tx, {
    workspaceId: ctx.workspaceId,
    baseId: table.baseId,
    tableId: table.id,
    kind: 'field.updated',
    payload: { field: toField(row), typeChanged },
    actorId: ctx.userId,
  });
  return row;
}

/** An AI select's stored answers are choice names: a renamed choice renames them. */
async function renameAiChoices(
  tx: Transaction,
  table: TableRow,
  field: FieldRow,
  before: AiOptions,
  after: AiOptions
) {
  if (before.output !== 'singleSelect' || after.output !== 'singleSelect') return;
  const column = sql.identifier(field.dbColumn);
  for (const old of before.choices) {
    const next = after.choices.find((c) => c.id === old.id);
    if (!next || next.name === old.name) continue;
    await tx.execute(sql`
      UPDATE ${qualified(table)} SET ${column} = ${JSON.stringify(next.name)}::jsonb
       WHERE ${column} = ${JSON.stringify(old.name)}::jsonb`);
  }
}

/** Locks field rows in id order (concurrent typecasts and schema changes queue up). */
export async function lockFields(tx: Transaction, ids: string[]): Promise<FieldRow[]> {
  if (!ids.length) return [];
  return tx
    .select()
    .from(fields)
    .where(inArray(fields.id, ids))
    .orderBy(asc(fields.id))
    .for('update');
}

/**
 * Typecast: adds the named choices to choice fields (`unknownChoices`/`withChoices` in the
 * registry), in the caller's transaction, with a `field.updated` event per changed field. The
 * field rows are locked first and the names checked again against their committed options, so
 * concurrent writers adding the same name end with one choice. At most MAX_TYPECAST_CHOICES new
 * choices per call (`maxNew`; an import passes its own) and MAX_CHOICES per field (422 otherwise).
 * Answers the fields as they are now.
 */
export async function addChoices(
  ctx: SchemaContext,
  table: TableRow,
  wanted: Map<string, string[]>,
  limits: { maxNew?: number } = {}
): Promise<FieldRow[]> {
  const maxNew = limits.maxNew ?? MAX_TYPECAST_CHOICES;
  const { tx } = ctx;
  const locked = await lockFields(tx, [...wanted.keys()]);
  const changes: { row: FieldRow; options: unknown }[] = [];
  let added = 0;
  for (const row of locked) {
    const def = getFieldType(fieldType(row));
    if (!def.unknownChoices || !def.withChoices || row.deletedAt) continue;
    const options = parseOptions(fieldType(row), row.config);
    const seen = new Set<string>();
    const names = (wanted.get(row.id) ?? [])
      .flatMap((name) => def.unknownChoices?.([name], options) ?? [])
      .filter((name) => !seen.has(name.toLowerCase()) && seen.add(name.toLowerCase()));
    if (!names.length) continue;
    const total = ((options as { choices?: unknown[] }).choices?.length ?? 0) + names.length;
    if (total > MAX_CHOICES) {
      throw new AppError('VALIDATION_FAILED', {
        detail: `"${row.name}" can have at most ${MAX_CHOICES} options.`,
      });
    }
    added += names.length;
    changes.push({ row, options: parseOptions(fieldType(row), def.withChoices(options, names)) });
  }
  if (added > maxNew) {
    throw new AppError('VALIDATION_FAILED', {
      detail: `One write can add at most ${maxNew} new select options.`,
    });
  }
  if (!changes.length) return locked;

  const now = new Date();
  const updated = new Map<string, FieldRow>();
  for (const { row, options } of changes) {
    const [next] = await tx
      .update(fields)
      .set({ config: options, updatedAt: now })
      .where(eq(fields.id, row.id))
      .returning();
    if (!next) throw new Error('add choices: no row returned');
    updated.set(next.id, next);
  }
  await bumpSchemaVersion(tx, table.id);
  await emitMany(
    tx,
    [...updated.values()].map((row) => ({
      workspaceId: ctx.workspaceId,
      baseId: table.baseId,
      tableId: table.id,
      kind: 'field.updated' as const,
      payload: { field: toField(row), typeChanged: false },
      actorId: ctx.userId,
    }))
  );
  return locked.map((row) => updated.get(row.id) ?? row);
}

/**
 * Moves a field to the trash: its column stays, so restoring is instant; "delete
 * permanently" (or the purge after TRASH_RETENTION_DAYS) drops it.
 *
 * A link field goes with its inverse field: both to the trash, the inverse `trashedWith`
 * this one, and the junction kept with its links, so the pair comes back together.
 */
export async function deleteField(ctx: SchemaContext, field: FieldRow): Promise<void> {
  const { tx } = ctx;
  if (field.isPrimary) {
    throw new AppError('CONFLICT', { detail: "The primary field can't be deleted." });
  }
  if (field.type === 'syncSource' && field.synced) {
    throw new AppError('CONFLICT', {
      detail: 'The sync matches records by this field: stop syncing the table to delete it.',
    });
  }
  const ids = [field.id];
  if (field.type === 'link') {
    const { inverseLinkFieldId } = parseOptions('link', field.config) as LinkOptions;
    if (inverseLinkFieldId) ids.push(inverseLinkFieldId);
  }
  const [owner] = await tx.select().from(tables).where(eq(tables.id, field.tableId));
  if (owner) await assertNoDependents(tx, owner.baseId, ids, 'delete');
  const now = new Date();
  const rows = await tx
    .update(fields)
    .set({
      deletedAt: now,
      deletedBy: ctx.userId,
      trashedWith: sql`CASE WHEN ${fields.id} = ${field.id} THEN NULL ELSE ${field.id}::uuid END`,
    })
    .where(and(inArray(fields.id, ids), isNull(fields.deletedAt)))
    .returning();
  if (!rows.some((r) => r.id === field.id)) throw new Error('delete field: no row returned');
  for (const row of rows) {
    const [table] = await tx.select().from(tables).where(eq(tables.id, row.tableId));
    if (!table) throw new Error('delete field: table not visible');
    await bumpSchemaVersion(tx, table.id);
    await emit(tx, {
      workspaceId: ctx.workspaceId,
      baseId: table.baseId,
      tableId: table.id,
      kind: 'field.deleted',
      payload: { fieldId: row.id },
      actorId: ctx.userId,
    });
  }
}

/**
 * A link field's junction still exists. A link converted to another type
 * lost its links: its trashed inverse can't come back, so it isn't listed.
 */
export const junctionKept = sql`(${fields.type} <> 'link' OR to_regclass(format('%I.%I',
  (SELECT t.db_schema FROM ${tables} t WHERE t.id = ${fields.tableId}), ${fields.dbColumn}))
  IS NOT NULL)`;

/**
 * Fields of a table in the trash that can be restored, most recently deleted first: the ones
 * deleted on their own (a link's inverse comes back with it, a table's inverse links with it).
 */
export async function trashedFields(tx: Transaction, tableId: string): Promise<FieldRow[]> {
  return tx
    .select()
    .from(fields)
    .where(
      and(
        eq(fields.tableId, tableId),
        isNotNull(fields.deletedAt),
        isNull(fields.trashedWith),
        junctionKept
      )
    )
    .orderBy(sql`${fields.deletedAt} DESC`);
}

/** Puts trashed fields back, each under its name or, for `renamable` ones, a free one. */
async function untrash(tx: Transaction, rows: FieldRow[], renamable: Set<string>) {
  const restored: FieldRow[] = [];
  for (const field of rows) {
    const name = renamable.has(field.id)
      ? await freeFieldName(tx, field.tableId, field.name)
      : field.name;
    if (!renamable.has(field.id)) await assertNameFree(tx, field.tableId, name);
    const [row] = await tx
      .update(fields)
      .set({ name, deletedAt: null, deletedBy: null, trashedWith: null, updatedAt: new Date() })
      .where(eq(fields.id, field.id))
      .returning();
    if (!row) throw new Error('restore field: no row returned');
    restored.push(row);
  }
  return restored;
}

/** Emits `field.restored` for restored fields, bumping their tables' schema versions. */
export async function emitRestored(ctx: SchemaContext, rows: FieldRow[], baseId: string) {
  for (const row of rows) await bumpSchemaVersion(ctx.tx, row.tableId);
  await emitMany(
    ctx.tx,
    rows.map((row) => ({
      workspaceId: ctx.workspaceId,
      baseId,
      tableId: row.tableId,
      kind: 'field.restored' as const,
      payload: { field: toField(row) },
      actorId: ctx.userId,
    }))
  );
}

/**
 * Brings back the fields a deleted field or table took to the trash (`trashedWith` it), under
 * free names. Answers them restored.
 */
export async function restoreTrashedWith(tx: Transaction, id: string): Promise<FieldRow[]> {
  const rows = await tx
    .select()
    .from(fields)
    .where(and(eq(fields.trashedWith, id), isNotNull(fields.deletedAt)));
  return untrash(tx, rows, new Set(rows.map((r) => r.id)));
}

/**
 * Brings a field back from the trash. A link field comes back with its inverse field and its
 * links, once the linked table is live (409 otherwise); the inverse takes a free name if its
 * own is taken.
 */
export async function restoreField(
  ctx: SchemaContext,
  table: TableRow,
  fieldId: string
): Promise<FieldRow> {
  const { tx } = ctx;
  const field = (await trashedFields(tx, table.id)).find((f) => f.id === fieldId);
  if (!field) throw new AppError('NOT_FOUND');
  if (field.type === 'link') {
    const { linkedTableId } = parseOptions('link', field.config) as LinkOptions;
    const [linked] = linkedTableId
      ? await tx.select().from(tables).where(eq(tables.id, linkedTableId))
      : [];
    if (linked?.deletedAt) {
      throw new AppError('CONFLICT', {
        detail: `It links to "${linked.name}", which is in the trash. Restore that table first.`,
      });
    }
  }
  const [row] = await untrash(tx, [field], new Set());
  if (!row) throw new Error('restore field: no row returned');
  const companions = await restoreTrashedWith(tx, field.id);
  // Its column kept its values, but they may be stale.
  if (computedSourceOf(row.type, row.config) || hasFormula(row.type)) {
    await (await computedEngine()).refreshField(tx, table.baseId, row.id);
  }
  await emitRestored(ctx, [row, ...companions], table.baseId);
  return row;
}

/**
 * Deletes a field in the trash for good: the metadata row, then its column, or for a link
 * the pair's rows and the junction with its links. Fields a table's deletion took aren't
 * reached here (they go with the table).
 */
export async function purgeField(ctx: SchemaContext, table: TableRow, fieldId: string) {
  const { tx } = ctx;
  const [field] = await tx
    .select()
    .from(fields)
    .where(
      and(
        eq(fields.id, fieldId),
        eq(fields.tableId, table.id),
        isNotNull(fields.deletedAt),
        isNull(fields.trashedWith)
      )
    );
  if (!field) throw new AppError('NOT_FOUND');
  await setLockTimeout(tx);
  await tx
    .delete(fields)
    .where(
      or(
        eq(fields.id, field.id),
        and(eq(fields.trashedWith, field.id), isNotNull(fields.deletedAt))
      )
    );
  if (field.type === 'link') await dropJunction(tx, table.id, field.dbColumn);
  else await dropColumn(tx, table.id, field.dbColumn);
}
