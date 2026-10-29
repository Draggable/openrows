import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';

// The Helm chart (deploy/helm/openrows): `helm lint --strict`, `helm template` against
// golden files per values file (UPDATE_GOLDEN=1 rewrites them), the values schema's and the
// templates' refusals, and the hardening every pod must keep. Needs the pinned Helm
// (deploy/helm/install-tools.sh; HELM=<path> or `helm` on PATH); in CI a missing Helm fails the
// run instead of skipping it. The install itself is CI's kind smoke test (test/kind-smoke.sh).
const root = resolve(import.meta.dirname, '..', '..', '..');
const chart = resolve(root, 'deploy/helm/openrows');
const valuesDir = resolve(import.meta.dirname, 'values');
const goldenDir = resolve(import.meta.dirname, 'golden');
const helm = process.env['HELM'] ?? 'helm';

function hasHelm(): boolean {
  try {
    execFileSync(helm, ['version', '--short'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
const helmAvailable = hasHelm();
if (!helmAvailable && process.env['CI']) {
  throw new Error('helm is required in CI for deploy/helm/test/chart.test.ts');
}

const RELEASE = ['openrows', chart, '--namespace', 'openrows'];

function template(args: string[]): string {
  return execFileSync(helm, ['template', ...RELEASE, ...args], { encoding: 'utf8', stdio: 'pipe' });
}

function templateError(args: string[]): string {
  const r = spawnSync(helm, ['template', ...RELEASE, ...args], { encoding: 'utf8' });
  expect(r.status, r.stdout).not.toBe(0);
  return r.stderr;
}

const valuesFile = (name: string) => join(valuesDir, `${name}.yaml`);

interface Container {
  name: string;
  image: string;
  command?: string[];
  env?: { name: string; value?: string; valueFrom?: { secretKeyRef?: { key: string } } }[];
  securityContext?: Record<string, unknown>;
  resources?: { requests?: Record<string, string> };
  readinessProbe?: { httpGet?: { path: string } };
  livenessProbe?: { httpGet?: { path: string } };
}
interface PodSpec {
  securityContext?: Record<string, unknown>;
  initContainers?: Container[];
  containers: Container[];
  automountServiceAccountToken?: boolean;
}
interface Doc {
  kind: string;
  metadata: { name: string; annotations?: Record<string, string> };
  spec?: Record<string, unknown> & { template?: { spec: PodSpec } };
  data?: Record<string, string>;
}

function docs(text: string): Doc[] {
  return parseAllDocuments(text)
    .map((d) => d.toJS() as Doc | null)
    .filter((d): d is Doc => d !== null);
}

function podSpecs(all: Doc[]): [string, PodSpec][] {
  return all.flatMap((d): [string, PodSpec][] => {
    if (d.kind === 'Pod') return [[d.metadata.name, d.spec as unknown as PodSpec]];
    if (d.spec?.template) return [[d.metadata.name, d.spec.template.spec]];
    return [];
  });
}

function find(all: Doc[], kind: string, name: string): Doc {
  const d = all.find((x) => x.kind === kind && x.metadata.name === name);
  if (!d) throw new Error(`${kind}/${name} not rendered`);
  return d;
}

function container(all: Doc[], kind: string, name: string, c: string): Container {
  const spec = find(all, kind, name).spec?.template?.spec;
  if (!spec) throw new Error(`${name} has no pod template`);
  const found = [...(spec.initContainers ?? []), ...spec.containers].find((x) => x.name === c);
  if (!found) throw new Error(`${name}/${c} not rendered`);
  return found;
}

const GOLDEN: { name: string; args: string[] }[] = [
  { name: 'bundled', args: ['-f', valuesFile('bundled')] },
  { name: 'external', args: ['-f', valuesFile('external')] },
  // The same release on upgrade: the migrate Job becomes the pre-upgrade hook.
  { name: 'bundled-upgrade', args: ['-f', valuesFile('bundled'), '--is-upgrade'] },
];

describe.skipIf(!helmAvailable)('the Helm chart', () => {
  it('passes helm lint --strict with every test values file', () => {
    for (const file of readdirSync(valuesDir)) {
      const r = spawnSync(helm, ['lint', '--strict', chart, '-f', join(valuesDir, file)], {
        encoding: 'utf8',
      });
      expect(r.status, `${file}: ${r.stdout}${r.stderr}`).toBe(0);
    }
  });

  for (const { name, args } of GOLDEN) {
    it(`renders the golden output: ${name}`, () => {
      const out = template(args);
      const file = join(goldenDir, `${name}.yaml`);
      if (process.env['UPDATE_GOLDEN'] || !existsSync(file)) writeFileSync(file, out);
      expect(out).toBe(readFileSync(file, 'utf8'));
    });
  }

  it('renders the api, worker, migrate Job, bundled Postgres and Ingress, and never a Secret', () => {
    const all = docs(template(['-f', valuesFile('bundled')]));
    expect(all.map((d) => `${d.kind}/${d.metadata.name}`).sort()).toEqual([
      'ConfigMap/openrows',
      'Deployment/openrows-api',
      'Deployment/openrows-worker',
      'Ingress/openrows',
      'Job/openrows-migrate-1',
      'Pod/openrows-test-ready',
      'Service/openrows',
      'Service/openrows-postgresql',
      'ServiceAccount/openrows',
      'StatefulSet/openrows-postgresql',
    ]);
    const external = docs(template(['-f', valuesFile('external')]));
    expect(external.some((d) => d.metadata.name.includes('postgresql'))).toBe(false);
    expect(find(external, 'Deployment', 'openrows-valkey')).toBeTruthy();
    for (const d of [...all, ...external]) expect(d.kind).not.toBe('Secret');
  });

  it('hardens every pod: non-root, read-only root, no privilege escalation, requests', () => {
    for (const name of ['bundled', 'external']) {
      for (const [pod, spec] of podSpecs(docs(template(['-f', valuesFile(name)])))) {
        expect(spec.securityContext?.['runAsNonRoot'], pod).toBe(true);
        expect(spec.automountServiceAccountToken, pod).toBe(false);
        for (const c of [...(spec.initContainers ?? []), ...spec.containers]) {
          const where = `${pod}/${c.name}`;
          expect(c.securityContext?.['readOnlyRootFilesystem'], where).toBe(true);
          expect(c.securityContext?.['allowPrivilegeEscalation'], where).toBe(false);
          expect(c.securityContext?.['capabilities'], where).toEqual({ drop: ['ALL'] });
          expect(c.resources?.requests?.['memory'], where).toBeDefined();
          // Third-party images by digest; ours by the tag or digest the operator pinned.
          if (!c.image.includes('openrows'))
            expect(c.image, where).toMatch(/@sha256:[0-9a-f]{64}$/);
        }
      }
    }
  });

  it('probes the api on /health and /ready and the worker on /health', () => {
    const all = docs(template(['-f', valuesFile('bundled')]));
    const api = container(all, 'Deployment', 'openrows-api', 'api');
    expect(api.livenessProbe?.httpGet?.path).toBe('/health');
    expect(api.readinessProbe?.httpGet?.path).toBe('/ready');
    const worker = container(all, 'Deployment', 'openrows-worker', 'worker');
    expect(worker.livenessProbe?.httpGet?.path).toBe('/health');
    expect(worker.readinessProbe?.httpGet?.path).toBe('/health');
  });

  it('runs the OSS image, never the hosted edition', () => {
    const text = template(['-f', valuesFile('bundled')]);
    const all = docs(text);
    for (const [, spec] of podSpecs(all)) {
      for (const c of [...(spec.initContainers ?? []), ...spec.containers]) {
        if (c.image.includes('openrows')) {
          expect(c.image).toBe(
            'ghcr.io/draggable/openrows:sha-0123456789abcdef0123456789abcdef01234567'
          );
          expect(c.command?.join(' ') ?? '').not.toMatch(/ee\/|cloud/);
        }
      }
    }
    expect(text).not.toMatch(/EDITION|ee\/cloud|ee-cloud/);
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]
      );
    for (const file of files(chart)) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/\bee\/|@openrows\/ee-/);
    }
  });

  it('takes every secret from the existing Secret, never from a value', () => {
    for (const name of ['bundled', 'external']) {
      const all = docs(template(['-f', valuesFile(name)]));
      const config = find(all, 'ConfigMap', 'openrows').data ?? {};
      for (const key of Object.keys(config)) {
        expect(key).not.toMatch(/SECRET|PASSWORD|TOKEN|_KEY$|DATABASE_URL|REDIS_URL/);
      }
      for (const [pod, spec] of podSpecs(all)) {
        for (const c of [...(spec.initContainers ?? []), ...spec.containers]) {
          for (const e of c.env ?? []) {
            if (/SECRET|PASSWORD|_KEY$/.test(e.name) && e.name !== 'TURNSTILE_SITE_KEY') {
              expect(e.valueFrom?.secretKeyRef, `${pod}/${c.name} ${e.name}`).toBeDefined();
            }
            // URLs are built only from the Secret's passwords ($(VAR) expansion).
            if (/_URL$/.test(e.name) && e.value?.includes('@')) {
              expect(e.value, `${pod}/${c.name} ${e.name}`).toMatch(/:\$\([A-Z_]+\)@/);
            }
          }
        }
      }
    }
  });

  it('documents every Secret key the templates read in values.yaml', () => {
    const values = readFileSync(join(chart, 'values.yaml'), 'utf8');
    const keys = new Set<string>();
    for (const name of ['bundled', 'external']) {
      for (const [, spec] of podSpecs(docs(template(['-f', valuesFile(name)])))) {
        for (const c of [...(spec.initContainers ?? []), ...spec.containers]) {
          for (const e of c.env ?? []) {
            const key = e.valueFrom?.secretKeyRef?.key;
            if (key) keys.add(key);
          }
        }
      }
    }
    expect(keys.size).toBeGreaterThan(10);
    for (const key of keys) expect(values, key).toContain(key);
  });

  it('runs the migrations as a plain Job on install and a pre-upgrade hook on upgrade', () => {
    const install = find(
      docs(template(['-f', valuesFile('bundled')])),
      'Job',
      'openrows-migrate-1'
    );
    expect(install.metadata.annotations?.['helm.sh/hook']).toBeUndefined();
    const upgrade = find(
      docs(template(['-f', valuesFile('bundled'), '--is-upgrade'])),
      'Job',
      'openrows-migrate-1'
    );
    expect(upgrade.metadata.annotations?.['helm.sh/hook']).toBe('pre-upgrade');
    const all = docs(template(['-f', valuesFile('bundled')]));
    for (const d of ['openrows-api', 'openrows-worker']) {
      expect(container(all, 'Deployment', d, 'wait-for-migrations').command?.[0]).toBe('node');
    }
    const migrate = container(all, 'Job', 'openrows-migrate-1', 'migrate');
    expect(migrate.command).toEqual(['node', 'dist/migrate.js']);
    // The api only ever connects as openrows_app (ADR-002): no owner credentials.
    const api = container(all, 'Deployment', 'openrows-api', 'api');
    expect(api.env?.map((e) => e.name)).not.toContain('MIGRATION_DATABASE_URL');
    expect(api.env?.map((e) => e.name)).not.toContain('PG_PASSWORD');
  });

  it('routes the Ingress host from appUrl to the api, WebSocket timeouts included', () => {
    const ingress = find(docs(template(['-f', valuesFile('bundled')])), 'Ingress', 'openrows');
    expect(JSON.stringify(ingress.spec)).toContain('"host":"openrows.example.org"');
    expect(ingress.metadata.annotations?.['nginx.ingress.kubernetes.io/proxy-read-timeout']).toBe(
      '3600'
    );
  });

  describe('refuses to render', () => {
    const base = ['-f', valuesFile('bundled')];
    const cases: [string, string[], RegExp][] = [
      ['without an existing Secret', ['--set', 'existingSecret='], /existingSecret is required/],
      ['without an image tag or digest', ['--set', 'image.tag='], /image.tag is required/],
      ['without appUrl', ['--set', 'appUrl='], /appUrl is required/],
      ['with an http appUrl', ['--set', 'appUrl=http://openrows.example.org'], /appUrl/],
      ['without an OIDC issuer', ['--set', 'oidc.issuerUrl='], /oidc.issuerUrl is required/],
      ['without an S3 endpoint', ['--set', 's3.endpoint='], /s3.endpoint is required/],
      ['without an S3 bucket', ['--set', 's3.bucket='], /s3.bucket is required/],
      [
        'with a writable root filesystem',
        ['--set', 'securityContext.readOnlyRootFilesystem=false'],
        /readOnlyRootFilesystem/,
      ],
      ['as root', ['--set', 'podSecurityContext.runAsNonRoot=false'], /runAsNonRoot/],
      [
        'with an unpinned Postgres image',
        ['--set', 'postgresql.image=postgres:16'],
        /postgresql\/image/,
      ],
      ['with an unknown value', ['--set', 'apiReplicas=2'], /apiReplicas/],
      [
        'with a secret in extraEnv',
        ['--set', 'extraEnv.SMTP_PASSWORD=x'],
        /extraEnv.SMTP_PASSWORD/,
      ],
      ['with EDITION in extraEnv', ['--set', 'extraEnv.EDITION=cloud'], /extraEnv.EDITION/],
      ['with a malformed digest', ['--set', 'image.digest=sha256:abc'], /digest/],
    ];
    for (const [label, args, message] of cases) {
      it(label, () => {
        expect(templateError([...base, ...args])).toMatch(message);
      });
    }
  });
});

describe("CI's helm job", () => {
  it('runs scripts that exist and are executable', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
    const job = workflow.slice(workflow.indexOf('\n  helm:\n'));
    const scripts = [...job.matchAll(/(deploy\/helm\/[\w./-]+\.sh)/g)].map((m) => m[1] ?? '');
    expect(scripts).toContain('deploy/helm/test/kind-smoke.sh');
    for (const script of scripts) {
      expect(statSync(resolve(root, script)).mode & 0o111, script).not.toBe(0);
    }
  });
});
