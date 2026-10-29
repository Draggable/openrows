import { describe, expect, it } from 'vitest';
import { parsePackage } from './model';

describe('parsePackage', () => {
  it('reads a package file like the server checks it', () => {
    const ok = parsePackage(
      JSON.stringify({
        manifest: { manifestVersion: 1, name: 'Mine', scopes: ['records:read'] },
        bundle: { js: 'openrows' },
      })
    );
    expect(ok).toEqual({
      ok: true,
      manifest: {
        manifestVersion: 1,
        name: 'Mine',
        description: '',
        version: '1.0.0',
        scopes: ['records:read'],
      },
      bundle: { html: '', css: '', js: 'openrows' },
    });
  });

  it('explains what is wrong', () => {
    expect(parsePackage('{')).toEqual({ ok: false, error: "That file isn't JSON." });
    const bad = parsePackage(
      JSON.stringify({ manifest: { manifestVersion: 1, name: 'x', scopes: ['root'] } })
    );
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/^The manifest isn't valid/);
    const big = parsePackage(
      JSON.stringify({
        manifest: { manifestVersion: 1, name: 'x', scopes: [] },
        bundle: { js: 'x'.repeat(1_000_001) },
      })
    );
    expect(!big.ok && big.error).toMatch(/^The bundle isn't valid/);
  });
});
