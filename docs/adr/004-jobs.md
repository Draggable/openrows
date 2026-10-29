# ADR-004: Background jobs with pg-boss in a separate worker process

- **Status:** Accepted (2026-10-25)
- **Related:** [ADR-003](003-realtime.md) (outbox)

## Context

The prototype ran automations and webhooks in-process and fire-and-forget, with `node-cron`.
Work was lost on restart, retries didn't exist, and every replica ran every cron job. We need
durable jobs for webhooks, automations, scheduled triggers, formula and rollup recompute,
`CREATE INDEX CONCURRENTLY`, field type changes on large tables (ADR-001), imports and exports,
and outbox pruning. Self-hosting must not need anything besides Postgres.

## Decision

1. **pg-boss** (current major, Postgres 13+) is the job queue. It stores jobs in its own
   `pgboss` schema in the same database. It uses `SKIP LOCKED` for exactly-once fetch, and
   provides retries with backoff, expiry, dead-letter queues, singleton/throttle keys and cron
   schedules that run once per cluster.
2. **A separate `worker` process, from the same image.** `packages/server` gets a second entry
   point, `dist/worker.js`. Compose runs `api` (`node dist/index.js`) and `worker`
   (`node dist/worker.js`) from one image. The worker shares the
   services, field-type registry and DB layer with the API, so we don't need a separate
   package until it diverges. The worker also uses the `openrows_app` role and sets
   `app.workspace_id` per job (ADR-002).
3. **The outbox feeds the queues.** A relay job (a pg-boss singleton) reads new outbox rows past
   a stored cursor, matches them against webhooks and automation triggers, and enqueues one job
   per match with `singletonKey = <outbox id>:<subscriber id>`. Enqueueing is idempotent, so a
   crash between enqueue and cursor update creates no duplicates. Jobs the API starts directly
   (an import, an index build) are sent inside the request transaction, using pg-boss's
   `db` option, so a rolled-back request creates no job.
4. **Job rules.** Every job has:
   - a `workspace_id`;
   - an idempotency key;
   - `retryLimit` (default 5) with exponential backoff;
   - `expireInSeconds`, the per-run timeout;
   - a dead-letter queue, shown in the UI for automations.

   Automation-triggered writes carry a `depth` in their outbox payload, and the chain stops at
   depth 5 (loop protection). Per-workspace concurrency and monthly run quotas are checked in
   the handler. Quotas come from the entitlements interface ([ADR-005](005-open-core.md)) and
   are unlimited in the open-source build.
5. **Outbound HTTP goes through one SSRF-safe client.** It resolves DNS, blocks private, link-local
   and metadata ranges after resolution, limits redirects and response size, and signs payloads
   with HMAC-SHA256 plus a timestamp. User scripts, if they come, run in an isolated sandbox,
   never in the worker process.

## Consequences

- Self-host needs only Postgres. The default Compose file runs both `api` and `worker`.
- Queue throughput is bounded by Postgres. pg-boss handles thousands of jobs per second on
  modest hardware, which is far above our expected automation volume. Hot paths (realtime
  fan-out) don't go through the queue.
- pg-boss creates and migrates its own schema at startup. It runs as `openrows_owner` in the
  `migrate` one-shot, not at API boot, so the app role doesn't need DDL rights.
- If job volume ever outgrows Postgres on hosted, the queue sits behind a small `Jobs`
  interface (`send`, `work`, `schedule`) and can move to BullMQ on the hosted Redis.

## Alternatives considered

- **graphile-worker.** It's also Postgres-only and lower latency (LISTEN-based), and it's a good
  library. pg-boss wins on built-in dead-letter queues, throttling, singleton keys and cron
  without extra code.
- **BullMQ.** It's mature, but it needs Redis, which self-hosters would then have to run.
- **Temporal or Inngest.** Too heavy for the problem, and they're another service to operate.
- **In-process jobs in the API.** That's what the prototype did. Work is lost on deploy, and
  jobs compete with request latency.

## Implementation notes (2026-10-26)

- **pg-boss 12** (`packages/server/src/jobs/`). The `migrate` one-shot installs and migrates the
  `pgboss` schema as the schema owner (`install.ts`, called by `runMigrations` under its advisory
  lock), then grants `openrows_app` `USAGE` on the schema and rows, sequences and functions in
  it, never `CREATE`. Neither the api nor the worker runs pg-boss migrations (`migrate: false`).
