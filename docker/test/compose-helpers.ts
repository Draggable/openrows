import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// Shared by the Compose and Dockerfile tests (compose.test.ts; the hosted overlay adds its own
// for the prod environment): `docker compose config` renders of a stack, and the Dockerfile's
// stages and build context. Not a test file itself.
export const root = resolve(import.meta.dirname, '..', '..');

function hasCompose(): boolean {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
export const composeAvailable = hasCompose();
if (!composeAvailable && process.env['CI']) {
  throw new Error('docker compose is required in CI for the docker/test Compose tests');
}

export type Port = { host_ip?: string; target: number; published: string };
export interface Service {
  image: string;
  command?: string[];
  entrypoint?: string[];
  ports?: Port[];
  environment?: Record<string, string>;
  depends_on?: Record<string, { condition: string }>;
  healthcheck?: {
    test: string[];
    interval?: string;
    timeout?: string;
    retries?: number;
    start_period?: string;
    start_interval?: string;
  };
  build?: { context?: string; dockerfile?: string; target?: string };
  volumes?: { type: string; source: string; target: string; read_only?: boolean }[];
  logging?: { driver: string; options?: Record<string, string> };
  network_mode?: string;
  extra_hosts?: string[] | Record<string, string>;
  profiles?: string[];
  user?: string;
}
export interface Rendered {
  name: string;
  services: Record<string, Service>;
}

/** One Compose stack as compose.sh runs it: project, env file, base file and overlays. */
export interface StackDef {
  project: string;
  envFile: string;
  files: string[];
  /** Values the shell supplies (they win over the env file), e.g. a template's empty secrets. */
  env?: Record<string, string>;
}

export const CI_ID = 'test-1';
export const DEV: StackDef = {
  project: 'openrows-dev',
  envFile: 'docker/.env.dev.example',
  files: ['compose', 'dev'],
};
/** CI's smoke stack (docker/ci.yml): the dev stack plus the ci overlay, a project per run. */
export const CI: StackDef = {
  project: `openrows-ci-${CI_ID}`,
  envFile: 'docker/.env.dev.example',
  files: ['compose', 'dev', 'ci'],
};

/** Only what the Docker CLI needs: a developer's own COMPOSE_PROFILES or IMAGE must not leak in. */
export function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT'];
  return {
    ...Object.fromEntries(keep.flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : []))),
    // Git (here and in the scripts) ignores the host's global and system config, so a runner
    // with commit signing or other settings enabled can't change what the tests do.
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    ...extra,
  };
}

export function composeArgs(stack: StackDef, profiles: string[]): string[] {
  return [
    'compose',
    ...profiles.flatMap((p) => ['--profile', p]),
    '--project-name',
    stack.project,
    '--env-file',
    stack.envFile,
    ...stack.files.flatMap((f) => ['-f', `docker/${f}.yml`]),
    'config',
    '--format',
    'json',
  ];
}

export function render(
  stack: StackDef,
  opts: { profiles?: string[]; extraEnv?: Record<string, string> } = {}
): Rendered {
  const out = execFileSync('docker', composeArgs(stack, opts.profiles ?? []), {
    cwd: root,
    stdio: 'pipe',
    env: baseEnv({ ...stack.env, ...opts.extraEnv }),
  });
  return JSON.parse(out.toString()) as Rendered;
}

/** A Compose duration as rendered (`8m0s`, `10s`, `1h0m0s`) in seconds; absent is 0. */
export function seconds(duration: string | undefined): number {
  const units: Record<string, number> = { h: 3600, m: 60, s: 1 };
  let total = 0;
  for (const [, n, unit] of (duration ?? '').matchAll(/(\d+)([hms])/g)) {
    total += Number(n) * (units[unit ?? 's'] ?? 0);
  }
  return total;
}

export const PINNED = /^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/;
export const APP_SERVICES = ['migrate', 'api', 'worker'] as const;

/** What one environment's stack must look like (stackTests). */
export interface StackExpectation {
  name: string;
  stack: StackDef;
  image: string;
  /** Our own images, which aren't pinned by digest. */
  ownImages: string[];
  api: string[];
  worker: string[];
  edition: string | undefined;
  services: string[];
  nodeEnv: string;
  /** Every published host port → its container port. */
  ports: Record<string, number>;
  /** Which service may publish a host port. */
  publisher: (port: string) => string | undefined;
}

