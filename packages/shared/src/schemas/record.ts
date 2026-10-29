import { z } from 'zod';

/** Most records one call may create, update, delete or restore (all in one transaction). */
export const MAX_RECORDS_PER_REQUEST = 1000;

/** Default and largest page of `GET /api/tables/:tableId/records`. */
export const RECORD_PAGE_DEFAULT = 100;
export const RECORD_PAGE_MAX = 1000;

/**
 * Cell values keyed by field id. Values go through the field-type registry's `coerce` and
 * `valueSchema` on the server; `null` empties a cell.
 */
export const recordCellsSchema = z.record(z.uuid(), z.unknown());

/** Echoed into the outbox event, so a client can recognise its own change (ADR-003). */
const clientOpId = z.string().min(1).max(100).optional();

/**
 * Airtable's `typecast`: select cells naming options that don't exist create them, in the
 * same transaction (needs schema rights, `field:update`; 422 `TYPECAST_FORBIDDEN` otherwise).
 * Off by default, so a client never adds options by accident.
 */
const typecast = z.boolean().optional();

export const recordIds = z.array(z.uuid()).min(1).max(MAX_RECORDS_PER_REQUEST);

const newRecord = z.object({ fields: recordCellsSchema.default({}) }).strict();

/**
 * `POST /api/tables/:tableId/records`: one record (`{ fields }`, answers the record) or up to
 * 1,000 (`{ records: [{ fields }] }`, answers `{ records }`).
 */
export const createRecordsSchema = z.union([
  z
    .object({
      records: z.array(newRecord).min(1).max(MAX_RECORDS_PER_REQUEST),
      clientOpId,
      typecast,
    })
    .strict(),
  z.object({ fields: recordCellsSchema.default({}), clientOpId, typecast }).strict(),
]);

/**
 * A per-cell patch: only the listed fields change (last writer wins per cell, ADR-003). With
 * `ifVersion`, the write fails with 409 unless the record is still at that version.
 */
export const updateRecordSchema = z
  .object({
    fields: recordCellsSchema,
    ifVersion: z.int().min(1).optional(),
    clientOpId,
    typecast,
  })
  .strict();

/** `PATCH /api/tables/:tableId/records`: up to 1,000 patches in one transaction. */
export const bulkUpdateRecordsSchema = z
  .object({
    records: z
      .array(
        z
          .object({
            id: z.uuid(),
            fields: recordCellsSchema,
            ifVersion: z.int().min(1).optional(),
          })
          .strict()
      )
      .min(1)
      .max(MAX_RECORDS_PER_REQUEST),
    clientOpId,
    typecast,
  })
  .strict();

/** `POST /api/tables/:tableId/records/delete` and `/restore`. */
export const recordIdsSchema = z.object({ recordIds, clientOpId }).strict();

/** Query of `GET /api/tables/:tableId/records`: oldest first, keyset paging by id. */
export const listRecordsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(RECORD_PAGE_MAX).default(RECORD_PAGE_DEFAULT),
    /** The `nextCursor` of the previous page. */
    cursor: z.uuid().optional(),
  })
  .strict();

/** A record as the API returns it: every live field's value, `null` when empty. */
export const RecordSchema = z.object({
  id: z.uuid(),
  tableId: z.uuid(),
  version: z.int(),
  fields: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime({ offset: true }),
  createdBy: z.uuid().nullable(),
  updatedAt: z.iso.datetime({ offset: true }),
  updatedBy: z.uuid().nullable(),
});

export const RecordListSchema = z.object({
  records: z.array(RecordSchema),
  nextCursor: z.uuid().nullable(),
});

export const RecordsSchema = z.object({ records: z.array(RecordSchema) });

export const DeletedRecordsSchema = z.object({
  records: z.array(z.object({ id: z.uuid(), deleted: z.literal(true) })),
});

export type CreateRecordsInput = z.infer<typeof createRecordsSchema>;
export type UpdateRecordInput = z.infer<typeof updateRecordSchema>;
export type BulkUpdateRecordsInput = z.infer<typeof bulkUpdateRecordsSchema>;
export type RecordIdsInput = z.infer<typeof recordIdsSchema>;
export type ListRecordsQuery = z.infer<typeof listRecordsQuerySchema>;
export type RecordData = z.infer<typeof RecordSchema>;
