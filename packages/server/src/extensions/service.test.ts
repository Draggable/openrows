import { builtInExtension, EXTENSION_CATALOG } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { AppError } from '../lib/errors.js';
import { extensionContentSecurityPolicy } from './sandbox.js';
import {
  extensionCatalog,
  mayBrowseCatalog,
  mayInstallCustom,
  resolveCatalogInstall,
} from './service.js';

describe('mayInstallCustom', () => {
  it('follows EXTENSIONS_CUSTOM_BUNDLES on top of base:manage_extensions', () => {
    expect(mayInstallCustom('creators', 'creator')).toBe(true);
    expect(mayInstallCustom('creators', 'owner')).toBe(true);
    expect(mayInstallCustom('creators', 'editor')).toBe(false);
    expect(mayInstallCustom('owners', 'creator')).toBe(false);
    expect(mayInstallCustom('owners', 'owner')).toBe(true);
    expect(mayInstallCustom('off', 'owner')).toBe(false);
    expect(mayInstallCustom('creators', null)).toBe(false);
  });

  it('defaults to owners on the hosted edition and creators elsewhere', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).extensionsCustomBundles).toBe('creators');
    expect(loadConfig({ NODE_ENV: 'test', EDITION: 'cloud' }).extensionsCustomBundles).toBe(
      'owners'
    );
    expect(
      loadConfig({ NODE_ENV: 'test', EDITION: 'cloud', EXTENSIONS_CUSTOM_BUNDLES: 'off' })
        .extensionsCustomBundles
    ).toBe('off');
    expect(() => loadConfig({ NODE_ENV: 'test', EXTENSIONS_CUSTOM_BUNDLES: 'everyone' })).toThrow(
      /EXTENSIONS_CUSTOM_BUNDLES/
    );
  });
});

describe('the extension catalog', () => {
  it('is on by default and off with EXTENSIONS_CATALOG=off, on either edition', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).extensionsCatalog).toBe(true);
    expect(loadConfig({ NODE_ENV: 'test', EDITION: 'cloud' }).extensionsCatalog).toBe(true);
    expect(loadConfig({ NODE_ENV: 'test', EXTENSIONS_CATALOG: 'off' }).extensionsCatalog).toBe(
      false
    );
    expect(
      loadConfig({
        NODE_ENV: 'test',
        EXTENSIONS_CATALOG: 'off',
        EXTENSIONS_CUSTOM_BUNDLES: 'owners',
      })
    ).toMatchObject({ extensionsCatalog: false, extensionsCustomBundles: 'owners' });
    expect(() => loadConfig({ NODE_ENV: 'test', EXTENSIONS_CATALOG: 'yes' })).toThrow(
      /EXTENSIONS_CATALOG/
    );
  });

  it('is browsed by those who may add extensions, only while it is on', () => {
    expect(mayBrowseCatalog(true, 'owner')).toBe(true);
    expect(mayBrowseCatalog(true, 'creator')).toBe(true);
    expect(mayBrowseCatalog(true, 'editor')).toBe(false);
    expect(mayBrowseCatalog(true, 'read_only')).toBe(false);
    expect(mayBrowseCatalog(true, null)).toBe(false);
    expect(mayBrowseCatalog(false, 'owner')).toBe(false);
  });

  it('answers the shipped listings, or none when off', () => {
    const on = extensionCatalog(true);
    expect(on.available).toBe(true);
    expect(on.listings.map((l) => l.name)).toEqual(['Chart', 'Print view', 'URL preview']);
    expect(extensionCatalog(false)).toEqual({ available: false, listings: [] });
  });
});

describe('resolveCatalogInstall', () => {
  const refusal = (f: () => unknown) => {
    try {
      f();
    } catch (err) {
      if (err instanceof AppError) return [err.code, err.detail];
      throw err;
    }
    throw new Error('not refused');
  };

  it('installs a built-in listing as that built-in, with the confirmed permissions', () => {
    for (const listing of EXTENSION_CATALOG) {
      const ext = builtInExtension(listing.source.key);
      expect(resolveCatalogInstall(true, listing.id, [...listing.scopes].reverse())).toEqual({
        builtIn: listing.source.key,
        manifest: ext?.manifest,
      });
    }
  });

  it('is refused while the catalog is off, for unknown listings and other permissions', () => {
    const [chart] = EXTENSION_CATALOG;
    if (!chart) throw new Error('no listings');
    expect(refusal(() => resolveCatalogInstall(false, chart.id, chart.scopes))).toEqual([
      'NOT_FOUND',
      'The extension catalog is turned off on this server.',
    ]);
    expect(refusal(() => resolveCatalogInstall(true, 'openrows.nope', []))).toEqual([
      'NOT_FOUND',
      'No such listing in the catalog.',
    ]);
    expect(refusal(() => resolveCatalogInstall(true, chart.id, ['records:read']))[0]).toBe(
      'CONFLICT'
    );
    expect(
      refusal(() => resolveCatalogInstall(true, chart.id, [...chart.scopes, 'records:write']))[0]
    ).toBe('CONFLICT');
  });
});

describe('extensionContentSecurityPolicy', () => {
  it('allows frames and web images only with embed', () => {
    const plain = extensionContentSecurityPolicy('abc', false);
    expect(plain).toContain("frame-src 'none'");
    expect(plain).toContain("connect-src 'none'");
    expect(plain).not.toContain('https:');
    const embed = extensionContentSecurityPolicy('abc', true);
    expect(embed).toContain('img-src data: blob: https:');
    expect(embed).toContain('frame-src https://www.youtube-nocookie.com');
    expect(embed).toContain("connect-src 'none'");
  });
});
