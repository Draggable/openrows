import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { extensionContentSecurityPolicy } from './sandbox.js';
import { mayInstallCustom } from './service.js';

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
