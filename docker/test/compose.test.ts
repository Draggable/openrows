import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  baseEnv,
  CI,
  CI_ID,
  composeArgs,
  composeAvailable,
  DEV,
  dockerContext,
  dockerStages,
  filesUnder,
  PINNED,
  render,
  root,
  type StackDef,
  seconds,
  stackTests,
  stageClosure,
} from './compose-helpers.js';

// `docker compose config` assertions for the dev stack, CI's smoke stack and a self-hoster's
// production stack (selfhost.yml), rendered with the committed env templates, plus the Dockerfile
// and docker/compose.sh. Runs wherever
// the Docker CLI with Compose v2 is installed (no daemon needed); in CI a missing Compose fails
// the run instead of skipping it.

const DEV_SERVICES = [
  'airtable-fake',
  'api',
  'keycloak',
  'mailpit',
  'migrate',
  'net',
  'postgres',
  's3',
  'webhook-receiver',
  'worker',
];

describe.skipIf(!composeAvailable)('docker compose config of the dev stack (#14)', () => {
  stackTests({
    name: 'dev',
    stack: DEV,
    image: 'openrows:local',
    ownImages: ['openrows:local'],
    // The dev stack runs the core's entry points (the Dockerfile's default target).
    api: ['node', 'dist/index.js'],
    worker: ['node', 'dist/worker.js'],
    edition: undefined,
    services: DEV_SERVICES,
    nodeEnv: 'development',
    // Every host port, all on 127.0.0.1 and all on `net` (the others share its namespace).
    ports: {
      '8180': 3000,
      '8080': 8080,
      '8025': 8025,
      '1025': 1025,
      '9000': 9000,
      '5432': 5432,
      '6379': 6379,
      '8190': 8190,
    },
    publisher: () => 'net',
  });

  it('dev: one shared network namespace, and the service names resolve to 127.0.0.1 in it', () => {
    const { services } = render(DEV, { profiles: ['valkey'] });
    for (const [name, svc] of Object.entries(services)) {
      if (name === 'net') continue;
      expect(svc.network_mode, name).toBe('service:net');
    }
    const net = services['net'];
    const hosts = Array.isArray(net?.extra_hosts)
      ? net.extra_hosts.map((h) => h.replace('=', ':'))
      : Object.entries(net?.extra_hosts ?? {}).map(([h, ip]) => `${h}:${ip}`);
    expect(hosts.sort()).toEqual(
      ['airtable-fake', 'keycloak', 'mailpit', 'postgres', 's3', 'valkey', 'webhook-receiver'].map(
        (h) => `${h}:127.0.0.1`
      )
    );
    // Every hostname the app's URLs use is one of them.
    const env = services['api']?.environment ?? {};
    for (const key of ['DATABASE_URL', 'S3_ENDPOINT']) {
      expect(hosts, key).toContain(`${new URL(env[key] ?? '').hostname}:127.0.0.1`);
    }
    expect(hosts).toContain(`${env['SMTP_HOST']}:127.0.0.1`);
  });

  it('dev: the app at http://localhost:8180, signing in through the dev realm on localhost:8080', () => {
    const { services } = render(DEV);
    const api = services['api']?.environment ?? {};
    const keycloak = services['keycloak'];
    expect(api['APP_URL']).toBe('http://localhost:8180');
    expect(api['OIDC_ISSUER_URL']).toBe(
      `${keycloak?.environment?.['KC_HOSTNAME']}/realms/openrows`
    );
    expect(api['OIDC_CLIENT_ID']).toBe('openrows-app');
    expect(services['api']?.depends_on?.['s3']?.condition).toBe('service_healthy');

    // The realm export accepts this stack's callback and secret.
    const realm = JSON.parse(
      readFileSync(resolve(root, 'docker/keycloak/openrows-realm.json'), 'utf8')
    ) as {
      realm: string;
      clients: { clientId: string; secret?: string; redirectUris: string[] }[];
    };
    const client = realm.clients.find((c) => c.clientId === api['OIDC_CLIENT_ID']);
    expect(client?.redirectUris).toContain(`${api['APP_URL']}/auth/callback`);
    expect(client?.secret).toBe(api['OIDC_CLIENT_SECRET']);

    expect(keycloak?.command).toEqual(['start-dev', '--import-realm']);
    expect(keycloak?.volumes).toEqual([
      expect.objectContaining({
        type: 'bind',
        source: resolve(root, 'docker/keycloak/openrows-realm.json'),
        target: '/opt/keycloak/data/import/openrows-realm.json',
        read_only: true,
      }),
      // the customer's identity provider for workspace single sign-on (dev and CI only).
      expect.objectContaining({
        type: 'bind',
        source: resolve(root, 'docker/keycloak/customer-realm.json'),
        target: '/opt/keycloak/data/import/customer-realm.json',
        read_only: true,
      }),
      // the rose sign-in and email theme.
      expect.objectContaining({
        type: 'bind',
        source: resolve(root, 'docker/keycloak/themes/openrows'),
        target: '/opt/keycloak/themes/openrows',
        read_only: true,
      }),
    ]);
    // Its management port moves off 9000, which the S3 server holds in the shared namespace.
    expect(keycloak?.environment?.['KC_HTTP_MANAGEMENT_PORT']).toBe('9990');
    expect(keycloak?.healthcheck?.test.join(' ')).toContain('/dev/tcp/127.0.0.1/9990');
    expect(services['s3']?.environment?.['S3_BUCKET']).toBe(api['S3_BUCKET']);
    expect(services['s3']?.environment?.['ROOT_ACCESS_KEY']).toBe(api['S3_ACCESS_KEY']);
  });
});

