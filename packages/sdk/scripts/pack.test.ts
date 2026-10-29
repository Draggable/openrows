import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR = fileURLToPath(new URL('..', import.meta.url));

/** What `npm publish` would upload: only dist, the README and the LICENSE. */
describe('npm pack', () => {
  it('contains only dist, README and LICENSE', () => {
    expect(
      existsSync(`${DIR}/dist/cjs/package.json`),
      'build the SDK first: npm run build -w @openrows/sdk'
    ).toBe(true);
    const [pack] = JSON.parse(
      execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
        cwd: DIR,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    ) as [{ files: { path: string }[] }];
    const files = pack.files.map((f) => f.path).sort();
    const outside = files.filter(
      (f) => !f.startsWith('dist/') && !['README.md', 'LICENSE', 'package.json'].includes(f)
    );
    expect(outside).toEqual([]);
    expect(files).toEqual(
      expect.arrayContaining([
        'LICENSE',
        'README.md',
        'dist/cjs/index.d.ts',
        'dist/cjs/index.js',
        'dist/cjs/package.json',
        'dist/esm/index.d.ts',
        'dist/esm/index.js',
      ])
    );
    expect(files.filter((f) => /\.(map|tsbuildinfo|ts)$/.test(f) && !f.endsWith('.d.ts'))).toEqual(
      []
    );
  });

  it('loads as ESM and as CommonJS', async () => {
    const esm = execFileSync(
      'node',
      [
        '--input-type=module',
        '-e',
        "import('@openrows/sdk').then((m) => console.log(typeof m.OpenRows))",
      ],
      { cwd: DIR, encoding: 'utf8' }
    );
    const cjs = execFileSync(
      'node',
      ['-e', "console.log(typeof require('@openrows/sdk').OpenRows)"],
      { cwd: DIR, encoding: 'utf8' }
    );
    expect([esm.trim(), cjs.trim()]).toEqual(['function', 'function']);
  });
});
