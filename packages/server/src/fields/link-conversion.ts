import {
  conversionOptions,
  convertValue,
  type FieldTypeName,
  getFieldType,
  type LinkOptions,
  type UpdateFieldInput,
} from '@openrows/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { qualified, readExpression, writeColumn } from '../data/columns.js';
import {
  addFieldColumn,
  createJunction,
  dropColumn,
  dropJunction,
  physicalName,
  setLockTimeout,
} from '../data/ddl.js';
import { emitMany, type OutboxEvent } from '../data/outbox.js';
import { fields } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import {
  decodeLinks,
  linkSpecs,
  linkTokens,
  matchNames,
  missingTargets,
  nameCandidates,
  resolveTokens,
  writeLinks,
} from '../records/links.js';
import { createRecords } from '../records/service.js';
import { requireEntitlements } from '../usage/quota.js';
import {
  addInverse,
  bumpSchemaVersion,
  type FieldRow,
  fieldType,
  linkInvalid,
  linkTarget,
  parseOptions,
  type SchemaContext,
  type TableRow,
  toField,
} from './service.js';

/**
 * Field-type conversions to and from links. Like every conversion they run in the
 * request's transaction (fields/service.ts `convertField` for the rest), but they need the
 * linked table, so they live here, next to the RecordService.
 *
 * - **Into a link**: each record's value is read as text (its `toPrimitive`: lists item by item,
 *   text whole and then by its comma-separated parts) and matched to live records of the linked
 *   table by primary field, ignoring case. As typecast does, names that match nothing
 *   become new records of the linked table (up to MAX_CONVERSION_RECORDS). The old column is
 *   dropped, the junction and the inverse field are created.
 * - **Out of a link**: the linked records' names convert like any value (`convertValue` from
 *   the link's names: text joins them, a select gets them as options). The inverse field goes
 *   to the trash and the junction is dropped, as when the link field is deleted.
 */

/** Most records a conversion into a link may create in the linked table. */
export const MAX_CONVERSION_RECORDS = 10_000;

export async function convertLinkField(
  ctx: SchemaContext,
  table: TableRow,
  field: FieldRow,
  toType: FieldTypeName,
  input: UpdateFieldInput
): Promise<FieldRow> {
  return toType === 'link'
    ? toLink(ctx, table, field, input)
    : fromLink(ctx, table, field, toType, input);
}

const renamed = (input: UpdateFieldInput) => ({
  ...(input.name !== undefined ? { name: input.name } : {}),
  ...(input.description !== undefined ? { description: input.description } : {}),
  ...(input.position !== undefined ? { position: input.position } : {}),
  ...(input.permissions ? { permissions: input.permissions } : {}),
});

async function toLink(
  ctx: SchemaContext,
  table: TableRow,
  field: FieldRow,
  input: UpdateFieldInput
): Promise<FieldRow> {
  const { tx } = ctx;
  if (field.isPrimary) linkInvalid('type', "The primary field can't be a link.");
  const from = getFieldType(fieldType(field));
  const requested = parseOptions('link', input.options ?? {}) as LinkOptions;
  const target = await linkTarget(tx, table, requested);

  // Live records' values as link input, before the column goes.
  const { rows } = await tx.execute<{ id: string; v: unknown }>(sql`
    SELECT r.id, ${readExpression(field)} AS v FROM ${qualified(table)} AS r
     WHERE r.deleted_at IS NULL ORDER BY r.id`);
  const inputs = rows.map((r) => {
    const primitive = from.toPrimitive(from.fromStorage(r.v, field.config), field.config);
    return { id: r.id, tokens: typeof primitive === 'boolean' ? null : linkTokens(primitive) };
  });

  const options: LinkOptions = {
    ...requested,
    inverseLinkFieldId: target.id !== table.id ? uuidv7() : null,
  };
  await setLockTimeout(tx);
  const [row] = await tx
    .update(fields)
    .set({
      ...renamed(input),
      type: 'link',
      config: options,
      dbColumn: physicalName.junction(field.id),
      updatedAt: new Date(),
    })
    .where(eq(fields.id, field.id))
    .returning();
  if (!row) throw new Error('convert to link: no row returned');
  const inverse = options.inverseLinkFieldId ? await addInverse(ctx, table, row, target) : null;
  await createJunction(tx, row.id);
  if (from.storage.kind !== 'system') await dropColumn(tx, table.id, field.dbColumn);

  const spec = (await linkSpecs(tx, table, [row])).get(row.id);
  if (spec) {
    const names = inputs.flatMap((i) =>
      (i.tokens ?? []).flatMap((t) => ('name' in t ? nameCandidates(t.name) : []))
    );
    let matched = await matchNames(tx, spec, names);
    const unmatched = new Map<string, string>();
    for (const i of inputs) {
      for (const n of i.tokens ? resolveTokens(i.tokens, matched).unmatched : []) {
        if (!matched.has(n.toLowerCase())) unmatched.set(n.toLowerCase(), n);
      }
    }
    const [primary] = await tx
      .select()
      .from(fields)
      .where(
        and(eq(fields.tableId, target.id), eq(fields.isPrimary, true), isNull(fields.deletedAt))
      );
    const creatable = primary && !getFieldType(fieldType(primary)).readOnly;
    if (unmatched.size && creatable) {
      if (unmatched.size > MAX_CONVERSION_RECORDS) {
        throw new AppError('VALIDATION_FAILED', {
          detail: `Converting would create ${unmatched.size} records in "${target.name}" (at most ${MAX_CONVERSION_RECORDS}).`,
        });
      }
      if (!ctx.role) throw new Error('link conversion: the changer has no role');
      const created = await createRecords(
        {
          tx,
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
          role: ctx.role,
          table: target,
          entitlements: requireEntitlements(ctx),
        },
        [...unmatched.values()].map((name) => ({ [primary.id]: name }))
      );
      matched = new Map(matched);
      [...unmatched.keys()].forEach((key, i) => {
        const id = created[i]?.id;
        if (id) matched.set(key, id);
      });
    }
    const resolved = inputs.map((i) => ({
      recordId: i.id,
      ids: i.tokens ? resolveTokens(i.tokens, matched).ids : [],
    }));
    // Ids in the old values that aren't records of the linked table are dropped.
    const missing = new Set(
      await missingTargets(tx, spec, [...new Set(resolved.flatMap((r) => r.ids))])
    );
    const max = options.prefersSingleRecordLink ? 1 : Number.POSITIVE_INFINITY;
    const writes = resolved
      .map((r) => ({ ...r, ids: r.ids.filter((id) => !missing.has(id)).slice(0, max) }))
      .filter((r) => r.ids.length > 0);
    await writeLinks(tx, spec, writes);
  }

  const events: OutboxEvent[] = [
    {
      workspaceId: ctx.workspaceId,
      baseId: table.baseId,
      tableId: table.id,
      kind: 'field.updated',
      payload: { field: toField(row), typeChanged: true },
      actorId: ctx.userId,
    },
  ];
  await bumpSchemaVersion(tx, table.id);
  if (inverse) {
    await bumpSchemaVersion(tx, target.id);
    events.push({
      workspaceId: ctx.workspaceId,
      baseId: target.baseId,
      tableId: target.id,
      kind: 'field.created',
      payload: { field: toField(inverse) },
      actorId: ctx.userId,
    });
  }
  await emitMany(tx, events);
  return row;
}

