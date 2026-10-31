# docker/: image, stacks and their tests

One image serves three Compose services: `api` (`node dist/index.js`, which also serves the
built client), `worker` (`node dist/worker.js`: pg-boss jobs, ADR-004; healthcheck
`GET /health` on port 3001) and the `migrate` one-shot (`node dist/migrate.js`), per
[ADR-004](../docs/adr/004-jobs.md). This directory has the image, the development stack, CI's
smoke stack and the base file for a production stack of your own
([docs/guide/self-hosting.md](../docs/guide/self-hosting.md)).

| File | Purpose |
| --- | --- |
| `Dockerfile` | Multi-stage: full `npm ci` + `npm run build` (shared and server with tsc, client with Vite), production `node_modules` for server + shared, then a slim runtime (target `oss`, the default) that runs `node <entry>.js` as PID 1 as user `node` |
| `compose.yml` | Base stack: `postgres`, `migrate`, `api`, `worker`, optional `valkey`. No host ports |
| `dev.yml` | Dev overlay: one shared network namespace (`net`), loopback ports, Keycloak with the dev realm, Mailpit, an S3 server, the webhook receiver and a fake Airtable |
| `ci.yml` | CI overlay on top of `dev.yml`: no host ports, the api on 8180 inside the namespace, and the `e2e` service (Playwright, profile `e2e`) |
| `selfhost.yml` | A self-hosted production stack's overlay on top of `compose.yml`: the api on loopback (`OPENROWS_BIND`) for your reverse proxy, and the optional profiles `keycloak` (Keycloak with its database in the stack's Postgres, `keycloak/init-db.sh`), `clamav` and `valkey` ([docs/guide/self-hosting.md](../docs/guide/self-hosting.md)) |
| `compose.sh` | `docker/compose.sh <dev\|ci> <compose args>`: base + overlay(s), project `openrows-<env>` (`openrows-ci-$OPENROWS_CI_ID`), the env file |
| `ghcr.sh` | `docker/ghcr.sh push <image> <repository> <commit>` (CI's `docker` job: `:sha-<commit>`, then `:main` while the commit is main's tip), `pull <repository> <commit> <local tag>` (checks the revision label) and `check-private <repository> <tag>`. Logs in with `$GH_TOKEN` on stdin in a private `DOCKER_CONFIG` deleted on exit |
| `webhook-receiver.mjs` | Dev/CI only: records what webhooks deliver; `GET /requests?path=` lists it for the e2e spec |
| `airtable-fake.mjs` | Dev/CI only: a fake of Airtable's API with a fixture base, for the importer |
| `.env.dev.example` | The dev stack's env file (development defaults only). Copy to `docker/.env.dev` (git-ignored) to change it |
| `.env.selfhost.example` | The template of a self-hosted stack's env file: copy it outside the checkout (mode 600) and fill it in |
| `keycloak/openrows-realm.json` | The dev realm export (client `openrows-app`, dev user, SMTP to Mailpit), with its contract test |
| `keycloak/openrows-realm.prod.json` | A production realm template: the dev realm's settings without its users, with the client secret and SMTP from the environment ([docs/deploy/keycloak.md](../docs/deploy/keycloak.md)) |
| `keycloak/customer-realm.json` | Dev/CI only: a second realm that plays a customer's identity provider |
| `keycloak/themes/openrows` | The sign-in and email theme |
| `test/` | `compose.test.ts` and `compose-helpers.ts`: `docker compose config` assertions, the Dockerfile and `compose.sh` (see "Tests") |

## Dev

```sh
docker/compose.sh dev up -d --wait   # builds the image the first time (about a minute)
docker/compose.sh dev ps
docker/compose.sh dev logs -f api
docker/compose.sh dev down -v        # stop; -v also drops the database, S3 and Valkey volumes
```

`up --wait` returns once Postgres, S3, Keycloak and the api (`/ready`) are healthy and
`migrate` has exited 0. It needs no env file: without `docker/.env.dev`, `compose.sh` uses
`.env.dev.example`, whose values are all development defaults. After a code change,
`docker/compose.sh dev up -d --wait --build` rebuilds the image.

