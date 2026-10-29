import { z } from 'zod';
import {
  EXTENSION_SIZES,
  extensionBundleSchema,
  extensionManifestSchema,
  extensionSettingsSchema,
} from '../extensions/manifest.js';
import { BUILT_IN_EXTENSION_KEYS } from '../extensions/samples.js';

/**
 * Installed extensions: a base's extension panel. Read by anyone on the base
 * (`base:read_extensions`), installed, arranged and removed by creators
 * (`base:manage_extensions`), their settings changed by editors (`base:configure_extensions`).
 * Third-party bundles need `EXTENSIONS_CUSTOM_BUNDLES` to allow the installer (owners only on
 * the hosted edition).
 */

const at = z.iso.datetime({ offset: true });

export const installExtensionSchema = z.union([
  z.strictObject({
    builtIn: z.enum(BUILT_IN_EXTENSION_KEYS as [string, ...string[]]),
  }),
  z.strictObject({
    manifest: extensionManifestSchema,
    bundle: extensionBundleSchema,
  }),
]);
export type InstallExtensionInput = z.input<typeof installExtensionSchema>;

export const updateExtensionSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100).optional(),
    size: z.enum(EXTENSION_SIZES).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' });
export type UpdateExtensionInput = z.infer<typeof updateExtensionSchema>;

/** The panel's order: every installed extension's id, once. */
export const reorderExtensionsSchema = z.strictObject({
  ids: z.array(z.uuid()).max(100),
});

export const extensionSettingsBodySchema = z.strictObject({ settings: extensionSettingsSchema });

export const ExtensionInstallationSchema = z.object({
  id: z.uuid(),
  baseId: z.uuid(),
  /** A built-in extension's key, or null for a third-party bundle. */
  builtIn: z.string().nullable(),
  name: z.string(),
  manifest: extensionManifestSchema,
  size: z.enum(EXTENSION_SIZES),
  position: z.int(),
  settings: z.record(z.string(), z.unknown()),
  createdBy: z.uuid().nullable(),
  createdAt: at,
  updatedAt: at,
});
export type ExtensionInstallation = z.infer<typeof ExtensionInstallationSchema>;

/** `GET /api/bases/:baseId/extensions`: the panel, and what the caller may do with it. */
export const ExtensionListSchema = z.object({
  extensions: z.array(ExtensionInstallationSchema),
  canManage: z.boolean(),
  canConfigure: z.boolean(),
  /** May the caller install a third-party bundle (the instance's policy and their role). */
  canInstallCustom: z.boolean(),
});
export type ExtensionList = z.infer<typeof ExtensionListSchema>;

/** `GET .../extensions/:extensionId/bundle`: what the frame runs. */
export const ExtensionBundleResponseSchema = z.object({
  manifest: extensionManifestSchema,
  bundle: z.object({ html: z.string(), css: z.string(), js: z.string() }),
});
export type ExtensionBundleResponse = z.infer<typeof ExtensionBundleResponseSchema>;
