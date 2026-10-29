#!/usr/bin/env node
// What the published npm packages ship: `npm run check:packages`, in CI's check job after
// the build, and in .github/workflows/release-packages.yml before `npm publish`.
//
// `node scripts/check-packages.mjs [packageDir...]` checks every published package (or those
// given), which must be built. For each it runs `npm pack --dry-run --json --ignore-scripts` and
// fails when:
// - the tarball holds anything but dist/, README.md, LICENSE and package.json, or in dist/ a
//   source map, a TypeScript source (not .d.ts), a tsbuildinfo, a test, a fixture, an `.env*`
//   file or the test helpers;
// - a packed file names this checkout's path, or one in dist/ (or package.json) another local
//   path (/home/<user>, /Users/<user>, a Windows user folder) or a source map
//   (`sourceMappingURL`);
// - the manifest isn't publishable: name outside @openrows, private, a licence other than
//   AGPL-3.0-only, a repository other than this one (npm's provenance checks it), no `files`
//   allowlist, no public access, or a runtime dependency on an unpublished workspace or one
//   whose range the workspace's own version doesn't satisfy.
//
// `node scripts/check-packages.mjs --tag <tag>` resolves a release tag (`sdk-v0.1.0`,
// `mcp-server-v0.1.0`, `n8n-v0.1.0`, `blocks-v0.1.0`) to its package and prints `dir=`, `name=` and `version=`
// lines, and `project=` (its Vitest project), for $GITHUB_OUTPUT; it fails when the tag's version isn't the package's.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const REPOSITORY = 'git+https://github.com/Draggable/openrows.git';
export const LICENSE = 'AGPL-3.0-only';

/** The published packages: their release tags' prefix, directory and Vitest project. */
export const PACKAGES = [
  { tag: 'sdk', dir: 'packages/sdk', project: 'sdk' },
  { tag: 'mcp-server', dir: 'packages/mcp-server', project: 'mcp-server' },
  { tag: 'n8n', dir: 'packages/n8n-nodes-openrows', project: 'n8n-nodes-openrows' },
  { tag: 'blocks', dir: 'packages/blocks', project: 'blocks' },
];