/** Placeholders for what the self-host template leaves empty. */
const SELFHOST_SECRETS = {
  PG_PASSWORD: 'placeholder-pg',
  OPENROWS_APP_DB_PASSWORD: 'placeholder-app',
  APP_URL: 'https://openrows.example.org',
  ENCRYPTION_KEY: 'placeholder-encryption-key-0123456789abcdef',
  OIDC_ISSUER_URL: 'https://auth.example.org/realms/openrows',
  OIDC_CLIENT_SECRET: 'placeholder-oidc',
  S3_ENDPOINT: 'https://s3.example.org',
  S3_BUCKET: 'openrows',
  S3_ACCESS_KEY: 'placeholder-s3-access',
  S3_SECRET_KEY: 'placeholder-s3-secret',
};
const SELFHOST: StackDef = {
  project: 'openrows',
  envFile: 'docker/.env.selfhost.example',
  files: ['compose', 'selfhost'],
  env: SELFHOST_SECRETS,
};

describe.skipIf(!composeAvailable)(
  "docker compose config of a self-hoster's stack (selfhost.yml)",
  () => {
    stackTests({
      name: 'selfhost',
      stack: SELFHOST,
      image: 'openrows:local',
      ownImages: ['openrows:local'],
      api: ['node', 'dist/index.js'],
      worker: ['node', 'dist/worker.js'],
      edition: undefined,
      services: ['api', 'migrate', 'postgres', 'worker'],
      nodeEnv: 'production',
      ports: { '3000': 3000 },
      publisher: () => 'api',
    });

    it('selfhost: Compose refuses to start while a required value is empty in the env file', () => {
      for (const name of Object.keys(SELFHOST_SECRETS)) {
        const result = spawnSync('docker', composeArgs(SELFHOST, []), {
          cwd: root,
          encoding: 'utf8',
          env: baseEnv({ ...SELFHOST_SECRETS, [name]: '' }),
        });
        expect(result.status, name).not.toBe(0);
        expect(result.stderr, name).toContain(`required variable ${name} is missing a value`);
      }
    });

    it('selfhost: the template commits no secret', () => {
      const lines = readFileSync(resolve(root, 'docker/.env.selfhost.example'), 'utf8').split('\n');
      const values = Object.fromEntries(
        lines.filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => l.split(/=(.*)/s).slice(0, 2))
      ) as Record<string, string>;
      for (const name of [
        ...Object.keys(SELFHOST_SECRETS).filter((k) => k.includes('PASSWORD') || k.includes('KEY')),
        'SMTP_PASSWORD',
        'KC_DB_PASSWORD',
        'KC_BOOTSTRAP_ADMIN_PASSWORD',
        'OIDC_ADMIN_CLIENT_SECRET',
        'TURNSTILE_SECRET_KEY',
        'VALKEY_PASSWORD',
      ]) {
        expect(values[name], name).toBe('');
      }
    });

    it('selfhost: the keycloak and clamav profiles, Keycloak on loopback with the production realm', () => {
      const { services } = render(SELFHOST, { profiles: ['keycloak', 'clamav'] });
      expect(Object.keys(services).sort()).toEqual(
        ['api', 'clamav', 'keycloak', 'keycloak-db', 'migrate', 'postgres', 'worker'].sort()
      );
      const kc = services['keycloak'];
      expect(kc?.command).toEqual(['start', '--import-realm']);
      expect(kc?.ports).toEqual([
        expect.objectContaining({ host_ip: '127.0.0.1', published: '8080', target: 8080 }),
      ]);
      expect(kc?.volumes?.map((v) => v.source)).toEqual([
        resolve(root, 'docker/keycloak/openrows-realm.prod.json'),
        resolve(root, 'docker/keycloak/themes/openrows'),
      ]);
      expect(services['keycloak-db']?.volumes?.[0]?.source).toBe(
        resolve(root, 'docker/keycloak/init-db.sh')
      );
      expect(services['clamav']?.ports ?? []).toEqual([]);
      for (const name of ['api', 'worker']) {
        expect(services[name]?.environment?.['CLAMAV_URL'], name).toBe('');
      }
    });
  }
);

