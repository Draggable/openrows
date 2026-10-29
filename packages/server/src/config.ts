import { z } from 'zod';
import { parseClamavUrl } from './attachments/scan.js';
import { DEFAULT_SCRIPT_IMAGE, type ScriptConfig } from './automations/script/types.js';
import { parseRule } from './lib/safe-fetch/address.js';
import type { OutboundConfig } from './lib/safe-fetch/policy.js';
import type { ApiRateLimits } from './ratelimit/admission.js';

/**
 * Server configuration, read once from the environment and validated with Zod.
 *
 * Development and tests get working defaults so `npm run dev` needs no `.env`. Production
 * refuses to start (ConfigError) when a secret is missing, still has a development or
 * placeholder value, or a public URL isn't HTTPS. Never log the config object: it holds secrets.
 */

/** Development-only defaults. Production rejects every one of them. */
export const DEV_DEFAULTS = {
  // The server runs as openrows_app, which RLS applies to; migrations run as the schema owner
  // and give openrows_app this password (docs/deploy/database.md).
  DATABASE_URL: 'postgresql://openrows_app:openrows_app_dev@localhost:5432/openrows',
  MIGRATION_DATABASE_URL: 'postgresql://openrows:openrows_dev@localhost:5432/openrows',
  APP_DB_PASSWORD: 'openrows_app_dev',
  APP_URL: 'http://localhost:5173',
  ENCRYPTION_KEY: 'dev-only-encryption-key-do-not-use-in-production',
} as const;

// Values that ship in .env.example, docker/.env.dev.example or MinIO's docs. Matched case-insensitively.
const INSECURE_SECRETS = new Set([
  DEV_DEFAULTS.ENCRYPTION_KEY,
  'openrows_dev',
  DEV_DEFAULTS.APP_DB_PASSWORD,
  'minioadmin',
  'secret',
  'password',
  'changeme',
]);
const PLACEHOLDER = /change[-_ ]?(me|this)|please-change|replace[-_ ]?me|example/i;

export function isInsecureSecret(value: string): boolean {
  return INSECURE_SECRETS.has(value.toLowerCase()) || PLACEHOLDER.test(value);
}

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

/** A comma-separated list of IPs, CIDRs and hostnames (`OUTBOUND_HTTP_ALLOW`/`_DENY`). */
const addressList = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean)
  )
  .superRefine((entries, ctx) => {
    for (const entry of entries) {
      try {
        parseRule(entry);
      } catch (err) {
        ctx.addIssue({ code: 'custom', message: (err as Error).message });
      }
    }
  });

/**
 * Which build runs (ADR-005): `oss`, the open-source core, or `cloud`, the hosted service,
 * which only the hosted edition's entry points start (edition/index.ts refuses it otherwise).
 */
