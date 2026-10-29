import {
  BRAND,
  buildOpenApiDocument,
  OAUTH_ACCESS_TOKEN_PREFIX,
  OPENAPI_PATH,
  type OpenApiDocument,
} from '@openrows/shared';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getPath } from 'hono/utils/url';
import { accountRoutes } from './account/routes.js';
import { adminAccountRoutes } from './admin/routes.js';
import { assistantRoutes } from './ai/assistant/routes.js';
import { aiFieldRoutes } from './ai/fields/routes.js';
import { aiRoutes } from './ai/routes.js';
import { AiService } from './ai/service.js';
import { airtableRoutes } from './airtable/routes.js';
import { attachmentRoutes } from './attachments/routes.js';
import { type ObjectStore, S3ObjectStore } from './attachments/storage.js';
import { ThumbnailJobs } from './attachments/thumbnails.js';
import { clientIp } from './auth/client-ip.js';
import { createCipher } from './auth/crypto.js';
import { type SessionMiddleware, sameOrigin, sessionMiddleware } from './auth/middleware.js';
import { OidcClient } from './auth/oidc.js';
import { authRoutes, meRoutes } from './auth/routes.js';
import { SESSION_COOKIE } from './auth/session-token.js';
import { SessionStore } from './auth/sessions.js';
import { resolveToken } from './auth/tokens.js';
import { type RouteEntry, RouteRegistry, unregisteredRoutes } from './authz/routes.js';
import { hookRoutes } from './automations/hooks.js';
import { automationRoutes } from './automations/routes.js';
import { createScriptSandbox, type ScriptSandbox } from './automations/script/index.js';
import { baseRoutes } from './bases/routes.js';
import { billingRoutes } from './billing/routes.js';
import { clientRoutes } from './client.js';
import { commentRoutes } from './comments/routes.js';
import type { Config } from './config.js';
import { setRecomputeSyncLimit } from './data/computed/engine.js';
import type { Database } from './db/index.js';
import { docsRoutes } from './docs/llms.js';
import { ossEdition } from './edition/oss.js';
import type { Edition } from './edition/types.js';
import { createEmailTransport, type EmailTransport } from './email/transport.js';
import { exportRoutes } from './export/routes.js';
import { extensionRoutes } from './extensions/routes.js';
import { extensionSandboxRoutes } from './extensions/sandbox.js';
import { fieldRoutes } from './fields/routes.js';
import { formRoutes } from './forms/routes.js';
import type { CaptchaVerifier } from './forms/turnstile.js';
import { CHECK_TIMEOUT_MS, type DependencyCheck, runChecks } from './health.js';
import { importExportRoutes } from './import-export/routes.js';
import { interfaceRoutes } from './interfaces/routes.js';
import { createJobs, type Jobs } from './jobs/send.js';
import { type AppEnv, requestContext } from './lib/context.js';
import { notFound, onError, problem } from './lib/errors.js';
import type { Logger } from './lib/logger.js';
import type { HttpMetrics } from './lib/metrics.js';
import {
  createSafeFetch,
  createUrlCheck,
  outboundPolicy,
  type SafeFetch,
} from './lib/safe-fetch/index.js';
import { securityHeaders } from './lib/security-headers.js';
import { mcpRoutes } from './mcp/routes.js';
import { noticeRoutes } from './notices/routes.js';
import { notificationRoutes } from './notifications/routes.js';
import { oauthRoutes } from './oauth/routes.js';
import { resolveOAuthToken } from './oauth/service.js';
import { apiAdmission } from './ratelimit/admission.js';
import { MemoryRateLimiter, type RateLimiter } from './ratelimit/limiter.js';
import { PostgresRateLimiter } from './ratelimit/postgres.js';
import type { FieldVisibility } from './realtime/projection.js';
import { realtimeRoutes } from './realtime/routes.js';
import { recordRoutes } from './records/routes.js';
import { regionRoutes } from './regions/routes.js';
import { revisionRoutes } from './revisions/routes.js';
import { scriptRoutes } from './scripts/routes.js';
import { sandboxRoutes } from './scripts/sandbox.js';
import { sharedRoutes, shareRoutes } from './shares/routes.js';
import { snapshotRoutes } from './snapshots/routes.js';
import { connectorRoutes } from './syncs/connector-routes.js';
import { syncRoutes } from './syncs/routes.js';
import { createSyncSources, type SyncSources } from './syncs/sources/index.js';
import { tableRoutes } from './tables/routes.js';
import { templateRoutes } from './templates/routes.js';
import { tokenRoutes } from './tokens/routes.js';
import { trashRoutes } from './trash/routes.js';
import { usageRoutes } from './usage/routes.js';
import { v1Routes } from './v1/routes.js';
import { viewRoutes } from './views/routes.js';
import { workspaceRoutes } from './workspaces/routes.js';

