import { z } from 'zod';

/**
 * Synced tables: a table whose records come from another table or view the creator can
 * read (in this base, another base, or another workspace they're a member of). A run reads the
 * source as the sync's creator, with their live access re-checked, then upserts and deletes the
 * synced records idempotently by key (the source record's id, or a key field's text, kept in the
 * table's "Sync source" field). Synced fields are read-only; fields added to the table stay
 * editable. The engine is packages/server/src/syncs/.
 */

/** How often a sync runs on its own: never (only "Sync now"), every 5 minutes, hourly, daily. */
export const SYNC_SCHEDULES = ['manual', '5m', 'hourly', 'daily'] as const;
export type SyncSchedule = (typeof SYNC_SCHEDULES)[number];

/** Minutes between scheduled runs. */
export const SYNC_SCHEDULE_MINUTES: Record<Exclude<SyncSchedule, 'manual'>, number> = {
  '5m': 5,
  hourly: 60,
  daily: 24 * 60,
};

/** Source records one sync copies; a bigger source pauses the sync (`too_many_records`). */
export const MAX_SYNC_RECORDS = 10_000;
/** Source fields one sync copies. */
export const MAX_SYNC_FIELDS = 100;
/** Synced tables per base. */
export const MAX_SYNCS_PER_BASE = 50;
/** Runs the history shows (and keeps) per sync. */
export const SYNC_RUN_HISTORY = 20;

/**
 * Why a sync stopped running: its creator paused it, lost access to the source (or to this
 * base), the source table or view was deleted, or it grew past MAX_SYNC_RECORDS.
 */
export const SYNC_PAUSE_REASONS = [
  'paused',
  'access_lost',
  'source_deleted',
  'too_many_records',
] as const;
export type SyncPauseReason = (typeof SYNC_PAUSE_REASONS)[number];

/**
 * Where a sync's records come from: a table or view of OpenRows, a CSV file at a URL or a
 * Postgres table or query. External sources are read by the worker through the SSRF-safe
 * client (CSV) or a Postgres connection to a checked, pinned address; their URL and connection
 * string are kept encrypted and never shown again. A `connector` source is one of the
 * edition's sync connectors (the hosted service's Google Sheets): read with the sync creator's
 * own connected account, picked by a path of ids (a spreadsheet, then a sheet).
 */
export const SYNC_SOURCE_KINDS = ['table', 'csv', 'postgres', 'connector'] as const;
export type SyncSourceKind = (typeof SYNC_SOURCE_KINDS)[number];

/** The biggest CSV file a sync reads (bytes, as sent: no compression). */
export const MAX_SYNC_CSV_BYTES = 20 * 1024 * 1024;
/** The most a Postgres source's rows may weigh, as text (bytes). */
export const MAX_SYNC_POSTGRES_BYTES = 50 * 1024 * 1024;
/** A Postgres source's SQL query, in characters. */
export const MAX_SYNC_QUERY_CHARS = 10_000;
/** Each statement of a Postgres source's read (Postgres' `statement_timeout`). */
export const SYNC_POSTGRES_STATEMENT_TIMEOUT_MS = 30_000;
/** A cell longer than this (characters) is cut, from both external sources. */
export const MAX_SYNC_CELL_CHARS = 100_000;
/** Rows a preview shows. */
export const SYNC_PREVIEW_ROWS = 5;

/** `schema.table` or `table`: plain identifiers, quoted by the server (any case). */
export const POSTGRES_TABLE_NAME =
  /^[A-Za-z_][A-Za-z0-9_$]{0,62}(\.[A-Za-z_][A-Za-z0-9_$]{0,62})?$/;

export const tableSyncSourceSchema = z
  .object({
    kind: z.literal('table').optional(),
    baseId: z.uuid(),
    tableId: z.uuid(),
    /** Only this view's records (its filter), or the whole table. */
    viewId: z.uuid().nullable().default(null),
  })
  .strict();

export const csvSyncSourceSchema = z
  .object({
    kind: z.literal('csv'),
    /** https (http only where the instance's outbound rules allow it); no credentials. */
    url: z.url({ protocol: /^https?$/, error: 'Enter an http or https URL.' }).max(2048),
  })
  .strict();

