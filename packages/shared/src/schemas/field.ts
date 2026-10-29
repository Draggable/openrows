import { z } from 'zod';
import { FIELD_TYPE_NAMES, type FieldTypeName } from '../fields/index.js';
import { editPermissionSchema, fieldPermissionsSchema } from './permissions.js';

const name = z.string().trim().min(1).max(255);

export const fieldTypeNameSchema = z.enum(FIELD_TYPE_NAMES as [FieldTypeName, ...FieldTypeName[]]);

/**
 * `POST /api/tables/:tableId/fields`. `options` are checked against the type's
 * `optionsSchema` in the field-type registry (defaults applied); `position` defaults to last.
 */
export const createFieldSchema = z
  .object({
    name,
    type: fieldTypeNameSchema,
    description: z.string().max(2000).optional(),
    options: z.record(z.string(), z.unknown()).optional(),
    position: z.number().finite().optional(),
  })
  .strict();

/**
 * `PATCH /api/fields/:fieldId`. Changing `type` (or `options`) converts the stored values
 * through the registry's `convertValue`; `position` reorders.
 */
export const updateFieldSchema = z
  .object({
    name: name.optional(),
    type: fieldTypeNameSchema.optional(),
    description: z.string().max(2000).nullable().optional(),
    options: z.record(z.string(), z.unknown()).optional(),
    position: z.number().finite().optional(),
    /** Who may edit the field's cells. Owners and creators only (`field:update`). */
    permissions: z
      .object({ edit: editPermissionSchema, allowForms: z.boolean().optional() })
      .strict()
      .optional(),
  })
  .strict();

/** A field as the API returns it. */
export const FieldSchema = z.object({
  id: z.uuid(),
  tableId: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  type: fieldTypeNameSchema,
  options: z.unknown(),
  isPrimary: z.boolean(),
  position: z.number(),
  /** Who may edit its cells; always set by the server, absent means the default. */
  permissions: fieldPermissionsSchema.optional(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  /** Set for fields in the trash. */
  deletedAt: z.iso.datetime({ offset: true }).nullable(),
  /**
   * A computed field waiting for the worker's recompute: its cells may be stale until a
   * `field.recomputed` event. Absent otherwise.
   */
  recomputing: z.literal(true).optional(),
  /** Copied from a sync's source: read-only, written only by the sync. Absent otherwise. */
  synced: z.literal(true).optional(),
});

export const FieldListSchema = z.object({ fields: z.array(FieldSchema) });

export type CreateFieldInput = z.infer<typeof createFieldSchema>;
export type UpdateFieldInput = z.infer<typeof updateFieldSchema>;
export type FieldMeta = z.infer<typeof FieldSchema>;

/** Most records one link picker search answers. */
export const LINK_CANDIDATES_MAX = 100;
/** Deepest `offset` the picker pages to (search narrows a longer list). */
export const LINK_CANDIDATES_MAX_OFFSET = 10_000;

const UUID_LIST_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(,[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})*$/i;

/**
 * `GET /api/fields/:fieldId/link-candidates`: records a link field can link to, for the
 * record picker. `search` matches the linked table's primary field (contains, ignoring case);
 * `offset` pages through the matches. `purpose: 'filter'` (a filter's record picker
 * ) lists every live record of the linked table, ignoring "limit record selection to a
 * view". `ids` (comma-separated, at most LINK_CANDIDATES_MAX) names records instead: those of
 * them that are live records of the linked table come back, in the given order (a filter's
 * chips), anything else is left out.
 */
export const linkCandidatesQuerySchema = z
  .object({
    search: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(LINK_CANDIDATES_MAX).default(50),
    offset: z.coerce.number().int().min(0).max(LINK_CANDIDATES_MAX_OFFSET).default(0),
    purpose: z.enum(['link', 'filter']).default('link'),
    ids: z
      .string()
      .max(LINK_CANDIDATES_MAX * 37)
      .regex(UUID_LIST_RE, 'Expected comma-separated record ids')
      .refine((s) => s.split(',').length <= LINK_CANDIDATES_MAX, 'Too many record ids')
      .optional(),
  })
  .strict();

/**
 * The picker's answer: the linked table and matching records with their primary text, and the
 * `offset` of the next page (`null` on the last one).
 */
export const LinkCandidatesSchema = z.object({
  tableId: z.uuid(),
  records: z.array(z.object({ id: z.uuid(), name: z.string() })),
  nextOffset: z.int().min(0).nullable(),
});

export type LinkCandidatesQuery = z.infer<typeof linkCandidatesQuerySchema>;
export type LinkCandidates = z.infer<typeof LinkCandidatesSchema>;