export interface AppDeps {
  config: Config;
  /**
   * The edition's providers (ADR-005): entitlements, billing, the usage meter and the
   * hooks. The OSS edition when omitted; the hosted edition passes its own through main.ts.
   */
  edition?: Edition;
  logger: Logger;
  db: Database;
  /** Dependencies /ready probes (see buildChecks in health.ts). */
  checks: DependencyCheck[];
  /** Where the app's mail goes; SMTP from the config (or a log line) when omitted. */
  email?: EmailTransport;
  /** Attachment storage; S3 from the config (none when unconfigured) when omitted. */
  objectStore?: ObjectStore;
  /**
   * Field-level visibility for events and revision history (plugs in here); everything
   * visible when omitted.
   */
  visibility?: FieldVisibility;
  /** Public forms' CAPTCHA check; Turnstile from the config when omitted. */
  captcha?: CaptchaVerifier;
  /** The API's rate limit store; `RATE_LIMIT_STORE` from the config when omitted. */
  rateLimiter?: RateLimiter;
  /**
   * Background jobs sent in the request's transaction (ADR-004); pg-boss on `db` when
   * omitted. The worker runs them.
   */
  jobs?: Jobs;
  /**
   * How the Airtable importer reaches api.airtable.com: the SSRF-safe client with the
   * outbound rules when omitted (tests pass the recorded-fixture fake).
   */
  airtable?: { http: SafeFetch; sleep?: (ms: number) => Promise<void> };
  /** AI providers; from the config (AI_*) and the outbound rules when omitted. */
  ai?: AiService;
  /** Synced tables' CSV and Postgres sources; from the config when omitted. */
  syncSources?: SyncSources;
  /** Run-script steps' sandbox; AUTOMATION_SCRIPTS from the config when omitted. */
  scripts?: ScriptSandbox;
  /** Request counters for the internal metrics port; none when omitted. */
  metrics?: HttpMetrics;
  /** Extra, informational `/ready` details (the outbox relay's lag); none when omitted. */
  readyDetails?: () => Promise<Record<string, unknown>>;
}

/** Failed bearer attempts per IP and window before every bearer attempt from it is 429. */
export const BEARER_FAILURE_LIMIT = 20;
export const BEARER_FAILURE_WINDOW_MS = 10 * 60 * 1000;

/** The OIDC client for the configured provider, or undefined when sign-in isn't configured. */
export function createOidcClient(config: Config): OidcClient | undefined {
  if (!config.oidc) return undefined;
  return new OidcClient(config.oidc, {
    redirectUri: `${config.appUrl}/auth/callback`,
    // Production config already insists on https; dev and tests talk to http://localhost.
    allowHttp: !config.isProduction,
  });
}

const OPENAPI_DESCRIPTION = [
  `The ${BRAND} HTTP API. The public REST API v1 (\`/api/v1\`) follows Airtable's Web API;`,
  'the other routes are the ones the web app uses. Authenticate with a personal access token',
  '(`Authorization: Bearer or_pat_…`) or the session cookie. Guides: `/docs/api`.',
].join(' ');