export const postgresSyncSourceSchema = z
  .object({
    kind: z.literal('postgres'),
    /**
     * `postgres://user:password@host:5432/database`, optionally `?sslmode=verify-full|require|
     * disable` (the default is verify-full; disable only where the instance allows plain
     * connections). Use a role that can only read.
     */
    connectionString: z
      .string()
      .trim()
      .max(2048)
      .regex(/^postgres(ql)?:\/\//i, 'Enter a postgres:// connection string.'),
    /** A table (or view) to read whole, `schema.table`; or `query`. */
    table: z
      .string()
      .trim()
      .regex(POSTGRES_TABLE_NAME, 'Enter a table as schema.table.')
      .optional(),
    /** One SELECT (or WITH … SELECT) statement. */
    query: z.string().trim().min(1).max(MAX_SYNC_QUERY_CHARS).optional(),
  })
  .strict()
  .refine((s) => (s.table === undefined) !== (s.query === undefined), {
    message: 'Give a table or a query.',
    path: ['table'],
  });

/** A sync connector's id: lower-case letters, digits and dashes. */
export const SYNC_CONNECTOR_ID = /^[a-z][a-z0-9-]{0,39}$/;
/** Levels a connector's picker can have (a spreadsheet, then a sheet: 2). */
export const MAX_CONNECTOR_LEVELS = 4;
/** Items one picker level lists. */
export const MAX_CONNECTOR_ITEMS = 100;
/** The row holding the column names, at most. */
export const MAX_CONNECTOR_HEADER_ROW = 1000;

const connectorItemId = z.string().min(1).max(1024);

export const connectorSyncSourceSchema = z
  .object({
    kind: z.literal('connector'),
    connector: z.string().regex(SYNC_CONNECTOR_ID, 'Unknown connector.'),
    /** One item id per picker level, outermost first (a spreadsheet's id, then a sheet's). */
    path: z.array(connectorItemId).min(1).max(MAX_CONNECTOR_LEVELS),
    /** The row holding the column names (1-based); rows above it are left out. */
    headerRow: z.number().int().min(1).max(MAX_CONNECTOR_HEADER_ROW).default(1),
  })
  .strict();

/** The external sources, which a preview reads and whose columns a sync maps. */
export const externalSyncSourceSchema = z.discriminatedUnion('kind', [
  csvSyncSourceSchema,
  postgresSyncSourceSchema,
  connectorSyncSourceSchema,
]);

/** The field types an external source's column can become. */
export const SYNC_COLUMN_TYPES = [
  'singleLineText',
  'longText',
  'number',
  'currency',
  'percent',
  'checkbox',
  'date',
  'dateTime',
  'singleSelect',
  'multipleSelect',
  'email',
  'url',
  'phone',
] as const;
export type SyncColumnType = (typeof SYNC_COLUMN_TYPES)[number];

/** An external source's column and the field it becomes (by the column's name). */
export const syncColumnSchema = z
  .object({
    name: z.string().min(1).max(255),
    type: z.enum(SYNC_COLUMN_TYPES).default('singleLineText'),
    /** The field type's options (checked against the type's own schema). */
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const createSyncSchema = z
  .object({
    /** The new table's name; defaults to the source table's (made unique in the base). */
    name: z.string().trim().min(1).max(255).optional(),
    source: z.union([
      tableSyncSourceSchema,
      csvSyncSourceSchema,
      postgresSyncSourceSchema,
      connectorSyncSourceSchema,
    ]),
    /** Source fields to copy, in order; default: every field. The primary is always copied. */
    fieldIds: z.array(z.uuid()).min(1).max(MAX_SYNC_FIELDS).optional(),
    /** The source field whose text identifies a record; null: the source record's id. */
    keyFieldId: z.uuid().nullable().default(null),
    /** An external source's columns, in order (the first is the primary); required for them. */
    columns: z.array(syncColumnSchema).min(1).max(MAX_SYNC_FIELDS).optional(),
    /** The column whose text identifies a row of an external source; null: the row number. */
    keyColumn: z.string().min(1).max(255).nullable().default(null),
    schedule: z.enum(SYNC_SCHEDULES).default('hourly'),
  })
  .strict();

/** "Preview": an external source's columns, the suggested types and its first rows. */
export const previewSyncSchema = z.object({ source: externalSyncSourceSchema }).strict();

export const SyncPreviewSchema = z.object({
  label: z.string(),
  columns: z.array(
    z.object({
      name: z.string(),
      type: z.enum(SYNC_COLUMN_TYPES),
      options: z.record(z.string(), z.unknown()),
    })
  ),
  /** The first SYNC_PREVIEW_ROWS rows as text, cut to 200 characters a cell. */
  rows: z.array(z.array(z.string())),
});

export const updateSyncSchema = z
  .object({
    schedule: z.enum(SYNC_SCHEDULES).optional(),
    /** true pauses the sync; false resumes it (and runs it). */
    paused: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' });

const at = z.iso.datetime({ offset: true });

export const SYNC_RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'paused'] as const;
export type SyncRunStatus = (typeof SYNC_RUN_STATUSES)[number];

export const SyncRunSchema = z.object({
  id: z.uuid(),
  trigger: z.enum(['create', 'manual', 'schedule']),
  status: z.enum(SYNC_RUN_STATUSES),
  created: z.number().int(),
  updated: z.number().int(),
  deleted: z.number().int(),
  unchanged: z.number().int(),
  /** Source records left out: no key, or a key another record already has. */
  skipped: z.number().int(),
  error: z.string().nullable(),
  createdAt: at,
  startedAt: at.nullable(),
  finishedAt: at.nullable(),
});

export const TableSyncSchema = z.object({
  id: z.uuid(),
  baseId: z.uuid(),
  tableId: z.uuid(),
  /** The source, with its names as of the last run (for "Synced from …"). */
  source: z.object({
    kind: z.enum(SYNC_SOURCE_KINDS),
    /** A table source's ids; null for external sources. */
    workspaceId: z.uuid().nullable(),
    baseId: z.uuid().nullable(),
    tableId: z.uuid().nullable(),
    viewId: z.uuid().nullable(),
    /** A table's "Base / Table / View"; a CSV's host and file; a database's host, name, table. */
    label: z.string(),
    /** A connector source's connector id; null otherwise. */
    connector: z.string().nullable(),
  }),
  keyFieldId: z.uuid().nullable(),
  /** An external source's key column; null: a table source, or the row number. */
  keyColumn: z.string().nullable(),
  /** Source field (a table source) or column (an external source) → this table's field. */
  fields: z.array(
    z.object({
      sourceFieldId: z.uuid().nullable(),
      column: z.string().nullable(),
      fieldId: z.uuid(),
    })
  ),
  /** The "Sync source" field: each record's source key. */
  sourceFieldId: z.uuid(),
  schedule: z.enum(SYNC_SCHEDULES),
  status: z.enum(['active', 'paused']),
  pauseReason: z.enum(SYNC_PAUSE_REASONS).nullable(),
  createdBy: z.uuid().nullable(),
  lastSyncedAt: at.nullable(),
  nextRunAt: at.nullable(),
  createdAt: at,
  /** Newest first, at most SYNC_RUN_HISTORY. */
  runs: z.array(SyncRunSchema),
  /** Whether the caller may change, pause or remove the sync (creators and up). */
  canManage: z.boolean(),
});

/**
 * Sync connectors: sources an edition adds (the hosted service's Google Sheets), each read
 * through the person's own connected account (OAuth, tokens kept encrypted, disconnect any time).
 */
export const SyncConnectorSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** The picker's levels, outermost first (e.g. "Spreadsheet", "Sheet"). */
  levels: z.array(z.string()),
  /** The caller's connected account, or null. */
  account: z
    .object({
      label: z.string(),
      connectedAt: at,
    })
    .nullable(),
});

export const SyncConnectorListSchema = z.object({ connectors: z.array(SyncConnectorSchema) });

export const browseConnectorSchema = z
  .object({
    connector: z.string().regex(SYNC_CONNECTOR_ID, 'Unknown connector.'),
    /** The ids picked so far: [] lists the first level's items. */
    path: z
      .array(connectorItemId)
      .max(MAX_CONNECTOR_LEVELS - 1)
      .default([]),
    /** Narrows the list (the first level: a name, or a pasted link to the item). */
    search: z.string().trim().max(2048).optional(),
  })
  .strict();

export const ConnectorItemsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      detail: z.string().nullable(),
      /** The last level: picking it completes the source. */
      leaf: z.boolean(),
    })
  ),
});

export const connectStartQuerySchema = z
  .object({ returnTo: z.string().max(2048).optional() })
  .strict();

export type SyncConnectorInfo = z.infer<typeof SyncConnectorSchema>;
export type BrowseConnectorInput = z.input<typeof browseConnectorSchema>;
export type ConnectorItems = z.infer<typeof ConnectorItemsSchema>;
export type CreateSyncInput = z.input<typeof createSyncSchema>;
export type ExternalSyncSource = z.infer<typeof externalSyncSourceSchema>;
export type SyncColumn = z.infer<typeof syncColumnSchema>;
export type SyncPreview = z.infer<typeof SyncPreviewSchema>;
export type PreviewSyncInput = z.input<typeof previewSyncSchema>;
export type UpdateSyncInput = z.infer<typeof updateSyncSchema>;
export type SyncRun = z.infer<typeof SyncRunSchema>;
export type TableSync = z.infer<typeof TableSyncSchema>;