| What | URL (all on 127.0.0.1) | Notes |
| --- | --- | --- |
| App (client + API) | http://localhost:8180 | `APP_URL`; the dev realm registers `/auth/callback` on it |
| Keycloak | http://localhost:8080 | admin console `admin` / `admin`; realm `openrows`; dev user `dev@openrows.test` / `openrows-dev-password` |
| Mailpit | http://localhost:8025, SMTP `localhost:1025` | Keycloak's verification and reset mail, and the app's mail |
| S3 | http://localhost:9000 | bucket `openrows`, keys `openrows-dev` / `openrows-dev-secret` |
| Postgres | `localhost:5432` | superuser `openrows` / `openrows_dev`; app role `openrows_app` / `openrows_app_dev` |
| Valkey | `localhost:6379` | only with `COMPOSE_PROFILES=valkey` |
| Webhook receiver | http://localhost:8190 | point a webhook at `http://webhook-receiver:8190/<any path>`; `GET /requests` shows what arrived |

The same stack provides the services for `npm run dev` and `npm run e2e:auth` on the host: those
use the default URLs (`localhost:5432`, `:8080`, `:8025`/`:1025`, `:9000`). To run only the
services, name them: `docker/compose.sh dev up -d --wait postgres keycloak mailpit s3`. The
stack's own api on 8180 doesn't conflict with the host's server on 3000 or Vite on 5173.

Keycloak runs `start-dev` (embedded H2) and imports the realm when the container is created, so
accounts registered in it last until the container is recreated. After editing the realm file:
`docker/compose.sh dev up -d --wait --force-recreate keycloak`.

The api runs with `NODE_ENV=development` in dev (as do `migrate` and `worker`), because
production refuses http URLs and the dev secrets. The image's default is `production`.

## Networking

