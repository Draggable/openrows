import { describe, expect, it } from 'vitest';
import { installExtensionSchema } from '../schemas/extension.js';
import {
  EXTENSION_CATALOG,
  extensionCatalogListing,
  extensionCatalogListingSchema,
  extensionCatalogProblems,
  FIRST_PARTY_PUBLISHER,
  sameExtensionScopes,
} from './catalog.js';
import { BUILT_IN_EXTENSIONS } from './samples.js';

describe('EXTENSION_CATALOG', () => {
  it('lists every built-in extension as a first-party listing read from its manifest', () => {
    expect(EXTENSION_CATALOG.map((l) => l.id)).toEqual([
      'openrows.chart',
      'openrows.print-view',
      'openrows.url-preview',
    ]);
    for (const ext of BUILT_IN_EXTENSIONS) {
      const listing = EXTENSION_CATALOG.find(
        (l) => l.source.kind === 'built-in' && l.source.key === ext.key
      );
      expect(listing).toEqual({
        id: `openrows.${ext.key}`,
        name: ext.manifest.name,
        description: ext.manifest.description,
        publisher: FIRST_PARTY_PUBLISHER,
        version: ext.manifest.version,
        scopes: ext.manifest.scopes,
        source: { kind: 'built-in', key: ext.key },
      });
    }
  });

  it('is a valid catalog', () => {
    expect(extensionCatalogProblems(EXTENSION_CATALOG)).toEqual([]);
    for (const listing of EXTENSION_CATALOG) {
      expect(extensionCatalogListingSchema.parse(listing)).toEqual(listing);
    }
  });

  it('finds the problems of a catalog entry', () => {
    const [chart] = EXTENSION_CATALOG;
    if (!chart) throw new Error('no listings');
    expect(extensionCatalogProblems([chart, chart])).toEqual([
      'Listing 1: the id openrows.chart is listed twice.',
    ]);
    expect(
      extensionCatalogProblems([{ ...chart, source: { kind: 'built-in', key: 'nope' } }])
    ).toEqual(['Listing 0: no built-in extension nope.']);
    expect(extensionCatalogProblems([{ ...chart, scopes: ['records:write'] }])).toEqual([
      "Listing 0: its scopes differ from the built-in's manifest.",
    ]);
    expect(
      extensionCatalogProblems([{ ...chart, scopes: ['records:read', 'records:read'] }])
    ).toHaveLength(2);
    expect(extensionCatalogProblems([{ ...chart, id: 'Not An Id' }])).toHaveLength(1);
    expect(extensionCatalogProblems([{ ...chart, publisher: { name: '' } }])).toHaveLength(1);
    expect(
      extensionCatalogProblems([{ ...chart, publisher: { name: 'X', url: 'http://x.test' } }])
    ).toHaveLength(1);
    expect(extensionCatalogProblems([{ ...chart, extra: true }])).toHaveLength(1);
  });
});

describe('installing a catalog listing', () => {
  it('finds a shipped listing by id', () => {
    expect(extensionCatalogListing('openrows.chart')).toBe(EXTENSION_CATALOG[0]);
    expect(extensionCatalogListing('openrows.nope')).toBeNull();
    expect(extensionCatalogListing('')).toBeNull();
  });

  it('compares the confirmed permissions with the listing’s, in any order', () => {
    expect(
      sameExtensionScopes(['records:read', 'cursor:read'], ['cursor:read', 'records:read'])
    ).toBe(true);
    expect(sameExtensionScopes([], [])).toBe(true);
    expect(sameExtensionScopes(['records:read'], ['records:read', 'records:write'])).toBe(false);
    expect(sameExtensionScopes(['records:read', 'records:write'], ['records:read'])).toBe(false);
    expect(sameExtensionScopes(['records:read'], ['records:write'])).toBe(false);
  });

  it('takes a listing id and the confirmed scopes, nothing else', () => {
    const body = { catalog: 'openrows.chart', scopes: ['records:read', 'settings:write'] };
    expect(installExtensionSchema.parse(body)).toEqual(body);
    for (const bad of [
      { catalog: 'openrows.chart' },
      { catalog: 'Not An Id', scopes: [] },
      { catalog: 'openrows.chart', scopes: ['admin'] },
      { catalog: 'openrows.chart', scopes: [], builtIn: 'chart' },
      { catalog: 'openrows.chart', scopes: [], bundle: { js: 'x' } },
    ]) {
      expect(installExtensionSchema.safeParse(bad).success).toBe(false);
    }
  });
});
