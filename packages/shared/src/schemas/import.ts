import { z } from 'zod';
import { MAX_IMPORT_BYTES, MAX_IMPORT_COLUMNS } from '../csv/index.js';
import { viewQuerySchema } from '../query/index.js';
import { fieldTypeNameSchema } from './field.js';

/** Where one column of the file goes: an existing field, or a new one the import creates. */
export const importColumnSchema = z
  .object({
    /** 0-based column of the file. Columns not listed are skipped. */
    index: z
      .int()
      .min(0)
      .max(MAX_IMPORT_COLUMNS - 1),
    fieldId: z.uuid().optional(),
    newField: z
      .object({
        name: z.string().trim().min(1).max(255),
        type: fieldTypeNameSchema,
        options: z.record(z.string(), z.unknown()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((c) => (c.fieldId === undefined) !== (c.newField === undefined), {
    message: 'Give either fieldId or newField.',
  });

/** Base64 characters of the biggest workbook an import takes. */
const MAX_IMPORT_BASE64 = Math.ceil(MAX_IMPORT_BYTES / 3) * 4;

/**
 * `POST /api/tables/:tableId/imports`: the file (CSV text, or an Excel workbook and one of its
 * sheets; up to 50 MB), how to read it and the column mapping. The import runs in the
 * background; poll the job for its progress.
 */
export const createImportSchema = z
  .object({
    /** CSV text. Give either `csv` or `xlsx`. */
    csv: z.string().min(1).max(MAX_IMPORT_BYTES).optional(),
    /** An Excel workbook (.xlsx), base64-encoded. Give either `csv` or `xlsx`. */
    xlsx: z.base64().min(1).max(MAX_IMPORT_BASE64).optional(),
    /** The workbook's sheet to import, by name: its first sheet when omitted. */
    sheet: z.string().min(1).max(255).optional(),
    /** The CSV's delimiter: detected from the first line when omitted. */
    delimiter: z.enum([',', ';', '\t', '|']).optional(),
    /** The first row names the columns (and isn't imported). */
    hasHeader: z.boolean().default(true),
    /**
     * "Add missing options": values of select columns that match no option become new
     * options before the rows are written (needs `field:update`; 422 `TYPECAST_FORBIDDEN`).
     */
    typecast: z.boolean().default(false),
    columns: z.array(importColumnSchema).min(1).max(MAX_IMPORT_COLUMNS),
  })
  .strict()
  .refine((b) => (b.csv === undefined) !== (b.xlsx === undefined), {
    message: 'Give either csv or xlsx.',
    path: ['csv'],
  })
  .refine((b) => b.xlsx !== undefined || b.sheet === undefined, {
    message: 'A sheet goes with xlsx.',
    path: ['sheet'],
  })
  .refine((b) => b.csv !== undefined || b.delimiter === undefined, {
    message: 'A delimiter goes with csv.',
    path: ['delimiter'],
  })
  .refine((b) => new Set(b.columns.map((c) => c.index)).size === b.columns.length, {
    message: 'Each column can be mapped once.',
    path: ['columns'],
  });

export const IMPORT_STATUSES = ['running', 'done', 'failed'] as const;

/** An import job and its progress. */
export const ImportJobSchema = z.object({
  id: z.uuid(),
  tableId: z.uuid(),
  status: z.enum(IMPORT_STATUSES),
  /** Data rows in the file (the header excluded). */
  totalRows: z.number().int(),
  /** Rows handled so far (created records). */
  processedRows: z.number().int(),
  /** Non-empty cells that couldn't be read as their field's type, left empty. */
  skippedCells: z.number().int(),
  /** Fields the import created. */
  createdFieldIds: z.array(z.uuid()),
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});

/**
 * `GET /api/tables/:tableId/export.csv`: the view's records (`viewId`: its saved filter,
 * sorts and visible fields) with `query` (a JSON ViewQuery: the toolbar's unsaved changes, the
 * find term, the visible fields) on top.
 */
export const exportCsvQuerySchema = z
  .object({
    viewId: z.uuid().optional(),
    query: z
      .string()
      .max(100_000)
      .optional()
      .transform((s, ctx) => {
        if (s === undefined) return undefined;
        try {
          return viewQuerySchema.parse(JSON.parse(s));
        } catch {
          ctx.addIssue({ code: 'custom', message: 'Not a JSON view query.' });
          return z.NEVER;
        }
      }),
  })
  .strict();

export type ImportColumn = z.infer<typeof importColumnSchema>;
export type CreateImportInput = z.input<typeof createImportSchema>;
export type ImportJob = z.infer<typeof ImportJobSchema>;
export type ExportCsvQuery = z.input<typeof exportCsvQuerySchema>;

/**
 * `GET /api/bases/:baseId/export.zip` and `GET /api/me/export.zip`: attachment files in
 * the archive (`files`, the default) or a manifest of signed URLs valid for 7 days (`links`).
 */
export const dataExportQuerySchema = z
  .object({ attachments: z.enum(['files', 'links']).default('files') })
  .strict();
export type DataExportQuery = z.input<typeof dataExportQuerySchema>;
