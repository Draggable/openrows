import { execFile } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// CI's images on GHCR and a deploy's pull: docker/ghcr.sh against a fake `docker` and a
// fake registry + GitHub API on a random loopback port. The real registry is exercised by CI's
// docker job.
const root = resolve(import.meta.dirname, '..', '..');
const script = resolve(root, 'docker/ghcr.sh');
const COMMIT = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const TOKEN = 'ghs_fakeTokenNeverPrinted0123456789';
const REPO = 'ghcr.io/draggable/example-private';

type Call = { args: string[]; config: string | null; stdin?: string };
type Registry = {
  /** Status of an anonymous manifest request per tag (default 401). */
  manifests: Record<string, number>;
  /** Whether /token hands out an anonymous token (as GHCR does for public packages). */
  anonymousToken: boolean;
  tip: string;
  seen: { path: string; auth?: string }[];
};

let server: Server;
let base: string;
let scratch: string;
let bin: string;
const registry: Registry = { manifests: {}, anonymousToken: false, tip: COMMIT, seen: [] };

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'openrows-ghcr-'));
  bin = join(scratch, 'bin');
  mkdirSync(bin);
  copyFileSync(resolve(root, 'docker/test/fake-ghcr-docker.mjs'), join(bin, 'docker'));
  chmodSync(join(bin, 'docker'), 0o755);
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    registry.seen.push({ path: url.pathname, auth: req.headers.authorization });
    if (url.pathname === '/token') {
      if (!registry.anonymousToken) {
        res.writeHead(403).end('{"errors":[{"code":"DENIED"}]}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"token":"anon-token"}');
      return;
    }
    const manifest = /^\/v2\/draggable\/example-private\/manifests\/(.+)$/.exec(url.pathname);
    if (manifest?.[1]) {
      res.writeHead(registry.manifests[manifest[1]] ?? 401).end();
      return;
    }
    if (url.pathname === '/repos/Draggable/openrows/commits/main') {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200).end(registry.tip);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  registry.manifests = {};
  registry.anonymousToken = false;
  registry.tip = COMMIT;
  registry.seen = [];
});

let runs = 0;
async function run(cmd: string, args: string[], env: Record<string, string> = {}) {
  const dir = join(scratch, `run-${++runs}`);
  mkdirSync(dir);
  const callsFile = join(dir, 'calls');
  const result = await new Promise<{ code: number; out: string }>((done) => {
    execFile(
      cmd,
      args,
      {
        cwd: root,
        env: {
          PATH: `${bin}:${process.env['PATH'] ?? '/usr/bin:/bin'}`,
          HOME: dir,
          RUNNER_TEMP: dir,
          GHCR_URL: base,
          GITHUB_API_URL: base,
          GITHUB_REPOSITORY: 'Draggable/openrows',
          GITHUB_ACTOR: 'ci-bot',
          FAKE_DOCKER_CALLS: callsFile,
          ...env,
        },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        done({ code, out: `${stdout}${stderr}` });
      }
    );
  });
  const calls: Call[] = existsSync(callsFile)
    ? readFileSync(callsFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Call)
    : [];
  // The token never shows up in output or in any docker argument.
  expect(result.out).not.toContain(TOKEN);
  for (const c of calls) expect(c.args.join(' ')).not.toContain(TOKEN);
  return { ...result, calls, dir };
}

const ghcr = (args: string[], env: Record<string, string> = {}) =>
  run(script, args, { GH_TOKEN: TOKEN, ...env });

describe('docker/ghcr.sh check-private', () => {
  it('is private when the registry refuses anonymous reads (401, 403, 404)', async () => {
    for (const status of [401, 403, 404]) {
      registry.manifests['main'] = status;
      expect((await ghcr(['check-private', REPO, 'main'])).code, String(status)).toBe(0);
    }
  });

  it('is public when an anonymous token reads the manifest', async () => {
    registry.anonymousToken = true;
    registry.manifests['main'] = 200;
    const { code, out } = await ghcr(['check-private', REPO, 'main']);
    expect(code).toBe(1);
    expect(out).toContain('the package is public');
    const manifest = registry.seen.find((s) => s.path.endsWith('/manifests/main'));
    expect(manifest?.auth).toBe('Bearer anon-token');
  });

  it('says neither on any other answer', async () => {
    registry.manifests['main'] = 500;
    const { code, out } = await ghcr(['check-private', REPO, 'main']);
    expect(code).toBe(3);
    expect(out).toContain('could not tell');
  });

  it('refuses malformed arguments', async () => {
    expect((await ghcr(['check-private', 'not a repo', 'main'])).code).toBe(2);
    expect((await ghcr(['nope'])).code).toBe(2);
    expect((await ghcr(['pull', REPO, 'abc123', 'x'])).code).toBe(2);
  });
});

