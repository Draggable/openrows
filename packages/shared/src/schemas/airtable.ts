import { z } from 'zod';

/**
 * The Airtable importer: a workspace creator pastes an Airtable personal access token
 * (scopes `data.records:read` and `schema.bases:read`), picks bases, and each becomes a new base
 * filled by a background job: tables, fields (a type mapping, formulas translated where our
 * parser takes them), then the records. The token is only kept, encrypted, for the job; it is
 * never returned. adds linked records (a second pass once every table's records are in),
 * lookups, rollups and counts on them, attachments copied from Airtable's file hosts, the grid
 * and kanban views, cancelling and the progress the dialog shows.
 */

/** Most bases one request imports. */
export const MAX_AIRTABLE_BASES_PER_IMPORT = 10;
/** Most report lines of each kind a job keeps. */
export const MAX_AIRTABLE_REPORT_ITEMS = 500;
/** Most records an import takes from one table; the rest are left out (and reported). */
export const MAX_AIRTABLE_TABLE_RECORDS = 100_000;
/** The largest file an import copies from Airtable (Airtable's own cap is 5 GB). */
export const MAX_AIRTABLE_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/** An Airtable personal access token: `pat` then letters, digits and a dot. */
export const airtableTokenSchema = z
  .string()
  .trim()
  .min(20)
  .max(256)
  .regex(/^pat[A-Za-z0-9]+\.[A-Za-z0-9]+$/, 'Paste an Airtable personal access token (pat…).');

export const airtableBaseIdSchema = z.string().regex(/^app[A-Za-z0-9]{14}$/, 'Not a base id.');

/** `POST /api/workspaces/:workspaceId/airtable/bases`: the bases a token can read. */
export const listAirtableBasesSchema = z.object({ token: airtableTokenSchema }).strict();
export type ListAirtableBasesInput = z.infer<typeof listAirtableBasesSchema>;

export const AirtableBaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  permissionLevel: z.string(),
});
export type AirtableBase = z.infer<typeof AirtableBaseSchema>;

export const AirtableBaseListSchema = z.object({ bases: z.array(AirtableBaseSchema) });
export type AirtableBaseList = z.infer<typeof AirtableBaseListSchema>;

/** `POST /api/workspaces/:workspaceId/airtable/imports`: one new base per Airtable base. */
export const createAirtableImportSchema = z
  .object({
    token: airtableTokenSchema,
    baseIds: z
      .array(airtableBaseIdSchema)
      .min(1)
      .max(MAX_AIRTABLE_BASES_PER_IMPORT)
      .refine((ids) => new Set(ids).size === ids.length, 'Each base can be picked once.'),
  })
  .strict();
export type CreateAirtableImportInput = z.infer<typeof createAirtableImportSchema>;

/** A field the import changed on the way: another type, or left out. */
export const AirtableReportFieldSchema = z.object({
  table: z.string(),
  field: z.string(),
  /** Airtable's field type. */
  type: z.string(),
  message: z.string(),
});
export type AirtableReportField = z.infer<typeof AirtableReportFieldSchema>;

export const AirtableReportSchema = z.object({
  tables: z.array(
    z.object({
      name: z.string(),
      tableId: z.uuid(),
      fields: z.int().min(0),
      records: z.int().min(0),
    })
  ),
  /** Fields left out (types OpenRows doesn't have, a link to a table left out, …). */
  unsupportedFields: z.array(AirtableReportFieldSchema),
  /** Formulas our parser didn't take: kept as text with their values, the formula described. */
  untranslatedFormulas: z.array(AirtableReportFieldSchema.extend({ formula: z.string() })),
  /** Fields imported as another type, to keep their values (created time, autonumber, …). */
  converted: z.array(AirtableReportFieldSchema),
  /** Cells whose value didn't fit their field (a collaborator who isn't a member, …). */
  skippedCells: z.int().min(0),
  /** Tables with more than MAX_AIRTABLE_TABLE_RECORDS records: the rest were left out. */
  truncatedTables: z.array(z.string()),
  /** Files that couldn't be copied from Airtable: the cell keeps the others. */
  failedAttachments: z
    .array(
      z.object({
        table: z.string(),
        field: z.string(),
        filename: z.string(),
        message: z.string(),
      })
    )
    .default([]),
  /** Links to records that weren't imported, or past a cell's 1,000 links. */
  skippedLinks: z.int().min(0).default(0),
  /** Views created (grid and kanban). */
  views: z.int().min(0).default(0),
  /** Views that weren't (calendar, form, …), and what was left out of those that were. */
  unsupportedViews: z
    .array(z.object({ table: z.string(), view: z.string(), type: z.string(), message: z.string() }))
    .default([]),
});
export type AirtableReport = z.infer<typeof AirtableReportSchema>;

/** One base's import, as the person who started it sees it. */
export const AirtableImportSchema = z.object({
  id: z.uuid(),
  /** The new base (it fills up while the import runs). */
  baseId: z.uuid(),
  airtableBaseId: z.string(),
  name: z.string(),
  status: z.enum(['running', 'done', 'failed', 'cancelled']),
  /**
   * `schema` while the tables, fields and views are created, `records` (with their files), then
   * `links` while linked records are filled in.
   */
  phase: z.enum(['schema', 'records', 'links']),
  tables: z.int().min(0),
  tablesDone: z.int().min(0),
  records: z.int().min(0),
  /** Files copied from Airtable, and those that failed (listed in the report). */
  attachments: z.int().min(0),
  attachmentsFailed: z.int().min(0),
  /** Records whose links were written, in the links phase. */
  linkedRecords: z.int().min(0),
  /** An estimate, 0 to 100 (100 once done). */
  percent: z.int().min(0).max(100),
  report: AirtableReportSchema,
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type AirtableImport = z.infer<typeof AirtableImportSchema>;

export const AirtableImportListSchema = z.object({ imports: z.array(AirtableImportSchema) });
export type AirtableImportList = z.infer<typeof AirtableImportListSchema>;