describe.skipIf(!composeAvailable)(
  "docker compose config for CI's smoke stack (docker/ci.yml, #8)",
  () => {
    const ALL = ['e2e', 'valkey'];
    const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string }>;
    };

    it('is the dev stack plus the e2e service (profile e2e), in project openrows-ci-<id>', () => {
      const cfg = render(CI);
      expect(cfg.name).toBe(`openrows-ci-${CI_ID}`);
      expect(Object.keys(cfg.services).sort()).toEqual([...DEV_SERVICES]);
      expect(Object.keys(render(CI, { profiles: ALL }).services).sort()).toEqual(
        [...DEV_SERVICES, 'e2e', 'valkey'].sort()
      );
      expect(cfg.services['api']?.image).toBe('openrows:local');
      expect(render(CI, { extraEnv: { IMAGE: 'openrows:ci-1-1' } }).services['api']?.image).toBe(
        'openrows:ci-1-1'
      );
    });

    it("raises the api's /auth rate limit: a shard's specs all sign in from one IP (#91)", () => {
      expect(render(CI).services['api']?.environment?.['AUTH_RATE_LIMIT']).toBe('300');
      expect(render(DEV).services['api']?.environment?.['AUTH_RATE_LIMIT']).toBe('30');
    });

    it('publishes no host port at all, so it never clashes with another run or service', () => {
      for (const [name, svc] of Object.entries(render(CI, { profiles: ALL }).services)) {
        expect(svc.ports ?? [], name).toEqual([]);
      }
    });

    it("runs every service, Playwright included, in net's namespace", () => {
      const { services } = render(CI, { profiles: ALL });
      for (const [name, svc] of Object.entries(services)) {
        if (name === 'net') continue;
        expect(svc.network_mode, name).toBe('service:net');
      }
      expect(services['net']?.extra_hosts).toEqual(
        render(DEV, { profiles: ['valkey'] }).services['net']?.extra_hosts
      );
    });

    it('serves the app on APP_URL inside the namespace, where the browser and the realm expect it', () => {
      const { services } = render(CI, { profiles: ['e2e'] });
      const api = services['api']?.environment ?? {};
      const appUrl = new URL(api['APP_URL'] ?? '');
      expect(api['PORT']).toBe(appUrl.port);
      expect(services['api']?.healthcheck?.test.join(' ')).toContain(
        `http://127.0.0.1:${api['PORT']}/ready`
      );
      expect(services['e2e']?.environment?.['E2E_BASE_URL']).toBe(api['APP_URL']);
      // The same issuer and realm client as dev.
      expect(api['OIDC_ISSUER_URL']).toBe(
        render(DEV).services['api']?.environment?.['OIDC_ISSUER_URL']
      );
      const realm = JSON.parse(
        readFileSync(resolve(root, 'docker/keycloak/openrows-realm.json'), 'utf8')
      ) as { clients: { clientId: string; redirectUris: string[] }[] };
      const client = realm.clients.find((c) => c.clientId === api['OIDC_CLIENT_ID']);
      expect(client?.redirectUris).toContain(`${api['APP_URL']}/auth/callback`);
    });

    it("e2e: the pinned Playwright image of package-lock's version, as the runner's user, on the checkout", () => {
      const e2e = render(CI, {
        profiles: ['e2e'],
        extraEnv: { E2E_UID: '1234', E2E_GID: '5678' },
      }).services['e2e'];
      const version = lock.packages['node_modules/@playwright/test']?.version;
      expect(version).toBeTruthy();
      expect(e2e?.image).toMatch(PINNED);
      expect(e2e?.image).toMatch(new RegExp(`^mcr\\.microsoft\\.com/playwright:v${version}-`));
      expect(lock.packages['node_modules/playwright-core']?.version).toBe(version);
      expect(e2e?.user).toBe('1234:5678');
      expect(e2e?.volumes).toEqual([
        expect.objectContaining({ type: 'bind', source: root, target: '/work' }),
      ]);
      expect(e2e?.environment).toMatchObject({ CI: 'true', HOME: '/tmp', E2E_STACK: '1' });
      expect(e2e?.command).toEqual(['npx', '--no-install', 'playwright', 'test']);
      expect(e2e?.depends_on?.['api']?.condition).toBe('service_healthy');
      expect(e2e?.depends_on?.['keycloak']?.condition).toBe('service_healthy');
    });

    it("gives Keycloak a slow-host start budget inside the smoke job's --wait-timeout, dev unchanged", () => {
      const ci = render(CI).services['keycloak']?.healthcheck;
      const dev = render(DEV).services['keycloak']?.healthcheck;
      // Dev keeps its quick verdict; only the ci overlay stretches it.
      expect(dev).toMatchObject({ interval: '5s', retries: 30, start_period: '30s' });
      expect(dev?.start_interval).toBeUndefined();
      expect(ci?.test).toEqual(dev?.test);
      // Probed every 5s during the grace period, so it still turns healthy promptly.
      expect(seconds(ci?.start_interval)).toBe(5);
      // Took over 3 minutes on a busy shared daemon once: at least 8 minutes before it can be
      // unhealthy.
      const budget =
        seconds(ci?.start_period) +
        seconds(ci?.interval) * (ci?.retries ?? 0) +
        seconds(ci?.timeout);
      expect(seconds(ci?.start_period)).toBeGreaterThanOrEqual(8 * 60);
      // The smoke job waits longer than that, so a failure is the healthcheck's verdict, and its
      // timeout-minutes leaves room for the build, npm ci, Playwright and the teardown.
      const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
      const smoke = workflow.slice(workflow.indexOf('\n  smoke:'), workflow.indexOf('\n  docker:'));
      const wait = Number(/compose\.sh ci up -d --wait --wait-timeout (\d+) /.exec(smoke)?.[1]);
      const jobMinutes = Number(/timeout-minutes: (\d+)/.exec(smoke)?.[1]);
      expect(wait).toBeGreaterThan(budget);
      expect(jobMinutes * 60).toBeGreaterThanOrEqual(wait + 20 * 60);
    });

    it("pins every third-party image and rotates every service's logs", () => {
      for (const [name, svc] of Object.entries(render(CI, { profiles: ALL }).services)) {
        if (svc.image !== 'openrows:local') expect(svc.image, name).toMatch(PINNED);
        expect(svc.logging?.options?.['max-size'], name).toBe('20m');
      }
    });
  }
);