const TOP_LEVEL = new Set(['README.md', 'LICENSE', 'package.json']);
const FORBIDDEN_FILE = [
  [/\.map$/, 'a source map'],
  [/\.tsbuildinfo$/, 'a tsbuildinfo'],
  [/(?<!\.d)\.[cm]?tsx?$/, 'a TypeScript source'],
  [/\.(test|spec)\.|(^|\/)__tests__\//, 'a test'],
  [/(^|\/)(__fixtures__|fixtures?)\//, 'a fixture'],
  [/(^|\/)\.env/, 'an .env file'],
  [/(^|\/)testing\//, 'a test helper'],
  [/(^|\/)\.[^/]+$/, 'a dotfile'],
];

function localPathPatterns(root) {
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    [new RegExp(escaped), 'this checkout’s path'],
    [/\/home\/[A-Za-z0-9._-]+\//, 'a /home path'],
    [/\/Users\/[A-Za-z0-9._-]+\//, 'a /Users path'],
    [/[A-Za-z]:\\\\?Users\\\\?/, 'a Windows user folder'],
    [/sourceMappingURL=/, 'a source map reference'],
  ];
}

/** Problems with a manifest, given the versions of the repository's workspaces. */
export function manifestProblems(manifest, dir, workspaces) {
  const problems = [];
  if (!/^@openrows\/[a-z0-9-]+$/.test(manifest.name ?? '')) {
    problems.push(`name ${manifest.name} isn't in the @openrows scope`);
  }
  if (manifest.private) problems.push('is private');
  if (manifest.license !== LICENSE) problems.push(`license isn't ${LICENSE}`);
  if (manifest.repository?.url !== REPOSITORY || manifest.repository?.directory !== dir) {
    problems.push(`repository isn't { url: ${REPOSITORY}, directory: ${dir} }`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    problems.push('has no `files` allowlist');
  }
  if (manifest.publishConfig?.access !== 'public')
    problems.push('publishConfig.access isn’t public');
  if (manifest.publishConfig?.provenance !== true) {
    problems.push('publishConfig.provenance isn’t true');
  }
  for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
    const workspace = workspaces.get(dep);
    if (!workspace) continue;
    if (workspace.private || !PACKAGES.some((p) => p.dir === workspace.dir)) {
      problems.push(`depends on ${dep}, which isn't published`);
    } else if (!satisfiesCaret(workspace.version, range)) {
      problems.push(`depends on ${dep}@${range}, but the workspace is ${workspace.version}`);
    }
  }
  return problems;
}

/** `^x.y.z` (or an exact version) against a version; anything else counts as unsatisfied. */
export function satisfiesCaret(version, range) {
  const v = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const r = /^(\^?)(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!v || !r) return false;
  const [a, b, c] = v.slice(1).map(Number);
  const [x, y, z] = r.slice(2).map(Number);
  if (!r[1]) return a === x && b === y && c === z;
  const cmp = a - x || b - y || c - z;
  if (cmp < 0) return false;
  if (x > 0) return a === x;
  if (y > 0) return a === 0 && b === y;
  return a === 0 && b === 0 && c === z;
}

/** Problems with a tarball's files: paths, and each text file's contents. */
export function fileProblems(files, read, root = ROOT) {
  const problems = [];
  const patterns = localPathPatterns(root);
  for (const path of files) {
    if (!path.startsWith('dist/') && !TOP_LEVEL.has(path)) {
      problems.push(`${path}: outside dist/, README.md, LICENSE and package.json`);
      continue;
    }
    const forbidden = FORBIDDEN_FILE.find(([re]) => re.test(path));
    if (forbidden) {
      problems.push(`${path}: ${forbidden[1]}`);
      continue;
    }
    // The README may show paths on purpose (/home/node in n8n's image); never this checkout's.
    const checks = path === 'README.md' ? patterns.slice(0, 1) : patterns;
    const text = read(path);
    for (const [re, what] of checks) {
      if (re.test(text)) problems.push(`${path}: contains ${what}`);
    }
  }
  return problems;
}

/** The repository's workspaces by name: directory, version, private. */
export function workspaceVersions(root = ROOT) {
  const out = new Map();
  for (const dir of PACKAGES.map((p) => p.dir).concat(['packages/shared', 'packages/server'])) {
    const m = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
    out.set(m.name, { dir, version: m.version, private: m.private === true });
  }
  return out;
}

export function packedFiles(dir) {
  const [pack] = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  );
  return pack.files.map((f) => f.path).sort();
}

/** Every problem with one package directory (relative to the root), built. */
export function checkPackage(dir, root = ROOT) {
  const abs = join(root, dir);
  const manifest = JSON.parse(readFileSync(join(abs, 'package.json'), 'utf8'));
  const files = packedFiles(abs);
  const problems = manifestProblems(manifest, dir, workspaceVersions(root));
  if (!files.some((f) => f.startsWith('dist/'))) problems.push('dist/ is empty: build it first');
  for (const required of ['README.md', 'LICENSE']) {
    if (!files.includes(required)) problems.push(`${required} is missing`);
  }
  problems.push(...fileProblems(files, (f) => readFileSync(join(abs, f), 'utf8'), root));
  return { name: manifest.name, version: manifest.version, files, problems };
}

/** A release tag's package, or an error when the tag is unknown or its version isn't the package's. */
export function resolveTag(tag, root = ROOT) {
  const match = /^([a-z0-9-]+?)-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
  const pkg = match && PACKAGES.find((p) => p.tag === match[1]);
  if (!match || !pkg) {
    throw new Error(
      `${tag} isn't a release tag (${PACKAGES.map((p) => `${p.tag}-v<version>`).join(', ')})`
    );
  }
  const manifest = JSON.parse(readFileSync(join(root, pkg.dir, 'package.json'), 'utf8'));
  if (manifest.version !== match[2]) {
    throw new Error(`${tag} doesn't match ${pkg.dir}/package.json (${manifest.version})`);
  }
  return { dir: pkg.dir, project: pkg.project, name: manifest.name, version: manifest.version };
}

function main(args) {
  if (args[0] === '--tag') {
    try {
      const resolved = resolveTag(args[1] ?? '');
      for (const [key, value] of Object.entries(resolved))
        process.stdout.write(`${key}=${value}\n`);
      return 0;
    } catch (error) {
      console.error(`::error::${error.message}`);
      return 1;
    }
  }
  const dirs = args.length > 0 ? args : PACKAGES.map((p) => p.dir);
  let failed = false;
  for (const dir of dirs) {
    const { name, version, files, problems } = checkPackage(dir);
    if (problems.length === 0) {
      console.log(`${name}@${version}: ${files.length} files OK`);
      continue;
    }
    failed = true;
    for (const p of problems) console.error(`::error::${name ?? dir}: ${p}`);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