const EditionSchema = z.enum(['oss', 'cloud']).default('oss');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  EDITION: EditionSchema,
  PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
  /**
   * The api's internal Prometheus listener (lib/metrics.ts): `GET /metrics` on this port,
   * never published. Unset: no listener.
   */
  METRICS_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  /** Public origin of the app (browser-facing). OIDC redirects to `${APP_URL}/auth/callback`. */
  APP_URL: z.url().optional(),
  /** Trust `X-Forwarded-*` and `X-Request-Id` from a reverse proxy in front of the server. */
  TRUST_PROXY: bool.default(false),
  /**
   * How many proxies in front of the server append to `X-Forwarded-For` (used only with
   * TRUST_PROXY). The client IP is the entry this many places from the right.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(1).max(10).default(1),
  /** Requests per minute per client IP on /auth/* (H7). */
  AUTH_RATE_LIMIT: z.coerce.number().int().min(1).default(30),
  /**
   * Requests per minute per client IP on the public share link API, /api/shared/*; each
   * token gets five times as many across IPs.
   */
  SHARE_RATE_LIMIT: z.coerce.number().int().min(1).default(600),
  /**
   * Public form submissions per client IP and form in 10 minutes; each form takes 50
   * times as many across IPs. Uploads of form files count separately, with the same limits.
   */
  FORM_SUBMIT_RATE_LIMIT: z.coerce.number().int().min(1).default(20),
  /**
   * The API's token buckets: requests per second and burst (the bucket's size) per base
   * on /api/v1 (Airtable's 5 per second), and per personal access token on any route or signed-in
   * user on /api/v1 (Airtable's 50 per second per token).
   */
  /**
   * Stale records per computed field a write recomputes in its own request; a field with
   * more is flagged and recomputed by the worker.
   */
  COMPUTED_SYNC_LIMIT: z.coerce.number().int().min(1).max(1_000_000).default(5000),
  API_RATE_LIMIT_BASE: z.coerce.number().positive().max(1_000_000).default(5),
  API_RATE_LIMIT_BASE_BURST: z.coerce.number().int().min(1).max(1_000_000).default(10),
  API_RATE_LIMIT_TOKEN: z.coerce.number().positive().max(1_000_000).default(50),
  API_RATE_LIMIT_TOKEN_BURST: z.coerce.number().int().min(1).max(1_000_000).default(100),
  /**
   * Where the buckets live: `postgres` (shared by every instance, the default) or `memory` (one
   * process only).
   */
  RATE_LIMIT_STORE: z.enum(['postgres', 'memory']).default('postgres'),
  /**
   * Cloudflare Turnstile: the secret (server-side verification) and the site key (the
   * public form's widget), both or neither. Without them public forms have no CAPTCHA, which
   * only development and tests allow: production refuses to publish or accept forms.
   */
  TURNSTILE_SECRET_KEY: z.string().min(1).max(200).optional(),
  TURNSTILE_SITE_KEY: z.string().min(1).max(200).optional(),
  /**
   * The instance's public status page, linked from the sign-in page and the help menu;
   * unset: no link. Hosted: https://status.openrows.io (docker/prod.yml). Production needs https.
   */
  STATUS_PAGE_URL: z
    .url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
    .max(2000)
    .optional(),
  /**
   * Outbound requests to user-chosen URLs (webhooks, automations, the Airtable import):
   * the SSRF-safe client in lib/safe-fetch/. Off by default: https only, ports 80 and 443,
   * public addresses only. Self-hosters can allow http, more ports and internal targets (an n8n
   * on the LAN: `OUTBOUND_HTTP_ALLOW=n8n.lan,10.0.5.0/24`) or deny more. Allowed entries never
   * reach the cloud metadata services (169.254.169.254, fd00:ec2::254).
   */
  OUTBOUND_HTTP_ALLOW_HTTP: bool.default(false),
  OUTBOUND_HTTP_PORTS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
    )
    .pipe(z.array(z.coerce.number<string>().int().min(1).max(65_535)).max(50)),
  OUTBOUND_HTTP_ALLOW: addressList,
  OUTBOUND_HTTP_DENY: addressList,
  /**
   * The Airtable importer: the Web API's origin (dev and CI stacks point it at a
   * fake Airtable; production needs https), and the hosts attachments are copied from, by
   * name (`*.` covers subdomains). Requests to both still go through the SSRF-safe client.
   */
  AIRTABLE_API_URL: z.url().default('https://api.airtable.com'),
  AIRTABLE_ATTACHMENT_HOSTS: z
    .string()
    .default('dl.airtable.com,*.airtableusercontent.com')
    .transform((v) =>
      v
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean)
    )
    .pipe(
      z.array(z.string().regex(/^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/, 'a host name')).max(20)
    ),
  /**
   * The instance's AI provider: any OpenAI-compatible chat completions API (OpenAI,
   * Anthropic's compatible endpoint, OpenRouter, Ollama). AI features are on for every workspace
   * when AI_MODEL is set; AI_API_KEY may be empty for local servers. The operator chose this
   * URL, so the SSRF-safe client reaches its host even when it's private (Ollama next door).
   */
  AI_BASE_URL: z.url({ protocol: /^https?$/ }).default('https://api.openai.com/v1'),
  AI_MODEL: z.string().trim().min(1).max(200).optional(),
  AI_API_KEY: z.string().min(1).max(512).optional(),
  /**
   * The hosts a workspace's own AI base URL may use (`*.` covers subdomains; comma-separated).
   * Unset: any public host the outbound rules allow, or HOSTED_AI_HOSTS with EDITION=cloud.
   */
  AI_ALLOWED_HOSTS: z
    .string()
    .optional()
    .transform((v) =>
      v === undefined
        ? undefined
        : v
            .split(',')
            .map((h) => h.trim().toLowerCase())
            .filter(Boolean)
    )
    .pipe(
      z
        .array(z.string().regex(/^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/, 'a host name'))
        .max(50)
        .optional()
    ),
  /** AI requests' deadline in seconds. */
  AI_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(300).default(60),
  /**
   * The worker's attachment GC: `dry-run` (default) only counts what it would delete
   * (logs and /metrics), `on` deletes, `off` doesn't run it.
   */
  ATTACHMENT_GC: z.enum(['off', 'dry-run', 'on']).default('dry-run'),
  /** Emails automations may send per workspace and UTC day, counted per recipient. */
  AUTOMATION_EMAIL_DAILY_LIMIT: z.coerce.number().int().min(0).max(1_000_000).default(100),
  /**
   * Per-workspace outbound limits in the worker: requests per minute (webhook deliveries,
   * automations' HTTP, Slack and email steps, run-script `fetch`; 0 turns the rate off), the
   * burst after a quiet period, and webhook deliveries (and automation runs) active at once.
   * Over them, work waits in the queue; nothing is dropped.
   */
  OUTBOUND_WORKSPACE_RATE_PER_MINUTE: z.coerce.number().int().min(0).max(1_000_000).default(600),
  OUTBOUND_WORKSPACE_BURST: z.coerce.number().int().min(1).max(100_000).default(100),
  OUTBOUND_WORKSPACE_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  /**
   * Run-script steps: `off` (default) or `local-container` (a throwaway `docker run` per
   * script on this host's Docker, through the `docker` CLI at AUTOMATION_SCRIPT_DOCKER).
   */
  AUTOMATION_SCRIPTS: z.enum(['off', 'local-container']).default('off'),
  /**
   * Who may install third-party extension bundles in a base's panel: `creators` (and
   * owners), `owners` only, or `off` (built-in extensions only). Unset: `owners` with
   * EDITION=cloud (admin-gated on the hosted service), else `creators`.
   */
  EXTENSIONS_CUSTOM_BUNDLES: z.enum(['creators', 'owners', 'off']).optional(),
  AUTOMATION_SCRIPT_DOCKER: z.string().min(1).default('docker'),
  /** The image scripts run in: any image with `node` 22 on its PATH. Pin it by digest. */
  AUTOMATION_SCRIPT_IMAGE: z.string().min(1).default(DEFAULT_SCRIPT_IMAGE),
  /** A Docker runtime for script containers, such as `runsc` (gVisor); default: Docker's. */
  AUTOMATION_SCRIPT_RUNTIME: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
    .optional(),
  AUTOMATION_SCRIPT_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(120).default(30),
  AUTOMATION_SCRIPT_CPU_SECONDS: z.coerce.number().int().min(1).max(120).default(10),
  AUTOMATION_SCRIPT_MEMORY_MB: z.coerce.number().int().min(64).max(2048).default(128),
  /** Script containers one process runs at once; more wait their turn. */
  AUTOMATION_SCRIPT_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  /** The server's connection: the `openrows_app` role, never the schema owner (ADR-002). */
  DATABASE_URL: z.url().optional(),
  /** Key material for encrypting stored OIDC tokens and the login cookie. At least 32 characters. */
  ENCRYPTION_KEY: z.string().min(32, 'must be at least 32 characters').optional(),
  OIDC_ISSUER_URL: z.url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_SCOPES: z.string().default('openid email profile'),
  /**
   * The worker's Keycloak admin client: a confidential client whose service account has
   * realm-management's `manage-users`, used to delete purged accounts' users at the provider.
   * Both or neither; needs OIDC_ISSUER_URL.
   */
  OIDC_ADMIN_CLIENT_ID: z.string().optional(),
  OIDC_ADMIN_CLIENT_SECRET: z.string().optional(),
  /**
   * Social sign-in buttons: comma-separated identity-provider aliases configured in the OIDC
   * provider (Keycloak: Identity providers), e.g. `github,google`. Each becomes a "Continue with"
   * button that passes `kc_idp_hint=<alias>`. Empty: only the plain sign-in.
   */
  AUTH_PROVIDERS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean)
    )
    .pipe(
      z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'must be identity-provider aliases'))
    ),
  /**
   * System admins (ADR-002 §7): comma-separated emails. At each sign-in with a verified
   * email, `users.is_system_admin` is set to whether the email is listed (so removing one
   * revokes the flag at their next sign-in). Grants no tenant access.
   */
  OPENROWS_SYSTEM_ADMINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean)
    )
    .pipe(z.array(z.email({ message: 'must be a comma-separated list of emails' }))),
  /** Outgoing mail (SMTP). Unset means mail is logged, not sent (development only). */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
  /**
   * `true`: implicit TLS (port 465). `starttls`: STARTTLS is required, the send fails without it
   * (587; production). `false`: STARTTLS when the server offers it (Mailpit in dev and CI).
   */
  SMTP_SECURE: z
    .enum(['true', 'false', '1', '0', 'yes', 'no', 'starttls'])
    .default('false')
    .transform((v) =>
      v === 'starttls'
        ? { secure: false, requireTls: true }
        : { secure: v === 'true' || v === '1' || v === 'yes', requireTls: false }
    ),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default('OpenRows <no-reply@openrows.io>'),
  S3_ENDPOINT: z.url().optional(),
  /** The SigV4 region: `auto` for Cloudflare R2 (which also accepts us-east-1). */
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  /**
   * The bucket's public base URL (bucket included: http://localhost:9000/openrows), which
   * browser-facing presigned URLs are signed for (attachments), if different from the
   * endpoint (a proxy or usercontent host). Unset, browsers use the endpoint, as the hosted
   * service does with Cloudflare R2.
   */
  S3_PUBLIC_URL: z.url().optional(),
  /** Optional. Checked by /ready when set; ADR-003/004 use it on the hosted service only. */
  REDIS_URL: z.url().optional(),
  /**
   * Optional: ClamAV's clamd, `tcp://host:port`. Set on the api and the worker alike:
   * confirmed uploads then wait (`scanning`) until the worker's scan passes them; infected ones
   * are quarantined. Unset, uploads are ready when confirmed (no scanning).
   */
  CLAMAV_URL: z
    .string()
    .max(300)
    .refine((v) => parseClamavUrl(v) !== null, 'must be tcp://host:port')
    .optional(),
  /**
   * Realtime fan-out (ADR-003 §4): `postgres` (LISTEN/NOTIFY, one process or several on one
   * database) or `redis` (hosted replicas; not implemented yet, M5: the server refuses to start).
   */
  EVENT_BUS: z.enum(['postgres', 'redis']).default('postgres'),
  /**
   * Directory of the built client (packages/client/dist). When set, the server also serves the
   * single-page app from it, so one origin serves the app and the API (the Docker image sets it).
   */
  CLIENT_DIR: z.string().optional(),
});

