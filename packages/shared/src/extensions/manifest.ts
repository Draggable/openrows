import { z } from 'zod';

/**
 * Extensions: a manifest and a bundle (HTML, CSS, JS) installed per base and rendered in
 * a sandboxed frame of `GET /sandbox/extension`
 * . The extension reaches the base only through the `@openrows/blocks` API over
 * `postMessage`; the app (the host) answers its calls as the signed-in person, and only those
 * its manifest's scopes allow.
 */

/**
 * What an extension may ask for. Without `records:read` it sees no tables at all; without
 * `cursor:read` no cursor; without `settings:write` it reads its settings but can't change them;
 * `embed:frames` lets it frame the few embed providers of EXTENSION_EMBED_ORIGINS and show
 * `https:` images (its frame then gets a CSP with those sources).
 */
export const EXTENSION_SCOPES = [
  'records:read',
  'records:write',
  'cursor:read',
  'settings:write',
  'embed:frames',
] as const;
export type ExtensionScope = (typeof EXTENSION_SCOPES)[number];

export const EXTENSION_SCOPE_LABELS: Record<ExtensionScope, string> = {
  'records:read': "Read this base's tables and records",
  'records:write': 'Create, change and delete records',
  'cursor:read': 'See the table, view and record you have selected',
  'settings:write': "Change the extension's settings",
  'embed:frames': 'Show images from the web and videos from YouTube, Vimeo and Loom',
};

/** The embed providers an extension with `embed:frames` may frame. */
export const EXTENSION_EMBED_ORIGINS = [
  'https://www.youtube-nocookie.com',
  'https://player.vimeo.com',
  'https://www.loom.com',
] as const;

export const EXTENSION_LIMITS = {
  /** Installed extensions per base. */
  maxPerBase: 20,
  /** Characters of a bundle's HTML, CSS and JS together (1 MB). */
  maxBundleChars: 1_000_000,
  /** Characters of an installation's settings as JSON (64 KB). */
  maxSettingsChars: 64_000,
  /** Records one select call answers. */
  maxSelect: 5_000,
  /** Records one create, update or delete call takes. */
  maxWriteBatch: 50,
  /** Calls per second; past it the host waits. */
  callsPerSecond: 20,
} as const;

export const EXTENSION_SIZES = ['small', 'medium', 'large'] as const;
export type ExtensionSize = (typeof EXTENSION_SIZES)[number];
/** Heights of the panel's cards, in pixels. */
export const EXTENSION_SIZE_HEIGHTS: Record<ExtensionSize, number> = {
  small: 240,
  medium: 380,
  large: 560,
};

export const extensionManifestSchema = z.strictObject({
  manifestVersion: z.literal(1),
  name: z.string().trim().min(1, 'Name the extension.').max(100),
  description: z.string().trim().max(500).default(''),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/, 'Use a version like 1.0.0.')
    .default('1.0.0'),
  /** Each scope once; an extension gets only these. */
  scopes: z
    .array(z.enum(EXTENSION_SCOPES))
    .max(EXTENSION_SCOPES.length)
    .refine((s) => new Set(s).size === s.length, 'List each scope once.'),
});
export type ExtensionManifest = z.infer<typeof extensionManifestSchema>;
export type ExtensionManifestInput = z.input<typeof extensionManifestSchema>;

export const extensionBundleSchema = z
  .strictObject({
    html: z.string().default(''),
    css: z.string().default(''),
    js: z.string().default(''),
  })
  .refine(
    (b) => b.html.length + b.css.length + b.js.length <= EXTENSION_LIMITS.maxBundleChars,
    `A bundle has at most ${EXTENSION_LIMITS.maxBundleChars.toLocaleString('en')} characters.`
  );
export type ExtensionBundle = z.infer<typeof extensionBundleSchema>;

/** An installation's settings: a JSON object of at most `maxSettingsChars`. */
export const extensionSettingsSchema = z
  .record(z.string().max(200), z.unknown())
  .refine(
    (s) => JSON.stringify(s).length <= EXTENSION_LIMITS.maxSettingsChars,
    `Settings take at most ${EXTENSION_LIMITS.maxSettingsChars.toLocaleString('en')} characters.`
  );
export type ExtensionSettings = Record<string, unknown>;

/** The scopes the sandbox document's CSP depends on (the frame's `?embed=1`). */
export function extensionSandboxPath(scopes: readonly ExtensionScope[]): string {
  return scopes.includes('embed:frames')
    ? `${EXTENSION_SANDBOX_PATH}?embed=1`
    : EXTENSION_SANDBOX_PATH;
}

/** The extension frame's path on the app's origin. */
export const EXTENSION_SANDBOX_PATH = '/sandbox/extension';
