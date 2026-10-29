import {
  type CreateViewSectionInput,
  MAX_VIEW_SECTIONS_PER_TABLE,
  type UpdateViewSectionInput,
  type ViewSection,
} from '@openrows/shared';
import { and, asc, eq, max, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { emit } from '../data/outbox.js';
import { type Transaction, viewSections } from '../db/index.js';
import type { SchemaContext, TableRow } from '../fields/service.js';
import { AppError } from '../lib/errors.js';

/**
 * View sections: named folders that group a table's views in the sidebar. Deleting one
 * leaves its views in place, outside any section (`views.section_id` is set null).
 */

type SectionRow = typeof viewSections.$inferSelect;

function toSection(row: SectionRow): ViewSection {
  return { id: row.id, tableId: row.tableId, name: row.name, position: row.position };
}

export async function listSections(tx: Transaction, tableId: string): Promise<ViewSection[]> {
  const rows = await tx
    .select()
    .from(viewSections)
    .where(eq(viewSections.tableId, tableId))
    .orderBy(asc(viewSections.position), asc(viewSections.createdAt));
  return rows.map(toSection);
}

async function loadSection(tx: Transaction, tableId: string, id: string): Promise<SectionRow> {
  const [row] = await tx
    .select()
    .from(viewSections)
    .where(and(eq(viewSections.id, id), eq(viewSections.tableId, tableId)));
  if (!row) throw new AppError('NOT_FOUND', { detail: 'No such section in this table.' });
  return row;
}

async function emitSection(
  ctx: SchemaContext,
  table: TableRow,
  kind: 'viewSection.created' | 'viewSection.updated' | 'viewSection.deleted',
  payload: Record<string, unknown>
) {
  await emit(ctx.tx, {
    workspaceId: ctx.workspaceId,
    baseId: table.baseId,
    tableId: table.id,
    kind,
    payload,
    actorId: ctx.userId,
  });
}

/** Adds a section at the end of the table's sidebar. */
export async function createSection(
  ctx: SchemaContext,
  table: TableRow,
  input: CreateViewSectionInput
): Promise<ViewSection> {
  const [stats] = await ctx.tx
    .select({ count: sql<number>`count(*)::int`, last: max(viewSections.position) })
    .from(viewSections)
    .where(eq(viewSections.tableId, table.id));
  if ((stats?.count ?? 0) >= MAX_VIEW_SECTIONS_PER_TABLE) {
    throw new AppError('CONFLICT', {
      detail: `A table can have at most ${MAX_VIEW_SECTIONS_PER_TABLE} view sections.`,
    });
  }
  const [row] = await ctx.tx
    .insert(viewSections)
    .values({
      id: uuidv7(),
      workspaceId: ctx.workspaceId,
      tableId: table.id,
      name: input.name,
      position: (stats?.last ?? 0) + 1,
    })
    .returning();
  if (!row) throw new Error('create view section: no row returned');
  const section = toSection(row);
  await emitSection(ctx, table, 'viewSection.created', { section });
  return section;
}

export async function updateSection(
  ctx: SchemaContext,
  table: TableRow,
  id: string,
  input: UpdateViewSectionInput
): Promise<ViewSection> {
  const row = await loadSection(ctx.tx, table.id, id);
  if (input.name === undefined && input.position === undefined) return toSection(row);
  const [updated] = await ctx.tx
    .update(viewSections)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.position !== undefined ? { position: input.position } : {}),
      updatedAt: new Date(),
    })
    .where(eq(viewSections.id, row.id))
    .returning();
  if (!updated) throw new Error('update view section: no row returned');
  const section = toSection(updated);
  await emitSection(ctx, table, 'viewSection.updated', { section });
  return section;
}

export async function deleteSection(ctx: SchemaContext, table: TableRow, id: string) {
  const row = await loadSection(ctx.tx, table.id, id);
  await ctx.tx.delete(viewSections).where(eq(viewSections.id, row.id));
  await emitSection(ctx, table, 'viewSection.deleted', { sectionId: row.id });
}