type Env = z.infer<typeof EnvSchema>;

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  publicUrl: string | undefined;
}

export interface OidcConfig {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  /** Identity-provider aliases offered as buttons (`kc_idp_hint`), in order. */
  providers: string[];
}

export interface SmtpConfig {
  host: string;
  port: number;
  /** Implicit TLS. */
  secure: boolean;
  /** STARTTLS or nothing (`SMTP_SECURE=starttls`). */
  requireTls: boolean;
  user: string | undefined;
  password: string | undefined;
}

export interface Config {
  env: Env['NODE_ENV'];
  /** EDITION: which providers the entry point must bring (edition/index.ts). */
  edition: Env['EDITION'];
  isProduction: boolean;
  port: number;
  /** The internal metrics port; undefined: none. */
  metricsPort: number | undefined;
  logLevel: NonNullable<Env['LOG_LEVEL']>;
  appUrl: string;
  trustProxy: boolean;
  trustProxyHops: number;
  authRateLimit: number;
  shareRateLimit: number;
  formSubmitRateLimit: number;
  /** The API's token buckets: per base on /api/v1, per token or user. */
  apiRateLimits: ApiRateLimits;
  /** Stale records per computed field a request recomputes itself. */
  computedSyncLimit: number;
  rateLimitStore: 'postgres' | 'memory';
  /** Cloudflare Turnstile for public forms; undefined: no CAPTCHA. */
  turnstile: { secretKey: string; siteKey: string } | undefined;
  /** Outbound requests to user URLs: lib/safe-fetch/'s policy. */
  outbound: OutboundConfig;
  /** The Airtable importer's API origin and attachment hosts. */
  airtable: AirtableConfig;
  /** AI providers: the instance's and the rules for workspaces' own. */
  ai: AiConfig;
  /** Automation emails per workspace and UTC day, for test runs and retries. */
  automationEmailDailyLimit: number;
  /** Run-script steps, for test runs and retries. */
  scripts: ScriptConfig;
  /** Who may install third-party extension bundles (EXTENSIONS_CUSTOM_BUNDLES). */
  extensionsCustomBundles: 'creators' | 'owners' | 'off';
  databaseUrl: string;
  encryptionKey: string;
  /** Undefined until configured; always set in production. */
  oidc: OidcConfig | undefined;
  /** Undefined until configured; always set in production. */
  s3: S3Config | undefined;
  redisUrl: string | undefined;
  /** ClamAV's clamd (CLAMAV_URL); undefined: uploads aren't scanned. */
  clamav: { host: string; port: number } | undefined;
  eventBus: 'postgres' | 'redis';
  /** Undefined means mail is logged instead of sent. */
  smtp: SmtpConfig | undefined;
  mailFrom: string;
  /** Undefined means the client is served elsewhere (Vite in development). */
  clientDir: string | undefined;
  /** Lowercased emails of system admins (`OPENROWS_SYSTEM_ADMINS`). */
  systemAdmins: string[];
  /** The public status page (STATUS_PAGE_URL); undefined: the app links none. */
  statusPageUrl: string | undefined;
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

const S3_KEYS = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'] as const;
const OIDC_KEYS = ['OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'] as const;

function urlPassword(url: string): string {
  return decodeURIComponent(new URL(url).password);
}

/** Cross-field rules. Returns problems as `VAR: message`. */
function check(env: Env): string[] {
  const issues: string[] = [];
  const prod = env.NODE_ENV === 'production';

  // S3 and OIDC are all-or-nothing groups: a half-configured group is always an error.
  for (const group of [S3_KEYS, OIDC_KEYS]) {
    const set = group.filter((k) => env[k] !== undefined);
    if (prod || set.length > 0) {
      for (const k of group) {
        if (env[k] === undefined) {
          issues.push(`${k}: required${prod ? ' in production' : ` when ${set[0]} is set`}`);
        }
      }
    }
  }

  // Turnstile is both keys or neither, in every environment. Production may run without
  // (public forms then refuse to publish or accept submissions, and the server logs why).
  if ((env.TURNSTILE_SECRET_KEY === undefined) !== (env.TURNSTILE_SITE_KEY === undefined)) {
    issues.push('TURNSTILE_SECRET_KEY and TURNSTILE_SITE_KEY: set both or neither');
  }

  if (!prod) return issues;

  for (const k of ['APP_URL', 'DATABASE_URL', 'ENCRYPTION_KEY'] as const) {
    if (env[k] === undefined) issues.push(`${k}: required in production`);
  }
  for (const k of ['ENCRYPTION_KEY', 'OIDC_CLIENT_SECRET', 'S3_SECRET_KEY'] as const) {
    const v = env[k];
    if (v !== undefined && isInsecureSecret(v)) {
      issues.push(`${k}: a default or placeholder value is not allowed in production`);
    }
  }
  if (env.AI_API_KEY !== undefined && isInsecureSecret(env.AI_API_KEY)) {
    issues.push('AI_API_KEY: a default or placeholder value is not allowed in production');
  }
  if (env.S3_ACCESS_KEY !== undefined && isInsecureSecret(env.S3_ACCESS_KEY)) {
    issues.push('S3_ACCESS_KEY: a default or placeholder value is not allowed in production');
  }
  if (env.DATABASE_URL !== undefined) {
    const password = urlPassword(env.DATABASE_URL);
    if (!password || isInsecureSecret(password)) {
      issues.push('DATABASE_URL: needs a non-default password in production');
    }
  }
  issues.push(...smtpProductionIssues(env));
  if (env.REDIS_URL !== undefined) {
    const password = urlPassword(env.REDIS_URL);
    if (password && isInsecureSecret(password)) {
      issues.push('REDIS_URL: a default or placeholder password is not allowed in production');
    }
  }
  for (const k of ['APP_URL', 'OIDC_ISSUER_URL', 'AIRTABLE_API_URL', 'STATUS_PAGE_URL'] as const) {
    const v = env[k];
    if (v !== undefined && new URL(v).protocol !== 'https:') {
      issues.push(`${k}: must use https in production`);
    }
  }
  return issues;
}

/** AI providers (AI_*). */
export interface AiConfig {
  /** The instance's provider; undefined: none (workspaces may still bring their own key). */
  instance: { baseUrl: string; model: string; apiKey: string | undefined } | undefined;
  /** Hosts a workspace's base URL may use; undefined: any the outbound rules allow. */
  allowedHosts: string[] | undefined;
  timeoutMs: number;
}

/**
 * The hosted service's AI providers: what a workspace's own base URL may use with
 * EDITION=cloud when AI_ALLOWED_HOSTS is unset.
 */
export const HOSTED_AI_HOSTS = [
  'api.openai.com',
  'api.anthropic.com',
  'openrouter.ai',
  'api.mistral.ai',
  'generativelanguage.googleapis.com',
  'api.groq.com',
  'api.together.xyz',
  'api.deepseek.com',
  'api.x.ai',
] as const;

function aiFrom(env: {
  EDITION: Env['EDITION'];
  AI_BASE_URL: string;
  AI_MODEL?: string | undefined;
  AI_API_KEY?: string | undefined;
  AI_ALLOWED_HOSTS?: string[] | undefined;
  AI_TIMEOUT_SECONDS: number;
}): AiConfig {
  return {
    instance: env.AI_MODEL
      ? {
          baseUrl: env.AI_BASE_URL.replace(/\/+$/, ''),
          model: env.AI_MODEL,
          apiKey: env.AI_API_KEY,
        }
      : undefined,
    allowedHosts: env.AI_ALLOWED_HOSTS
      ? [...new Set(env.AI_ALLOWED_HOSTS)]
      : env.EDITION === 'cloud'
        ? [...HOSTED_AI_HOSTS]
        : undefined,
    timeoutMs: env.AI_TIMEOUT_SECONDS * 1000,
  };
}

/** Where the Airtable importer reads from. */
export interface AirtableConfig {
  apiUrl: string;
  attachmentHosts: string[];
}

type SmtpEnv = Pick<Env, 'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_SECURE' | 'SMTP_USER' | 'SMTP_PASSWORD'>;

/** Production's SMTP rules (api and worker): a real password, and never credentials in clear. */
function smtpProductionIssues(env: SmtpEnv): string[] {
  const issues: string[] = [];
  if (env.SMTP_PASSWORD !== undefined && isInsecureSecret(env.SMTP_PASSWORD)) {
    issues.push('SMTP_PASSWORD: a default or placeholder value is not allowed in production');
  }
  if (
    env.SMTP_HOST !== undefined &&
    env.SMTP_USER !== undefined &&
    !env.SMTP_SECURE.secure &&
    !env.SMTP_SECURE.requireTls
  ) {
    issues.push(
      'SMTP_SECURE: must be true (port 465) or starttls in production when SMTP_USER is set'
    );
  }
  return issues;
}

function smtpFrom(env: SmtpEnv): SmtpConfig | undefined {
  if (env.SMTP_HOST === undefined) return undefined;
  return {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE.secure,
    requireTls: env.SMTP_SECURE.requireTls,
    user: env.SMTP_USER,
    password: env.SMTP_PASSWORD,
  };
}

function airtableFrom(env: { AIRTABLE_API_URL: string; AIRTABLE_ATTACHMENT_HOSTS: string[] }) {
  return {
    apiUrl: new URL(env.AIRTABLE_API_URL).origin,
    attachmentHosts: [...new Set(env.AIRTABLE_ATTACHMENT_HOSTS)],
  };
}

const ScriptEnvSchema = EnvSchema.pick({
  AUTOMATION_SCRIPTS: true,
  AUTOMATION_SCRIPT_DOCKER: true,
  AUTOMATION_SCRIPT_IMAGE: true,
  AUTOMATION_SCRIPT_RUNTIME: true,
  AUTOMATION_SCRIPT_TIMEOUT_SECONDS: true,
  AUTOMATION_SCRIPT_CPU_SECONDS: true,
  AUTOMATION_SCRIPT_MEMORY_MB: true,
  AUTOMATION_SCRIPT_CONCURRENCY: true,
});

function scriptsFrom(env: z.infer<typeof ScriptEnvSchema>): ScriptConfig {
  return {
    executor: env.AUTOMATION_SCRIPTS,
    docker: env.AUTOMATION_SCRIPT_DOCKER,
    image: env.AUTOMATION_SCRIPT_IMAGE,
    runtime: env.AUTOMATION_SCRIPT_RUNTIME,
    limits: {
      timeoutSeconds: env.AUTOMATION_SCRIPT_TIMEOUT_SECONDS,
      cpuSeconds: env.AUTOMATION_SCRIPT_CPU_SECONDS,
      memoryMb: env.AUTOMATION_SCRIPT_MEMORY_MB,
    },
    concurrency: env.AUTOMATION_SCRIPT_CONCURRENCY,
  };
}

const OutboundEnvSchema = EnvSchema.pick({
  OUTBOUND_HTTP_ALLOW_HTTP: true,
  OUTBOUND_HTTP_PORTS: true,
  OUTBOUND_HTTP_ALLOW: true,
  OUTBOUND_HTTP_DENY: true,
});

function outboundFrom(env: z.infer<typeof OutboundEnvSchema>): OutboundConfig {
  return {
    allowHttp: env.OUTBOUND_HTTP_ALLOW_HTTP,
    extraPorts: [...new Set(env.OUTBOUND_HTTP_PORTS)],
    allow: env.OUTBOUND_HTTP_ALLOW,
    deny: env.OUTBOUND_HTTP_DENY,
  };
}

function nonEmpty(source: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter(
      (e): e is [string, string] => e[1] !== undefined && e[1].trim() !== ''
    )
  );
}

