import { z } from 'zod';
import { MAX_SORTS } from '../query/index.js';
import type { ScriptRecordData, ScriptTableInfo } from '../scripts/protocol.js';
import {
  EXTENSION_LIMITS,
  type ExtensionBundle,
  type ExtensionScope,
  type ExtensionSettings,
  extensionSettingsSchema,
} from './manifest.js';

/**
 * Extensions: the messages between an extension's frame and the app.
 *
 * The app (the host) frames `GET /sandbox/extension` (`sandbox="allow-scripts allow-modals"`:
 * an opaque origin, so no cookies, storage or parent DOM; its CSP leaves it no network). On load
 * the host posts `ExtensionStart` with one end of a MessageChannel; the frame's bootstrap puts
 * the bundle's HTML and CSS in the document, sets `window.openrows` (runtime.ts, the API that
 * `@openrows/blocks` types) and runs the bundle's JS. From then on they talk over the port: the
 * frame sends `ExtensionMessage`s, the host answers each call with an `ExtensionCallResult` and
 * pushes `ExtensionEvent`s. The host treats the frame as untrusted: every message is parsed with
 * `extensionMessageSchema`, a call needs the scope of EXTENSION_METHOD_SCOPES, tables and fields
 * must be the base's, and every call goes through the normal API as the signed-in person.
 */

const id = z.uuid();
const cells = z.record(id, z.unknown());

export const EXTENSION_CALL_METHODS = [
  'select',
  'get',
  'create',
  'update',
  'delete',
  'watch',
  'unwatch',
  'setSettings',
  'openUrl',
] as const;
export type ExtensionCallMethod = (typeof EXTENSION_CALL_METHODS)[number];

/** The scope each call needs (null: any extension). */
export const EXTENSION_METHOD_SCOPES: Record<ExtensionCallMethod, ExtensionScope | null> = {
  select: 'records:read',
  get: 'records:read',
  watch: 'records:read',
  unwatch: 'records:read',
  create: 'records:write',
  update: 'records:write',
  delete: 'records:write',
  setSettings: 'settings:write',
  openUrl: null,
};

export const extensionCallArgsSchemas = {
  select: z.strictObject({
    tableId: id,
    viewId: id.optional(),
    fieldIds: z.array(id).max(500).optional(),
    sorts: z
      .array(z.strictObject({ fieldId: id, direction: z.enum(['asc', 'desc']) }))
      .max(MAX_SORTS)
      .optional(),
    recordIds: z.array(id).max(EXTENSION_LIMITS.maxSelect).optional(),
    limit: z.int().min(1).max(EXTENSION_LIMITS.maxSelect).optional(),
  }),
  get: z.strictObject({ tableId: id, recordId: id }),
  create: z.strictObject({
    tableId: id,
    records: z
      .array(z.strictObject({ fields: cells }))
      .min(1)
      .max(EXTENSION_LIMITS.maxWriteBatch),
  }),
  update: z.strictObject({
    tableId: id,
    records: z
      .array(z.strictObject({ id, fields: cells }))
      .min(1)
      .max(EXTENSION_LIMITS.maxWriteBatch),
  }),
  delete: z.strictObject({
    tableId: id,
    recordIds: z.array(id).min(1).max(EXTENSION_LIMITS.maxWriteBatch),
  }),
  watch: z.strictObject({ tableId: id }),
  unwatch: z.strictObject({ tableId: id }),
  setSettings: z.strictObject({ settings: extensionSettingsSchema }),
  openUrl: z.strictObject({
    url: z
      .string()
      .max(2_048)
      .refine((u) => /^https?:\/\//i.test(u), 'Only http and https links open.'),
  }),
} satisfies Record<ExtensionCallMethod, z.ZodType>;

export type ExtensionCallArgs = {
  [M in ExtensionCallMethod]: z.infer<(typeof extensionCallArgsSchemas)[M]>;
};

/** What the frame sends over the port. */
export const extensionMessageSchema = z.union([
  z.strictObject({
    type: z.literal('call'),
    id: z.int().min(1),
    method: z.enum(EXTENSION_CALL_METHODS),
    args: z.unknown(),
  }),
  /** An uncaught error in the extension: the card shows it. */
  z.strictObject({ type: z.literal('error'), message: z.string().max(2_000) }),
]);
export type ExtensionMessage = z.infer<typeof extensionMessageSchema>;

/** Where the person is in the base: the open table and view, the selected record and field. */
export interface ExtensionCursor {
  tableId: string | null;
  viewId: string | null;
  recordId: string | null;
  fieldId: string | null;
}

export type ExtensionTheme = 'light' | 'dark';

/** What the extension knows when it starts. */
export interface ExtensionInit {
  installation: { id: string; name: string };
  scopes: ExtensionScope[];
  theme: ExtensionTheme;
  /** `tables` is empty without `records:read`. */
  base: { id: string; name: string; tables: ScriptTableInfo[] };
  /** Null without `cursor:read`. */
  cursor: ExtensionCursor | null;
  settings: ExtensionSettings;
  /** `settings:write` and the person may change settings (editors and up). */
  canEditSettings: boolean;
  limits: typeof EXTENSION_LIMITS;
}

/** What the host posts to the frame first, with the port. */
export interface ExtensionStart {
  type: 'start';
  bundle: ExtensionBundle;
  init: ExtensionInit;
}

/** The host's answer to a call. */
export type ExtensionCallResult =
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: string };

/** What the host pushes: `records` only for watched tables, `cursor` only with `cursor:read`. */
export type ExtensionEvent =
  | { type: 'event'; name: 'cursor'; cursor: ExtensionCursor }
  | { type: 'event'; name: 'settings'; settings: ExtensionSettings }
  | { type: 'event'; name: 'theme'; theme: ExtensionTheme }
  | { type: 'event'; name: 'base'; base: ExtensionInit['base'] }
  | { type: 'event'; name: 'records'; tableId: string };

/** A record as the extension gets it (the scripts' shape). */
export type ExtensionRecordData = ScriptRecordData;
