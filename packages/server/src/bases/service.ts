import type { Base, CreateBaseInput, UserRole } from '@openrows/shared';
import { and, eq, isNotNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { createBaseSchema, dropBaseSchema, physicalName, setLockTimeout } from '../data/ddl.js';
import { emit } from '../data/outbox.js';
import { bases, type Transaction } from '../db/index.js';
import type { SchemaContext } from '../fields/service.js';
import { AppError } from '../lib/errors.js';

export type BaseRow = typeof bases.$inferSelect;

export function toBase(b: BaseRow, role: UserRole): Base {
  return {
    id: b.id,
    workspaceId: b.workspaceId,
    name: b.name,
    description: b.description,
    icon: b.icon,
    color: b.color,
    role,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}

/** Creates a base with its `b_<hex>` record schema (ADR-001) and a `base.created` event. */
export async function createBase(
  ctx: SchemaContext,
  input: CreateBaseInput,
  role: UserRole
): Promise<Base> {
  const { tx } = ctx;
  const id = uuidv7();
  const [row] = await tx
    .insert(bases)
    .values({
      id,
      workspaceId: ctx.workspaceId,
      ...input,
      dbSchema: physicalName.schema(id),
      createdBy: ctx.userId,
    })
    .returning();
  if (!row) throw new Error('create base: no row returned');
  await createBaseSchema(tx, row.id);
  const base = toBase(row, role);
  await emit(tx, {
    workspaceId: ctx.workspaceId,
    baseId: row.id,
    kind: 'base.created',
    payload: { base },
    actorId: ctx.userId,
  });
  return base;
}

/**
 * Moves a base to the trash: the base and its tables disappear from every route
 * (authz_resolve skips deleted bases); its schema stays until it is deleted permanently.
 */
export async function deleteBase(ctx: SchemaContext, baseId: string): Promise<void> {
  await ctx.tx
    .update(bases)
    .set({ deletedAt: new Date(), deletedBy: ctx.userId })
    .where(eq(bases.id, baseId));
  await emit(ctx.tx, {
    workspaceId: ctx.workspaceId,
    baseId,
    kind: 'base.deleted',
    payload: { baseId },
    actorId: ctx.userId,
  });
}

/** A base of the workspace in the trash, or 404. */
async function trashedBase(tx: Transaction, workspaceId: string, id: string): Promise<BaseRow> {
  const [row] = await tx
    .select()
    .from(bases)
    .where(and(eq(bases.id, id), eq(bases.workspaceId, workspaceId), isNotNull(bases.deletedAt)));
  if (!row) throw new AppError('NOT_FOUND', { detail: 'No such base in the trash.' });
  return row;
}

/** Brings a base back from the trash with everything in it, as it was. */
export async function restoreBase(ctx: SchemaContext, id: string, role: UserRole): Promise<Base> {
  const row = await trashedBase(ctx.tx, ctx.workspaceId, id);
  const [restored] = await ctx.tx
    .update(bases)
    .set({ deletedAt: null, deletedBy: null, updatedAt: new Date() })
    .where(eq(bases.id, row.id))
    .returning();
  if (!restored) throw new Error('restore base: no row returned');
  const base = toBase(restored, role);
  await emit(ctx.tx, {
    workspaceId: ctx.workspaceId,
    baseId: row.id,
    kind: 'base.restored',
    payload: { base },
    actorId: ctx.userId,
  });
  return base;
}

/**
 * Deletes a base in the trash for good: its record schema (every record table and
 * junction), then its row, which takes its tables, fields, views, collaborators, invitations,
 * comments, revisions and shares with it. Stored files are left for the purge job.
 */
export async function purgeBase(ctx: SchemaContext, id: string): Promise<void> {
  const row = await trashedBase(ctx.tx, ctx.workspaceId, id);
  await setLockTimeout(ctx.tx);
  await dropBaseSchema(ctx.tx, row.id);
  await ctx.tx.delete(bases).where(eq(bases.id, row.id));
}