/** The OpenAPI document of every contract route in `entries`. */
export function openApiDocument(entries: readonly RouteEntry[], appUrl: string): OpenApiDocument {
  const operations = entries.flatMap(({ contract, access }) => {
    // Contract routes only; the MCP endpoint is JSON-RPC, documented on its own.
    // The ops console is for system admins, not part of the public API.
    if (!contract || access.kind === 'token' || access.kind === 'admin') return [];
    const token =
      access.kind === 'public'
        ? ''
        : access.token === null
          ? '; signed-in session only (no personal access tokens)'
          : `; personal access tokens need \`${access.token}\``;
    const rule =
      (access.kind === 'resource'
        ? `\`${access.action}\` on the ${access.resource} (see ACTIONS for the minimum role)`
        : access.kind === 'session'
          ? 'any signed-in user, for their own data'
          : 'anyone') + token;
    return [{ endpoint: contract, access: rule, kind: access.kind }];
  });
  return buildOpenApiDocument(operations, {
    title: `${BRAND} API`,
    version: '0.1.0',
    sessionCookie: SESSION_COOKIE,
    serverUrl: appUrl,
    description: OPENAPI_DESCRIPTION,
  });
}

/**
 * The OpenRows HTTP app.
 *
 * The prototype routers were unsafe (see legacy/README.md) and live in legacy/ as reference
 * only. Routes come back one issue at a time, each declared in the route registry with its
 * access rule (src/authz); createApp refuses to build an app with a route that bypassed it.
 * Sign-in is Keycloak (or any OIDC provider) through src/auth (ADR-006).
 */