describe('docker/Dockerfile', () => {
  const text = readFileSync(resolve(root, 'docker/Dockerfile'), 'utf8');

  const stages = dockerStages(text);

  it('builds the image FROM one digest-pinned Node 22 image only (or an earlier stage)', () => {
    const arg = /^ARG NODE_IMAGE=(\S+)$/m.exec(text)?.[1];
    expect(arg).toMatch(PINNED);
    expect(arg).toMatch(/^node:22\.\d+\.\d+-bookworm-slim@/);
    expect(stages.length).toBeGreaterThan(0);
    const closure = stageClosure(stages, 'oss');
    stages.forEach((stage, i) => {
      if (!closure.has(stage.name)) return;
      const earlier = stages.slice(0, i).map((s) => s.name);
      expect(stage.from === `\${NODE_IMAGE}` || earlier.includes(stage.from), stage.name).toBe(
        true
      );
    });
  });

  // A COPY of a path .dockerignore leaves out fails the build ("not found"), which only the smoke
  // job's image builds would otherwise catch.
  it('every COPY source is in the build context', () => {
    const context = dockerContext();
    for (const stage of stages) {
      for (const line of stage.lines) {
        if (!/^COPY\s/i.test(line) || /--from=/.test(line)) continue;
        const sources = line
          .split(/\s+/)
          .slice(1, -1)
          .filter((arg) => !arg.startsWith('--'));
        for (const source of sources) {
          const path = source.replace(/\/$/, '');
          expect(existsSync(resolve(root, path)), `${stage.name}: ${source} is missing`).toBe(true);
          const files = filesUnder(path);
          expect(files.some(context), `${stage.name}: COPY ${source}`).toBe(true);
          if (!statSync(resolve(root, path)).isDirectory()) {
            expect(context(path), `${stage.name}: COPY ${source}`).toBe(true);
          }
        }
      }
    }
  });

  it('runs node directly as PID 1, as the non-root node user, with the client and migrations', () => {
    for (const name of ['oss']) {
      const lines = stages.find((s) => s.name === name)?.lines ?? [];
      expect(lines, name).toContain('USER node');
      expect(lines.join('\n'), name).toContain('CLIENT_DIR=/app/packages/client/dist');
      expect(lines, name).toContain(
        'COPY --from=build /app/packages/server/drizzle packages/server/drizzle'
      );
    }
    expect(stages.find((s) => s.name === 'oss')?.lines).toContain('CMD ["node", "dist/index.js"]');
  });

  it('the default target, the last stage, is the open-source image: oss from build and deps', () => {
    expect(stages.at(-1)?.name).toBe('oss');
    expect([...stageClosure(stages, 'oss')].sort()).toEqual(['build', 'deps', 'oss']);
  });
});