/**
 * Only the outbound HTTP policy (`OUTBOUND_HTTP_*`), for the worker, which doesn't load the
 * whole config. Throws ConfigError like loadConfig.
 */
export function loadOutboundConfig(
  source: Record<string, string | undefined> = process.env
): OutboundConfig {
  const parsed = OutboundEnvSchema.safeParse(nonEmpty(source));
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  return outboundFrom(parsed.data);
}

/**
 * EDITION alone, for the worker, which checks it before anything else (even without a
 * database). Throws ConfigError.
 */
export function loadEdition(source: Record<string, string | undefined> = process.env) {
  const parsed = EditionSchema.safeParse(nonEmpty(source)['EDITION']);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `EDITION: ${i.message}`));
  }
  return parsed.data;
}

/** What the worker needs besides its database: webhook secrets, links in mail, SMTP. */
export interface WorkerConfig {
  isProduction: boolean;
  appUrl: string;
  encryptionKey: string;
  outbound: OutboundConfig;
  airtable: AirtableConfig;
  /** AI providers, for AI work in jobs. */
  ai: AiConfig;
  smtp: SmtpConfig | undefined;
  mailFrom: string;
  attachmentGc: 'off' | 'dry-run' | 'on';
  /** Automation emails per workspace and UTC day. */
  automationEmailDailyLimit: number;
  /** Per-workspace outbound limits (OUTBOUND_WORKSPACE_*). */
  outboundLimits: { perMinute: number; burst: number; concurrency: number };
  /** Run-script steps. */
  scripts: ScriptConfig;
  /** Keycloak's admin API for deleting purged users, when configured. */
  identityAdmin: { issuerUrl: string; clientId: string; clientSecret: string } | undefined;
  /** ClamAV's clamd (CLAMAV_URL): the `attachments.scan` jobs; undefined: not run. */
  clamav: { host: string; port: number } | undefined;
}