- **Queues are created by the worker** (`ensureQueues`), not by migrate: non-partitioned queues
  are rows, so the app role can, and the queue settings live next to their handlers. Every queue
  gets a dead-letter queue `<name>.dead` (standard policy, kept 30 days). Recurring jobs use the
  `stately` policy (one queued, one active), retry 5 times with exponential backoff and have an
  expiry; their cron schedules are declared at every start (`boss.schedule`, UTC) and run once
  per occurrence across workers. Each also runs once at start, deduplicated across workers by
  `singletonKey: 'start'` with a 10-minute slot.
- **Tenant context**: `withTenant(db, workspaceId, fn)` is `inScope` with the workspace and no
  user; `tenantJob(db, schema, fn)` checks the job's data (which must carry `workspaceId`) with
  Zod first. A job with bad data fails and, after its retries, is dead-lettered.
- **The `Jobs` interface** (`send.ts`) has `send(tx, queue, data, options)` and `stop()`; pg-boss
  runs in the api only to send (started lazily on the api's Drizzle database through pg-boss's
  Drizzle adapter; no supervision, cron or registry there). The job is written in the request's
  transaction.
- **Outbox relay ordering.** Outbox ids are taken before commit, so the relay can't simply read
  "ids past the cursor": a transaction holding id 10 may commit after one holding id 11. The
  outbox has a `txid xid8` column (default `pg_current_xact_id()`), and `outbox_relay_next`
  (SECURITY DEFINER; event metadata only, never the payload) returns rows past a `(txid, id)`
  cursor whose `txid` is below `pg_snapshot_xmin(pg_current_snapshot())`: every transaction that
  could still commit sorts after the cursor, so nothing is skipped. The price is that a long
  transaction anywhere in the cluster holds the relay back until it ends.
- **Relay idempotency.** One relay runs at a time (a transaction-level advisory lock). Jobs get a
  name-based UUID id from `(outbox id, subscriber id)` and `singletonKey = <outbox id>:<subscriber
  id>`; pg-boss inserts with `ON CONFLICT DO NOTHING` on `(queue, id)`, so a batch replayed after
  a crash between enqueue and `outbox_relay_advance` sends nothing new, even when the first
  delivery already completed (a singleton key alone only dedupes queued jobs). The cursor moves
  forward only.
- **Ops**: the worker serves `GET /health` and `GET /metrics` (Prometheus text) on
  `WORKER_PORT` (3001), used by the Compose healthcheck; SIGTERM stops fetching and waits up to
  15 s for running jobs (`stop_grace_period: 20s`).

## Implementation notes (2026-10-26): the SSRF-safe client

- **`packages/server/src/lib/safe-fetch/`** implements §5's client: `createSafeFetch(policy)`
  returns a `fetch`-like function with a buffered, capped response. Every hop (at most 3
  redirects) is checked again: scheme, port, credentials, then DNS once and every answer against
  `address.ts`; the connection goes to the first validated address through the socket's
  `lookup`, with the hostname kept for Host, SNI and the certificate check, so DNS rebinding
  can't move it. Built on `node:http`/`node:https` with a fresh agent per request rather than
  undici: same pinned-`lookup` mechanism, no new dependency (undici 8 needs Node 22.19), and no
  proxy environment variables are ever read.
- **Policy** comes from `OUTBOUND_HTTP_ALLOW_HTTP`, `OUTBOUND_HTTP_PORTS`, `OUTBOUND_HTTP_ALLOW`
  and `OUTBOUND_HTTP_DENY` (off by default; the deny list wins over the allow list; the cloud
  metadata addresses are refused even when allowlisted).
- **Errors** are `SafeFetchError` with a code (`ADDRESS_NOT_ALLOWED`, `TIMEOUT`,
  `RESPONSE_TOO_LARGE`, ...) and a message safe to show in delivery logs: it names the host,
  never the address it resolved to.
- **Boundary**: `boundary.test.ts` fails when other server code opens outbound connections
  (global `fetch`, undici, `node:http(s)` clients, sockets, HTTP client libraries), apart from a
  short allowlist of operator-configured destinations.

## Implementation notes (2026-10-26): webhooks

- The first outbox subscriber. `webhookSubscriber` (`src/webhooks/subscriber.ts`) is in
  `OUTBOX_SUBSCRIBERS`; the worker relays only to subscribers whose queue it runs. It reads the
  enabled webhooks of the batch's bases through the SECURITY DEFINER `webhooks_matching`
  (metadata only: no URL, no secret) and matches on the event kind, the webhook's own base and
  its table filter. Payload-level checks (field filter, form submissions, computed-only updates)
  happen in the job, which reads the event under the tenant's scope.
