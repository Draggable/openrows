import { z } from 'zod';

/**
 * Record revision history: one durable row per record change, written by the
 * RecordService in the same transaction as the change. Rapid edits of the same cells by the same
 * person within `REVISION_COALESCE_SECONDS` become one revision (the first `before`, the last
 * `after`). Computed fields never appear: only cells someone wrote.
 */

/** Default retention of revisions, in days (self-hosted; hosted plans set their own). */
export const DEFAULT_REVISION_RETENTION_DAYS = 365;

/** Edits of the same cells by the same person this close together become one revision. */
export const REVISION_COALESCE_SECONDS = 60;

/** Most revisions one page of `GET .../revisions` answers. */
export const MAX_REVISIONS_PAGE = 100;

export const REVISION_KINDS = ['created', 'updated', 'deleted', 'restored'] as const;
export type RevisionKind = (typeof REVISION_KINDS)[number];

/** One cell of a revision: its value before and after, as the API reads them. */
export const RevisionChangeSchema = z.object({
  fieldId: z.uuid(),
  /** The field's type when the change was made: a value of another type isn't restorable. */
  type: z.string(),
  before: z.unknown(),
  after: z.unknown(),
});
export type RevisionChange = z.infer<typeof RevisionChangeSchema>;

export const RevisionSchema = z.object({
  id: z.uuid(),
  recordId: z.uuid(),
  kind: z.enum(REVISION_KINDS),
  /** Who made the change; null once their account is gone. */
  actorId: z.uuid().nullable(),
  /** How a change was made without a person: `form` (a public form), `automation`. */
  via: z.enum(['form', 'automation']).nullable(),
  /** When the change (its last coalesced edit) was made. */
  at: z.iso.datetime({ offset: true }),
  /** The changed cells the caller may read (`updated` only), in field order. */
  changes: z.array(RevisionChangeSchema),
  /** The revision a restore brought back, when this change is one. */
  restoredFrom: z.uuid().nullable(),
});
export type Revision = z.infer<typeof RevisionSchema>;

/** A page of a record's revisions, newest first. */
export const RevisionListSchema = z.object({
  revisions: z.array(RevisionSchema),
  nextCursor: z.string().nullable(),
});
export type RevisionList = z.infer<typeof RevisionListSchema>;

export const listRevisionsQuerySchema = z
  .object({
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_REVISIONS_PAGE).default(50),
  })
  .strict();
export type ListRevisionsQuery = z.infer<typeof listRevisionsQuerySchema>;

/**
 * `POST .../revisions/:revisionId/restore`: the whole record as it was right after the
 * revision, or only `fieldId`'s cell. A normal write: edit permissions apply and it is itself a
 * revision.
 */
export const restoreRevisionSchema = z
  .object({
    fieldId: z.uuid().optional(),
    clientOpId: z.string().min(1).max(100).optional(),
  })
  .strict();
export type RestoreRevisionInput = z.input<typeof restoreRevisionSchema>;
