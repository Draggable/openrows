import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fileProblems,
  manifestProblems,
  PACKAGES,
  REPOSITORY,
  resolveTag,
  satisfiesCaret,
  workspaceVersions,
  // @ts-expect-error: a plain .mjs script without types
} from './check-packages.mjs';

type Workspaces = Map<string, { dir: string; version: string; private: boolean }>;
type Manifest = Record<string, unknown>;

const repo = resolve(import.meta.dirname, '..');
const manifestOf = (dir: string): Manifest =>
  JSON.parse(readFileSync(join(repo, dir, 'package.json'), 'utf8'));

const good = (overrides: Manifest = {}): Manifest => ({
  name: '@openrows/thing',
  version: '1.0.0',
  license: 'AGPL-3.0-only',
  repository: { type: 'git', url: REPOSITORY, directory: 'packages/thing' },
  files: ['dist'],
  publishConfig: { access: 'public', provenance: true },
  ...overrides,
});

describe('the published packages check (#123)', () => {
  it('passes every published manifest of this repository', () => {
    const workspaces = (workspaceVersions as (root: string) => Workspaces)(repo);
    for (const { dir } of PACKAGES as { dir: string }[]) {
      expect([dir, manifestProblems(manifestOf(dir), dir, workspaces)]).toEqual([dir, []]);
    }
  });

  it('the MCP server depends on the SDK version in the repository', () => {
    const mcp = manifestOf('packages/mcp-server') as { dependencies: Record<string, string> };
    const sdk = manifestOf('packages/sdk') as { version: string };
    expect(satisfiesCaret(sdk.version, mcp.dependencies['@openrows/sdk'])).toBe(true);
  });

  it.each([
    [{ name: 'n8n-nodes-openrows' }, "isn't in the @openrows scope"],
    [{ private: true }, 'is private'],
    [{ license: 'MIT' }, "license isn't AGPL-3.0-only"],
    [{ repository: { url: 'git+https://github.com/someone/fork.git' } }, "repository isn't"],
    [{ files: undefined }, 'no `files` allowlist'],
    [{ publishConfig: { access: 'restricted', provenance: true } }, 'access isn’t public'],
    [{ publishConfig: { access: 'public' } }, 'provenance isn’t true'],
    [{ dependencies: { '@openrows/shared': '*' } }, "@openrows/shared, which isn't published"],
    [{ dependencies: { '@openrows/sdk': '^0.2.0' } }, 'but the workspace is 0.1.0'],
  ])('refuses a manifest with %j', (overrides, message) => {
    const workspaces: Workspaces = new Map([
      ['@openrows/sdk', { dir: 'packages/sdk', version: '0.1.0', private: false }],
      ['@openrows/shared', { dir: 'packages/shared', version: '0.1.0', private: true }],
    ]);
    const problems = manifestProblems(good(overrides), 'packages/thing', workspaces) as string[];
    expect(problems.join('\n')).toContain(message);
  });

  it('accepts dist, README, LICENSE and package.json without local paths', () => {
    const files = ['LICENSE', 'README.md', 'dist/index.d.ts', 'dist/index.js', 'package.json'];
    expect(fileProblems(files, () => 'export const x = 1;', '/checkout')).toEqual([]);
  });

  it.each([
    ['src/index.ts', 'outside dist/'],
    ['.env', 'outside dist/'],
    ['dist/index.js.map', 'a source map'],
    ['dist/index.ts', 'a TypeScript source'],
    ['dist/tsconfig.build.tsbuildinfo', 'a tsbuildinfo'],
    ['dist/client.test.js', 'a test'],
    ['dist/__fixtures__/base.json', 'a fixture'],
    ['dist/.env.local', 'an .env file'],
    ['dist/testing/harness.js', 'a test helper'],
  ])('refuses %s', (path, message) => {
    expect(fileProblems([path], () => '', '/checkout').join('\n')).toContain(message);
  });

  it.each([
    ['//# sourceMappingURL=index.js.map', 'a source map reference'],
    ['"/checkout/packages/sdk/src/index.ts"', 'this checkout’s path'],
    ['"/home/kevin/openrows/src"', 'a /home path'],
    ['"/Users/kevin/openrows/src"', 'a /Users path'],
    ['"C:\\\\Users\\\\kevin\\\\openrows"', 'a Windows user folder'],
  ])('refuses dist files containing %s', (text, message) => {
    expect(fileProblems(['dist/index.js'], () => text, '/checkout').join('\n')).toContain(message);
  });

  it("lets the README show container paths, but never the checkout's", () => {
    expect(fileProblems(['README.md'], () => '/home/node/.n8n/nodes', '/checkout')).toEqual([]);
    expect(fileProblems(['README.md'], () => 'see /checkout/x', '/checkout')).not.toEqual([]);
  });

  it('resolves release tags to their package, matching its version', () => {
    for (const { tag, dir, project } of PACKAGES as {
      tag: string;
      dir: string;
      project: string;
    }[]) {
      const { version, name } = manifestOf(dir) as { version: string; name: string };
      expect(resolveTag(`${tag}-v${version}`, repo)).toEqual({ dir, project, name, version });
    }
    expect(() => resolveTag('sdk-v99.0.0', repo)).toThrow("doesn't match packages/sdk");
    expect(() => resolveTag('v0.1.0', repo)).toThrow("isn't a release tag");
    expect(() => resolveTag('server-v0.1.0', repo)).toThrow("isn't a release tag");
  });

  it.each([
    ['0.1.0', '^0.1.0', true],
    ['0.1.5', '^0.1.0', true],
    ['0.2.0', '^0.1.0', false],
    ['1.4.0', '^1.2.3', true],
    ['2.0.0', '^1.2.3', false],
    ['0.0.3', '^0.0.3', true],
    ['0.0.4', '^0.0.3', false],
    ['1.0.0', '1.0.0', true],
    ['1.0.0', '*', false],
  ])('%s satisfies %s: %s', (version, range, expected) => {
    expect(satisfiesCaret(version, range)).toBe(expected);
  });

  it('the release workflow publishes every package, on its tags only, with provenance', () => {
    const text = readFileSync(join(repo, '.github/workflows/release-packages.yml'), 'utf8');
    const tags = (PACKAGES as { tag: string }[]).map((p) => `'${p.tag}-v*'`).join(', ');
    expect(text).toContain(`tags: [${tags}]`);
    expect(text).not.toMatch(/^\s+branches:/m);
    // npm signs provenance only from GitHub-hosted runners.
    expect([...text.matchAll(/^\s+runs-on: (.+)$/gm)].map((m) => m[1])).toEqual(['ubuntu-latest']);
    expect(text).toMatch(/^\s+id-token: write$/m);
    expect(text).toMatch(/^\s+contents: read$/m);
    expect(text).toContain('npm publish -w "$NAME" --provenance --access public');
    expect(text).toContain('node scripts/check-packages.mjs "$DIR"');
    expect(text).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
    // The token only ever reaches npm through the environment, never a command line or echo.
    for (const line of text.split('\n').filter((l) => l.includes('NPM_TOKEN'))) {
      expect(line.trim()).toMatch(
        /^(NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}|#.*|echo "::error::The NPM_TOKEN secret is not set"|- name: Check that NPM_TOKEN is set)$/
      );
    }
  });
});
