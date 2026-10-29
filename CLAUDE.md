# OpenRows: guide for Claude Code and contributors

OpenRows is an open-source (AGPL-3.0) Airtable alternative. This repository is the whole
open-source core: server, worker, web client, shared packages, SDKs, Docker and Helm files. A
hosted service runs the same core at `app.openrows.io`, plus hosted-only features that live in a
separate, private repository and plug into the core's edition interfaces
([ADR-008](docs/adr/008-repository-split.md)). `AGENTS.md` is a symlink to this file.

Read before starting: this file, the [README](README.md), [CONTRIBUTING.md](CONTRIBUTING.md) and
the [ADRs](docs/adr/README.md). When docs disagree, trust the code, then fix the doc.

## Toolchain

- **Node 22** (`.nvmrc` and `.node-version` say `22`; `engines.node` is `>=22.12.0`, Vite 8 needs
  22.12). Use `nvm use` or any Node 22.
- **npm workspaces only.** `package-lock.json` is the only lockfile. No pnpm, yarn or Bun.
  Install with `npm ci` (or `npm install` when you change dependencies).
- **ESM everywhere** (`"type": "module"`). Server and shared use `NodeNext` resolution, so
  relative imports end in `.js` (`import { x } from './foo.js'`). The client uses bundler
  resolution and extensionless imports.
- **TypeScript 5.9** with project references. Each package's `tsconfig.json` references a build
  config (emits `dist/`) and a test config (type-checks tests). `tsc -b`, never `tsc --noEmit`
  (TS6310 with references).
- **Biome 2** for lint and format (no ESLint, no Prettier). Single quotes, semicolons, width 100.
  `any`, `@ts-ignore` and non-null assertions (`!`) are errors; use `import type` for types.
  Markdown and YAML aren't formatted.
- **Git hooks: lefthook**, installed by `npm install`/`npm ci` (`prepare`, skipped under `CI`).
  pre-commit runs `biome check --write` on staged files; commit-msg runs **commitlint**
  (`@commitlint/config-conventional`).

## Commands

All from the repo root.

