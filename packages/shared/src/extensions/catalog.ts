import { z } from 'zod';
import { EXTENSION_SCOPES, type ExtensionScope } from './manifest.js';
import { BUILT_IN_EXTENSIONS, builtInExtension } from './samples.js';

/**
 * The extension catalog: reviewed extensions listed for browsing in a base's extension panel,
 * shipped with the app (never fetched). A listing names its publisher and the permissions
 * (manifest scopes) the extension asks for. Entries are added to EXTENSION_CATALOG in this
 * repository after review; there is no submission or publishing flow in the app.
 *
 * The first catalog lists the built-in extensions; their name, description, version and
 * scopes come from the built-in's manifest, so the listing can't drift from what runs.
 */

/** A listing's stable id: lowercase words joined by `.` or `-`, publisher first. */
export const EXTENSION_CATALOG_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

export const extensionPublisherSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  url: z.url({ protocol: /^https$/ }).optional(),
});
export type ExtensionPublisher = z.infer<typeof extensionPublisherSchema>;

/**
 * Where a listing's extension comes from, by `kind`. `built-in`: one of BUILT_IN_EXTENSIONS,
 * by key. Further kinds (a reviewed package) become a discriminated union on `kind` when the
 * catalog lists them.
 */
export const extensionCatalogSourceSchema = z.strictObject({
  kind: z.literal('built-in'),
  key: z.string().min(1),
});
export type ExtensionCatalogSource = z.infer<typeof extensionCatalogSourceSchema>;

export const extensionCatalogListingSchema = z.strictObject({
  id: z.string().min(1).max(100).regex(EXTENSION_CATALOG_ID),
  name: z.string().min(1).max(100),
  description: z.string().max(500),
  publisher: extensionPublisherSchema,
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  /** The permissions the extension asks for, as its manifest lists them. */
  scopes: z.array(z.enum(EXTENSION_SCOPES)),
  source: extensionCatalogSourceSchema,
});
export type ExtensionCatalogListing = z.infer<typeof extensionCatalogListingSchema>;

/** The publisher of the extensions that ship with the app. */
export const FIRST_PARTY_PUBLISHER: ExtensionPublisher = {
  name: 'OpenRows',
  url: 'https://openrows.io',
};

/** A listing of a built-in extension, read from its manifest. */
function builtInListing(
  id: string,
  key: string,
  publisher: ExtensionPublisher
): ExtensionCatalogListing {
  const ext = builtInExtension(key);
  if (!ext) throw new Error(`The catalog lists an unknown built-in extension: ${key}`);
  const { name, description, version, scopes } = ext.manifest;
  return {
    id,
    name,
    description,
    publisher,
    version,
    scopes: [...scopes] as ExtensionScope[],
    source: { kind: 'built-in', key },
  };
}

/** The shipped catalog, in the order the panel lists it. */
export const EXTENSION_CATALOG: readonly ExtensionCatalogListing[] = BUILT_IN_EXTENSIONS.map((e) =>
  builtInListing(`openrows.${e.key}`, e.key, FIRST_PARTY_PUBLISHER)
);

/** The problems of a catalog (ids unique, every listing valid, built-in sources known). */
export function extensionCatalogProblems(catalog: readonly unknown[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const [i, entry] of catalog.entries()) {
    const parsed = extensionCatalogListingSchema.safeParse(entry);
    if (!parsed.success) {
      problems.push(`Listing ${i}: ${parsed.error.issues.map((x) => x.message).join('; ')}`);
      continue;
    }
    const listing = parsed.data;
    if (ids.has(listing.id)) problems.push(`Listing ${i}: the id ${listing.id} is listed twice.`);
    ids.add(listing.id);
    if (new Set(listing.scopes).size !== listing.scopes.length) {
      problems.push(`Listing ${i}: each scope is listed once.`);
    }
    if (listing.source.kind === 'built-in') {
      const ext = builtInExtension(listing.source.key);
      if (!ext) problems.push(`Listing ${i}: no built-in extension ${listing.source.key}.`);
      else if (ext.manifest.scopes.join(',') !== listing.scopes.join(',')) {
        problems.push(`Listing ${i}: its scopes differ from the built-in's manifest.`);
      }
    }
  }
  return problems;
}