export function createApp({
  config,
  edition = ossEdition(),
  logger,
  checks,
  db,
  email,
  objectStore,
  visibility,
  captcha,
  rateLimiter,
  jobs = createJobs(db),
  airtable,
  ai,
  syncSources,
  scripts: scriptSandbox,
  metrics,
  readyDetails,
}: AppDeps): {
  app: Hono<AppEnv>;
  routes: RouteRegistry;
  session: SessionMiddleware;
  store: SessionStore;
  /** The image thumbnail jobs of this process. */
  thumbnails: ThumbnailJobs;
  /** Notification emails; index.ts runs it on a timer, tests call `run()`. */
  /** Job sending; index.ts stops it on shutdown. */
  jobs: Jobs;
} {
  setRecomputeSyncLimit(config.computedSyncLimit);
  const app = new Hono<AppEnv>({
    // Airtable's client writes records to `/v1/<base>/<table>/`: that's the same route.
    getPath: (req) => {
      const path = getPath(req);
      return path.startsWith('/api/v1/') && path.endsWith('/') ? path.slice(0, -1) : path;
    },
  });
  const oidc = createOidcClient(config);
  const store = new SessionStore(db, oidc, config.encryptionKey);
  // Personal access tokens: `Authorization: Bearer or_pat_…` instead of the cookie.
  // The API's rate limits, checked once the caller is known.
  const limiter =
    rateLimiter ??
    (config.rateLimitStore === 'memory' ? new MemoryRateLimiter() : new PostgresRateLimiter(db));
  const session = sessionMiddleware(
    store,
    {
      // OAuth apps' access tokens act like personal access tokens.
      resolve: (token) =>
        token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)
          ? resolveOAuthToken(db, token)
          : resolveToken(db, token),
      ip: (c) => clientIp(c, { trustProxy: config.trustProxy, hops: config.trustProxyHops }),
      failureLimit: BEARER_FAILURE_LIMIT,
      windowMs: BEARER_FAILURE_WINDOW_MS,
    },
    apiAdmission({
      db,
      limiter,
      limits: config.apiRateLimits,
      // The OSS edition is unlimited: no transaction per request to learn it.
      entitlements: edition.name === 'oss' ? undefined : edition.entitlements,
    })
  );
  const routes = new RouteRegistry(app, { db, session });

  if (metrics) app.use('*', metrics.middleware());
  // The edition's providers for every handler: c.var.edition.entitlements and so on.
  app.use('*', async (c, next) => {
    c.set('edition', edition);
    c.set(
      'clientIp',
      clientIp(c, { trustProxy: config.trustProxy, hops: config.trustProxyHops }) ?? null
    );
    await next();
  });
  app.use('*', requestContext({ logger, trustProxy: config.trustProxy }));
  app.use('*', securityHeaders(config));
  app.use('*', cors({ origin: config.appUrl, credentials: true }));
  app.use('*', sameOrigin(config.appUrl));

  // Liveness: the process is up and serving. Never touches dependencies.
  routes.public('GET', '/health', (c) =>
    c.json({ status: 'ok', edition: edition.name, timestamp: new Date().toISOString() })
  );

  // Readiness: every dependency answers. 503 problem+json (with the same `checks`) otherwise.
  // `details` (the outbox relay's lag, from index.ts): informational, so a lagging worker
  // doesn't make the API unready; left out when it can't be read in time.
  routes.public('GET', '/ready', async (c) => {
    const [{ ok, checks: results }, details] = await Promise.all([
      runChecks(checks, { logger: c.get('logger') }),
      readyDetails
        ? Promise.race([
            readyDetails().catch(() => undefined),
            new Promise<undefined>((resolve) =>
              setTimeout(() => resolve(undefined), CHECK_TIMEOUT_MS).unref()
            ),
          ])
        : undefined,
    ]);
    const extra = details ? { details } : {};
    if (ok) return c.json({ status: 'ok', checks: results, ...extra });
    return problem(c, 'NOT_READY', {
      detail: 'One or more dependencies are unavailable.',
      extensions: { checks: results, ...extra },
    });
  });

  authRoutes(routes, { db, config, store, oidc });
  meRoutes(routes);
  accountRoutes(routes, { db, config, jobs });
  // The account side of the ops console: support access list, ending an impersonation.
  adminAccountRoutes(routes, { db, config });
  tokenRoutes(routes, { db });
  noticeRoutes(routes, { db });
  const mail = email ?? createEmailTransport(config, logger);
  workspaceRoutes(routes, { db, config, email: mail, jobs });
  // Data residency: the regions, and workspaces created in another region's stack.
  regionRoutes(routes, { db, config });
  // AI providers: the instance's (AI_*) and workspaces' own keys, in Settings → AI.
  const aiService =
    ai ??
    new AiService({
      config: config.ai,
      outbound: config.outbound,
      cipher: createCipher(config.encryptionKey, 'ai-key'),
      usage: edition.usage,
      entitlements: edition.entitlements,
      db,
      managed: edition.ai,
      logger,
    });
  usageRoutes(routes, { aiCredits: aiService.instanceAvailable });
  // Billing: owners' checkout and portal, the provider's signed webhooks.
  billingRoutes(routes, { db, config });
  baseRoutes(routes, { db, config, email: mail, jobs });
  // Templates: the gallery, installs and "Save as template".
  templateRoutes(routes);
  tableRoutes(routes);
  viewRoutes(routes);
  fieldRoutes(routes);
  trashRoutes(routes);
  recordRoutes(routes);
  commentRoutes(routes);
  notificationRoutes(routes, { db, secret: config.encryptionKey });
  revisionRoutes(routes, { visibility });
  // CSV imports and snapshot restores run in the worker.
  importExportRoutes(routes, { db, jobs });
  const files = objectStore ?? (config.s3 ? new S3ObjectStore(config.s3) : undefined);
  const thumbnails = new ThumbnailJobs(db, files, logger);
  // Malware scanning: with CLAMAV_URL, confirmed uploads wait for the worker's scan.
  const scanning = config.clamav ? { jobs } : undefined;
  attachmentRoutes(routes, { store: files, thumbnails, scanning });
  // Base snapshots, stored next to the attachments under `snapshots/`.
  snapshotRoutes(routes, { db, store: files, jobs });
  // Automations: managed here, run by the worker. Secrets of their actions and webhook
  // URLs are encrypted; webhook-received triggers have a public URL each.
  // Tests and retries run in the request, with the worker's outbound steps.
  const outbound = outboundPolicy(config.outbound);
  const automationCipher = createCipher(config.encryptionKey, 'automation-secret');
  // Run-script steps: the sandbox, when AUTOMATION_SCRIPTS is on (tests may pass one).
  const scripts = scriptSandbox ?? createScriptSandbox(config.scripts);
  const automationDeps = {
    cipher: automationCipher,
    appUrl: config.appUrl,
    checkUrl: createUrlCheck(outbound),
    scripts,
  };
  automationRoutes(routes, {
    ...automationDeps,
    jobs,
    run: {
      db,
      logger,
      scripts,
      outbound: {
        cipher: automationCipher,
        http: createSafeFetch(outbound),
        email: mail,
        emailDailyLimit: config.automationEmailDailyLimit,
      },
    },
  });
  hookRoutes(routes, { db, jobs, limiter, config });
  // Saved scripts and the browser sandbox they run in.
  scriptRoutes(routes);
  // CSV URLs and Postgres sources by the outbound rules; databases over TLS when hosted.
  // : the edition's sync connectors, read with each person's own connected account.
  const sources =
    syncSources ??
    createSyncSources({
      encryptionKey: config.encryptionKey,
      outbound: config.outbound,
      requireTls: config.edition === 'cloud',
      connectors: edition.syncConnectors,
    });
  syncRoutes(routes, { jobs, sources });
  connectorRoutes(routes, {
    db,
    appUrl: config.appUrl,
    encryptionKey: config.encryptionKey,
    sources,
  });
  sandboxRoutes(routes);
  // The base's extension panel and the sandbox extensions run in.
  extensionRoutes(routes, { customBundles: config.extensionsCustomBundles });
  extensionSandboxRoutes(routes);
  // Interfaces: pages built on a base, published to its collaborators.
  interfaceRoutes(routes, { db, appUrl: config.appUrl, email: mail, visibility });
  // Airtable imports: new bases filled by the worker's `airtable.import`.
  airtableRoutes(routes, {
    jobs,
    cipher: createCipher(config.encryptionKey, 'airtable-token'),
    http: airtable?.http ?? createSafeFetch(outbound),
    sleep: airtable?.sleep,
    origin: config.airtable.apiUrl,
    attachmentHosts: config.airtable.attachmentHosts,
  });
  aiRoutes(routes, { ai: aiService, limiter });
  // AI fields: their generation state, regenerate and stop; the worker answers.
  aiFieldRoutes(routes, { ai: aiService });
  // The AI assistant: change plans for a base or a new one, applied on confirm.
  assistantRoutes(routes, { ai: aiService, limiter, automations: automationDeps });
  // Whole-base and account data exports.
  exportRoutes(routes, { db, store: files });
  // Share links: managed by creators, read by anyone holding a token (and the
  // link's password or an allowed email domain, when it asks).
  // Public forms need a CAPTCHA in production.
  shareRoutes(routes, { formsReady: !config.isProduction || Boolean(config.turnstile) });
  sharedRoutes(routes, { db, config, store: files, sessions: store, captcha });
  // Public form links: anyone with the link submits, through the form's allowlist.
  formRoutes(routes, { db, config, store: files, thumbnails, captcha, jobs, scanning });
  // Realtime catch-up; the WebSocket gateway itself is on the HTTP server (index.ts).
  realtimeRoutes(routes, { visibility });
  // The public REST API v1, Airtable's shape.
  // Webhook management is part of it; URLs are checked with the outbound rules.
  const policy = outboundPolicy(config.outbound);
  v1Routes(routes, {
    db,
    appUrl: config.appUrl,
    webhooks: {
      cipher: createCipher(config.encryptionKey, 'webhook-secret'),
      checkUrl: createUrlCheck(policy),
      http: createSafeFetch(policy),
      jobs,
    },
    automations: { ...automationDeps, jobs },
  });

  // OAuth apps: registration, consent, and the token endpoint for the apps.
  oauthRoutes(routes, { db, config });

  // The remote MCP endpoint: the same tools as @openrows/mcp-server, on the API above.
  mcpRoutes(routes, { appUrl: config.appUrl });
  // The docs index for AI agents.
  docsRoutes(routes, { appUrl: config.appUrl });

  // The edition's routes: the hosted edition adds them through the registry, so each has
  // an access rule.
  edition.hooks.run('routes', routes, { config, db, logger });

  // The API description, generated from the same contracts the routes validate with.
  // Public, like the docs of any API: it says what exists, not what anyone may see.
  let openApi: OpenApiDocument | undefined;
  routes.public('GET', OPENAPI_PATH, (c) => {
    openApi ??= openApiDocument(routes.entries, config.appUrl);
    return c.json(openApi);
  });
  // Last: the client's catch-all must not shadow a server route.
  if (config.clientDir) clientRoutes(routes, config.clientDir);

  app.onError(onError);
  app.notFound(notFound);

  const rogue = unregisteredRoutes(app, routes);
  if (rogue.length > 0) {
    throw new Error(
      `routes added outside the route registry (no access rule): ${rogue.join(', ')}`
    );
  }
  return { app, routes, session, store, thumbnails, jobs };
}