| Command | What it does |
| --- | --- |
| `npm ci` | Install (also installs the git hooks) |
| `npm run dev` | Builds `shared`, then watches shared (`tsc --watch`), server (`tsx watch`, port 3000) and client (Vite, port 5173; proxies `/api`, `/auth`, `/health`, `/mcp`, `/llms.txt`, `/scim`). Needs Postgres (see "Dev stack"); no `.env` needed |
| `npm run build` | Builds shared, server and client (`tsc -b`, client also `vite build`) |
| `npm run typecheck` | `tsc -b` over all project references, tests included (`type-check` is an alias) |
| `npm run lint` | `biome check .` (lint + format check), then `npm run lint:brand`. Must pass |
| `npm run lint:brand` | `scripts/check-brand-name.mjs`: users read the name as "OpenRows" (capital O and R). Fails on `openrows`/`Openrows` that isn't part of an identifier (`openrows.io`, `@openrows/sdk`, `openrows-app`, `b_openrows` are fine) in the client's JSX text and visible attributes, `index.html`, the manifest and brand SVG titles, server emails and llms.txt, the Keycloak theme and Markdown prose (root `*.md`, READMEs, `docs/`; code blocks and inline code skipped). |
| `npm run check:packages` | `scripts/check-packages.mjs` (CI's check job and the release workflow): `npm pack --dry-run` of the published packages (sdk, mcp-server, n8n nodes, blocks; build them first) holds only `dist/`, README, LICENSE and package.json, with no source maps, sources, tests, fixtures, `.env*` or local paths, and publishable manifests. Releases: push `sdk-v<version>`, `mcp-server-v<version>`, `n8n-v<version>` or `blocks-v<version>` (the package's version, on main) and `.github/workflows/release-packages.yml` publishes with provenance; never `npm publish` locally |
| `npm run lint:fix` | `biome check --write .` |
| `npm run format` | `biome format --write .` |
| `npm test` | All unit tests in one Vitest process: shared, server, client (jsdom), the `docker` project (Keycloak realm contract, Compose config tests; needs the Docker CLI with Compose v2, no daemon) and the `helm` project (the chart's `helm lint` and golden `helm template` tests; needs the pinned Helm from `deploy/helm/install-tools.sh <dir> helm`, `HELM=<dir>/helm`; `UPDATE_GOLDEN=1` rewrites the golden files) |
| `npm run test:coverage` | Same with v8 coverage into `coverage/` |
| `npm run test:integration` | Server integration tests against real Postgres 16 via Testcontainers. **Needs a Docker daemon.** Run `npm run build -w @openrows/shared` first on a fresh clone (or `npm run build`) |
| `npm run e2e` | Playwright suite against the built server serving the built client (`CLIENT_DIR`, CSP enforced; `E2E_PORT`, default 4173). Run `npm run build` first. First time: `npx playwright install chromium`. Specs import `test`/`expect` from `e2e/helpers/test.ts`, which fails a test on any CSP violation |
| `npm run e2e:auth` | Opt-in sign-up/sign-in flow through Keycloak and Mailpit. Needs the dev stack up and `npm run build` |
| `E2E_STACK=1 E2E_BASE_URL=http://localhost:8180 npm run e2e` | Smoke + the stack specs (`stack`, `shell`, `home`, `links`, `computed`, `realtime`, `presence`, `sharing`, `share-links`, `shared-layouts`, `embeds`, `public-forms`, `comments`, `activity`, `notifications`, `exports`, `tokens`, `oauth`, `account-deletion`, `api-v1`, `webhooks`, `automations`, `automations-builder`, `view-layouts`, `view-access`, `airtable-import-stack`, `templates`, `interfaces`, `interfaces-shared`, `usage`, `cookies`, `notices`, the `golden-path` and `seed` specs) against the running Compose dev stack (`npm run build` first: the seed and notices specs run `packages/server/dist/seed/cli.js` and `dist/notices/cli.js`). CI runs it sharded in `docker/compose.sh ci` stacks |
| `npm run db:generate` | `drizzle-kit generate`: a new migration from `packages/server/src/db/schema.ts` |
| `npm run lint:openapi` | Redocly's `recommended` rules over the OpenAPI document the server serves (generated without a database; CI's check job). Needs `npm run build -w @openrows/shared` |
| `npm run eval:ai` | The AI assistant's formula evals (`packages/server/evals/formula/*.jsonl`) against a real provider: `AI_MODEL`, `AI_API_KEY`, `AI_BASE_URL` (default OpenAI's); prints the pass rate, exits 1 below 90%. `-- --recorded` replays the recordings (as CI's unit test does), `-- --record` saves new ones. Never prints the key |
| `npm run db:check` | Fails if `schema.ts` and `packages/server/drizzle/` drift (CI runs it). Fix with `db:generate` and commit the result |
| `npm run db:migrate` | Applies migrations (`MIGRATION_DATABASE_URL` or `DATABASE_URL`, advisory lock) and sets the `openrows_app` password |
| `npm run db:seed -- --email <address>` | Gives that user (signed in once) the "Product Roadmap (demo)" workspace: 5 tables, 31 fields, 2,000 records (`DATABASE_URL`, idempotent; `node dist/seed/cli.js` in the image) |

Single test: `npx vitest run packages/server/src/config.test.ts`, or by name:
`npx vitest run -t "name"`. Single integration file:
`npm run test:integration -- test/integration/workspaces.test.ts` (paths relative to
`packages/server`).

## Repository layout

```
packages/
  shared/   @openrows/shared: Zod schemas (src/schemas/), types (src/types/), the action/role
            table (src/authz.ts), the error-code catalog (src/errors.ts), the field-type registry
            (src/fields/; markdown.ts: the rich text sanitizer and parser), form views
            (src/forms/: the `config.form` schema, form field types, conditions evaluated in
            memory; public.ts: public form submissions, uploads and prefill; link
            pickers and publicFormFieldProblem), comment bodies
            (src/comments.ts: sanitizeComment, parseComment, mention tokens), the formula parser and type checker (src/formula/: AST by field
            id, stored/display forms, function catalog, golden files in __golden__) and evaluator
            (evaluate.ts, the function library in formula/functions/, REGEX_* on re2js),
            the AI assistant's change plans (src/assistant/: the plan schema, checkPlan,
            checkFormulaSuggestion), browser scripts (src/scripts/: sandbox.ts, the worker's
            Airtable-like API serialized into the sandbox document; protocol.ts, the messages and
            SCRIPT_RUN_LIMITS; samples.ts; api.ts, the editor's API reference), extensions
            (src/extensions/: manifest.ts (scopes, limits, the manifest and bundle
            schemas), protocol.ts (the frame's messages, EXTENSION_METHOD_SCOPES), runtime.ts
            (the frame's bootstrap and `window.openrows`, serialized into the sandbox document),
            samples.ts (BUILT_IN_EXTENSIONS: chart, print view, URL preview)), interfaces (src/schemas/interface.ts: pages' layouts, filters and grid
            elements: number and chart elements, the data route's shapes), templates (src/templates/: format.ts, the versioned `openrows.template` document
            and its Zod schema; define.ts, defineTemplate: keys to stable ids; builtin/: the 10
            built-in templates, BUILT_IN_TEMPLATES), automations (src/automations/: schedule.ts, cron and intervals in a time zone with
            DST rules; template.ts, the `{{trigger...}}`/`{{steps.N...}}` tokens, never eval;
            schemas/automation.ts), the ViewQuery
            spec (src/query/; `within` and `dateRange`), CSV parse/write and type inference
            (src/csv/), the endpoint contracts (and `downloads`, the file routes), typed
            client builder and OpenAPI generator (src/contracts/; v1/: the REST API v1). Built to dist/ by tsc;
            server and client import the built output, so rebuild shared after changing it
  server/   @openrows/server: Hono on @hono/node-server
    src/index.ts, app.ts     entry and createApp (all routes registered here); index.ts and
                             worker.ts only call startApi() (main.ts) and startWorkerProcess()
                             (worker-main.ts), which the hosted edition calls with its providers
    src/edition/             the open-core plug-in interfaces (ADR-005): types.ts
                             (EntitlementsProvider, BillingProvider, UsageMeter, EditionHooks),
                             oss.ts (the OSS defaults: unlimited, no billing, a meter that never
                             blocks), hooks.ts (HookRegistry; `routes`: extra routes through the
                             RouteRegistry), index.ts (resolveEdition: EDITION=cloud needs the
                             hosted providers); `c.var.edition` in handlers;
                             `@openrows/server/edition` is what the hosted edition imports
    src/billing/             billing: store.ts (applyBillingEvent: a verified provider event in
                             one transaction: `billing_event_claim`, the subscription unless a newer
                             or ended one is stored, the plan via `workspace_plan_set`), routes.ts
                             (owners' GET /api/workspaces/:workspaceId/billing, POST .../checkout and
                             .../portal, PATCH .../billing/subscription (plan, interval, cancel);
                             the public POST /api/billing/:provider/webhooks, verified by
                             the edition's BillingWebhooks); seats.ts (the debounced
                             `billing.seats` job, seats = billable editors), dunning.ts (the
                             hourly `billing.dunning`: 14-day grace, owner emails, Free fallback);
                             the provider itself (Polar) is the hosted edition's
    src/usage/               plans' usage: counters.ts (table_record_counts: addRecords from the
                             RecordService in the write's transaction, recountTable after writes
                             around it, the worker's daily `usage.reconcile`), service.ts
                             (workspaceUsage: records per base, files, this month's automation runs
                             and API calls, billable editors), routes.ts (GET
                             /api/workspaces/:workspaceId/usage), quota.ts (enforcement,
                             "read and edit, no new data": assertRecordRoom (RecordContext's
                             required `entitlements`), attachment room, monthly runs and API
                             calls, editor seats, plan features, the revision history window;
                             QUOTA_EXCEEDED / PLAN_FEATURE_REQUIRED), warnings.ts (the
                             worker's hourly `usage.warnings` and per-workspace `usage.check`: owners
                             emailed once per limit, level (80%/100%) and month,
                             `usage_warnings_sent`; routes.ts also has GET
                             /api/bases/:baseId/usage-warnings, the base banner's); edition/plan.ts: the stored plan
                             (`workspaces.plan`, `plan_overrides`, set only through
                             `workspace_plan_set`)
    src/worker.ts            worker process: pg-boss jobs (src/jobs/), GET /health and
                             /metrics on WORKER_PORT (3001), graceful SIGTERM
    src/jobs/                background jobs on pg-boss (ADR-004; run-cli.ts: queue one run
                             of a cron job now): queues.ts (JOB_QUEUES:
                             cron, retries, dead-letter queues), install.ts (the pgboss schema,
                             from runMigrations), runtime.ts (startWorker, builtinQueues: the
                             relay, prunes and snapshots), tenant.ts (withTenant, tenantJob: RLS
                             in jobs), relay.ts (the outbox relay, OUTBOX_SUBSCRIBERS: webhooks,
                             background recomputes), computed.ts (computed fields past
                             COMPUTED_SYNC_LIMIT, the NOW()/TODAY() refresh), send.ts
                             (the Jobs interface: send in the request transaction), status.ts
                             (the `jobs` rows of imports and restores), http.ts
    src/migrate.ts           migrate one-shot (Drizzle migrations, then pg-boss's schema)
    src/config.ts            Zod-validated env (dev defaults; production refuses defaults)
    src/auth/                OIDC (BFF + PKCE), sessions, rate limit, requireSession (cookie or
                             `Authorization: Bearer or_pat_…`; tokens.ts: personal access
                             tokens)
    src/audit/               the workspace audit log's recording: record.ts (`audit(c, tx, ...)`
                             in the change's transaction, `auditForUser` for sign-ins and tokens);
                             the edition's AuditSink keeps them (none in OSS)
    src/auth/ also asks the edition's `SingleSignOn` (edition/types.ts; `noSso` in OSS):
                             `/auth/login?email=` → `kc_idp_hint`, and the callback's decision
                             (`identity_provider` claim, require SSO, JIT)
    src/regions/             data residency: routes.ts (GET /api/regions,
                             POST /api/regions/:regionId/workspaces through the edition's
                             DataResidency; Enterprise owners on the home region only)
    src/policies/            workspace policies: repo.ts (readWorkspacePolicies; the write checks:
                             assertShareAllowed for new links and embed origins, assertInviteAllowed
                             for invitations); tokens are refused in authorize() (`tokensAllowed` from
                             authz_resolve), dead links in share_resolve; authz/activity.ts: the member
                             activity withResource touches; the routes that set them are the hosted edition's
    src/admin/               the core side of the ops console: audit.ts (appendAdminAudit),
                             impersonation.ts (start/end on the admin's session), routes.ts
                             (GET /api/me/support-access, DELETE /api/me/impersonation)
    src/notices/             service notices: service.ts (Terms, privacy, price and plan
                             notices: the banner list and dismissal, createNotice with the Terms'
                             least notice, NOTICE_MIN_DAYS, sendNotice: every account or owner
                             once, logged per run), routes.ts (GET /api/me/notices, POST
                             .../:noticeId/dismiss), cli.ts (the operator's `notices` command:
                             create, send [--dry-run], list, withdraw)
    src/account/             deleting your account: routes.ts (GET /api/me/deletion, POST
                             /api/me/delete: recent sign-in, typed email, sole-owner refusal)
    src/purge/               hard deletion: service.ts (the worker's `purge.deleted`:
                             accounts and workspaces marked deleted, files by prefix, record
                             schemas, rows; `purge.trash`: trash past 30 days), identity.ts
                             (Keycloak admin API: deletes the purged account's user)
    src/tokens/              personal access token management: routes.ts (/api/me/tokens,
                             session only), service.ts (list, create with grant checks, revoke)
    src/oauth/               OAuth apps (docs/api/oauth.md): secrets.ts (client ids and
                             secrets, codes, `or_oat_`/`or_ort_` tokens, PKCE S256), service.ts
                             (apps, authorizations, consent, the code exchange and refresh
                             rotation with replay revocation, resolveOAuthToken for bearer auth),
                             routes.ts (session /api/me/oauth-apps, /api/me/authorizations,
                             /api/oauth/authorize; public /oauth/token, /oauth/revoke and the
                             RFC 8414 metadata); the consent page is the client's /oauth/authorize
    src/ratelimit/           the API's rate limits: limiter.ts (RateLimiter, token buckets,
                             headers; MemoryRateLimiter), postgres.ts (PostgresRateLimiter: the
                             UNLOGGED rate_limit_buckets through rate_limit_take, shared by every
                             instance; prunes), admission.ts (apiAdmission, run by requireSession:
                             per token on any route or user on /api/v1, per reachable base on v1)
    src/webhooks/            webhooks (docs/api/webhooks.md): routes.ts (management under
                             /api/v1/bases/:baseId/webhooks, ping), service.ts (CRUD, URL and
                             filter checks, the encrypted secret), subscriber.ts (the outbox
                             subscriber, prune), deliver.ts (the webhooks.deliver job: creator
                             access, signed POST via safe-fetch, log, auto-disable + email),
                             payload.ts, signature.ts (HMAC, verify)
    src/automations/         automations: service.ts (CRUD, configs checked against the
                             base, arming: the match set, the next scheduled run), routes.ts
                             (/api/bases/:baseId/automations, creators, sessions only),
                             subscriber.ts (the outbox subscriber, `automations.schedule`, the
                             prune), run.ts (the `automations.run` job: one transaction, steps in
                             savepoints through the RecordService as the creator, the loop guard
                             by `app.automation_depth`, idempotency keys: testAutomation and
                             retryRun, in the request, as the caller): hooks.ts (the
                             public POST /hooks/a/<token> of webhook-received triggers: 100 KB
                             JSON, per-IP and per-URL limits), outbound.ts (send email with the
                             daily cap, HTTP request and Slack message through safe-fetch),
                             secrets.ts (secret headers and Slack URLs encrypted apart from the
                             actions, hook tokens); the button click route is in routes.ts; script/ (the
                             run-script step's sandbox: types.ts (ScriptExecutor, ScriptSandbox:
                             the plan hook), local-container.ts (one locked-down `docker run` per
                             script), runner.ts (what runs inside, serialized into `node -e`),
                             supervise.ts (the stdio protocol and limits), bridge.ts (the script's
                             base and fetch calls, run as the run's person); off unless
                             AUTOMATION_SCRIPTS, docs/deploy/automation-scripts.md)
    src/scripts/             browser scripts: routes.ts + service.ts (saved scripts under
                             /api/bases/:baseId/scripts: editors read, creators write), sandbox.ts
                             (the public, static GET /sandbox/script: its CSP `sandbox
                             allow-scripts`, no network, the inline script by hash)
    src/extensions/          extensions: service.ts + routes.ts (installations under
                             /api/bases/:baseId/extensions: everyone on the base reads, creators
                             install, arrange and remove, editors change settings; third-party
                             bundles per EXTENSIONS_CUSTOM_BUNDLES), sandbox.ts (the public, static
                             GET /sandbox/extension; `?embed=1` for `embed:frames`)
    src/syncs/               synced tables: service.ts (create: the source re-read in its
                             workspace's scope, the table with copied fields and its Sync source
                             field; schedule, pause, remove; queueRun; `syncs.schedule` through
                             `table_syncs_due`), run.ts (the worker's `syncs.run`: access
                             re-checked, pauses, upserts and deletes by key through the
                             RecordService with `ctx.sync`, idempotent), routes.ts; sources/
                             (csv.ts, a CSV URL through safe-fetch with conditional GETs;
                             postgres.ts, a table or SELECT on a pinned, checked address
                             (safe-fetch's createHostCheck), READ ONLY, statement timeout,
                             cursor pages, row and byte caps; index.ts: checkSource, the preview,
                             the encrypted `sync-source` secret; createSyncSources:
                             connectors.ts, the generic SyncConnector plug-in point (the edition's
                             `syncConnectors`), per-person accounts in `sync_connector_accounts`,
                             token refresh), connector-routes.ts (/api/me/sync-connectors: list,
                             connect + callback with PKCE, disconnect); the picker's
                             POST /api/bases/:baseId/syncs/browse is in routes.ts
    src/interfaces/          interfaces: service.ts (interfaces and pages, drafts checked
                             against the base, publish/unpublish; non-creators get published
                             pages only), routes.ts (/api/bases/:baseId/interfaces, sessions only
: the interface's own /api/interfaces/:interfaceId routes on the
                             `interface` resource kind), data.ts (dashboards'
                             numbers and charts through the RecordService's summaries,
                             `aggregateRecords`/`groupRecordValues`; chartRows: caps, "Other")
: runtime.ts (a page's records projected like a share link's,
                             the page filter with `me` as the viewer; edits and form submissions
                             limited to the page), collaborators.ts (interface-only collaborators,
                             `interface_members`; invitations through workspaces/service.ts)
    src/templates/           templates: install.ts (a template → snapshot header + record and
                             link lines → restoreBase, formulas by name stored by id in its
                             `beforeRefresh`), export.ts ("Save as template": a base in the
                             format), routes.ts (GET /api/templates[/:slug], POST
                             /api/workspaces/:workspaceId/templates, GET /api/bases/:baseId/template.json)
    src/ai/                  AI providers: provider.ts (AiProvider: chat completions with
                             Zod-schema structured output and token usage; the OpenAI-compatible
                             one through safe-fetch; AiProviderError never carries the key or the
                             provider's text), service.ts (AiService: the workspace's own key in
                             `workspace_ai_settings`, encrypted (`ai-key`), else the instance's
                             AI_*; AI_ALLOWED_HOSTS; `forWorkspace` meters `aiTokens` on the
                             instance's provider), routes.ts (/api/workspaces/:id/ai, owners'
                             .../ai/settings and its test); __fixtures__/fake-openai.ts for tests;
                             assistant/: plan.ts (generatePlan: structured change plans,
                             checked with shared's checkPlan, one more round for formulas that
                             don't type-check), formula.ts (generateFormula), schema.ts (what the
                             model reads: the schema, records only on opt-in), apply.ts (the
                             confirmed plan through the services, one transaction), routes.ts
                             (/api/bases/:baseId/assistant/*, /api/workspaces/:id/assistant/*),
                             evals.ts + eval-cli.ts (the formula evals of evals/formula/*.jsonl,
                             `npm run eval:ai`);
                             fields/ (AI fields): repo.ts (cells marked pending in the
                             write's transaction, `ai.requested`/`ai.status` events), service.ts
                             (prompt checks, backfill, status/generate/cancel), generate.ts (the
                             worker's `ai.generate`: per table, batched, rate-limited, as the
                             field's creator; quota and errors keep values), routes.ts
    src/airtable/            the Airtable importer: client.ts (Airtable's Web API through
                             safe-fetch, AIRTABLE_API_URL only, 5 req/s, 429 back-off; file
                             downloads from AIRTABLE_ATTACHMENT_HOSTS only), mapping.ts (Airtable
                             field types and options → ours, formula references, links, lookups,
                             rollups, counts), schema.ts (the schema step: tables, links and
                             inverses, computed fields in rounds, grid/kanban views), files.ts
                             (attachments copied per page, sniffed, thumbnails), import.ts (the
                             request's new bases + encrypted-token jobs, the worker's
                             `airtable.import`: schema, records by page with the record map
                             `airtable_import_records`, the links pass; cancel), routes.ts;
                             __fixtures__/ (the recorded-fixture fake of Airtable and a generated
                             20k-record base, for tests)
    src/v1/                  the public REST API v1 (Airtable's shape, docs/api/v1.md):
                             routes.ts (resource routes on the base, then authorizeTable),
                             records.ts (names ⇄ ids, cells via the registry's apiValue, list,
                             upsert, PUT), meta.ts, formula-filter.ts (filterByFormula → a
                             Predicate the query compiler runs as SQL), errors.ts ({ error })
    src/mcp/                 the remote MCP endpoint (docs/api/mcp.md): routes.ts (POST /mcp,
                             Streamable HTTP, stateless; personal access tokens only through
                             `routes.token`; the @openrows/mcp-server tools on @openrows/sdk,
                             calling /api/v1 in process with the caller's token)
    src/docs/                llms.ts: the public GET /llms.txt (the docs index for AI agents)
    src/indexes/             field indexes for saved views (ADR-001): plan.ts (which
                             indexes views' sorts, groups and filters want, per-table caps),
                             sync.ts (the worker's `indexes.sync`: CREATE/DROP INDEX
                             CONCURRENTLY on INDEX_DATABASE_URL, statements from the DDL
                             functions of drizzle/0049_field_indexes.sql)
    src/authz/               central authorization: policy, resolver, RouteRegistry, scope
    src/db/                  Drizzle client and schema.ts (the metadata schema)
    src/<domain>/routes.ts   feature routes: workspaces/ (+ service.ts: members, invitations,
                             personal workspace; collaborators.ts: the directory), bases/ (duplicate.ts: the
                             `bases.duplicate` job, on the snapshot restore's engine), tables/, fields/ (+ service.ts; link-conversion.ts: conversions to and from links),
                             records/ (+ service.ts, the RecordService, repo.ts, links.ts:
                             link specs, name matching and junction writes, and
                             permissions.ts: table/field edit permissions on every write),
                             views/ (+ service.ts: CRUD, duplicate, typed config checked on
                             write and pruned on read, personal and locked rules; sections.ts:
                             sidebar sections; visibility.ts: `visibleTo`, the personal-view
                             filter every view lookup uses)
    src/attachments/         attachments: S3 object store (storage.ts), presigned uploads,
                             confirm, signed downloads and storage usage (service.ts), image
                             thumbnail jobs with sharp (thumbnails.ts, in-process until M4),
                             the worker's garbage collection of unreferenced files (gc.ts);
                             malware scans (CLAMAV_URL): scan.ts (the clamd INSTREAM client,
                             fail-closed), scan-job.ts (the worker's `attachments.scan` and its
                             sweep: `scanning` → `ready` or `infected`, quarantined)
    src/comments/            record comments: routes.ts (under the record, on the table),
                             service.ts (author/moderator rules, mention access, reactions,
                             outbox events; `comment.mentioned` for notifications)
    src/notifications/       notifications: repo.ts (created in the writer's transaction:
                             comments, user cells with notify; NOTIFY per recipient), service.ts
                             (inbox, unread, read, preferences, the access re-check), mailer.ts
                             (the worker's `notifications.email`: throttled, coalesced emails;
                             `notifications.digest.hourly`/`.daily`: digests),
                             unsubscribe.ts (signed one-click tokens), routes.ts (+ public
                             /email/unsubscribe)
    src/shares/              view and base share links: service.ts (hashed tokens,
                             create/list/update/revoke, withShare: the token re-resolved through
                             `share_resolve` per request, a read-only transaction scoped to its
                             workspace, then the access checks; withSharedView: one view of the
                             link: sharedViewShape in shared's schemas/share.ts), access.ts (argon2id passwords, the signed unlock cookie,
                             email-domain checks), routes.ts (the creators' routes and the public
                             /api/shared/* router, rate-limited per IP and token, unlock per link
                             and IP; CSV download; GET /embed/:shareToken: index.html framed
                             only by the link's embed origins, `frameAncestors` read by
                             lib/security-headers.ts); the projection is
                             compileSharedView/sharedRecords in records/service.ts
    src/forms/               public forms: routes.ts (the public /api/forms/:formToken
                             routes: form, submissions, uploads, cover/logo, a link field's
                             record picker; rate limits, body cap, Turnstile), service.ts
                             (loadForm: the layout as the allowlist;
                             submitForm: conditions, required, uploads, idempotency, one record
                             through the RecordService as the "Form" actor), turnstile.ts
    src/trash/               the trash: routes.ts (workspace trash of bases, base trash of
                             tables/fields/views, a table's record trash; restore and delete
                             permanently, through the services: bases/, tables/, fields/,
                             views/ and the RecordService), service.ts (the listings)
    src/snapshots/           base snapshots: format.ts (gzipped JSON lines), writer.ts
                             (takeSnapshot: one REPEATABLE READ read, paged, streamed to S3 under
                             snapshots/), restore.ts (to a new base: ids remapped through temp
                             tables, attachments share object keys, computed fields recomputed),
                             service.ts, routes.ts, jobs.ts (the worker's daily snapshots and
                             retention prune), restore-job.ts (restores run by the worker)
    src/revisions/           record revision history: repo.ts (writeRevisions, called by the
                             RecordService in the write's transaction; coalescing; the prune),
                             service.ts (list with hidden fields left out, restore through
                             updateRecords), retention.ts (REVISION_RETENTION_DAYS)
    src/realtime/            realtime (ADR-003): gateway.ts (the /ws WebSocket gateway: Origin
                             + session cookie at upgrade, subscribe authz, limits, revocation),
                             bus.ts (EventBus; Postgres LISTEN bus, redis stub by EVENT_BUS;
                             presence over NOTIFY without storage),
                             projection.ts (the event filter: personal views, FieldVisibility),
                             routes.ts (GET /api/bases/:baseId/events catch-up)
    src/import-export/       CSV import (import.ts: checked in the request, run by the worker's
                             `imports.run` job, resumable by batch) and the streaming CSV
                             export of a view (export.ts),
    src/export/              data export: zip.ts (streaming ZIP writer), base.ts (a whole
                             base: schema.json, CSV + JSON lines per table, attachments),
                             account.ts (profile, memberships, comments, owned bases), routes.ts
                             (GET /api/bases/:baseId/export.zip, GET /api/me/export.zip, limiter)
    src/data/                DDL manager (ddl.ts), outbox (outbox.ts), record-column helpers,
                             links.ts (SQL over link junctions), positions.ts (a view's
                             manual record order), query/ (the ViewQuery
                             compiler and executor), computed/ (the field dependency
                             graph and the lookup/rollup/count recompute engine; formula.ts:
                             formula fields; past the sync limit, pages in the worker)
    src/lib/                 errors (problem+json), logger (pino), context, validate (readJson),
                             safe-fetch/ (the SSRF-safe client, the only way to request a
                             user-chosen URL; boundary.test.ts forbids fetch/undici/node:http(s)
                             clients elsewhere)
    src/email/               SMTP transport and escaping templates
    src/seed/                demo seed: the Product Roadmap template and seedDemo, through
                             the services; cli.ts is `npm run db:seed`
    drizzle/                 migrations (generated + hand-written) and meta/
    test/helpers/            Testcontainers DB, factories, testApp, mock OIDC issuer
    test/integration/        integration suite (npm run test:integration)
  client/   @openrows/client: React 19, Vite 8, TanStack Router + Query, Tailwind 4
    src/router.tsx           code-based routes and guards
    src/app/                 the app shell (drawer below 768 px, rail
                             to 1023 px, NavToggle in the top bars): Shell, sidebars, HomePage, BasePage, SettingsPage,
                             CommandPalette (Ctrl/Cmd K), CreateView (the view type picker), ErrorPage, WorkspaceSwitcher, MembersPage,
                             InvitePage (/invite/:token); routes in src/router.tsx
    src/features/grid/       the grid view (ADR-007): Grid.tsx (virtualized rows/columns),
                             selection.ts (selection + keyboard model), layout.ts (columns),
                             windowing.ts + useWindowedRecords.ts (paged view queries),
                             clipboard/ (TSV/HTML copy, paste and fill planning),
                             history/ (undo/redo log of inverse bulk patches)
                             cells/: CellContent (renderer) and CellEditor per registry
                             editor kind (LinkEditor: the link picker), model.ts (registry
                             helpers)
    src/features/fields/     field management: FieldEditor (popover form), TypePicker,
                             FieldOptions + ChoiceEditor, ConversionPreview, useFieldManagement
                             (header menu actions, delete + undo), model.ts, icons.ts,
                             formula-editor/ (CodeMirror 6 FormulaEditor, lazy-loaded;
                             model.ts: completions, signature help, errors, preview)
    src/features/record/     the record expand view: RecordExpand (modal or side panel,
                             every field with the cell editors, prev/next, ?record=<id> deep
                             link, copy link, delete + undo), model.ts; comments/:
                             CommentsPanel (list, reactions, composer with @mentions), model.ts
                             activity/: ActivityPanel (revisions + comments, restore a
                             value or the record), model.ts
    src/features/views/kanban/   the kanban view: Kanban (stacks as windowed, virtualized
                             view queries; drag and Alt+arrow moves), KanbanToolbar, model.ts
    src/features/views/calendar/ the calendar view: Calendar (month/week/day, drag, resize,
                             keyboard moves, undated panel), CalendarToolbar, model.ts (day math,
                             time zones, events, lanes, move/resize patches)
    src/features/views/gallery/  the gallery view: Gallery (virtualized rows of cards, cover
                             image, card fields and size), model.ts
    src/features/views/timeline/ the timeline/Gantt view: Timeline (bars by start/end, day/
                             week/month zoom, grouping, pointer drag and resize, dependency
                             arrows), model.ts (windows, ticks, rows, dependencies)
    src/features/views/list/     the list view: List (tree nested by a self link), model.ts
    src/features/views/form/     the form view builder: FormView (field list with drag and
                             Alt+arrow reorder, per-field settings and conditions), FormSettings,
                             FormPreview (live, conditional fields follow the answers), model.ts
    src/features/views/toolbar/  the view toolbar: ViewToolbar (hide fields, filter, group,
                             sort, row height, find), FilterMenu, SortMenu (+ GroupMenu),
                             HideFieldsMenu, RecordFilterPicker (link filters by record),
                             useViewQuery (saved query + local changes), model.ts,
                             LayoutToolbar (the gallery/timeline/list toolbar)
    src/features/views/rowColor/ row colours: RowColorMenu (the toolbar's Color),
                             useRowColor, model.ts; views/access.ts: canConfigureView (locked
                             views)
    src/features/attachments/ uploads: upload.ts (announce, PUT to the presigned URL,
                             confirm; download and thumbnail URLs)
    src/features/permissions/ edit permissions: model.ts (useEditRights, locks),
                             PermissionPicker, FieldPermissionsDialog, TablePermissionsDialog
    src/features/collaborators/ the collaborator directory: CollaboratorsProvider (per
                             workspace query), UserChip/UserCell (avatar + name), model.ts;
                             ShareBaseDialog + share-model.ts (the base's Share dialog)
    src/features/share/      share links: ShareViewDialog (ShareLinks: the view menu's
                             "Share view" and the base Share dialog's whole-base links; password,
                             domains, copy/download toggles), SharedViewPage (the public /s/:token
                             page: password form, sign-in prompt, table tabs, read-only grid; with
                             `embed`, the compact /embed/:token?theme= page),
                             SharedLayouts.tsx (read-only kanban, calendar, gallery,
                             timeline and list on the app views' models), SharedCell.tsx, model.ts
                             (embed code, embed origins)
                             PublicFormPage (the public /f/:token form), FormLinkDialog
                             (a form view's "Share form"), form-model.ts
    src/features/trash/      the trash: TrashDialog (BaseTrashDialog from the base menu:
                             records per table, fields, views, tables; WorkspaceTrashDialog from
                             Home's sidebar: bases), model.ts (purge status, roles)
    src/features/snapshots/  the base menu's Snapshots dialog: Snapshot now, restore to a
                             new base, delete, retention; model.ts
    src/features/duplicate/  the base menu's "Duplicate base" dialog: name, target
                             workspace, records option, the job's progress; model.ts
    src/features/interfaces/ interfaces (/b/:baseId/interfaces, lazy): InterfacesPage (page
                             list, new-page dialog, Edit/Preview/Publish, the page view: record
                             list or record review, the designer's panel), Canvas.tsx (the
                             12-column element grid: drag, resize, Alt+arrows; text, filter,
                             button and field elements), model.ts: Charts.tsx (number and
                             SVG charts, `--chart-1..6` in index.css), chart-model.ts,
                             DataElementSettings.tsx, useDashboardData.ts (the page's data, live)
: PageRuntime.tsx (pages through the interface's routes: forms,
                             kanban/calendar/timeline on share/SharedLayouts.tsx, interface-only
                             viewers' lists and reviews), InterfaceApp.tsx (/i/:interfaceId, an
                             interface on its own), LayoutSettings.tsx, ShareInterfaceDialog.tsx
    src/features/templates/  the template gallery: TemplateGallery (categories, tiles, the
                             preview, "Use template"; Home and the new-base dialog), model.ts,
                             useInstallTemplate
    src/features/account/    Settings → "Delete account": DeleteAccount (the dialog: owned
                             workspaces' fate, the password prompt, typed email), model.ts
    src/features/tokens/     Settings → "Developer: personal access tokens": AccessTokens
                             (list with requests per day, create form, copy-once dialog,
                             revoke), model.ts
    src/features/oauth/      OAuth apps: ConsentPage (/oauth/authorize), Integrations.tsx
                             (Settings → Integrations: authorized apps; "Developer: OAuth apps":
                             register, secret once, rotate, delete), model.ts
    src/features/api-docs/   the public API reference at /docs/api: ApiDocsPage (guides,
                             every operation of /api/openapi.json, filter, deep links; the
                             "From Airtable" page at /docs/api/from-airtable; the SDK's page at
                             /docs/api/sdk from sdk-reference.json + sdk-model.ts), guides.tsx,
                             model.ts (OpenAPI → tags and operations, schema summaries)
    src/features/webhooks/   the base menu's Webhooks dialog: list, create, secret once,
                             test ping, rotate, delivery log; model.ts
    src/features/extensions/ the base's extension panel: ExtensionsPanel (the base top bar's
                             Extensions: cards with sandboxed frames, Add extension, arrange, size,
                             remove), host.ts (scope checks per call, the records API as the
                             signed-in person, cursor/settings/theme/records events)
    src/features/syncs/      synced tables: SyncDataDialog (the sidebar's "Sync data"
: ExternalSource, a CSV URL or Postgres source's preview and
                             column mapping),
                             SyncBar (the table header's source, status, Sync now, settings),
                             model.ts
    src/features/scripts/    the Scripts page (/b/:baseId/scripts, lazy): ScriptsPage (list,
                             samples, Run/Stop, output, inline prompts), ScriptEditor (CodeMirror,
                             completions from model.ts), host.ts (the sandboxed frame, the checked
                             call handler, per-run limits; calls go through the records API)
    src/features/automations/ the automations builder (/b/:baseId/automations, lazy):
                             AutomationsPage (list with on/off, last run, runs; the editor),
                             steps.tsx (trigger and action cards), TokenInput (the {{…}} token
                             picker), RunPanel (Test with a sample record, run history, Retry),
                             model.ts (defaults, tokens, 422 errors by card)
    src/features/usage/      the workspace's Usage page's model (app/UsagePage.tsx,
                             /w/:workspaceId/usage): meters, history windows, feature labels;
                             Billing.tsx + billing-model.ts (app/BillingPage.tsx,
                             /w/:workspaceId/billing, owners), PaymentBanner.tsx (past due);
                             UsageBanner.tsx (the 80%/100% banners of a workspace's home and a
                             base, owners and creators, dismissible)
    src/features/notifications/ the top bar's bell and inbox popover: NotificationBell,
                             model.ts
    src/features/richtext/   the WYSIWYG rich text editor (TipTap, lazy chunk): RichTextEditor,
                             extensions.ts (the subset's schema), markdown-doc.ts (Markdown ⇄
                             editor document), paste.ts (pasted HTML cleaned in an inert document)
    src/features/ai-fields/  AI fields: AiCell.tsx (the grid cell with its state, the record
                             view's Regenerate, the column menu's generate/stop items), model.ts,
                             useAiFieldsAvailable (the type picker offers AI only with a provider)
    src/features/assistant/  the AI assistant: AssistantDialog (BaseAssistantDialog, the base
                             top bar's "Assistant"; DescribeBaseDialog, Home's "Describe it": the
                             prompt, the plan as a list of additions to tick, Apply), model.ts
    src/features/admin-console/ the workspace admin console (app/AdminConsolePage.tsx,
                             /w/:workspaceId/admin, owners): AdminConsole.tsx (policies, SSO and SCIM
                             status, people across bases), model.ts; `workspaceAdminApi` in api/client.ts
    src/features/audit/      the workspace audit log (app/AuditLogPage.tsx, /w/:workspaceId/audit-log,
                             owners): AuditLog.tsx (filters, entries, exports, the SIEM stream), model.ts;
                             `auditApi` in api/client.ts
    src/features/ai/         Settings → AI (app/AiSettingsPage.tsx, /w/:workspaceId/ai, owners):
                             AiSettings.tsx (the provider in use, Test connection, the
                             bring-your-own-key form; the key is write-only), model.ts;
                             useAiAvailability in api/queries.ts hides AI features when off
    src/features/airtable/   Home's "Import from Airtable": AirtableImportDialog (token, pick
                             bases, your imports with progress and the report), model.ts
    src/features/import/     CSV import dialog: ImportDialog (preview, column mapping,
                             progress), model.ts (mapping and request)
    src/features/realtime/   live updates (ADR-003): connection.ts (the tab's one WebSocket,
                             backoff, resume via catch-up), apply.ts (patches the query caches by
                             record id), RealtimeProvider (useRealtimeSubscription,
                             useRealtimeStatus, usePresencePeers), ConnectionStatus (top bar dot,
                             offline banner), Presence.tsx + presence-model.ts (who else is
                             on the view, their selected cell, "editing…", record header avatars)
    src/pages/               auth/LoginPage
    src/components/ui/       shadcn/ui-style primitives on Radix/cmdk/sonner, styled with the
                             Ledger tokens (src/index.css); add new ones by hand, use cn()
    src/api/                 client.ts (typed API from the contracts, ApiError), keys.ts
                             (query-key factory), queries.ts (hooks), records.ts (optimistic edits),
                             clientOps.ts (clientOpIds, to skip realtime echoes)
    src/lib/                 auth.ts, theme.ts (light/dark), media.ts (breakpoints and
                             useMediaQuery), swipe.ts (drawer swipes), utils.ts (cn)
    src/sw/                  the service worker: policy.ts (what is kept, for whom),
                             handlers.ts (precached shell, network-first API reads kept per user,
                             cleared on 401/another user), worker.ts (the global scope; built to
                             /sw.js by vite/service-worker.ts with the precache list, own
                             tsconfig.sw.json, production builds only)
    src/features/offline/    offline.ts (offline state, clearOfflineData, registration),
                             OfflineBanner ("Offline, read-only."), SignOutForm (every sign-out:
                             clears the offline data, then POSTs /auth/logout)
  sdk/      @openrows/sdk: the typed JS client of the REST API v1 (ESM + CJS, no runtime
            deps, Node 20+ and browsers; README.md). src/client.ts (OpenRows, Table, Query,
            Comments, Webhooks; batches of 10), http.ts (token, 429 retry after Retry-After,
            OpenRowsError), generated/v1.ts (types + endpoint table generated from the v1
            contracts by scripts/codegen.ts), scripts/reference.ts (TypeDoc → the client's
            features/api-docs/sdk-reference.json, the /docs/api/sdk page). After changing the v1
            contracts or the SDK: `npm run generate -w @openrows/sdk` (tests fail otherwise).
            Integration tests: server's test/integration/sdk.test.ts. Published to npm only by
            .github/workflows/release-packages.yml on an `sdk-v<version>` tag
  mcp-server/ @openrows/mcp-server: MCP tools for AI agents on the official MCP TypeScript
            SDK and @openrows/sdk (README.md). src/tools.ts (the 8 tools, Zod inputs, size caps,
            TOOL_SCOPES), server.ts (createOpenRowsMcpServer), cli.ts + bin.ts (the
            `openrows-mcp-server` stdio bin: OPENROWS_API_KEY, OPENROWS_URL). The server mounts the
            same tools at /mcp. stdio.test.ts runs the built bin (build it first, like the SDK's
            pack test); integration: server's test/integration/mcp.test.ts. Published on an
            `mcp-server-v<version>` tag (after the SDK version it depends on)
  blocks/   @openrows/blocks: the typed SDK of extensions (README.md: the package format,
            scopes, the API): `Block` (the frame's `window.openrows`, implemented by shared's
            extensions/runtime.ts), initializeBlock, manifestProblems. No runtime deps; its tests
            run shared's runtime. Published on a `blocks-v<version>` tag
  n8n-nodes-openrows/ @openrows/n8n-nodes-openrows: n8n community nodes (README.md), CommonJS (n8n
            `require`s them; n8n-workflow is the only peer dependency). src/credentials/
            (OpenRowsApi: server URL + token), src/nodes/OpenRows/ (OpenRows.node.ts: record
            operations in records.ts, pickers in methods.ts; OpenRowsTrigger.node.ts: registers a
            webhook, verifies signatures in signature.ts), src/testing/harness.ts (n8n's function
            contexts mocked, not packed; also used by the server's test/integration/n8n.test.ts),
            test/fake-api.ts. Published on an `n8n-v<version>` tag
docker/     the one image, compose.sh dev|ci, dev realm, compose tests (docker/README.md);
            keycloak/themes/openrows: the rose sign-in and email theme
deploy/     helm/openrows: the Helm chart (README.md): the oss image's api, worker, migrate Job
            (plain on install, pre-upgrade hook on upgrade), optional Postgres/Valkey/Ingress, secrets
            from an existing Secret only; helm/test/: chart.test.ts (lint, golden templates,
            refusals), kind-smoke.sh (CI's `helm` job); helm/install-tools.sh: pinned Helm and kind
e2e/        Playwright specs (smoke, api-docs (both modes: the reference offline, axe), stack, cookies (the inventory of docs/legal/cookies.md), notices, shell, home, account-deletion, golden-path, seed, links, computed, realtime, presence, sharing, share-links, shared-layouts, embeds, public-forms, comments, activity, notifications, exports, tokens, oauth, api-v1, webhooks, automations, automations-builder, view-layouts, view-access, airtable-import-stack, templates, interfaces, interfaces-shared and usage against the Compose stack; pwa (installability, offline reads, sign-out clearing; service workers are blocked in every other spec, playwright.config.ts); grid, kanban, calendar, gallery, timeline, list, forms, create-view, cells, clipboard, fields, formula, record, toolbar, import, attachments, members, typecast, permissions, recompute, trash, snapshots, airtable-import, quota, usage-warnings, billing, ai-settings, ai-fields, audit-log, sso-settings, scim-settings, workspace-admin, oauth-apps, scripts, extensions, syncs, templates-gallery, interfaces-designer, interfaces-dashboard, interface-app, assistant, brand (the rose, contrast in both themes), laptop-layout (the top bar and toolbars at 1280 px) and mobile (360 and 412 px, touch) against a mocked API, grid-perf,
            auth/)
docs/       adr/, deploy/; legal/cookies.md (the cookie inventory an e2e checks); guide/ (
            the user guide, self-hosting.md and airtable-migration.md; with api/ and the SDK's
            README, the docs site's Markdown, rendered at openrows.io/docs); design/ (DESIGN.md, the tokens; brand/: the rose logo
            and its traced SVG, from which `node scripts/brand-assets.mjs` makes the icons)
bench/      ADR-001 storage benchmark (separate npm project, Docker only)
```

### Module conventions

- **Server domain modules** live in `packages/server/src/<domain>/`. Today a module is a single
  `routes.ts` exporting `<domain>Routes(routes: RouteRegistry, deps)`, called from `createApp`
  in `src/app.ts` (see `src/workspaces/routes.ts`). Simple handlers query Drizzle directly;
  `tables/` and `fields/` put the logic in `service.ts`; `records/` also has `repo.ts`. Every
  record write goes through `records/service.ts` (forms, API and automations too).
- **Schema changes** (bases, tables, fields) go through the services, which run DDL through
  `src/data/ddl.ts` (SECURITY DEFINER functions, same transaction, `lock_timeout`) and write an
  outbox event (`src/data/outbox.ts`) in the same transaction (ADR-001 implementation notes).
- **For new modules**, follow the same shape and split as the logic grows: `routes.ts` (HTTP,
  validation, access rule), `service.ts` (business logic), `repo.ts` (queries that take a
  `Transaction`). Keep Drizzle tables in `src/db/schema.ts`, request/response Zod schemas in
  `packages/shared/src/schemas/<domain>.ts`, and one **endpoint contract** per JSON route in
  `contracts` (`packages/shared/src/contracts/index.ts`: method, path, `params` checks, `query`,
  `body`, `response`, `status`).
- Register JSON routes with `routes.endpoint(contracts.<resource>.<name>, access, handler)`: it
  parses path params (404 when a checked one is malformed), query and body (`readJson`, 422)
  with the contract, and the handler returns the response data, which goes through the
  contract's response schema. `GET /api/openapi.json` is generated from the registered
  contracts. `src/contracts.test.ts` fails if the server and the contracts diverge, and
  `test/integration/contracts.test.ts` drives the server with the typed client.
- File downloads (not JSON, like the CSV export) are declared in `downloads` in the contracts
  module, registered with `routes.resource`, and linked from the client with `downloadUrl` from
  `src/api/client.ts`.
- Errors: throw `AppError` with a code from `packages/shared/src/errors.ts`
  (`src/lib/errors.ts` maps it, `ZodError` and `HTTPException` to RFC 9457 problem+json). Never
  return 5xx details. Log with the request's pino logger (`c.var.logger`).
- Client: call the API only through `api` in `src/api/client.ts`
  (`api.records.list({ params: { tableId }, query })`), never `fetch` or a hand-written URL (a
  test fails); server state through the hooks in `src/api/` and keys from `queryKeys`.
- Tests sit next to the code (`foo.ts` → `foo.test.ts`; DOM tests `*.dom.test.tsx`).
  Integration tests go in `packages/server/test/integration/`.

### Adding a field type

Everything type-specific (validation, coercion, storage, sorting, filtering, display,
conversion, the cell editor hint) lives in the registry in `packages/shared/src/fields/`; never
add a `switch (field.type)` elsewhere.

1. Add one module `fields/types/<kebab-name>.ts` exporting a `FieldTypeDef` built with
   `defineFieldType({...})` (or a family helper: `textLike`, `numberLike`, `dateTimeLike`,
   `userLike`). Fill every member of `FieldTypeDef` in `fields/types.ts`: a strict Zod
   `optionsSchema` whose `parse({})` is a valid default, `valueSchema`, `coerce` (never throws,
   idempotent, `null` when unreadable), `toStorage`/`fromStorage`, `storage` (the ADR-001 column
   type as data, no SQL or DB imports), `filterOperators`, `sort`, `compare`, `format`,
   `toPrimitive`, `editor`, `readOnly`/`computed`, `formulaType` (what formulas see).
2. Add it to `FIELD_TYPE_DEFS` in `fields/index.ts` (the module name in camelCase is the type
   name; a test fails if a module in `types/` isn't registered).
3. Add its option sets to `SAMPLE_OPTIONS` in `fields/registry.test.ts`. The fast-check
   properties (coerce, storage round-trip, compare, conversion to and from every other type)
   then cover it; add example tests to `fields/types.test.ts`.

## Authorization (the rule for every route)

Implemented in `packages/server/src/authz/` per [ADR-002](docs/adr/002-tenancy.md).

- **Tenant = workspace.** Every tenant table has `workspace_id NOT NULL`. Roles, highest first:
  `owner` > `creator` > `editor` > `commenter` > `read_only`. Inside a base the effective role
  is the higher of the workspace role and the `base_members` role (a base role raises, never
  lowers; owners are owners everywhere); someone with only base roles is a base-only
  collaborator (`role: null` on their workspace). Base collaborators and base invitations:
  `src/bases/collaborators.ts` and `src/workspaces/service.ts`. System admins
  (`users.is_system_admin`, set from `OPENROWS_SYSTEM_ADMINS` at sign-in) get **no** tenant
  access.
- **Routes are added only through `RouteRegistry`**, never `app.get(...)`. `createApp` throws at
  startup if a route bypassed it (`unregisteredRoutes`). The one exception is the `/ws`
  WebSocket upgrade (`src/realtime/gateway.ts`), which isn't an HTTP route: it checks `Origin`
  and the session cookie itself and runs `authorize()` on every subscribe. Pick one access kind:
  - `routes.public(method, path, handler)`: anyone (health, sign-in flow, `/api/openapi.json`).
    `routes.endpoint(contract, 'public', handler)` is the contract form; the only public JSON
    APIs besides the OpenAPI document are share links (`/api/shared/:shareToken/...`) and
    public forms (`/api/forms/:formToken/...`), whose token is checked on every request
    (`withShare`, `withFormShare`), never a session (a session only proves the
    viewer's email domain for domain-limited links).
  - `routes.endpoint(contract, 'session' | { resource, action, param? }, handler)`: the same
    rules as `session`/`resource` below, for routes with a shared contract (every JSON route).
  - `routes.session(method, path, handler)`: any signed-in user, touching only their own data;
    wrap queries in `inScope(db, { userId }, (tx) => ...)` so RLS applies.
  - `routes.token(method, path, handler)`: personal access tokens only, any scope (no bearer:
    401; the cookie is never read). Only the MCP endpoint, whose tools go back through
    the authorized `/api/v1` routes with the same token.
  - `routes.admin(contract, handler)`: the hosted ops console only (registered by the
    hosted edition on the `routes` hook, contracts in shared's `adminContracts`): a
    system admin's own cookie session with a sign-in in the last 30 minutes; 404 for everyone
    else. Cross-tenant reads go through the console's SECURITY DEFINER functions
    (`drizzle/0080_admin_console_rls.sql`); every request appends to `admin_audit_log`.
  - `routes.resource(method, path, { resource, action, param? }, handler)`: runs
    `requireSession` + `withResource`, which resolves the resource's workspace and role in one
    query (`authz_resolve`), calls `authorize(principal, action, resource)`, and runs the
    handler in one transaction with `SET LOCAL app.workspace_id`/`app.user_id`. Use `c.var.tx`
    and `c.var.resource` (with `.role`) in the handler. The path needs `:<resource>Id` unless
    `param` says otherwise.
- **Actions** and their resource kind and minimum role are in `ACTIONS` in
  `packages/shared/src/authz.ts`. Add new actions there, with their personal access token scope
  in `ACTION_SCOPES` (null: a signed-in session only).
- **Personal access tokens**: `Authorization: Bearer or_pat_…` is resolved by
  `requireSession` (the cookie is then ignored; OAuth apps' `or_oat_…` access tokens, too,
  with their authorization's scopes and grants); `c.var.principal.token` holds the scopes and
  grants. Effective access = the user's live role ∩ the token's scopes ∩ its grants, in
  `authorize()` (outside the grants: 404; missing scope: 403). Session routes are session-only
  unless registered with `{ token: '<scope>' }` (the last argument of `routes.endpoint(contract,
  'session', handler, …)`); a resource route narrows its scope with `token` in its access rule
  (null keeps it to sessions). Sharing, permissions, members, exports and anything about the
  account stay session-only; checks inside a handler use `principalMay`/`assertSession`.
- **Edit permissions** narrow the role per table (`addRecords`, `deleteRecords`,
  `editRecords`) and per field (`edit`): `packages/shared/src/schemas/permissions.ts`, enforced
  in the RecordService (`records/permissions.ts`, 403 `EDIT_RESTRICTED`). A new record write
  path must go through the RecordService with the writer's `role`; add it to
  `test/integration/permissions.test.ts`.
- **Refusals:** 401 anonymous; **404** when the resource is missing or the user has no role on
  it (never 403 across tenants, so ids don't leak); 403 when the role is too low.
- **RLS:** every tenant table has `ENABLE` + `FORCE ROW LEVEL SECURITY` and a `tenant` policy on
  `app.workspace_id` (hand-written `drizzle/0003_rls.sql`). The server connects as
  **`openrows_app`** (no `BYPASSRLS`; production refuses a superuser or bypass role); migrations
  run as the owner/superuser (`MIGRATION_DATABASE_URL`). A new tenant table needs RLS and a
  policy in a migration: `test/integration/migrations.test.ts` fails otherwise.
- **Interfaces** are a resource kind of their own (`interface`): `authz_resolve` adds the
  interface-only role (`interface_members`) there and nowhere else, so an interface-only
  collaborator gets 404 from the base's API; their requests set `app.interface_id`, which the
  RESTRICTIVE `interface_scope` policies enforce. The matrix runs every route as an interface-only
  editor and viewer too (`interfaceOnly` overrides per case).
- **The cross-tenant matrix:** every new route must get a case in `CASES` in
  `packages/server/test/integration/authz-matrix.test.ts` (status per owner, creator, editor,
  commenter, read-only, other tenant, anonymous). A registered route without a case fails the
  run. Add RLS isolation cases to `rls.test.ts` for new tenant tables.

## Database and migrations

- Drizzle ORM 0.45 + drizzle-kit 0.31 on Postgres 16. Drizzle owns only the `public` metadata
  schema; per-base record schemas (`b_*`, ADR-001) are managed separately and never diffed.
- Change `packages/server/src/db/schema.ts`, run `npm run db:generate`, review and commit the
  SQL and `drizzle/meta/`. `npm run db:check` must pass.
- Hand-written migrations (RLS, grants, functions, like `0003_rls.sql`):
  `npm run db:generate -- -- --custom --name <name>` (both `--` are needed to get past the two npm layers), then write the SQL into the generated file.
- **Never `drizzle-kit push`** (there is no `db:push`). All schema changes go through migrations.
- Ids are UUIDv7, generated app-side (`uuidv7()`).

## Dev stack (Docker)

```sh
docker/compose.sh dev up -d --wait    # Postgres, migrate, api, worker, Keycloak, Mailpit, S3, webhook receiver
docker/compose.sh dev down -v         # stop and drop volumes
```

Only the services, for `npm run dev`/`npm run e2e:auth` on the host:
`docker/compose.sh dev up -d --wait postgres keycloak mailpit s3`. After a code change:
`docker/compose.sh dev up -d --wait --build`. After editing the realm:
`docker/compose.sh dev up -d --wait --force-recreate keycloak`. Details:
[docker/README.md](docker/README.md).

| What | Where (127.0.0.1) | Credentials |
| --- | --- | --- |
| App (stack's api + client) | http://localhost:8180 | |
| Keycloak | http://localhost:8080 | admin `admin` / `admin`; realm `openrows`, client `openrows-app`; dev user `dev@openrows.test` / `openrows-dev-password` |
| Mailpit | http://localhost:8025 (SMTP 1025) | |
| S3 (Versity) | http://localhost:9000 | bucket `openrows`, `openrows-dev` / `openrows-dev-secret` |
| Webhook receiver | http://localhost:8190 | dev/CI only: webhooks to `http://webhook-receiver:8190/…`; `GET /requests` |
| Fake Airtable | `http://airtable-fake:8191` (in the stack only) | dev/CI only: the importer's fixture base, token `patFixture0000001.a1b2c3d4…` (`docker/airtable-fake.mjs`) |
| Postgres | localhost:5432 | superuser `openrows` / `openrows_dev`; app role `openrows_app` / `openrows_app_dev` |

The realm export is `docker/keycloak/openrows-realm.json` (contract-tested by
`openrows-realm.test.ts`). To sign in from `npm run dev`, export the `OIDC_*` values from
`.env.example` (the server doesn't read `.env` files itself); without them `/auth/login`
answers 503.

**Sign-in** ([ADR-006](docs/adr/006-auth-provider.md)): the server is a BFF. `GET /auth/login`
redirects to Keycloak with authorization code + PKCE S256, `state` and `nonce` (kept in an
encrypted HttpOnly cookie); `GET /auth/callback` exchanges the code, requires a verified email,
upserts the user by (issuer, subject) and sets an opaque HttpOnly session cookie (stored as its
SHA-256). The browser never sees tokens. `POST /auth/logout` ends the session and does
RP-initiated logout. `GET /api/me` returns the principal. State-changing requests must come from
`APP_URL` (Origin check).

## Testing rules

- Test-first. Unit tests mock nothing they don't have to; integration tests use a **real
  Postgres** (never mock the database there).
- Integration helpers (`packages/server/test/helpers/`): `useTestDb()` gives each file its own
  clone of a migrated template (`t.db` = owner connection for fixtures, `t.appDb` = openrows_app
  for the app under test); `createUser`, `createWorkspace`, `addMember`, `createBase`,
  `createTenant`, `createSession` (`factories.ts`); `authedClient(t, user)` sends a real session
  cookie; `testApp({ db })` builds the app with test config and captured logs (`runJob(id)` runs an import or restore it sent, as the worker would);
  `useMockIssuer()`/`signIn()` (`oidc.ts`) for OIDC flows; `useTestS3()` (`s3.ts`) starts a real
  S3 server (Versity) and `MemoryObjectStore` (`object-store.ts`) stands in where S3 doesn't
  matter; `zipOf()`/`unzip()` (`unzip.ts`) read a ZIP answer. Test images are pinned in `images.ts`.
- New route → matrix case; new tenant table → RLS + isolation test; schema change → migration +
  `db:check`.

## Definition of done

- Tests added (unit + integration where relevant), written first where practical.
- `npm run lint`, `npm run typecheck`, `npm run build`, `npm test` and `npm run db:check` pass;
  `npm run test:integration` passes when server/DB code changed.
- Docs (this file, READMEs, ADRs, docs/) kept truthful in the same change.
- Conventional commits; reference the issue a change fixes (`Fixes #<issue>`).

## Working agreement

- **Pull requests to `main`**, reviewed by a maintainer; CI must be green. Keep `main`
  releasable.
- **Conventional commits** (`feat(authz): ...`, `fix:`, `docs:`, `chore:`, `ci:`, `build:`,
  `test:`, `refactor:`), enforced by commitlint.
- **CI** ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs on GitHub-hosted runners
  (`ubuntu-latest`) for pushes to `main`, tags and pull requests. Jobs: `check` (lint, typecheck,
  build, the published packages, db:check, OpenAPI lint, coverage), `integration`, `smoke` (the
  Compose stack + Playwright), `helm` (the chart installed in a kind cluster) and `docker` (the
  image builds; on `main` and `v*` tags it is pushed to `ghcr.io/draggable/openrows`).
- Releases of the npm packages: `.github/workflows/release-packages.yml` on a package tag.

## Open core

- Everything in this repository is **AGPL-3.0-only** ([LICENSE](LICENSE)). The name and logo
  are trademarks ([TRADEMARKS.md](TRADEMARKS.md)).
- **Hosted-only features** (billing, plans and quotas, the ops console, enterprise SSO, SCIM,
  audit logs, data residency, hosted AI credits, Google Sheets sync) are not in this repository.
  They plug into interfaces the core defines (`packages/server/src/edition/`: entitlements,
  billing, usage meter, audit sink, single sign-on, data residency, sync connectors, hooks), each
  with an open-source default. Anything a self-hoster needs belongs in the core, and the core
  must build, run and pass its tests on its own ([ADR-005](docs/adr/005-open-core.md),
  [ADR-008](docs/adr/008-repository-split.md)).
- **`EDITION=oss|cloud`** (config.ts, default `oss`). The core's `dist/index.js`/`dist/worker.js`
  run the OSS edition and refuse `cloud`; `/health` names the edition. `docker/Dockerfile`'s
  default target `oss` is the image CI publishes.

## ADRs

| ADR | Decision |
| --- | --- |
| [000](docs/adr/000-notes.md) | Dated decision notes: toolchain baseline, Biome, lefthook, type-check scripts |
| [001](docs/adr/001-record-storage.md) | Records in one physical Postgres table per user table, junction tables for links |
| [002](docs/adr/002-tenancy.md) | Workspace = tenant, `workspace_id` everywhere, forced RLS, two DB roles, separate system-admin flag |
| [003](docs/adr/003-realtime.md) | Realtime: server-authoritative cell ops, per-cell LWW with versions, outbox → LISTEN/NOTIFY or Redis |
| [004](docs/adr/004-jobs.md) | Jobs: pg-boss in a separate worker process from the same image |
| [005](docs/adr/005-open-core.md) | Open core: an AGPL-3.0 core with plug-in interfaces; hosted-only paid features outside it |
| [006](docs/adr/006-auth-provider.md) | Auth: Keycloak (or any OIDC provider) via OIDC, server-side sessions, no better-auth |
| [007](docs/adr/007-grid-rendering.md) | Grid: DOM virtualization (TanStack Virtual) in rows and columns, ARIA grid, windowed loading |
| [008](docs/adr/008-repository-split.md) | Repository split at the public launch: a public core repository, the hosted edition in a private one |

To change an accepted decision, write a superseding ADR ([template](docs/adr/README.md)).
