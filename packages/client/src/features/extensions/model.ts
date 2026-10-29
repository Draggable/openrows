import {
  type ExtensionBundle,
  type ExtensionManifest,
  extensionBundleSchema,
  extensionManifestSchema,
} from '@openrows/shared';

/** What an uploaded package file holds, checked like the server checks it. */
export function parsePackage(
  text: string
):
  | { ok: true; manifest: ExtensionManifest; bundle: ExtensionBundle }
  | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file isn't JSON." };
  }
  const obj = (json ?? {}) as { manifest?: unknown; bundle?: unknown };
  const manifest = extensionManifestSchema.safeParse(obj.manifest);
  if (!manifest.success) {
    return {
      ok: false,
      error: `The manifest isn't valid: ${manifest.error.issues[0]?.message ?? 'unknown problem'}`,
    };
  }
  const bundle = extensionBundleSchema.safeParse(obj.bundle ?? {});
  if (!bundle.success) {
    return {
      ok: false,
      error: `The bundle isn't valid: ${bundle.error.issues[0]?.message ?? 'unknown problem'}`,
    };
  }
  return { ok: true, manifest: manifest.data, bundle: bundle.data };
}
