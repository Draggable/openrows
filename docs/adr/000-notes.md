# Decision notes

Short dated decisions too small for a full ADR. Promote one to its own ADR if it gets
contested or needs more context.

## 2026-10-25: Toolchain and dependency baseline

- **Node 22 and npm only.** `engines.node` is `>=22.12.0`, because Vite 8 needs at least 22.12.
  `.nvmrc` and `.node-version` pin 22. `bun.lock` is gone; `package-lock.json` is the only
  lockfile. Workspaces build in the order listed in the root `package.json`: shared, server,
  client.
- **ESM everywhere.** Every package has `"type": "module"`. Server and shared use `NodeNext`
  resolution, so relative imports carry a `.js` extension. The client uses `bundler` resolution
  and extensionless imports.
- **TypeScript project references.** Each package has a `tsconfig.json` solution file that
  references `tsconfig.build.json` (emits `dist/`, no tests) and `tsconfig.test.json`
  (type-checks tests, no emit). The client has `tsconfig.app.json` and `tsconfig.node.json`
  instead. `npm run type-check` is `tsc -b` from the root. `@openrows/shared` is built by `tsc`
  as ESM only (tsup and the CJS build are gone). Its `exports` list `types` first.
- **TypeScript 5.9, not 7.** TypeScript 7 (the Go-native compiler) is out, but we stay on 5.9
  until Vite, Vitest, Drizzle and Biome support it. Revisit in M1.
- **Zod 4.** The shared schemas are small, so we moved now rather than migrate more code later.
  We use the top-level format helpers (`z.uuid()`, not the deprecated `z.string().uuid()`).
  Zod 4's UUID check is stricter (RFC 9562 variant bits).
- **Drizzle ORM 0.45 and drizzle-kit 0.31**, the latest stable releases. Drizzle 1.0 is still a
  release candidate; move to it once it ships stable.
- **React 19, with TanStack Router replacing react-router-dom.** The client only had three
  placeholder routes, so we moved to the decided stack (TanStack Router and Query) now instead
  of upgrading react-router to a new major and then removing it. Routes are code-based for now.
  File-based routing can come with the M1 app shell if the route count grows.
- **Tailwind 4.** The move was close to trivial: the theme tokens moved from
  `tailwind.config.js` into `@theme` in `src/index.css`, and `@tailwindcss/vite` replaced
  PostCSS and autoprefixer. It also cleared the `postcss-selector-parser` advisory that affects
  Tailwind 3, and it is what current ShadCN expects.