/** The checks every environment's stack passes. */
export function stackTests(x: StackExpectation) {
  const { name, stack } = x;
  it(`${name}: project ${stack.project}, one image for migrate/api/worker, migrate before both`, () => {
    const cfg = render(stack);
    expect(cfg.name).toBe(stack.project);
    const { api, worker, migrate, postgres } = cfg.services as Record<string, Service>;

    expect(api?.image).toBe(x.image);
    expect(worker?.image).toBe(api?.image);
    expect(migrate?.image).toBe(api?.image);
    expect(migrate?.build?.dockerfile).toBe('docker/Dockerfile');
    expect(api?.command).toEqual(x.api);
    expect(worker?.command).toEqual(x.worker);
    expect(api?.environment?.['EDITION']).toBe(x.edition);
    expect(worker?.environment?.['EDITION']).toBe(x.edition);
    expect(migrate?.command).toEqual(['node', 'dist/migrate.js']);

    expect(migrate?.depends_on?.['postgres']?.condition).toBe('service_healthy');
    expect(api?.depends_on?.['migrate']?.condition).toBe('service_completed_successfully');
    expect(worker?.depends_on?.['migrate']?.condition).toBe('service_completed_successfully');
    expect(api?.healthcheck?.test.join(' ')).toContain('http://127.0.0.1:3000/ready');
    expect(api?.healthcheck?.start_period).toBe('30s');
    expect(postgres?.healthcheck?.test.join(' ')).toContain('pg_isready');
    // The worker's /health: pg-boss runs and Postgres answers.
    expect(worker?.healthcheck?.test.join(' ')).toContain('http://127.0.0.1:3001/health');
    expect(worker?.environment?.['WORKER_PORT']).toBe('3001');

    for (const service of APP_SERVICES) {
      expect(cfg.services[service]?.environment?.['NODE_ENV'], service).toBe(x.nodeEnv);
    }
  });
  it(`${name}: migrate connects as the superuser, api and worker as openrows_app (ADR-002)`, () => {
    const { services } = render(stack);
    const pg = services['postgres']?.environment ?? {};
    const appPassword = services['migrate']?.environment?.['OPENROWS_APP_DB_PASSWORD'];
    expect(appPassword).toBeTruthy();
    expect(appPassword).not.toBe(pg['POSTGRES_PASSWORD']);
    expect(services['migrate']?.environment?.['MIGRATION_DATABASE_URL']).toBe(
      `postgresql://${pg['POSTGRES_USER']}:${pg['POSTGRES_PASSWORD']}@postgres:5432/${pg['POSTGRES_DB']}`
    );
    const appUrl = `postgresql://openrows_app:${appPassword}@postgres:5432/${pg['POSTGRES_DB']}`;
    expect(services['api']?.environment?.['DATABASE_URL']).toBe(appUrl);
    expect(services['worker']?.environment?.['DATABASE_URL']).toBe(appUrl);
  });

  it(`${name}: only the worker gets the owner connection, for field index builds (#72)`, () => {
    const { services } = render(stack);
    const pg = services['postgres']?.environment ?? {};
    expect(services['worker']?.environment?.['INDEX_DATABASE_URL']).toBe(
      `postgresql://${pg['POSTGRES_USER']}:${pg['POSTGRES_PASSWORD']}@postgres:5432/${pg['POSTGRES_DB']}`
    );
    expect(services['api']?.environment?.['INDEX_DATABASE_URL']).toBeUndefined();
  });

  it(`${name}: the env file's Turnstile keys reach the api (#101, #171)`, () => {
    const { services } = render(stack, {
      extraEnv: {
        TURNSTILE_SECRET_KEY: 'placeholder-ts-secret',
        TURNSTILE_SITE_KEY: 'placeholder-ts-site',
      },
    });
    const api = services['api']?.environment ?? {};
    expect(api['TURNSTILE_SECRET_KEY']).toBe('placeholder-ts-secret');
    expect(api['TURNSTILE_SITE_KEY']).toBe('placeholder-ts-site');
  });

  it(`${name}: the worker decrypts webhook secrets with the api's key and links to its URL (#107)`, () => {
    const { services } = render(stack);
    const api = services['api']?.environment ?? {};
    const worker = services['worker']?.environment ?? {};
    expect(worker['ENCRYPTION_KEY']).toBeTruthy();
    expect(worker['ENCRYPTION_KEY']).toBe(api['ENCRYPTION_KEY']);
    expect(worker['APP_URL']).toBe(api['APP_URL']);
    for (const key of [
      'SMTP_HOST',
      'SMTP_FROM',
      'OUTBOUND_HTTP_ALLOW',
      'OUTBOUND_HTTP_DENY',
      'AI_MODEL',
      'AI_ALLOWED_HOSTS',
      'AUTOMATION_EMAIL_DAILY_LIMIT',
      'OUTBOUND_WORKSPACE_RATE_PER_MINUTE',
      'OUTBOUND_WORKSPACE_CONCURRENCY',
    ]) {
      expect(worker[key], key).toBe(api[key]);
    }
  });

  it(`${name}: services ${x.services.join(', ')}, plus valkey only with its profile`, () => {
    expect(Object.keys(render(stack).services).sort()).toEqual([...x.services]);
    const withValkey = render(stack, { profiles: ['valkey'] });
    expect(Object.keys(withValkey.services).sort()).toEqual([...x.services, 'valkey'].sort());
  });

  it(`${name}: host ports only on 127.0.0.1, exactly ${Object.keys(x.ports).join(', ')}`, () => {
    const { services } = render(stack, { profiles: ['valkey'] });
    const published: Record<string, number> = {};
    for (const [service, svc] of Object.entries(services)) {
      for (const port of svc.ports ?? []) {
        expect(port.host_ip, `${service} ${port.published}`).toBe('127.0.0.1');
        published[port.published] = port.target;
        expect(service, `${port.published} is published by`).toBe(x.publisher(port.published));
      }
    }
    expect(published).toEqual(x.ports);
  });

  it(`${name}: every third-party image is pinned by digest, one digest per image`, () => {
    const { services } = render(stack, { profiles: ['valkey'] });
    const byRepo = new Map<string, Set<string>>();
    for (const [service, svc] of Object.entries(services)) {
      if (x.ownImages.includes(svc.image)) continue;
      expect(svc.image, service).toMatch(PINNED);
      const repo = svc.image.split(':')[0] ?? '';
      byRepo.set(repo, (byRepo.get(repo) ?? new Set()).add(svc.image));
    }
    for (const [repo, images] of byRepo) expect(images.size, repo).toBe(1);
  });

  it(`${name}: every service rotates its json-file logs (10 × 20 MB, compressed)`, () => {
    const { services } = render(stack, { profiles: ['valkey'] });
    for (const [name, svc] of Object.entries(services)) {
      expect(svc.logging, name).toEqual({
        driver: 'json-file',
        options: { 'max-size': '20m', 'max-file': '10', compress: 'true' },
      });
    }
  });
}