- `webhooks.deliver` is a `standard` queue: 7 retries, `retryDelay` 450 s with backoff
  (pg-boss: `delay × 2^n × (1..2)`, so ~7.5 min, 15 min, … 8 h, ~24 h in all), capped at 16 h
  per wait, a 2-minute expiry, then the dead-letter queue. One attempt per run: the job reads in
  one tenant transaction, POSTs outside any transaction (never holding a connection over the
  network), and records the attempt in a second one. The relay's job id is the event id
  receivers see, so retries and a replayed relay batch never send a second event id.
- The worker now LISTENs on the outbox channel and sends an `outbox.relay` job ~250 ms after a
  notify (the queue is `stately`, so bursts collapse), so deliveries take seconds, not a minute.
- The worker needs the API's `ENCRYPTION_KEY` (webhook secrets are AES-256-GCM under an HKDF
  key with purpose `webhook-secret`; they must be readable to sign, so they can't be hashed),
  `APP_URL` and the SMTP settings (`loadWorkerConfig`; production refuses a missing or default
  key, as `loadConfig` does). Compose passes them.
- The outbox carries what deliveries need and the realtime projection strips it: `before` (the
  written cells before an update, the record's cells before a deletion) and `via: 'form'` on a
  form's record. Realtime clients see the same payloads as before.

## Implementation notes (2026-10-26): jobs a person waits for, and the attachment GC

- CSV imports and snapshot restores moved from the API process to the worker. The request
  checks everything it can (the mapping, access, the snapshot), inserts a row in `jobs` (tenant
  RLS: kind, status, starter, the checked input, an import's CSV text, progress, result, error)
  and sends the pg-boss job under the same id in the same transaction. The existing import
  endpoints keep their contract; the restore endpoint now answers the job (`RestoreJob`) and
  `GET /api/bases/:baseId/snapshot-restores/:restoreId` polls it. Only the starter reads a job.
- Recovery: `imports.run` and `snapshots.restore` set pg-boss's `heartbeatSeconds` (30), so a
  killed worker's job is failed and retried within about a minute, not after its 2-hour expiry.
  An import commits its progress with each batch and every step locks the job row and re-reads
  it, so a retry resumes after the last committed batch and a racing duplicate run waits, then
  continues or stops; a restore is one transaction that also marks the job done, so a retry
  starts over. Handlers re-check the starter's live role in every step.
- Failure is always visible: an `AppError` fails the job with its message at once (no retry);
  any error on the last attempt fails it with a generic message; `jobs.sweep` (every minute,
  SECURITY DEFINER `jobs_sweep`) fails running rows whose pg-boss job is gone or failed for
  good, and `jobs_prune` deletes finished rows after 7 days.
- The API creates the queues it sends to (`API_QUEUES`) if no worker has yet: pg-boss refuses a
  send to a missing queue.
- `attachments.gc` (hourly, needs S3; `ATTACHMENT_GC=dry-run|on|off`, dry run by default) works
  per workspace in its tenant scope; only the workspace list comes from a SECURITY DEFINER
  function. Object keys reach `storage_garbage` through triggers on deleted attachment and
  snapshot rows, so cascades (purged fields, tables, bases) are caught without changing those
  code paths. `packages/server/src/attachments/gc.ts` has the rules that keep live files.
- Exports stay streamed in the request: they start answering with the first page, hold
  one page at a time, and so don't hit a time-to-first-byte proxy timeout.

## Implementation notes (2026-10-27): automations

- **Loop depth is 3, not 5.** The issue set it: a person's change starts a chain at depth 1, and
  a run whose event came from a depth-3 run is recorded as `skipped` (loop guard) and does
  nothing. The depth travels with the transaction, not the RecordService call: the run sets
  `app.automation_id` and `app.automation_depth` (`set_config(..., true)`), and the outbox's
  `automation_id`/`automation_depth` columns default to them, so every event the run writes
  carries its depth, recomputed cells and the linked side of a link included.
- **The third outbox subscriber.** `automationSubscriber` matches record events to the enabled
  record-triggered automations of the event's base and table (`automations_matching`, SECURITY
  DEFINER, metadata only) armed before the event, and sends one `automations.run` job per match
  with `singletonKey = <outbox id>:<automation id>`. The job reads the event under the tenant
  scope and decides (watched fields, the filter's match set, depth).
- **Exactly once per (event or scheduled time, automation).** A run is one transaction: the
  `automation_runs` row with its unique `(automation_id, idempotency_key)`, every step (each in a
  savepoint) and the outcome. A crash leaves nothing and the retry starts over; a replayed batch,
  a duplicate job or one racing it finds the row (or waits on it) and does nothing. Unexpected
  errors retry (3 times); a step's own error (validation, permission, a missing table) is a
  failed run, not a retry.
- **Scheduled triggers** are `automations.schedule` (every minute, `stately`): due automations
  come from `automations_due` (SECURITY DEFINER, ids and times), the run's job id is a name-based
  UUID of (automation, time), and `next_run_at` then moves past now, so a worker that was away
  runs a missed schedule once.
- **As the creator.** The run resolves `created_by`'s live role on the base (`authz_resolve`)
  and runs the actions through the RecordService with it; no role turns the automation off.
  `created_by` becomes whoever changes the trigger or actions or turns it on.
- Per-workspace monthly run counts are kept (`automation_run_counts`); quotas and per-workspace
  concurrency come with the entitlements interface (ADR-005).

## Implementation notes (2026-10-27): more triggers, outbound actions

- **Three more ways into `automations.run`.** Form submissions write a `form.submitted` outbox
  event (internal: never sent to clients) that the automation subscriber maps to
  `formSubmitted`; webhook-received and button-clicked runs are sent by the API itself in the
  request's transaction (`automations.run` is now one of `API_QUEUES`), with idempotency keys
  `hook:<request id>` and `button:<click id>`. The job's data carries the webhook's body (≤ 100
  KB) or the click (record, field, clicker); the clicker is stored as `triggered_by`.
- **The webhook URL is the credential.** `/hooks/a/<token>`: 192 random bits, stored as SHA-256
  (looked up by `automation_hook_resolve`, SECURITY DEFINER: enabled webhook automations of live
  bases only) and encrypted (so creators can see the URL again); rotation replaces both.
- **Outbound steps are at least once.** Email, HTTP and Slack steps run inside the run's
  transaction but act outside it, so a run retried after a crash may send again. Their own
  failures (refused URL, non-2xx, the email cap) fail the step, never retry the job. The daily
  email cap is taken in its own committed transaction (`automation_email_counts`), so a send
  can't be un-counted by a rollback.

## Implementation notes (2026-10-27): test runs and retries

- **Tests and retries run in the API, not the worker.** The builder's Test and a failed run's
  Retry are answered with the run's result, so they run synchronously in the request's
  transaction through the same `performRun` as the `automations.run` job (steps in savepoints,
  `app.automation_depth` = 1 so the loop guard applies to what they cause). The API has the
  worker's outbound client, mailer, cipher and daily email cap for them.
- **As the person who clicked.** Both run with the caller's live role on the base, not as the
  automation's creator, so nobody gets another creator's rights by pressing a button. Runs keep
  `mode` (`live`, `test`, `retry`) and `retry_of`; tests aren't counted and don't change the
  automation's last run; a run is retried at most once (`retry:<run id>` idempotency key).

## Implementation notes (2026-10-27): the Airtable importer

- **`airtable.import`**, one job per Airtable base (`packages/server/src/airtable/import.ts`),
  with a `jobs` row of kind `airtable`. The request creates the empty base first, so the job's
  `base_id` is the only base it ever writes to (every table it touches is checked against it).
- **Secrets in a job row.** The person's Airtable token is the job's only credential: it sits in
  `jobs.payload`, AES-256-GCM-encrypted with its own HKDF purpose (`airtable-token`), never in
  pg-boss's job data. `finishJob`/`failJob` clear it, and `jobs_sweep` (migration
  `0059_airtable_import`) clears it 24 hours after the start at the latest, failing a job still
  running by then.
- **Outbound.** Airtable is called only through the SSRF-safe client, `https://api.airtable.com`
  the only origin, spaced to Airtable's 5 requests a second per base, 30 s after a 429.
- **Resumable.** The schema step commits with the progress (tables and field ids); each page of
  100 records commits with the next Airtable offset, so a retry resumes after the last page.

## Implementation notes (2026-10-27): links, attachments and views of the importer

- **A second pass for links.** Records of a later table don't exist while an earlier one is
  imported, so each page also stores its records' Airtable ids, our ids and their link cells'
  Airtable ids in `airtable_import_records` (RLS like `jobs`, cascade-deleted with the job and
  deleted when it ends). The `links` phase then writes each link pair from the side with the
  fewest links per cell, 100 records a transaction through the RecordService, with an
  Airtable-id cursor in the progress, so a retry resumes after the last batch.
- **Attachments in the job, not a job each.** Airtable's file URLs expire within hours, so a
  page's files are copied before the page's transaction (4 at a time), from the configured file
  hosts only, through the SSRF-safe client; the rows are inserted with the page. A retried page
  copies its files again; the copies of a rolled-back page are unreferenced keys for the GC.
- **Cancel** is a failed job with `progress.cancelled`: each step locks the running row first,
  so the worker stops at the next step and nothing is rolled back.
- **The origin is configuration** (`AIRTABLE_API_URL`, `AIRTABLE_ATTACHMENT_HOSTS`, https in
  production) so the dev and CI stacks can run a fake Airtable (`docker/airtable-fake.mjs`).

## Implementation notes (2026-10-27): notification emails and digests

- **The mailer moved to the worker.** The API's 5-second interval is gone; the worker's
  `notifications.email` job (`stately`, every minute and about a second after a `NOTIFY
  notifications`, which the worker now LISTENs to next to the outbox) claims due notifications
  of recipients on `immediately` through `notifications_email_claim` (unchanged rules: one email
  per recipient and record per 10 minutes, coalesced).
- **Digests** are two cron queues: `notifications.digest.hourly` (`0 * * * *`) and
  `notifications.digest.daily` (`0 8 * * *`, `DAILY_DIGEST_HOUR_UTC`). Each run loops over
  `notifications_digest_claim(frequency, 50)` (SECURITY DEFINER, advisory-locked): all of up to
  50 recipients' due notifications are marked `sending` in one statement, so a recipient gets
  one digest and a second worker or a retry finds nothing to send. Access, the preference and
  a verified address are re-checked per recipient in their scope, as for immediate emails.
- **Retries.** A failed send puts its notifications back to `pending` and the run throws once
  the others were tried, so pg-boss retries it with backoff (a digest run stops claiming after
  a failure, or it would take them right back). A recipient the relay refuses (SMTP 5xx) is
  `skipped`. A worker killed mid-send leaves `sending` rows, claimed again after 15 minutes:
  delivery is at least once, like webhooks.
- **`node dist/jobs/run-cli.js <queue>`** queues one run of any cron job now (the stack's e2e
  uses it for the daily digest; operators can too). It needs the database's credentials.

## Implementation notes (2026-10-28): outbox safety and per-workspace outbound limits

- `outbox_prune` never deletes past the relay cursor: it walks the head in id order and stops at
  the first recent or unrelayed row (migration 0065), so `outbox_floor` stays true and a worker
  down past the 7-day retention loses nothing. `outbox_relay_lag()` also answers the oldest
  unrelayed event's age: the worker's `openrows_outbox_relay_oldest_pending_age_seconds` and the
  API's `/ready` `details.outboxRelay` (informational, never unready).
- The API's last timer, the hourly session sweep, is the worker's `sessions.sweep`. Thumbnails
  still run in the API process (a follow-up).
- Outbound limits per workspace, config now (`OUTBOUND_WORKSPACE_*`), entitlements later through
  `OutboundLimits`: a token bucket `outbound:<workspace>` in the shared `rate_limit_buckets` (one
  token per webhook delivery, HTTP/Slack/email step and script `fetch`), and a concurrency cap
  on `webhooks.deliver` and `automations.run`. The cap uses pg-boss 12's `groupConcurrency`
  (every tenant job is sent with its workspace as `group`), which keeps a noisy workspace's
  backlog in the queue while other workspaces' jobs are fetched; its active count is a snapshot,
  so parallel fetchers can overshoot, and each job also takes an exact slot in the UNLOGGED
  `outbound_leases` (SECURITY DEFINER `outbound_lease_take`/`_release`, expiring with the job).
  Both queues now run several handlers per worker (`localConcurrency` 8 and 4).
- Over a limit, work is delayed, not dropped or failed: `deferJob` completes the job and inserts
  a copy (id named after the job's, so a re-run sends no second copy) due when the bucket refills
  or a slot frees. A webhook copy keeps its event id and attempt count; an automation run is
  rolled back first and re-evaluated when the copy runs.