const WorkerEnvSchema = EnvSchema.pick({
  NODE_ENV: true,
  EDITION: true,
  OIDC_ISSUER_URL: true,
  OIDC_ADMIN_CLIENT_ID: true,
  OIDC_ADMIN_CLIENT_SECRET: true,
  ATTACHMENT_GC: true,
  CLAMAV_URL: true,
  AUTOMATION_EMAIL_DAILY_LIMIT: true,
  OUTBOUND_WORKSPACE_RATE_PER_MINUTE: true,
  OUTBOUND_WORKSPACE_BURST: true,
  OUTBOUND_WORKSPACE_CONCURRENCY: true,
  AUTOMATION_SCRIPTS: true,
  AUTOMATION_SCRIPT_DOCKER: true,
  AUTOMATION_SCRIPT_IMAGE: true,
  AUTOMATION_SCRIPT_RUNTIME: true,
  AUTOMATION_SCRIPT_TIMEOUT_SECONDS: true,
  AUTOMATION_SCRIPT_CPU_SECONDS: true,
  AUTOMATION_SCRIPT_MEMORY_MB: true,
  AUTOMATION_SCRIPT_CONCURRENCY: true,
  APP_URL: true,
  ENCRYPTION_KEY: true,
  OUTBOUND_HTTP_ALLOW_HTTP: true,
  OUTBOUND_HTTP_PORTS: true,
  OUTBOUND_HTTP_ALLOW: true,
  OUTBOUND_HTTP_DENY: true,
  AIRTABLE_API_URL: true,
  AIRTABLE_ATTACHMENT_HOSTS: true,
  AI_BASE_URL: true,
  AI_MODEL: true,
  AI_API_KEY: true,
  AI_ALLOWED_HOSTS: true,
  AI_TIMEOUT_SECONDS: true,
  SMTP_HOST: true,
  SMTP_PORT: true,
  SMTP_SECURE: true,
  SMTP_USER: true,
  SMTP_PASSWORD: true,
  SMTP_FROM: true,
});