Some Docker hosts block TCP between containers on a bridge network. Containers that share one
network namespace can always reach each other on `127.0.0.1`, and so can a host-network container
and a published port. So in dev every service runs with `network_mode: service:net`. `net` is a
container that only holds the namespace open (`sleep infinity` in the already-pinned Postgres
image). It publishes every port (a container in another's namespace can't publish its own) and
maps the service names (`postgres`, `keycloak`, `mailpit`, `s3`, `valkey`) to `127.0.0.1` with
`extra_hosts`. Every container in the namespace shares that `/etc/hosts`, so the URLs in
`compose.yml` (`postgres:5432`, `s3:9000`, `mailpit`) read the same as in a production stack. It
also gives the browser and the api the same issuer: `http://localhost:8080` is Keycloak for both,
which the OIDC token exchange needs. Ports inside the namespace must be unique, so Keycloak's
management port moves from 9000 (the S3 server's) to 9990.

A production stack (`compose.yml` with your own overlay) uses an ordinary Compose bridge network,
with service names as DNS names.

The services in `net`'s namespace lose their network when `net` is replaced or restarted on its
own (for example `up --force-recreate --no-deps net`). The next plain
`docker/compose.sh dev up -d --wait` sees that and recreates them.

## CI

[.github/workflows/ci.yml](../.github/workflows/ci.yml) runs on GitHub-hosted runners. Two jobs
use this directory.

**`smoke`** brings the stack up and runs Playwright against it:

```sh
export OPENROWS_CI_ID=local IMAGE=openrows:ci-local   # CI: <run id>-<attempt>-<shard>
docker buildx build -f docker/Dockerfile -t "$IMAGE" .
npm ci                                                # the e2e container uses node_modules
docker/compose.sh ci up -d --wait --no-build
E2E_UID=$(id -u) E2E_GID=$(id -g) docker/compose.sh ci run --rm --no-deps e2e
docker/compose.sh ci --profile e2e down -v --remove-orphans
```

- `compose.sh ci` = `compose.yml` + `dev.yml` + `ci.yml`, always with `.env.dev.example`, in
  project `openrows-ci-$OPENROWS_CI_ID`. Containers, volumes and the network are per run, so two
  runs on one host (or a run next to your dev stack) don't meet.
- No host port at all (`ports: !reset []` on `net`; Compose 2.24 or later).
- Playwright runs in the `e2e` service, inside `net`'s namespace like everything else. The
  browser, the api and Keycloak see the same `http://localhost:8180` (the api listens on 8180
  here, so `APP_URL` and the dev realm's callback stay as in dev) and the same issuer,
  `http://localhost:8080`.
- The e2e image is `mcr.microsoft.com/playwright` of the version in `package-lock.json`, pinned
  by digest; the compose tests fail when they drift. It runs as the runner's user
  (`E2E_UID`/`E2E_GID`), so the report and traces it writes into the checkout aren't root-owned.
- It runs `e2e/smoke.spec.ts` and, with `E2E_STACK=1`, the stack specs: the client loads,
  `/health`, `/ready` (database and S3), `/auth/login` redirects to Keycloak and the seeded dev
  user signs in, then the golden path and the rest. Against your dev stack:
  `E2E_STACK=1 E2E_BASE_URL=http://localhost:8180 npm run e2e`.
- Keycloak gets a longer start budget than in dev (`ci.yml` overrides its healthcheck: 8 minutes
  of grace probed every 5s, then 6 × 10s). The job waits `--wait-timeout 660`; the compose tests
  check that these stay ordered.
- The teardown step runs with `if: always()`: `down -v --remove-orphans` and `docker image rm`
  of the run's own tag.

**`docker`** runs after the other jobs pass. It builds the `oss` target of `docker/Dockerfile`
and, on a push to `main` or a `v*` tag, pushes it with `ghcr.sh push` as
`ghcr.io/draggable/openrows:sha-<full commit sha>` and points `:main` at it (registry-side, only
while the commit is still main's tip); a tag also gets `:<tag>`. Pull requests build without
pushing.

## Security headers

The api sets them itself on every response (HTML, API, errors, static files), so no reverse
proxy is needed (`packages/server/src/lib/security-headers.ts`). The Content-Security-Policy is
derived from the config, never from hard-coded hosts:

| Directive | Value |
| --- | --- |
| `default-src`, `font-src`, `base-uri` | `'self'` |
| `script-src` | `'self'` (no `'unsafe-inline'` or `'unsafe-eval'`: the theme bootstrap is the external `/theme.js`, and the client runs Zod without code generation) |
| `style-src` | `'self' 'unsafe-inline'`: the toaster injects a `<style>` element and Radix/React set inline `style` attributes; styles can't run code |
| `img-src`, `connect-src` | `'self'` plus the origin of `S3_PUBLIC_URL` (or `S3_ENDPOINT` without it): presigned uploads and signed thumbnail/download URLs |
| `form-action` | `'self'` plus the origin of `OIDC_ISSUER_URL`: signing out is a form POST that redirects to the provider's end-session endpoint |
| `object-src` | `'none'` |
| `frame-ancestors` | `'none'` (also `X-Frame-Options: DENY`) |

The browser never calls the OIDC provider itself (the server is a BFF), so `connect-src` doesn't
list it. If your provider's end-session endpoint is on another origin than its issuer, sign-out's
redirect is refused: put both on one origin.

Also: `Strict-Transport-Security: max-age=31536000; includeSubDomains` when `APP_URL` is https
(never over http), `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`,
`Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()` and
`Cross-Origin-Opener-Policy: same-origin` (except `/oauth/authorize` and `/login`, the pages an
OAuth app's sign-in popup shows: `unsafe-none`, so the app's window keeps its handle on the popup).
`/api/*` and `/auth/*` responses get
`Cache-Control: no-store`, the hashed files under `/assets` `public, max-age=31536000, immutable`,
and everything else `no-cache`. A proxy in front may add headers but shouldn't set a second,
different CSP (browsers enforce both).

## Database roles

`migrate` connects as the Postgres superuser (`PG_USER`/`PG_PASSWORD`), applies
`packages/server/drizzle` under an advisory lock, and creates or updates the `openrows_app` role
with `OPENROWS_APP_DB_PASSWORD`. `api` and `worker` connect as `openrows_app`, which row-level
security applies to ([ADR-002](../docs/adr/002-tenancy.md),
[docs/deploy/database.md](../docs/deploy/database.md)). The api starts only after `migrate`
exits 0, and its healthcheck is `/ready` (Postgres, S3, and Redis when `REDIS_URL` is set). The
worker also gets `INDEX_DATABASE_URL` (the superuser, like `migrate`) for field index builds:
`CREATE INDEX CONCURRENTLY` needs the table's owner and can't run in a SECURITY DEFINER function,
so it runs only the statements those functions check and answer
(`packages/server/src/indexes/sync.ts`). The api never gets it.

## Valkey

Off unless `COMPOSE_PROFILES=valkey` (in the env file or the shell). `down -v` only removes the
volumes of the profiles it's given, so drop Valkey's with
`COMPOSE_PROFILES=valkey docker/compose.sh dev down -v`. /ready checks it when `REDIS_URL` is
set. With `VALKEY_PASSWORD` set it requires that password, and then
`REDIS_URL=redis://:<password>@valkey:6379`. Set a password in production.

## S3

Dev runs [Versity S3 Gateway](https://github.com/versity/versitygw) (Apache-2.0) on its posix
backend, where each top-level directory of the `s3data` volume is a bucket, so the container
creates `$S3_BUCKET` with `mkdir` before it starts.

In production any S3-compatible service works (path-style URLs, SigV4). Browsers upload and
download attachments with presigned URLs, so the bucket must be reachable from browsers, either
at `S3_ENDPOINT` itself (leave `S3_PUBLIC_URL` empty) or through `S3_PUBLIC_URL` (the bucket's
base URL on another host whose proxy keeps the path and the Host header, which are signed), and
it needs a CORS rule for `APP_URL`: methods `PUT`, `GET`, `HEAD`, header `content-type`, exposing
`ETag`. Keep the bucket private (no public reads): every URL is signed and short-lived, and
everything but raster images downloads with `Content-Disposition: attachment`. Serve it from a
registrable domain other than the app's, so no app cookie ever reaches a user file. For
Cloudflare R2: `S3_ENDPOINT=https://<account id>.r2.cloudflarestorage.com`, `S3_REGION=auto`.

## Image pins

Every third-party image is `name:tag@sha256:<digest of the multi-arch index>`. The tag is for
humans; Docker pulls the digest. Our own image is `${IMAGE:-openrows:local}`.
`docker/test/compose.test.ts` fails on an unpinned image, on two digests for one image, and on a
Dockerfile `FROM` other than the pinned `NODE_IMAGE`. To upgrade an image:

```sh
docker buildx imagetools inspect postgres:16   # the top "Digest:"
```

Then change the tag and the digest together, everywhere the image appears (`net` and `postgres`
use the same Postgres; `packages/server/test/helpers/images.ts` pins the same Mailpit).

## Logs

Every service logs through Docker's `json-file` driver with rotation: at most 10 files of 20 MB
per container, rotated files compressed. The app writes JSON lines (pino):
`docker/compose.sh dev logs -f api worker`.

## Tests

`npm test` runs `docker/test/compose.test.ts` in the `docker` Vitest project. It renders
`docker compose config --format json` for the dev and ci stacks from `.env.dev.example`, and for
the self-hosted stack from `.env.selfhost.example` with placeholder secrets, and checks: the
project names, one image for `migrate`/`api`/`worker` and their commands, startup order, the
`/ready` healthcheck, which roles connect where, the service set, every published port (loopback
only; dev only on `net`, the self-hosted stack only the api and, with its profile, Keycloak), the
shared namespace and its hosts, the dev Keycloak issuer and realm callback, that Compose refuses
empty required secrets and the template commits none, digest pins, log rotation, that the ci
stack publishes no port, runs everything in `net`'s namespace and pins the locked Playwright
version, the Dockerfile, and `compose.sh`. It needs the Docker CLI with Compose v2, not a daemon,
and fails rather than skips under `CI` when Compose is missing.