async function fromLink(
  ctx: SchemaContext,
  table: TableRow,
  field: FieldRow,
  toType: FieldTypeName,
  input: UpdateFieldInput
): Promise<FieldRow> {
  const { tx } = ctx;
  const link = getFieldType('link');
  const fromOptions = parseOptions('link', field.config) as LinkOptions;
  const to = getFieldType(toType);
  const spec = (await linkSpecs(tx, table, [field])).get(field.id);

  // Every record's links (with names), as convertField reads every row.
  const values: { id: string; value: unknown }[] = [];
  if (spec) {
    const { rows } = await tx.execute<{ id: string; v: unknown }>(sql`
      SELECT r.id, ${readExpression({ ...field, link: spec.read })} AS v
        FROM ${qualified(table)} AS r ORDER BY r.id`);
    for (const r of rows) {
      values.push({ id: r.id, value: link.fromStorage(decodeLinks(spec.read, r.v), fromOptions) });
    }
  }
  const fromTyped = { type: 'link' as const, options: fromOptions };
  const requested = parseOptions(toType, input.options ?? {});
  const toOptions = parseOptions(
    toType,
    conversionOptions(
      values.map((v) => v.value),
      fromTyped,
      { type: toType, options: requested }
    )
  );
  const column = physicalName.column(uuidv7());
  await setLockTimeout(tx);
  await addFieldColumn(tx, table.id, column, to.storage);
  if (to.storage.kind === 'column' && !to.readOnly) {
    const converted = values.flatMap(({ id, value }) => {
      const next = convertValue(value, fromTyped, { type: toType, options: toOptions });
      const v = to.toStorage(next as never, toOptions);
      return v === null ? [] : [{ id, v }];
    });
    await writeColumn(tx, table, column, to.storage.sqlType, converted);
  }
  const [row] = await tx
    .update(fields)
    .set({
      ...renamed(input),
      type: toType,
      config: toOptions,
      dbColumn: column,
      updatedAt: new Date(),
    })
    .where(eq(fields.id, field.id))
    .returning();
  if (!row) throw new Error('convert from link: no row returned');

  const events: OutboxEvent[] = [
    {
      workspaceId: ctx.workspaceId,
      baseId: table.baseId,
      tableId: table.id,
      kind: 'field.updated',
      payload: { field: toField(row), typeChanged: true },
      actorId: ctx.userId,
    },
  ];
  // The inverse field goes to the trash with the junction, as when the link is deleted.
  if (fromOptions.inverseLinkFieldId) {
    const [inverse] = await tx
      .update(fields)
      .set({ deletedAt: new Date() })
      .where(and(eq(fields.id, fromOptions.inverseLinkFieldId), isNull(fields.deletedAt)))
      .returning();
    if (inverse) {
      await bumpSchemaVersion(tx, inverse.tableId);
      events.push({
        workspaceId: ctx.workspaceId,
        baseId: table.baseId,
        tableId: inverse.tableId,
        kind: 'field.deleted',
        payload: { fieldId: inverse.id },
        actorId: ctx.userId,
      });
    }
  }
  await dropJunction(tx, table.id, field.dbColumn);
  await bumpSchemaVersion(tx, table.id);
  await emitMany(tx, events);
  return row;
}