describe.skipIf(!composeAvailable)('docker/compose.sh', () => {
  const run = (cmd: string, args: string[], env: Record<string, string> = {}, cwd = root) =>
    spawnSync(cmd, args, { cwd, encoding: 'utf8', env: baseEnv(env) });

  it('accepts only its environments (there is no staging)', () => {
    for (const env of ['staging', '']) {
      const result = run('docker/compose.sh', env ? [env, 'config'] : []);
      expect(result.status, env).toBe(2);
      expect(result.stderr).toContain('usage: docker/compose.sh <dev|');
    }
  });

  it('dev renders the same config as the tests, from the example env file when there is no .env.dev', () => {
    const result = run('docker/compose.sh', ['dev', 'config', '--format', 'json'], {
      OPENROWS_ENV_FILE: resolve(root, 'docker/.env.dev.example'),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(render(DEV));
  });

  it('ci: a project per OPENROWS_CI_ID, always from the dev template, the same config as the tests', () => {
    const missing = run('docker/compose.sh', ['ci', 'config']);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('set OPENROWS_CI_ID');
    const bad = run('docker/compose.sh', ['ci', 'config'], { OPENROWS_CI_ID: 'Run 1' });
    expect(bad.status).toBe(2);

    const result = run(
      'docker/compose.sh',
      ['ci', '--profile', 'e2e', 'config', '--format', 'json'],
      {
        OPENROWS_CI_ID: CI_ID,
      }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(render(CI, { profiles: ['e2e'] }));
  });
});