export interface Stage {
  name: string;
  from: string;
  lines: string[];
}

/** The Dockerfile's stages, with continuation lines joined. */
export function dockerStages(text: string): Stage[] {
  const lines = text
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const stages: Stage[] = [];
  for (const line of lines) {
    const from = /^FROM\s+(\S+)\s+AS\s+(\S+)$/i.exec(line);
    if (from?.[1] && from[2]) stages.push({ name: from[2], from: from[1], lines: [] });
    else stages.at(-1)?.lines.push(line);
  }
  return stages;
}

/**
 * Whether a repo-relative file is in docker/Dockerfile's build context: .dockerignore's rules as
 * BuildKit applies them (the last pattern matching the path or one of its parent directories
 * wins; `*` and `?` stay within a path segment, `**` spans any number of them).
 */
export function dockerContext(): (file: string) => boolean {
  const rules = readFileSync(resolve(root, '.dockerignore'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const negated = l.startsWith('!');
      const pattern = (negated ? l.slice(1) : l).replace(/^\/+|\/+$/g, '');
      const segments = pattern.split('/');
      const source = segments
        .map((segment, i) => {
          const last = i === segments.length - 1;
          if (segment === '**') return last ? '.*' : '(?:.*/)?';
          const glob = segment
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '[^/]*')
            .replace(/\?/g, '[^/]');
          return last ? glob : `${glob}/`;
        })
        .join('')
        .replace(/\/\.\*$/, '(?:/.*)?');
      return { negated, regex: new RegExp(`^${source}$`) };
    });
  return (file) => {
    const parts = file.split('/');
    const paths = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
    let included = true;
    for (const rule of rules) {
      if (paths.some((p) => rule.regex.test(p))) included = rule.negated;
    }
    return included;
  };
}

/** The repo-relative files at or under `path`, without node_modules and build outputs. */
export function filesUnder(path: string): string[] {
  const full = resolve(root, path);
  if (!statSync(full).isDirectory()) return [path];
  return readdirSync(full, { withFileTypes: true })
    .filter((e) => !['node_modules', 'dist', 'coverage'].includes(e.name))
    .flatMap((e) => (e.isDirectory() || e.isFile() ? filesUnder(`${path}/${e.name}`) : []));
}

/** The stages `target` is built from: its FROM chain and every COPY --from, transitively. */
export function stageClosure(stages: Stage[], target: string): Set<string> {
  const seen = new Set<string>();
  const visit = (name: string) => {
    const stage = stages.find((s) => s.name === name);
    if (!stage || seen.has(name)) return;
    seen.add(name);
    visit(stage.from);
    for (const line of stage.lines) {
      const from = /--from=(\S+)/.exec(line)?.[1];
      if (from) visit(from);
    }
  };
  visit(target);
  return seen;
}