/**
 * The worker's settings, with loadConfig's rules for them: production needs APP_URL (https) and
 * a real ENCRYPTION_KEY, the same key as the API's, which webhook secrets are encrypted with.
 * Throws ConfigError.
 */
export function loadWorkerConfig(
  source: Record<string, string | undefined> = process.env
): WorkerConfig {
  const parsed = WorkerEnvSchema.safeParse(nonEmpty(source));
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const env = parsed.data;
  const prod = env.NODE_ENV === 'production';
  const issues: string[] = [];
  if (prod) {
    if (env.APP_URL === undefined) issues.push('APP_URL: required in production');
    else if (new URL(env.APP_URL).protocol !== 'https:') {
      issues.push('APP_URL: must use https in production');
    }
    if (env.ENCRYPTION_KEY === undefined) issues.push('ENCRYPTION_KEY: required in production');
    else if (isInsecureSecret(env.ENCRYPTION_KEY)) {
      issues.push('ENCRYPTION_KEY: a default or placeholder value is not allowed in production');
    }
    if (new URL(env.AIRTABLE_API_URL).protocol !== 'https:') {
      issues.push('AIRTABLE_API_URL: must use https in production');
    }
    if (env.AI_API_KEY !== undefined && isInsecureSecret(env.AI_API_KEY)) {
      issues.push('AI_API_KEY: a default or placeholder value is not allowed in production');
    }
    issues.push(...smtpProductionIssues(env));
  }
  const admin = [env.OIDC_ISSUER_URL, env.OIDC_ADMIN_CLIENT_ID, env.OIDC_ADMIN_CLIENT_SECRET];
  if (
    (env.OIDC_ADMIN_CLIENT_ID !== undefined || env.OIDC_ADMIN_CLIENT_SECRET !== undefined) &&
    admin.some((v) => v === undefined)
  ) {
    issues.push(
      'OIDC_ADMIN_CLIENT_ID, OIDC_ADMIN_CLIENT_SECRET: set both, with OIDC_ISSUER_URL, or neither'
    );
  }
  if (prod && env.OIDC_ADMIN_CLIENT_SECRET !== undefined) {
    if (isInsecureSecret(env.OIDC_ADMIN_CLIENT_SECRET)) {
      issues.push(
        'OIDC_ADMIN_CLIENT_SECRET: a default or placeholder value is not allowed in production'
      );
    }
  }
  if (issues.length > 0) throw new ConfigError(issues);
  return {
    isProduction: prod,
    identityAdmin:
      env.OIDC_ISSUER_URL && env.OIDC_ADMIN_CLIENT_ID && env.OIDC_ADMIN_CLIENT_SECRET
        ? {
            issuerUrl: env.OIDC_ISSUER_URL,
            clientId: env.OIDC_ADMIN_CLIENT_ID,
            clientSecret: env.OIDC_ADMIN_CLIENT_SECRET,
          }
        : undefined,
    appUrl: new URL(env.APP_URL ?? DEV_DEFAULTS.APP_URL).origin,
    encryptionKey: env.ENCRYPTION_KEY ?? DEV_DEFAULTS.ENCRYPTION_KEY,
    outbound: outboundFrom(env),
    airtable: airtableFrom(env),
    ai: aiFrom(env),
    smtp: smtpFrom(env),
    mailFrom: env.SMTP_FROM,
    attachmentGc: env.ATTACHMENT_GC,
    clamav: env.CLAMAV_URL ? (parseClamavUrl(env.CLAMAV_URL) ?? undefined) : undefined,
    automationEmailDailyLimit: env.AUTOMATION_EMAIL_DAILY_LIMIT,
    outboundLimits: {
      perMinute: env.OUTBOUND_WORKSPACE_RATE_PER_MINUTE,
      burst: env.OUTBOUND_WORKSPACE_BURST,
      concurrency: env.OUTBOUND_WORKSPACE_CONCURRENCY,
    },
    scripts: scriptsFrom(env),
  };
}