describe('docker/ghcr.sh push', () => {
  it('pushes sha-<commit> with a private login, then moves :main while the commit is the tip', async () => {
    const { code, out, calls, dir } = await ghcr(['push', '--private', 'img:local', REPO, COMMIT]);
    expect(code, out).toBe(0);
    const sha = `${REPO}:sha-${COMMIT}`;
    expect(calls.map((c) => c.args)).toEqual([
      ['login', 'ghcr.io', '-u', 'ci-bot', '--password-stdin'],
      ['tag', 'img:local', sha],
      ['push', sha],
      ['buildx', 'imagetools', 'create', '--tag', `${REPO}:main`, sha],
      ['image', 'rm', sha],
    ]);
    // The token went through stdin, into a job-private Docker config that is gone afterwards.
    expect(calls[0]?.stdin).toBe(`${TOKEN}\n`);
    const config = calls[0]?.config ?? '';
    expect(config.startsWith(join(dir, 'ghcr-docker-config.'))).toBe(true);
    for (const c of calls) expect(c.config).toBe(config);
    expect(existsSync(config)).toBe(false);
    // Anonymous checks before (:main) and after (the new tag) the push.
    const checked = registry.seen.filter((s) => s.path.includes('/manifests/')).map((s) => s.path);
    expect(checked).toEqual([
      '/v2/draggable/example-private/manifests/main',
      `/v2/draggable/example-private/manifests/sha-${COMMIT}`,
    ]);
  });

  it('leaves :main alone when main has moved on', async () => {
    registry.tip = OTHER;
    const { code, out, calls } = await ghcr(['push', '--private', 'img:local', REPO, COMMIT]);
    expect(code, out).toBe(0);
    expect(out).toContain(`main is at ${OTHER} now`);
    expect(calls.some((c) => c.args.includes('imagetools'))).toBe(false);
  });

  it('refuses to push to a package anyone can read', async () => {
    registry.anonymousToken = true;
    registry.manifests['main'] = 200;
    const { code, out, calls } = await ghcr(['push', '--private', 'img:local', REPO, COMMIT]);
    expect(code).toBe(1);
    expect(out).toContain('the package is public');
    expect(calls).toEqual([]);
  });

  it('fails without moving :main when the pushed tag answers anonymous reads', async () => {
    registry.anonymousToken = true;
    registry.manifests[`sha-${COMMIT}`] = 200;
    const { code, out, calls } = await ghcr(['push', '--private', 'img:local', REPO, COMMIT]);
    expect(code).toBe(1);
    expect(out).toContain('make the');
    expect(calls.some((c) => c.args[0] === 'push')).toBe(true);
    expect(calls.some((c) => c.args.includes('imagetools'))).toBe(false);
  });

  it('skips the anonymous checks without --private (the oss image)', async () => {
    const { code, calls } = await ghcr(['push', 'img:oss', 'ghcr.io/draggable/openrows', COMMIT]);
    expect(code).toBe(0);
    expect(registry.seen.some((s) => s.path.includes('/manifests/'))).toBe(false);
    expect(calls.some((c) => c.args[0] === 'push')).toBe(true);
  });

  it('needs GH_TOKEN', async () => {
    const { code, out, calls } = await run(script, ['push', 'img:oss', REPO, COMMIT]);
    expect(code).toBe(2);
    expect(out).toContain('set GH_TOKEN');
    expect(calls).toEqual([]);
  });
});

describe('docker/ghcr.sh pull', () => {
  it('pulls sha-<commit>, checks its revision label and tags it locally', async () => {
    const { code, out, calls } = await ghcr(['pull', REPO, COMMIT, `openrows:sha-${COMMIT}`], {
      FAKE_REVISION: COMMIT,
    });
    expect(code, out).toBe(0);
    const sha = `${REPO}:sha-${COMMIT}`;
    expect(calls.map((c) => c.args)).toEqual([
      ['login', 'ghcr.io', '-u', 'ci-bot', '--password-stdin'],
      ['pull', '--quiet', sha],
      [
        'image',
        'inspect',
        '--format',
        '{{index .Config.Labels "org.opencontainers.image.revision"}}',
        sha,
      ],
      ['tag', sha, `openrows:sha-${COMMIT}`],
      ['image', 'rm', sha],
    ]);
    expect(calls[0]?.stdin).toBe(`${TOKEN}\n`);
    expect(existsSync(calls[0]?.config ?? '/')).toBe(false);
  });

  it('refuses an image built from another commit', async () => {
    const { code, out, calls } = await ghcr(['pull', REPO, COMMIT, `openrows:sha-${COMMIT}`], {
      FAKE_REVISION: OTHER,
    });
    expect(code).toBe(1);
    expect(out).toContain(`was built from ${OTHER}`);
    expect(calls.some((c) => c.args[0] === 'tag')).toBe(false);
  });

  it('gives up after 3 refused pulls', async () => {
    const { code, out, calls } = await ghcr(['pull', REPO, COMMIT, `openrows:sha-${COMMIT}`], {
      FAKE_PULL_FAIL: '1',
      GHCR_RETRY_DELAY: '0',
    });
    expect(code).toBe(1);
    expect(out).toContain('could not pull');
    expect(calls.filter((c) => c.args[0] === 'pull')).toHaveLength(3);
  }, 30_000);
});
