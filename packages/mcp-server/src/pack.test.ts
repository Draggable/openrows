import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR = fileURLToPath(new URL('..', import.meta.url));

/** What `npm publish` would upload: dist (no tests), the README and the LICENSE. */
describe('npm pack', () => {
  it('contains only dist, README and LICENSE, with an executable bin', () => {
    const [pack] = JSON.parse(
      execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
        cwd: DIR,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    ) as [{ files: { path: string; mode: number }[] }];
    const outside = pack.files.filter(
      (f) =>
        !f.path.startsWith('dist/') && !['README.md', 'LICENSE', 'package.json'].includes(f.path)
    );
    expect(outside).toEqual([]);
    expect(pack.files.map((f) => f.path)).toEqual(
      expect.arrayContaining(['LICENSE', 'README.md', 'dist/bin.js', 'dist/index.js'])
    );
    expect(pack.files.filter((f) => /\.test\.|tsbuildinfo/.test(f.path))).toEqual([]);
    const bin = pack.files.find((f) => f.path === 'dist/bin.js');
    expect((bin?.mode ?? 0) & 0o111).not.toBe(0);
  });
});
