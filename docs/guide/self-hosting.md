# Self-hosting

Run your own OpenRows server with Docker Compose or on Kubernetes with the Helm chart: the image, the services, the settings production requires, sign-in, storage, email, backups and upgrades.

## Requirements

- A Linux host with Docker Engine and Docker Compose v2, or a Kubernetes cluster (1.29 or later) with Helm 3.8 or later (see "Kubernetes (Helm)").
- An OpenID Connect provider that issues verified email addresses: Keycloak, which the repository ships a realm for, or any other.
- An S3-compatible bucket (AWS S3, Cloudflare R2, Versity S3 Gateway, a MinIO you already run, ...).
- A public https name for the app, with a reverse proxy or tunnel in front of it. In production the server refuses an http `APP_URL`.
- Optional: an SMTP relay for the app's own email, and ClamAV for scanning uploads.

The open-source edition has no plans, quotas or billing: every workspace is unlimited.

## The image and the services

One image serves three Compose services, built from [docker/Dockerfile](https://github.com/Draggable/openrows/blob/main/docker/Dockerfile). Its default target, `oss`, is the open-source server and holds no hosted-only code:

| Service | Command | What it does |
| --- | --- | --- |
| `migrate` | `node dist/migrate.js` | One-shot: applies the database migrations under an advisory lock, installs the job queue's schema and gives the `openrows_app` role its password. `api` and `worker` start only after it exits 0 |
| `api` | `node dist/index.js` | The HTTP API, the realtime WebSocket at `/ws` and the built web client, all on port 3000 |
| `worker` | `node dist/worker.js` | Background jobs (see "Background worker") |
| `postgres` | Postgres 16 | The database, on the Compose network only |

CI publishes the `oss` image to `ghcr.io/draggable/openrows` (tags `main` and `sha-<full commit sha>`) on pushes to `main` when publishing succeeds. If you can't pull it, build it from a checkout:

```sh
git clone https://github.com/Draggable/openrows.git && cd openrows
docker build -f docker/Dockerfile -t openrows:local .
```

## Quick start

To try OpenRows on your own machine, start the development stack. It needs no configuration and runs everything on 127.0.0.1: Postgres, the migrations, the api, the worker, Keycloak with a ready realm, Mailpit and an S3 server.

```sh
git clone https://github.com/Draggable/openrows.git && cd openrows
docker/compose.sh dev up -d --wait
```

Open http://localhost:8180 and sign in as `dev@openrows.test` with the password `openrows-dev-password`. Mail lands in Mailpit at http://localhost:8025. `docker/compose.sh dev down -v` stops it and drops its data. This stack runs in development mode with well-known secrets, and its Airtable importer talks to a built-in fake Airtable: never expose it.

### A production stack

Use the base file [docker/compose.yml](https://github.com/Draggable/openrows/blob/main/docker/compose.yml) (postgres, migrate, api, worker) with the overlay [docker/selfhost.yml](https://github.com/Draggable/openrows/blob/main/docker/selfhost.yml): it publishes only the api, on loopback for your reverse proxy, passes the settings `compose.yml` doesn't, and has optional profiles for Keycloak in the stack (`keycloak`), malware scanning (`clamav`) and Valkey (`valkey`).

1. Copy [docker/.env.selfhost.example](https://github.com/Draggable/openrows/blob/main/docker/.env.selfhost.example) to a file outside the checkout (mode 600) and fill in every empty value that applies. Leave the Keycloak (`KC_*`, `OPENROWS_KC_*`) values empty unless you turn on the `keycloak` profile.
2. If you need more (another port, a setting the overlay doesn't pass), copy `selfhost.yml` and edit your copy: Compose only reads the env file to fill in `${...}`, so a container sees only what its `environment:` lists.
3. Build and start it (empty values count as unset):

```sh
c="docker compose -p openrows -f docker/compose.yml -f docker/selfhost.yml --env-file /srv/openrows/.env"
$c build
$c up -d --wait
$c ps
```

To run the GHCR image instead of building, set `IMAGE=ghcr.io/draggable/openrows:sha-<commit>` in the env file and use `$c pull` then `$c up -d --wait --no-build`. Compose refuses to start while a required value is empty (`${VAR:?}`), and the server then refuses defaults and placeholders.

## Kubernetes (Helm)

The chart in [deploy/helm/openrows](https://github.com/Draggable/openrows/tree/main/deploy/helm/openrows) runs the same `oss` image as the Compose stack: the api (Deployment and Service), the worker (Deployment), the migrations (a Job), and optionally a Postgres 16 StatefulSet, a Valkey and an Ingress. It isn't published to a chart repository yet: install it from a checkout. It never runs the hosted edition.

What the chart does for you:

- **Migrations first.** On `helm install` the migrate Job starts with everything else and the api and worker pods wait for it (their `wait-for-migrations` init container). On `helm upgrade` it is a `pre-upgrade` hook: the migrations run before any new pod, and a failed migration stops the upgrade with the old pods still serving.
- **Secrets from your Secret only.** The chart never creates a Secret and has no default secret. It refuses to render without `existingSecret`, and on install or upgrade it refuses a Secret that lacks a key it needs.
- **Hardened pods.** Every pod runs as a non-root user with a read-only root filesystem, no privilege escalation, no Linux capabilities, the runtime's seccomp profile, no service account token and resource requests. The values schema refuses to turn those off.
- **Probes.** The api's startup and liveness probes are `/health` (the process serves) and its readiness probe `/ready` (Postgres, S3 and, when set, Redis answer). The worker's are its `/health` (pg-boss runs, Postgres answers). `helm test` checks `/health`, `/ready` and the web client through the Service.

### 1. The image

Pick an image of the commit you run. CI pushes `ghcr.io/draggable/openrows:sha-<full commit sha>` when the push succeeds; otherwise build the `oss` target yourself and push it to a registry your cluster can pull from:

```sh
git clone https://github.com/Draggable/openrows.git && cd openrows
docker build -f docker/Dockerfile --target oss -t registry.example.org/openrows:sha-$(git rev-parse HEAD) .
docker push registry.example.org/openrows:sha-$(git rev-parse HEAD)
```

The chart needs `image.tag` (or `image.digest`): there is no `latest`, because an image and its migrations belong together. Use the chart from the same checkout as the image.

### 2. The Secret

Create one Secret in the release's namespace with these keys. With the bundled Postgres, the two database passwords go into URLs the chart builds, so make them URL-safe (hex):

```sh
kubectl create namespace openrows
kubectl -n openrows create secret generic openrows-secrets \
  --from-literal=ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -hex 24)" \
  --from-literal=OPENROWS_APP_DB_PASSWORD="$(openssl rand -hex 24)" \
  --from-literal=OIDC_CLIENT_SECRET='<your OIDC client secret>' \
  --from-literal=S3_ACCESS_KEY='<access key id>' \
  --from-literal=S3_SECRET_KEY='<secret access key>'
```

| Key | When |
| --- | --- |
| `ENCRYPTION_KEY`, `OIDC_CLIENT_SECRET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | always |
| `POSTGRES_PASSWORD`, `OPENROWS_APP_DB_PASSWORD` | the bundled Postgres (`postgresql.enabled`, the default): its superuser, and the `openrows_app` role the migrate Job gives that password |
| `DATABASE_URL`, `MIGRATION_DATABASE_URL`; optional `INDEX_DATABASE_URL`, `OPENROWS_APP_DB_PASSWORD` | an external Postgres (`postgresql.enabled: false`): the `openrows_app` URL, the schema owner's URL, the owner's URL for the worker's field index builds, and the password the migrate Job gives `openrows_app` (leave it out when your DBA manages the role; see [docs/deploy/database.md](https://github.com/Draggable/openrows/blob/main/docs/deploy/database.md)) |
| `VALKEY_PASSWORD` | the bundled Valkey (`valkey.enabled`); without it, an optional `REDIS_URL` points at yours |
| `SMTP_PASSWORD` | with `smtp.user` |
| `OIDC_ADMIN_CLIENT_SECRET` | with `oidc.adminClientId` |
| `TURNSTILE_SECRET_KEY` | with `turnstile.siteKey` |
| `AI_API_KEY` | optional, with `ai.model` |

Secrets managed elsewhere (External Secrets, Sealed Secrets, Vault) work the same way: the chart only reads the Secret by name.

### 3. Your values

```yaml
# openrows-values.yaml
image:
  repository: registry.example.org/openrows
  tag: sha-<full commit sha>
appUrl: https://openrows.example.org
existingSecret: openrows-secrets
oidc:
  issuerUrl: https://auth.example.org/realms/openrows
s3:
  endpoint: https://s3.eu-west-1.amazonaws.com
  region: eu-west-1
  bucket: openrows-attachments
smtp:
  host: smtp.example.org
  user: openrows
  from: OpenRows <no-reply@example.org>
trustProxy:
  enabled: true # the ingress controller sets X-Forwarded-For
ingress:
  enabled: true
  className: nginx
  tls:
    - secretName: openrows-tls
      hosts: [openrows.example.org]
```

[values.yaml](https://github.com/Draggable/openrows/blob/main/deploy/helm/openrows/values.yaml) documents every value and `values.schema.json` checks them: an http `appUrl`, an unknown key, an image without a digest for Postgres or Valkey, or a secret-looking name in `extraEnv` (more non-secret variables, such as `CLAMAV_URL`) fails the render. The settings behave as in "Configuration" below; the chart sets `NODE_ENV=production`.

### 4. Install

```sh
helm install openrows ./deploy/helm/openrows -n openrows -f openrows-values.yaml --wait --timeout 10m
helm test openrows -n openrows
```

The api serves everything on one Service port: the web client, `/api`, `/auth`, `/mcp` and the realtime WebSocket at `/ws`. Your ingress or proxy must pass WebSocket upgrades and keep idle connections open; the default `ingress.annotations` do that for ingress-nginx (one-hour read and send timeouts, 64 MB bodies for CSV imports). For another controller, replace them with its equivalents. Without `ingress.enabled`, point your own proxy at the Service.

### Upgrades and operations

- **Upgrade:** build or pick the new commit's image, then `helm upgrade openrows ./deploy/helm/openrows -n openrows -f openrows-values.yaml --set image.tag=sha-<new commit> --wait`. The migrate hook runs first; `kubectl -n openrows logs job/openrows-migrate-<revision>` shows its output, and a failed run stays until the next upgrade.
- **Rollback:** `helm rollback openrows <revision>` brings back the old pods, but not the database: migrations only move forward, so restore a backup to undo one (see "Backups and restore").
- **Scaling:** `api.replicas` and `worker.replicas` can be more than one. Realtime runs through Postgres, so the api needs no sticky sessions, and the worker's cron jobs run once per occurrence across replicas.
- **Backups:** the bundled Postgres keeps its data on a PersistentVolumeClaim (`postgresql.persistence`), which `helm uninstall` leaves behind. Back it up with `pg_dump` (`kubectl -n openrows exec statefulset/openrows-postgresql -- pg_dump -U openrows -Fc openrows > openrows.dump`) or your storage's snapshots, and the bucket with your provider's tools. For production, prefer a managed or operator-run Postgres.
- **Not in the chart:** Keycloak (use your own OIDC provider, configured as in "Sign-in"), ClamAV (run clamd and set `extraEnv.CLAMAV_URL`), run-script automation steps (they need a Docker daemon), NetworkPolicies, a PodDisruptionBudget and autoscaling.

## Configuration

`compose.yml` builds `DATABASE_URL` (as `openrows_app`), `MIGRATION_DATABASE_URL` and the worker's `INDEX_DATABASE_URL` (as `PG_USER`) from the `PG_*` values, and sets `NODE_ENV=production`. The full annotated list is [.env.example](https://github.com/Draggable/openrows/blob/main/.env.example). To use a Postgres outside the stack, override those URLs in your overlay and create the roles as [docs/deploy/database.md](https://github.com/Draggable/openrows/blob/main/docs/deploy/database.md) describes: an owner that is a superuser or has `BYPASSRLS` for migrations, and `openrows_app` for the app.

| Variable | Required | What it does |
| --- | --- | --- |
| `PG_DB`, `PG_USER`, `PG_PASSWORD` | yes | The stack's Postgres database and superuser; `migrate` and the worker's index builds connect as it |
| `OPENROWS_APP_DB_PASSWORD` | yes | The password `migrate` gives `openrows_app`, the role the api and worker use. Use a different one from `PG_PASSWORD` |
| `APP_URL` | yes | The app's public https origin. Sign-in redirects to `${APP_URL}/auth/callback`; it is also the CORS origin and the origin state-changing requests must come from |
| `ENCRYPTION_KEY` | yes | At least 32 characters (`openssl rand -base64 32`). Encrypts stored OIDC tokens, the login cookie and secrets such as webhook signing secrets. The api and worker need the same key; changing it signs everyone out |
| `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | yes | Sign-in (see "Sign-in"). `compose.yml` defaults `OIDC_CLIENT_ID` to `openrows-app`; `OIDC_SCOPES` defaults to `openid email profile` |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | yes | Object storage; `S3_REGION` defaults to `us-east-1`, `S3_PUBLIC_URL` is optional (see "Storage") |
| `TRUST_PROXY`, `TRUST_PROXY_HOPS` | behind a proxy | `true` and the number of proxies that append to `X-Forwarded-For`. Only when the api is reachable through the proxy alone |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | no | The app's email. Without `SMTP_HOST`, mail is logged, not sent |
| `OPENROWS_SYSTEM_ADMINS` | no | Comma-separated emails, synced at each sign-in with a verified email. Grants no access to anyone's workspaces; the ops console it unlocks is part of the hosted edition only |
| `AUTH_PROVIDERS` | no | Identity-provider aliases (e.g. `github,google`) shown as "Continue with" buttons, passed as `kc_idp_hint` |
| `STATUS_PAGE_URL` | no | Your status page (https in production). The sign-in page, the help menu and the command palette link to it. Unset: no link |
| `OIDC_ADMIN_CLIENT_ID`, `OIDC_ADMIN_CLIENT_SECRET` | no | Worker only: a Keycloak service account that deletes a deleted account's user at Keycloak |
| `TURNSTILE_SECRET_KEY`, `TURNSTILE_SITE_KEY` | for public forms | Cloudflare Turnstile, both or neither. Without them, production refuses to publish public forms or accept submissions |
| `CLAMAV_URL` | no | `tcp://host:port` of clamd, on the api and the worker (see "Security notes") |
| `AUTH_RATE_LIMIT`, `SHARE_RATE_LIMIT`, `FORM_SUBMIT_RATE_LIMIT` | no | Per-IP limits: `/auth/*` per minute (30), public share link API per minute (600), public form submissions per form in 10 minutes (20) |
| `API_RATE_LIMIT_BASE`, `API_RATE_LIMIT_BASE_BURST`, `API_RATE_LIMIT_TOKEN`, `API_RATE_LIMIT_TOKEN_BURST`, `RATE_LIMIT_STORE` | no | REST API buckets: 5/s burst 10 per base, 50/s burst 100 per token; `postgres` (shared) or `memory` |
| `OUTBOUND_HTTP_ALLOW_HTTP`, `OUTBOUND_HTTP_PORTS`, `OUTBOUND_HTTP_ALLOW`, `OUTBOUND_HTTP_DENY` | no | Webhooks, automations, the Airtable import and synced tables' CSV URLs may only call https on ports 80 and 443 at public addresses. Allow http, more ports or internal targets (`n8n.lan,10.0.5.0/24`); the deny list wins. A synced table's Postgres host follows the same address rules (any port): allow your database's host or network here to sync from it |
| `ATTACHMENT_GC` | no | Worker: `dry-run` (default) counts unreferenced files, `on` deletes them, `off` skips the job |
| `AUTOMATION_EMAIL_DAILY_LIMIT`, `OUTBOUND_WORKSPACE_RATE_PER_MINUTE`, `OUTBOUND_WORKSPACE_BURST`, `OUTBOUND_WORKSPACE_CONCURRENCY` | no | Per-workspace limits on automation emails (100 a day) and outbound requests; over them, work waits |
| `AUTOMATION_SCRIPTS` and `AUTOMATION_SCRIPT_*` | no | Run-script automation steps, `off` by default (see "Security notes") |
| `EXTENSIONS_CUSTOM_BUNDLES` | no | Who may install third-party extension bundles in a base's extension panel: `creators` (and owners), `owners` or `off` (built-in extensions only). Unset: `creators` (`owners` with `EDITION=cloud`) |
| `REVISION_RETENTION_DAYS` | no | Worker: how long record history is kept, 1 to 36,500 days (365) |
| `COMPUTED_SYNC_LIMIT` | no | Stale records per computed field a write recomputes itself (5000); beyond that the worker does it |
| `AIRTABLE_API_URL`, `AIRTABLE_ATTACHMENT_HOSTS` | no | Where the Airtable importer reads from: `https://api.airtable.com` and `dl.airtable.com,*.airtableusercontent.com` by default |
| `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY`, `AI_TIMEOUT_SECONDS` | no | The server's AI provider: any OpenAI-compatible API (`https://api.openai.com/v1` by default; Anthropic's `https://api.anthropic.com/v1`, OpenRouter, or Ollama at `http://ollama:11434/v1` with no key). With `AI_MODEL` set, AI features are on in every workspace. Without it, workspace owners can bring their own key in Settings → AI |
| `AI_ALLOWED_HOSTS` | no | The hosts a workspace's own AI base URL may use (`api.openai.com,*.example.com`); unset, any public host the outbound rules allow |
| `LOG_LEVEL` | no | `info` by default |
| `REDIS_URL`, `EVENT_BUS` | no | Nothing needs Redis yet; `/ready` checks it when set. `EVENT_BUS=redis` isn't implemented and the server refuses to start with it |

With `NODE_ENV=production` the api refuses to start, and logs "invalid configuration, refusing to start" with every problem, when:

- `APP_URL`, `DATABASE_URL`, `ENCRYPTION_KEY`, any `OIDC_*` value above or any of the four `S3_*` values is missing;
- `ENCRYPTION_KEY`, `OIDC_CLIENT_SECRET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `SMTP_PASSWORD`, `OIDC_ADMIN_CLIENT_SECRET`, or the password in `DATABASE_URL` or `REDIS_URL` is a known default or placeholder (`openrows_dev`, `minioadmin`, `secret`, `password`, `changeme`, or anything containing `change-me`, `replace-me` or `example`); `migrate` refuses the same for `OPENROWS_APP_DB_PASSWORD`;
- `APP_URL`, `OIDC_ISSUER_URL` or `AIRTABLE_API_URL` isn't https;
- `SMTP_USER` is set but `SMTP_SECURE` is neither `true` nor `starttls`;
- `DATABASE_URL` connects as a superuser or a role with `BYPASSRLS`. Row-level security is the second layer of tenant isolation, so the server must run as `openrows_app`.

## Sign-in (OIDC)

The server is a backend-for-frontend: it runs the authorization code flow with PKCE (S256) itself and gives the browser only an opaque session cookie. Any OpenID Connect provider works if it:

- serves discovery at `${OIDC_ISSUER_URL}/.well-known/openid-configuration`, with an issuer that matches `OIDC_ISSUER_URL` exactly and that the api container can reach;
- has a confidential client (client secret) for the standard flow, with the redirect URI `${APP_URL}/auth/callback` and post-logout redirects to `${APP_URL}/`;
- puts `email` and `email_verified: true` in the ID token. OpenRows refuses any sign-in with an unverified email;
- keeps its end-session endpoint on the issuer's origin: the CSP allows sign-out's redirect only to that origin.

Users are matched by issuer and subject. While a session is in use the server refreshes the provider's refresh token every 5 minutes, so a user disabled at the provider is signed out.

To run Keycloak in your stack, turn on `selfhost.yml`'s `keycloak` profile (`COMPOSE_PROFILES=keycloak`) with `KC_HOSTNAME`, the `KC_*` secrets and the SMTP values: it adds the `keycloak-db` one-shot (Keycloak's own database in the stack's Postgres) and Keycloak on `KEYCLOAK_BIND` (loopback), for your proxy to publish its realm paths (keep `/admin/` off the public name). The realm file [docker/keycloak/openrows-realm.prod.json](https://github.com/Draggable/openrows/blob/main/docker/keycloak/openrows-realm.prod.json) names the hosted service's URLs: change them to yours before the first start (the realm is imported only once), or create the realm and client by hand. [docs/deploy/keycloak.md](https://github.com/Draggable/openrows/blob/main/docs/deploy/keycloak.md) lists every realm and client setting, the optional Google and GitHub providers and the `openrows-admin` service account. Keycloak sends the sign-up and password-reset mail itself; test its SMTP before you turn on email verification.

## Storage

Attachments, thumbnails and base snapshots (under `snapshots/`) live in the bucket. Any S3-compatible service works (path-style URLs, SigV4); `/ready` checks the bucket with a signed request.

- Browsers upload and download with short-lived presigned URLs, so they must reach the bucket: at `S3_ENDPOINT`, or at `S3_PUBLIC_URL` (the bucket's base URL, bucket included) when they go through another host that keeps the path and Host header.
- Give the bucket a CORS rule for `APP_URL`: methods `PUT`, `GET`, `HEAD`, header `content-type`, exposing `ETag`.
- Keep it private. Every URL is signed, and everything but raster images downloads as an attachment. Serve it from a registrable domain other than the app's.
- The CSP's `img-src` and `connect-src` follow the origin of `S3_PUBLIC_URL`, or of `S3_ENDPOINT`.
- For Cloudflare R2, use `S3_REGION=auto` and leave `S3_PUBLIC_URL` empty. For AWS, `https://s3.<region>.amazonaws.com` and the bucket's region.

## Email

The api and worker send invitations, notification emails and digests, automation emails and notices through `SMTP_*`. Use `SMTP_SECURE=starttls` on 587 (STARTTLS required) or `true` on 465, and set `SMTP_FROM` to your own domain. Send a test from the worker:

```sh
$c exec worker node dist/email/send-test-cli.js you@example.com
```

## Background worker

The worker runs pg-boss jobs in Postgres: the outbox relay (which feeds webhooks, automations and background recomputes), webhook deliveries, automations, notification emails and digests, CSV and Airtable imports, snapshot restores, daily base snapshots, computed fields too large to recompute in a request, field indexes for saved views, the trash purge after 30 days, account and workspace deletion, attachment garbage collection, and the hourly prunes. Without it, none of these run.

- Health: `GET /health` on port 3001 inside the container (the Compose healthcheck), with Prometheus metrics at `/metrics`. The api serves its metrics on `METRICS_PORT` (9464 in `compose.yml`), never published.
- Failed jobs retry 5 times with backoff, then move to the queue's `<name>.dead` queue for 30 days.
- `$c up -d --scale worker=2` is safe: scheduled jobs run once across workers.
- Queue a scheduled job now: `$c exec worker node dist/jobs/run-cli.js <queue>` (it lists the queues when run without one).
- `ATTACHMENT_GC` ships as `dry-run`: files of purged records stay in the bucket until you set it to `on`.

## Backups and restore

Back up three things: the Postgres database (`openrows`, plus `keycloak` if Keycloak keeps its data in the same Postgres), the bucket, and your env file. Base snapshots sit in the same bucket, so they don't replace a backup of it. A consistent dump, taken inside the container:

```sh
$c exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > openrows-$(date -u +%Y%m%dT%H%M%SZ).dump
```

For a production setup, run that dump on a schedule (a systemd timer or cron job), encrypt it, copy it off the host (an S3 bucket in another region works well), alert when the newest backup is older than a day, and regularly restore one into a throwaway stack to prove it works.

To restore: stop `api` and `worker`, make sure the roles exist (`$c run --rm migrate` creates `openrows_app`), recreate the database empty, restore it with `pg_restore --exit-on-error --single-transaction`, then start the stack again with `$c up -d --wait`, which applies any migrations newer than the backup. Users also export their own data: a base from the base menu (**Export base (ZIP)**) and their account from **Settings**.

## Upgrading

```sh
git pull
$c build
$c up -d --wait
```

`up` runs `migrate` first, under an advisory lock, then recreates `api` and `worker` on the new image; the job queue's schema is upgraded the same way. Migrations only go forward: back up before upgrading, because going back across a migration means restoring that backup.

## Security notes

- Publish only the api, on loopback, behind your TLS proxy. Never publish Postgres. Set `TRUST_PROXY` only when the proxy is the only way in, or clients choose their own IP for rate limits.
- Pass WebSocket upgrades on `/ws` through the proxy, with the `Origin` header and a read timeout above 30 seconds (the gateway pings every 30 s and checks `Origin` against `APP_URL`).
- The api sets the CSP, HSTS (when `APP_URL` is https) and the other security headers itself. Don't add a second CSP at the proxy: browsers enforce both.
- Malware scanning: turn on `selfhost.yml`'s `clamav` profile and set `CLAMAV_URL=tcp://clamav:3310` (the overlay passes it to the api and the worker). Uploads then wait as "scanning" until the worker's scan passes them; infected files are quarantined, and a scanner that is down never lets a file through. clamd needs about 1.5 GB of memory and downloads its signatures on first start.
- Run-script automation steps are off. Turning them on (`AUTOMATION_SCRIPTS=local-container`) runs each script in a locked-down `docker run`, which needs a Docker daemon, and whatever reaches a daemon is root on its host: read [docs/deploy/automation-scripts.md](https://github.com/Draggable/openrows/blob/main/docs/deploy/automation-scripts.md) first.
- Extensions run in a sandboxed frame without your app's origin, cookies or network, and reach data only through the scopes their manifest declares, as the person viewing them. A third-party bundle is still code you run in your users' browsers (a frame can always navigate itself away, carrying what it has read in the URL), so `EXTENSIONS_CUSTOM_BUNDLES` limits who may install one: set `owners` or `off` to tighten it.
- Outbound requests to user-chosen URLs never reach private addresses unless you allow them with `OUTBOUND_HTTP_ALLOW`, and never the cloud metadata service.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| The api exits right after start | `$c logs api`: "invalid configuration, refusing to start" lists each variable, or "bypasses row-level security" means `DATABASE_URL` isn't `openrows_app` |
| `api` and `worker` never start | `$c logs migrate`: it must exit 0. It refuses a default `OPENROWS_APP_DB_PASSWORD` |
| `/ready` answers 503 | Its `checks` say which dependency fails: `database`, `s3` or `redis` |
| Sign-in fails | The issuer at `${OIDC_ISSUER_URL}/.well-known/openid-configuration` must match exactly and be reachable from the container; the redirect URI must be `${APP_URL}/auth/callback`; the email must be verified |
| Sign-out isn't redirected | The provider's end-session endpoint is on another origin than its issuer |
| Uploads or thumbnails fail in the browser | The bucket's CORS rule for `APP_URL`, and whether browsers reach `S3_PUBLIC_URL` or `S3_ENDPOINT` |
| No live updates, "offline" banner | `/ws` upgrades through the proxy, and the `Origin` header matches `APP_URL` |
| Public forms won't publish | `TURNSTILE_SECRET_KEY` and `TURNSTILE_SITE_KEY` must reach the api container |
| No email | Without `SMTP_HOST` mail is only logged; send a test with `send-test-cli.js` |
| Imports, webhooks or snapshots never finish | The worker's health and logs; "INDEX_DATABASE_URL is not set" means no field indexes are built |
| A webhook to your LAN is refused | Allow the target with `OUTBOUND_HTTP_ALLOW` (and `OUTBOUND_HTTP_ALLOW_HTTP`, `OUTBOUND_HTTP_PORTS`) on the api and worker |
| "Sync data" from a database or CSV on your LAN says "private or reserved address" | Allow the host with `OUTBOUND_HTTP_ALLOW` on the api and worker (a CSV over http also needs `OUTBOUND_HTTP_ALLOW_HTTP`, and a port besides 80/443 `OUTBOUND_HTTP_PORTS`) |

Logs are JSON lines: `$c logs -f api worker`. `GET /health` answers while the process is up and names the edition; `GET /ready` checks the dependencies.
