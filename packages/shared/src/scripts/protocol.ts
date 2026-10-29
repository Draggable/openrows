import { z } from 'zod';
import { MAX_SORTS } from '../query/index.js';

/**
 * Browser scripts: the messages between a script's sandbox and the app.
 *
 * The app (the host) frames `GET /sandbox/script`, a document with its own CSP (`sandbox
 * allow-scripts`: an opaque origin, so no cookies, storage or parent DOM; no network). On load
 * the host posts `ScriptStart` to the frame with one end of a MessageChannel; the frame starts a
 * worker from a blob URL and hands it both, and the script runs in the worker (so a busy loop
 * never blocks the app, and Stop is removing the frame). From then on the worker and the host
 * talk over the port only: the worker sends `SandboxMessage`s, the host answers each call with a
 * `ScriptCallResult`. The host treats the worker as untrusted: every message is parsed with
 * `sandboxMessageSchema`, tables and fields must be the base's, and every call goes through the
 * normal API as the signed-in person, so a script can do nothing its runner can't.
 */

/** What one run may do. The host enforces these; the worker checks the batch size too. */
export const SCRIPT_RUN_LIMITS = {
  /** API-backed calls (selects, writes, record lookups) in one run. */
  maxCalls: 2_000,
  /** Calls per second; past it the host waits (Airtable throttles similarly). */
  callsPerSecond: 20,
  /** Records one create, update or delete call takes (Airtable's limit). */
  maxWriteBatch: 50,
  /** Records created, updated or deleted in one run. */
  maxRecordsWritten: 10_000,
  /** Records read in one run, all selects together. */
  maxRecordsRead: 50_000,
  /** Output entries (text, tables, logs) one run shows. */
  maxOutputEntries: 1_000,
  /** Characters of one output entry; longer ones are cut. */
  maxOutputChars: 100_000,
  /** Rows of one `output.table`. */
  maxTableRows: 1_000,
  /** Wall clock of one run. */
  timeoutMs: 15 * 60_000,
} as const;

const id = z.uuid();
const label = z.string().max(1_000);
const cells = z.record(id, z.unknown());

export const SCRIPT_CALL_METHODS = [
  'select',
  'get',
  'create',
  'update',
  'delete',
  'input',
] as const;
export type ScriptCallMethod = (typeof SCRIPT_CALL_METHODS)[number];

export const scriptCallArgsSchemas = {
  select: z.strictObject({
    tableId: id,
    viewId: id.optional(),
    fieldIds: z.array(id).max(500).optional(),
    sorts: z
      .array(z.strictObject({ fieldId: id, direction: z.enum(['asc', 'desc']) }))
      .max(MAX_SORTS)
      .optional(),
    recordIds: z.array(id).max(SCRIPT_RUN_LIMITS.maxRecordsRead).optional(),
  }),
  get: z.strictObject({ tableId: id, recordId: id }),
  create: z.strictObject({
    tableId: id,
    records: z
      .array(z.strictObject({ fields: cells }))
      .min(1)
      .max(SCRIPT_RUN_LIMITS.maxWriteBatch),
  }),
  update: z.strictObject({
    tableId: id,
    records: z
      .array(z.strictObject({ id, fields: cells }))
      .min(1)
      .max(SCRIPT_RUN_LIMITS.maxWriteBatch),
  }),
  delete: z.strictObject({
    tableId: id,
    recordIds: z.array(id).min(1).max(SCRIPT_RUN_LIMITS.maxWriteBatch),
  }),
  input: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('text'), label }),
    z.strictObject({
      kind: z.literal('buttons'),
      label,
      options: z
        .array(
          z.strictObject({
            label: z.string().min(1).max(200),
            variant: z.enum(['default', 'primary', 'secondary', 'danger']).optional(),
          })
        )
        .min(1)
        .max(20),
    }),
    z.strictObject({ kind: z.literal('table'), label }),
    z.strictObject({ kind: z.literal('view'), label, tableId: id }),
    z.strictObject({ kind: z.literal('field'), label, tableId: id }),
    z.strictObject({
      kind: z.literal('record'),
      label,
      tableId: id,
      viewId: id.optional(),
      /** A query result's or a list's records; absent: the table's (or view's) first ones. */
      recordIds: z.array(id).max(SCRIPT_RUN_LIMITS.maxRecordsRead).optional(),
    }),
  ]),
} satisfies Record<ScriptCallMethod, z.ZodType>;

export type ScriptCallArgs = {
  [M in ScriptCallMethod]: z.infer<(typeof scriptCallArgsSchemas)[M]>;
};

const text = z.string().max(SCRIPT_RUN_LIMITS.maxOutputChars * 2);

/** What the worker sends over the port (`output` messages differ by `kind`). */
export const sandboxMessageSchema = z.union([
  z.strictObject({
    type: z.literal('call'),
    id: z.int().min(1),
    method: z.enum(SCRIPT_CALL_METHODS),
    args: z.unknown(),
  }),
  z.strictObject({
    type: z.literal('output'),
    kind: z.enum(['text', 'markdown', 'inspect']),
    text,
  }),
  z.strictObject({
    type: z.literal('output'),
    kind: z.literal('table'),
    /** Column names, then rows of display text. */
    columns: z.array(z.string().max(1_000)).max(100),
    rows: z.array(z.array(z.string().max(10_000)).max(100)).max(SCRIPT_RUN_LIMITS.maxTableRows),
  }),
  z.strictObject({ type: z.literal('output'), kind: z.literal('clear') }),
  z.strictObject({
    type: z.literal('log'),
    level: z.enum(['log', 'info', 'warn', 'error']),
    text,
  }),
  z.strictObject({ type: z.literal('done') }),
  z.strictObject({
    type: z.literal('error'),
    message: z.string().max(10_000),
    line: z.int().min(1).nullable(),
  }),
]);
export type SandboxMessage = z.infer<typeof sandboxMessageSchema>;

/** A field as the script sees it. */
export interface ScriptFieldInfo {
  id: string;
  name: string;
  type: string;
  description: string | null;
  options: unknown;
  isComputed: boolean;
}

/** A table as the script sees it. */
export interface ScriptTableInfo {
  id: string;
  name: string;
  description: string | null;
  primaryFieldId: string | null;
  fields: ScriptFieldInfo[];
  views: { id: string; name: string; type: string }[];
}

/** A record as the host sends it: cells by field id, with their display text. */
export interface ScriptRecordData {
  id: string;
  name: string;
  createdTime: string;
  cells: Record<string, unknown>;
  strings: Record<string, string>;
}

/** What the host posts to the frame first, with the port. */
export interface ScriptStart {
  type: 'start';
  code: string;
  base: { id: string; name: string; tables: ScriptTableInfo[] };
  session: { currentUser: { id: string; name: string; email: string } | null };
  limits: typeof SCRIPT_RUN_LIMITS;
}

/** The host's answer to a call. */
export type ScriptCallResult =
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: string };

/** The frame's path on the app's origin. */
export const SCRIPT_SANDBOX_PATH = '/sandbox/script';
