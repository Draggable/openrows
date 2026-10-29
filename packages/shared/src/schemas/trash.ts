import { z } from 'zod';
import { fieldTypeNameSchema } from './field.js';
import { recordIds } from './record.js';

/**
 * The trash: deleted records, fields, views, tables (per base) and bases (per workspace),
 * restorable until they are purged. Items older than TRASH_RETENTION_DAYS are shown as "will be
 * purged", until then they can still be restored.
 */
export const TRASH_RETENTION_DAYS = 30;

const at = z.iso.datetime({ offset: true });

/** What every item in the trash says: what it was, who deleted it, when, and its purge date. */
const trashItem = {
  id: z.uuid(),
  name: z.string(),
  deletedAt: at,
  /** Null when unknown (the user is gone). */
  deletedBy: z.uuid().nullable(),
  /** deletedAt + TRASH_RETENTION_DAYS: from then on it may be purged at any time. */
  purgeAfter: at,
};

export const TrashedTableSchema = z.object({ ...trashItem });

export const TrashedFieldSchema = z.object({
  ...trashItem,
  tableId: z.uuid(),
  tableName: z.string(),
  type: fieldTypeNameSchema,
  /** The other side of a link field, deleted (and restored) with it. */
  inverse: z.object({ id: z.uuid(), name: z.string(), tableName: z.string() }).nullable(),
});

export const TrashedViewSchema = z.object({
  ...trashItem,
  tableId: z.uuid(),
  tableName: z.string(),
  type: z.string(),
  personal: z.boolean(),
});

/** `GET /api/bases/:baseId/trash`: the base's deleted tables, and fields and views of its live tables. */
export const BaseTrashSchema = z.object({
  tables: z.array(TrashedTableSchema),
  fields: z.array(TrashedFieldSchema),
  views: z.array(TrashedViewSchema),
});

/** The most records one page of a table's record trash holds. */
export const RECORD_TRASH_PAGE_MAX = 200;

export const recordTrashQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(RECORD_TRASH_PAGE_MAX).default(100),
  /** The `nextCursor` of the previous page. */
  cursor: z
    .string()
    .regex(/^\d{1,16}_[0-9a-f-]{36}$/)
    .optional(),
});

export const TrashedRecordSchema = z.object({
  id: z.uuid(),
  /** The primary field as text ('' when empty). */
  name: z.string(),
  deletedAt: at,
  deletedBy: z.uuid().nullable(),
  purgeAfter: at,
});

/** `GET /api/tables/:tableId/trash/records`: most recently deleted first. */
export const RecordTrashSchema = z.object({
  records: z.array(TrashedRecordSchema),
  nextCursor: z.string().nullable(),
});

/** `POST /api/tables/:tableId/trash/records/purge`. */
export const purgeRecordsSchema = z.object({ recordIds }).strict();

export const PurgedRecordsSchema = z.object({ purged: z.number().int() });

export const TrashedBaseSchema = z.object({ ...trashItem });

/** `GET /api/workspaces/:workspaceId/trash`. */
export const WorkspaceTrashSchema = z.object({ bases: z.array(TrashedBaseSchema) });

export type TrashedTable = z.infer<typeof TrashedTableSchema>;
export type TrashedField = z.infer<typeof TrashedFieldSchema>;
export type TrashedView = z.infer<typeof TrashedViewSchema>;
export type TrashedRecord = z.infer<typeof TrashedRecordSchema>;
export type TrashedBase = z.infer<typeof TrashedBaseSchema>;
export type BaseTrash = z.infer<typeof BaseTrashSchema>;
export type RecordTrash = z.infer<typeof RecordTrashSchema>;
export type WorkspaceTrash = z.infer<typeof WorkspaceTrashSchema>;
export type RecordTrashQuery = z.infer<typeof recordTrashQuerySchema>;