/**
 * Parses and validates `env` (process.env by default). Empty strings count as unset, so Compose
 * `${VAR:-}` passthroughs behave like missing variables. Throws ConfigError listing every problem.
 */
export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(nonEmpty(source));
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    );
  }
  const env = parsed.data;
  const issues = check(env);
  if (issues.length > 0) throw new ConfigError(issues);

  const s3 =
    env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY && env.S3_SECRET_KEY
      ? {
          endpoint: env.S3_ENDPOINT,
          region: env.S3_REGION,
          bucket: env.S3_BUCKET,
          accessKey: env.S3_ACCESS_KEY,
          secretKey: env.S3_SECRET_KEY,
          publicUrl: env.S3_PUBLIC_URL,
        }
      : undefined;
  const oidc =
    env.OIDC_ISSUER_URL && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET
      ? {
          issuerUrl: env.OIDC_ISSUER_URL,
          clientId: env.OIDC_CLIENT_ID,
          clientSecret: env.OIDC_CLIENT_SECRET,
          scopes: env.OIDC_SCOPES,
          providers: [...new Set(env.AUTH_PROVIDERS)],
        }
      : undefined;

  return {
    env: env.NODE_ENV,
    edition: env.EDITION,
    isProduction: env.NODE_ENV === 'production',
    port: env.PORT,
    metricsPort: env.METRICS_PORT,
    logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === 'test' ? 'silent' : 'info'),
    appUrl: new URL(env.APP_URL ?? DEV_DEFAULTS.APP_URL).origin,
    trustProxy: env.TRUST_PROXY,
    trustProxyHops: env.TRUST_PROXY_HOPS,
    authRateLimit: env.AUTH_RATE_LIMIT,
    shareRateLimit: env.SHARE_RATE_LIMIT,
    formSubmitRateLimit: env.FORM_SUBMIT_RATE_LIMIT,
    apiRateLimits: {
      base: { perSecond: env.API_RATE_LIMIT_BASE, burst: env.API_RATE_LIMIT_BASE_BURST },
      token: { perSecond: env.API_RATE_LIMIT_TOKEN, burst: env.API_RATE_LIMIT_TOKEN_BURST },
    },
    rateLimitStore: env.RATE_LIMIT_STORE,
    computedSyncLimit: env.COMPUTED_SYNC_LIMIT,
    turnstile:
      env.TURNSTILE_SECRET_KEY && env.TURNSTILE_SITE_KEY
        ? { secretKey: env.TURNSTILE_SECRET_KEY, siteKey: env.TURNSTILE_SITE_KEY }
        : undefined,
    outbound: outboundFrom(env),
    airtable: airtableFrom(env),
    ai: aiFrom(env),
    automationEmailDailyLimit: env.AUTOMATION_EMAIL_DAILY_LIMIT,
    scripts: scriptsFrom(env),
    extensionsCustomBundles:
      env.EXTENSIONS_CUSTOM_BUNDLES ?? (env.EDITION === 'cloud' ? 'owners' : 'creators'),
    databaseUrl: env.DATABASE_URL ?? DEV_DEFAULTS.DATABASE_URL,
    encryptionKey: env.ENCRYPTION_KEY ?? DEV_DEFAULTS.ENCRYPTION_KEY,
    oidc,
    s3,
    redisUrl: env.REDIS_URL,
    clamav: env.CLAMAV_URL ? (parseClamavUrl(env.CLAMAV_URL) ?? undefined) : undefined,
    eventBus: env.EVENT_BUS,
    smtp: smtpFrom(env),
    mailFrom: env.SMTP_FROM,
    clientDir: env.CLIENT_DIR,
    systemAdmins: [...new Set(env.OPENROWS_SYSTEM_ADMINS)],
    statusPageUrl: env.STATUS_PAGE_URL,
  };
}