- **Removed:** better-auth, ioredis (never used), the AWS SDK,
  nodemailer, node-cron and `@hono/zod-validator` (only used by legacy code; each comes back
  with the issue that needs it), jest and ts-jest (Vitest), tsup, and ESLint and Prettier (no
  config, and the lint script didn't work; Biome replaces them in M0). bcryptjs was never in
  the dependencies, and nothing imports it now.

## 2026-10-25: Lint, format, git hooks and type-check scripts

- **Biome 2 for lint and format**, pinned to an exact version so formatting can't drift between
  machines. Single quotes, semicolons, ES5 trailing commas, width 100 (matching the existing
  code). It checks TS, JS, JSON and CSS. Markdown and YAML are excluded, because Biome pads
  Markdown tables, and every STATUS.md edit would then rewrite the whole table. `legacy/` is
  excluded too.
- **Rules:** the recommended preset, plus errors for `noExplicitAny`, `noTsIgnore`,
  `useImportType` and `noNonNullAssertion`. `useLiteralKeys` is off: it contradicts the
  `noPropertyAccessFromIndexSignature` compiler option, which wants `process.env['X']`.
- **lefthook, not husky**, as in the maintainers' other repos. The root `prepare` script calls
  `scripts/install-hooks.js`, which skips installing when there's no `.git` (Docker builds),
  under `CI`, and when lefthook isn't installed (`--omit=dev`). Running `lefthook install`
  directly would fail in those cases.
- **`typecheck` is `tsc -b` per workspace, not `tsc --noEmit`.** With project references,
  `tsc --noEmit` fails (TS6310), because referenced projects must emit declarations.
  `type-check` stays as an alias.
- **Client API calls take a Zod schema** (`api.get(path, schema)`), and the helper returns the
  parsed value. A non-2xx response or a schema mismatch throws `ApiError`. The default base is
  `/api` (the Vite proxy), not `http://localhost:3000/api`.

## 2026-10-25: Migrations and metadata schema

- **Migration `0000_init` holds only what is decided:** `users` and `sessions` for OIDC, plus
  `workspaces`, `workspace_members`, `bases`, `tables`, `fields` and `views`. Every other
  prototype table (orgs, teams, JSONB `records`, forms, embeds, webhooks, automations, audit
  logs, notifications, API tokens, invitations, attachments) is dropped; each comes back with its
  issue. The old schema is kept in `legacy/server/src/db/schema.ts`.
- **OIDC identity on `users`.** The issue asks for `users.oidc_issuer` + `oidc_subject`
  (unique), so there is no separate `user_identities` table, which ADR-006 §4 sketched. One user
  has one identity, which is all a single trusted issuer needs. If account linking across
  issuers is ever needed, move the pair into `user_identities` in a migration.
- **UUIDv7 ids are generated app-side** with the `uuidv7` package (`$defaultFn` in the schema),
  as ADR-001 says. The columns have no database default, so raw SQL inserts must supply an id.
  Postgres 18's built-in `uuidv7()` can become the default once we require 18.
- **Sessions are keyed by `id_hash`**, the hex SHA-256 of the 256-bit cookie token
  (`src/auth/session-token.ts`). `expires_at` is the absolute expiry and `last_seen_at` drives
  the idle expiry. The refresh and ID tokens are `bytea` ciphertext columns
. `oidc_sid` is indexed for back-channel
  logout.
- **Tenancy shape (ADR-002) without RLS yet.** Tenant tables carry `workspace_id NOT NULL`;
  `tables`, `fields` and `views` reference their parent through composite foreign keys that
  include `workspace_id`, backed by `UNIQUE (workspace_id, id)`. `bases` references `workspaces`
  directly. An integration test classifies every `public` table as global (`users`, `sessions`,
  `workspaces`, the tenant root) or tenant-owned. 
- **Physical-storage hooks (ADR-001):** `bases.db_schema`, `tables.db_schema`/`db_table`/
  `schema_version`, and `fields.db_column`, all stored, never re-derived. `drizzle.config.ts`
  sets `schemaFilter: ['public']`. Orderable rows use `position double precision` (fractional
  ordering). `fields.type` and `views.type` are plain `text`, validated by the shared registry in
  M1, so adding a type needs no migration. Workspace roles do have a `CHECK`, kept in sync with
  `USER_ROLES` by a unit test.
- **`npm run db:migrate` runs our own entrypoint** (`src/migrate.ts`, via tsx), not
  `drizzle-kit migrate`, so dev, CI and the Compose `migrate` one-shot (`node dist/migrate.js`)
  share one code path. It takes a Postgres advisory lock, so concurrent runs are safe.
  `db:push` is removed.
- **Drift check:** `npm run db:check` runs `drizzle-kit generate` and fails if anything in
  `drizzle/` was added or changed. It compares file hashes, not git status, so it also works
  before the migration is committed. `drizzle/` is excluded from Biome, because drizzle-kit owns
  its formatting.

## 2026-10-25: Test infrastructure

- **Vitest projects, not `vitest.workspace.ts`.** Vitest 3.2 deprecated the workspace file
  and later majors removed it. The root `vitest.config.ts` lists the three packages under
  `test.projects`. Root `npm test` runs all unit tests in one process, and `npm test -w <pkg>`
  still works.
- **Unit and integration tests are split.** Unit tests (`src/**/*.test.ts[x]`) never need
  Docker. Server integration tests live in `packages/server/test/integration/` with their own
  config, and run with `npm run test:integration`. CI runs them as a separate job.
- **One Postgres per run, one database per test file.** The global setup starts
  `postgres:16-alpine` (with `fsync=off`) and migrates `openrows_template` once. `useTestDb()`
  clones it with `CREATE DATABASE … TEMPLATE` (milliseconds) and drops it after the file, so
  files can run in parallel without cleanup code.
- **`authedClient(db, user)` takes the database explicitly** and inserts a real session row,
  then sends its cookie through `app.request`. Once reads the cookie, tests built on it
  won't need to change.
- **Playwright runs against the built app**: `node packages/server/dist/index.js` and
  `vite preview` (which proxies `/api`, `/auth` and `/health` like the dev server). That's
  closer to production than `npm run dev`, and it starts in about a second. `E2E_BASE_URL`
  skips the web servers, which is how points it at Compose. Only chromium for now.

## 2026-10-25: Config, logging, errors and health checks

- **One Zod-validated config, read once in `index.ts`** and passed into `createApp({ config,
  logger, checks })`. Nothing else reads `process.env`, except the migrate one-shot, which
  only needs `DATABASE_URL` (and requires it in production), so Compose doesn't have to hand
  app secrets to it. Empty strings count as unset, so Compose `${VAR:-}` passthroughs fail
  validation instead of slipping through.
- **Production is strict, development is zero-config.** Production requires `APP_URL`,
  `DATABASE_URL`, `ENCRYPTION_KEY`, the OIDC trio and the S3 group, rejects a list of known
  defaults plus a placeholder pattern (`change-me`, `example`...), and requires https for
  `APP_URL` and `OIDC_ISSUER_URL` (ADR-006). S3 and OIDC are all-or-nothing in every
  environment. The config holds no OIDC or crypto code; consumes it.
- **`ENCRYPTION_KEY`, not `SESSION_SECRET`.** Session cookies are random tokens stored hashed
, so nothing is signed; the only server secret is the key that encrypts stored OIDC
  tokens. It's free text of at least 32 characters, which derives an AES-256-GCM key from.
- **`APP_URL` replaces `CLIENT_URL`.** The BFF serves the app and API on one public origin
.
- **pino, JSON only.** No pino-pretty or transport, so there's no worker thread and logs look the
  same everywhere; pipe through `pino-pretty` locally if wanted. Redaction is path-based (secret
  and token keys, cookies, auth headers) as a safety net: request logs carry only method, path,
  status and duration, never query strings (OAuth `code`) or headers.
- **Request ids are UUIDv7**, echoed in `X-Request-Id` and in every problem body. An incoming
  `X-Request-Id` is reused only with `TRUST_PROXY=true` and only if it's short and log-safe.
- **Errors: RFC 9457 problem+json with a shared catalog.** `ERROR_CATALOG` in
  `packages/shared/src/errors.ts` maps stable `UPPER_SNAKE_CASE` codes to status and title; `type` is `https://openrows.io/problems/<code>`. Clients branch on
  `code`. Extensions (`errors`, `checks`) come after the standard members and can't overwrite them.
  Validation failures are 422 `VALIDATION_FAILED`.
- **`/ready` probes without client libraries.** Postgres uses the app pool; S3 is a SigV4-signed
  HeadBucket through `aws4fetch` (tiny, no dependencies, and able to presign for M1 uploads);
  Redis is a raw RESP `AUTH`/`PING` over a socket, because nothing else uses Redis yet. A failed
  readiness check is still problem+json (503 `NOT_READY`) and carries the same per-dependency
  `checks` as the 200 body. Failure details are logged, not returned, because `/ready` may be
  reachable from outside.
- **Integration coverage:** `/ready` against the Testcontainers Postgres, a refused database
  port, and a password-protected `redis:7-alpine` container. S3 signing is covered by a unit test
  against a local HTTP server instead of a MinIO container, to keep the suite lean.

## 2026-10-25: Authorization layer, RLS and the route matrix

- **Roles follow Airtable: `owner`, `creator`, `editor`, `commenter`, `read_only`.** They
  replace `admin` and `viewer` (migration `0002` renames existing rows). What each role may do
  is a single table, `ACTIONS` in `packages/shared/src/authz.ts`: each action names the resource
  kind it's checked against and the lowest role allowed. Workspace settings are owner-only;
  creating bases and changing schema is creator and up; records and views are editor and up;
  comments are commenter and up.
- **Base-level overrides replace the workspace role inside the base** (`base_members`). They can
  raise or lower it, except that workspace owners are owners everywhere. Overrides can't be
  `owner`. A user with only an override is a base-only collaborator: they can use the base, and
  the workspace itself answers 404. Table and field level permissions come in M3.
- **Resolution through a `SECURITY DEFINER` function.** RLS hides every tenant row until the
  workspace is known, so `authz_resolve(kind, id, user_id)` (owned by the schema owner, executable
  only by `openrows_app`) returns the workspace, base and both roles in one query. It works for
  workspaces, bases, tables, fields and views, and treats trashed resources (or trashed parents)
  as missing. That's why the migrating role must be a superuser or `BYPASSRLS`. Migration
  `0003_rls` checks this, and `docs/deploy/database.md` documents the roles.
- **One transaction per resource request.** `withResource` opens it, resolves, authorizes, then
  `set_config`s the workspace and user and hands the handler `c.var.tx`. It rolls back when the
  handler throws. Session-only routes ("my workspaces", "create workspace") use
  `inScope(db, { userId[, workspaceId] }, fn)`.
- **404 rather than 403 across tenants (L2).** No role on an existing resource is answered
  exactly like a missing one. A system admin gets no tenant access through `authorize` (C1).
  Admin routes will use their own path (ADR-002 §7).
- **The route registry is the only way to add routes.** `RouteRegistry.public/session/resource`
  each record an access rule. `createApp` throws if `app.routes` has anything the registry
  doesn't know about, and a unit test shows a plain `app.get` is caught. The integration matrix
  (`test/integration/authz-matrix.test.ts`) needs a hand-written expectation for every registry
  entry, then calls each route as owner, creator, editor, commenter, read-only, another tenant
  and anonymous against a fresh world. Every refused write must leave the data unchanged.
  Expectations are written per route rather than derived from `ACTIONS`, so a wrong policy
  entry fails too.
- **Dev mirrors production.** The default `DATABASE_URL` is `openrows_app`. The migrate
  entrypoint uses `MIGRATION_DATABASE_URL` (falling back to `DATABASE_URL`, or the dev superuser
  when nothing is set) and sets the `openrows_app` password from `OPENROWS_APP_DB_PASSWORD`
  (`openrows_app_dev` in zero-config dev only). Production refuses to boot as a role that
  bypasses RLS.
- **Not done here:** syncing `is_system_admin` from `OPENROWS_SYSTEM_ADMINS` (with the first
  admin route, M5), attachments and other future tenant tables (they get `workspace_id` and the
  policy when they're created; the migration test enforces it), and creating a base's physical
  schema (M1's DDL manager).
