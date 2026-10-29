import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR = fileURLToPath(new URL('..', import.meta.url));

interface Manifest {
  keywords: string[];
  n8n: { n8nNodesApiVersion: number; credentials: string[]; nodes: string[] };
  peerDependencies: Record<string, string>;
  dependencies?: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(`${DIR}/package.json`, 'utf8')) as Manifest;

/** What n8n installs: a community node package that loads as CommonJS, nothing else. */
describe('npm pack', () => {
  it('is a community node package with no runtime dependencies', () => {
    expect(manifest.keywords).toContain('n8n-community-node-package');
    expect(manifest.n8n.n8nNodesApiVersion).toBe(1);
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(Object.keys(manifest.peerDependencies)).toEqual(['n8n-workflow']);
  });

  it('contains dist (without the test helpers), README and LICENSE', () => {
    expect(
      existsSync(`${DIR}/dist/nodes/OpenRows/OpenRows.node.js`),
      'build the package first: npm run build -w @openrows/n8n-nodes-openrows'
    ).toBe(true);
    const [pack] = JSON.parse(
      execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
        cwd: DIR,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    ) as [{ files: { path: string }[] }];
    const files = pack.files.map((f) => f.path).sort();
    expect(
      files.filter(
        (f) => !f.startsWith('dist/') && !['README.md', 'LICENSE', 'package.json'].includes(f)
      )
    ).toEqual([]);
    expect(files.filter((f) => f.startsWith('dist/testing'))).toEqual([]);
    for (const listed of [...manifest.n8n.credentials, ...manifest.n8n.nodes]) {
      expect(files).toContain(listed);
    }
    expect(files).toEqual(
      expect.arrayContaining([
        'README.md',
        'LICENSE',
        'dist/nodes/OpenRows/openrows.svg',
        'dist/nodes/OpenRows/OpenRows.node.json',
        'dist/credentials/openrows.svg',
      ])
    );
  });

  it('loads every listed node and credential with require, as n8n does', () => {
    const script = `
      const m = require('./package.json').n8n;
      const out = [...m.credentials, ...m.nodes].map((file) => {
        const mod = require('./' + file);
        const Cls = mod[file.split('/').pop().split('.')[0]];
        const it = new Cls();
        return it.name ?? it.description.name;
      });
      console.log(out.join(','));`;
    const out = execFileSync('node', ['-e', script], { cwd: DIR, encoding: 'utf8' });
    expect(out.trim()).toBe('openRowsApi,openRows,openRowsTrigger');
  });
});
