import { z } from 'zod';
import { FieldSchema } from './field.js';
import { editPermissionSchema, tablePermissionsSchema } from './permissions.js';

const name = z.string().trim().min(1).max(255);

/**
 * `POST /api/bases/:baseId/tables`. A new table gets the default fields Name (primary, single
 * line text), Notes (long text) and Status (single select: Todo, In progress, Done), and a grid
 * view. With `primaryFieldName` it gets only the primary field, under that name: the start of
 * a base imported from a file, whose columns become the other fields.
 */
export const createTableSchema = z
  .object({
    name,
    description: z.string().max(2000).optional(),
    icon: z.string().max(50).optional(),
    primaryFieldName: name.optional(),
  })
  .strict();

export const updateTableSchema = z
  .object({
    name: name.optional(),
    description: z.string().max(2000).nullable().optional(),
    icon: z.string().max(50).nullable().optional(),
    position: z.number().finite().optional(),
    /**
     * Who may add, delete and edit records; the listed keys replace theirs, the others
     * stay. Owners and creators only (`table:update`).
     */
    permissions: z
      .object({
        addRecords: editPermissionSchema.optional(),
        deleteRecords: editPermissionSchema.optional(),
        editRecords: editPermissionSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** `POST /api/tables/:tableId/duplicate`. */
export const duplicateTableSchema = z
  .object({
    name: name.optional(),
    /** Copy the records too, not just the fields. */
    includeRecords: z.boolean().default(false),
  })
  .strict();

/** A table as the API returns it, with its live fields in position order. */
export const TableSchema = z.object({
  id: z.uuid(),
  baseId: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  position: z.number(),
  schemaVersion: z.number().int(),
  /** Record permissions; always set by the server, absent means the defaults. */
  permissions: tablePermissionsSchema.optional(),
  fields: z.array(FieldSchema),
  /**
   * Synced from another table or view: its records come from the source, so nobody adds,
   * deletes or restores them by hand. Absent otherwise.
   */
  synced: z.literal(true).optional(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});

export const TableListSchema = z.object({ tables: z.array(TableSchema.omit({ fields: true })) });

export type CreateTableInput = z.infer<typeof createTableSchema>;
export type UpdateTableInput = z.infer<typeof updateTableSchema>;
export type DuplicateTableInput = z.input<typeof duplicateTableSchema>;
export type TableMeta = z.infer<typeof TableSchema>;
