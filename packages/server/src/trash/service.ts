import {
  type BaseTrash,
  isFieldTypeName,
  TRASH_RETENTION_DAYS,
  type WorkspaceTrash,
} from '@openrows/shared';
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { bases, fields, type Transaction, tables, views } from '../db/index.js';
import { junctionKept } from '../fields/service.js';
import { visibleTo } from '../views/visibility.js';

/** Most items of each kind one trash listing answers (most recently deleted first). */
export const TRASH_LIST_MAX = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The common part of a trash item. */
function item(row: { id: string; name: string; deletedAt: Date | null; deletedBy: string | null }) {
  const deletedAt = row.deletedAt ?? new Date();
  return {
    id: row.id,
    name: row.name,
    deletedAt: deletedAt.toISOString(),
    deletedBy: row.deletedBy,
    purgeAfter: new Date(deletedAt.getTime() + TRASH_RETENTION_DAYS * DAY_MS).toISOString(),
  };
}

/**
 * A base's trash: its deleted tables, and the fields and views deleted from its live tables
 * (a trashed table's own fields and views come back with it). Only fields that come back on their
 * own are listed (a link's inverse goes with it), and only the views `userId` may see.
 */
export async function baseTrash(
  tx: Transaction,
  baseId: string,
  userId: string
): Promise<BaseTrash> {
  const trashedTables = await tx
    .select()
    .from(tables)
    .where(and(eq(tables.baseId, baseId), isNotNull(tables.deletedAt)))
    .orderBy(desc(tables.deletedAt))
    .limit(TRASH_LIST_MAX);

  const liveTable = and(eq(tables.baseId, baseId), isNull(tables.deletedAt));
  const trashedFields = await tx
    .select({ field: fields, tableName: tables.name })
    .from(fields)
    .innerJoin(tables, eq(tables.id, fields.tableId))
    .where(and(liveTable, isNotNull(fields.deletedAt), isNull(fields.trashedWith), junctionKept))
    .orderBy(desc(fields.deletedAt))
    .limit(TRASH_LIST_MAX);
  const linkIds = trashedFields.filter((f) => f.field.type === 'link').map((f) => f.field.id);
  const inverses = linkIds.length
    ? await tx
        .select({ field: fields, tableName: tables.name })
        .from(fields)
        .innerJoin(tables, eq(tables.id, fields.tableId))
        .where(and(inArray(fields.trashedWith, linkIds), isNotNull(fields.deletedAt)))
    : [];
  const inverseOf = new Map(inverses.map((i) => [i.field.trashedWith, i]));

  const trashedViews = await tx
    .select({ view: views, tableName: tables.name })
    .from(views)
    .innerJoin(tables, eq(tables.id, views.tableId))
    .where(and(liveTable, isNotNull(views.deletedAt), visibleTo(userId)))
    .orderBy(desc(views.deletedAt))
    .limit(TRASH_LIST_MAX);

  return {
    tables: trashedTables.map(item),
    fields: trashedFields.flatMap(({ field, tableName }) => {
      if (!isFieldTypeName(field.type)) return [];
      const inverse = inverseOf.get(field.id);
      return [
        {
          ...item(field),
          tableId: field.tableId,
          tableName,
          type: field.type,
          inverse: inverse
            ? { id: inverse.field.id, name: inverse.field.name, tableName: inverse.tableName }
            : null,
        },
      ];
    }),
    views: trashedViews.map(({ view, tableName }) => ({
      ...item(view),
      tableId: view.tableId,
      tableName,
      type: view.type,
      personal: view.personal,
    })),
  };
}

/** A workspace's trash: its deleted bases. */
export async function workspaceTrash(
  tx: Transaction,
  workspaceId: string
): Promise<WorkspaceTrash> {
  const rows = await tx
    .select()
    .from(bases)
    .where(and(eq(bases.workspaceId, workspaceId), isNotNull(bases.deletedAt)))
    .orderBy(desc(bases.deletedAt))
    .limit(TRASH_LIST_MAX);
  return { bases: rows.map(item) };
}
