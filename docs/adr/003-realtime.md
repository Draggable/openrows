# ADR-003: Realtime collaboration model

- **Status:** Accepted (2026-10-25)
- **Related:** [ADR-001](001-record-storage.md), [ADR-002](002-tenancy.md), [ADR-004](004-jobs.md)

## Context

The prototype's WebSocket code was never mounted. It took the user's identity from the query
string, kept state in single-process `Map`s, and no write path ever broadcast anything.
Record edits were read-merge-write of a whole JSONB blob, so two people editing one record lost
changes. The ADR-001 benchmark reproduced this: 23 lost cells in 2 seconds on 8 hot rows. We
need a model that works for one self-hosted container and for several hosted API replicas.

## Decision

1. **Server-authoritative operations.** Clients never send whole records. They send ops, e.g.
   `setCells { tableId, recordId, cells: { [fieldId]: value }, clientOpId }`, over REST or
   the WebSocket. Both call the same `RecordService`. In one transaction it authorizes, validates
   and coerces each value through the field-type registry, runs
   `UPDATE … SET <only those columns>, version = version + 1, updated_at, updated_by RETURNING version`,
   and inserts an outbox row.
2. **Per-cell last-writer-wins, with record versions.** Concurrent edits to different cells of
   one record both survive. Each statement updates only its own columns, and Postgres row locks
   serialize the statements (0 lost updates in the benchmark). For the same cell, the last commit
   wins, which is what Airtable does. The `version` that comes back lets clients detect that
   their copy is stale. Structural ops (field config, view config, deleting a record someone is
   editing) carry `baseVersion` and fail with `409` on mismatch.
3. **Transactional outbox.** `outbox(id bigserial, workspace_id, base_id, table_id, kind,
   payload jsonb, actor_id, client_op_id, created_at)` is written in the same transaction as the
   change, so events are never lost and never sent for rolled-back writes. The same transaction
   calls `pg_notify('outbox', <base_id>)`, and Postgres delivers it only on commit. The payload
   stays in the table, because NOTIFY payloads are capped at 8 kB.
4. **Fan-out behind an `EventBus` interface.**
   - Self-host: each API process holds one dedicated `LISTEN outbox` connection (not pooled).
     On a notification it reads `outbox WHERE id > last_seen` and pushes to subscribed sockets.
     That needs no extra infrastructure and works with several replicas on one database.
   - Hosted: one relay (in the worker, with a pg-boss singleton) reads the outbox and publishes
     per-base channels to Redis (Valkey) pub/sub. The WebSocket nodes subscribe there. It is the
     same interface with a different implementation, selected by `EVENT_BUS=postgres|redis`.
5. **Ordering and catch-up.** Events are ordered per base by outbox `id`. Each message carries
   its `seq`. A client that sees a gap, or reconnects, asks `GET /bases/:id/events?since=<seq>`.
   If `seq` is older than the retention window (7 days, pruned by a pg-boss cron), the client
   refetches the views it has open.
6. **WebSocket gateway.** It is mounted on the API server (`/ws`). Auth is the same session
   cookie as HTTP, checked at upgrade, with an `Origin` check. There are no tokens in query
   strings. Clients subscribe per table or view; access is checked on subscribe and again when
   a permission-change event arrives. Payloads go through the same field-visibility projection
   as REST, so hidden fields never leave the server.
7. **Client.** It applies ops optimistically, matches the echo by `clientOpId`, and patches
   TanStack Query caches by record id instead of invalidating them. Undo/redo is client-side
   inverse ops sent as normal ops.
8. **Presence is ephemeral.** Cursors and selections don't go through the outbox. They travel
   on the same bus, as NOTIFY without persistence or Redis keys with a TTL, and are rate-limited
   per socket.
9. **Yjs only for rich text, later.** Long-text and rich-text cells may get a Yjs document per
   cell in M3+, stored beside the record. Everything else stays LWW.

## Consequences

- Every mutation goes through `RecordService` or `SchemaService` and writes an outbox row. The
  outbox also feeds webhooks and automations (ADR-004), so there is one event stream.
- A `LISTEN` connection can't sit behind a transaction-mode PgBouncer. The API needs one direct
  connection per process.
- With LWW, two people typing in the same cell at once doesn't merge text. That's acceptable
  for cells. Rich text gets Yjs.
- The outbox grows with write volume. It needs an index on `(base_id, id)` and the pruning job.

## Implementation notes

- **Gateway:** `packages/server/src/realtime/` (`gateway.ts`, `bus.ts`, `projection.ts`,
  `routes.ts`), on the `ws` library with the HTTP server's `upgrade` event (`index.ts` passes it to
  `startServer`). `/ws` isn't a Hono route, so the gateway checks what the route registry would:
  `Origin` must equal `APP_URL` (a missing one is refused), the session cookie must resolve
  through the same `SessionStore`, and the query string is never read. Refusals are plain HTTP
  answers before the upgrade: 403, 401, 404 (another path), 429 (per-user socket cap).
- **Protocol** (`packages/shared/src/schemas/realtime.ts`, strict Zod): client `subscribe` /
  `unsubscribe` `{ target: { tableId } | { viewId } }` and `ping`; server `ready`, `subscribed`
  (with the `seq` events start after), `unsubscribed`, `event { seq, baseId, tableId, kind,
  payload, actorId, clientOpId, at }`, `revoked`, `error { code }`, `pong`. A subscription gets its
  table's events plus the base's `base.*` and `table.*` events (the sidebar).
- **Authorization:** subscribe runs `authorize()` like the REST read (`record:read` on the table,
  `view:read` on the view, where another user's personal view doesn't exist). Missing, trashed,
  another tenant's and malformed ids all get the same `NOT_FOUND` error. Membership changes,
  workspace updates and deletion write an access event (`base_id` NULL) and `NOTIFY
  outbox_access, <workspace id>`; the bus handles it on the same queue as event delivery, so a
  removed member's subscriptions are `revoked` before any later event. `*.deleted` events for a
  base, table or view re-check that base's subscriptions, and every 60 s the gateway re-checks
  every subscription and session (sign-out or expiry closes the socket with 4401).
- **Projection:** `projectEvent` is the one filter for the socket and catch-up. A personal
  view's events carry `personalTo` and reach only its owner. `FieldVisibility` is the hook for
  field permissions; today nothing is hidden.
- **Ordering without gaps:** ids come from one sequence but transactions commit out of order, so
  a reader that moved past id 11 would skip id 10 committed later. Writers take
  `pg_advisory_xact_lock_shared(hash('outbox:'||base))` in `emitMany` (writers never wait for
  each other); readers (the bus, catch-up) take the exclusive lock with `pg_try_advisory_xact_lock`
  and never wait: while a writer of the base is in flight they retry (20 ms doubling to 1 s; its
  commit notifies too). A writer holding the lock for long delays that base's events until it
  commits.
- **Limits:** 16 kB per client frame (1009), 50 subscriptions per socket, 20 sockets per user and
  process, 20 messages/s (burst 40; 20 refusals close with 1008), ping every 30 s (no pong:
  terminated), 5 min without subscriptions closes (4000), more than 4 MB unsent closes (1013).
- **Catch-up:** `GET /api/bases/:baseId/events?since=&limit=` (`base:read`, up to 1,000 per page,
  `next` and `hasMore`). `since` below `outbox_floor()` (the highest id the prune may have
  removed) is 410 `EVENTS_EXPIRED`. A new subscription's `seq` is never below the floor.
- **Retention:** the worker calls `outbox_prune('7 days')` hourly (SECURITY DEFINER, deletes an
  id prefix in batches), an interval timer until pg-boss. `EVENT_BUS=redis` is a stub that refuses
  to start (M5).

## Implementation notes (client)

- **One connection per tab:** `packages/client/src/features/realtime/connection.ts`
  (`RealtimeConnection`, no React, tested with a fake socket), provided by `RealtimeProvider` in
  the authed shell. Components call `useRealtimeSubscription({ tableId })` (ref-counted; the base
  page subscribes to the open table). The socket opens with the first subscription, closes 30 s
  after the last, reconnects with backoff (500 ms doubling to 30 s, times 50–100 % jitter; at once
  on the browser's `online`), sends an application `ping` every 25 s and drops a socket silent for
  40 s. Close 4401 refetches `/api/me` (the route guard signs the user out).
- **Resume:** the client keeps the last applied seq per base. After a reconnect, the first
  `subscribed` of a base starts a catch-up from it (pages until `hasMore` is false); the new
  socket's events are buffered meanwhile and applied after, and every seq is applied at most once.
  410 or any failure refetches every open query and continues from the new socket's position.
  Seqs have gaps by design (one sequence for every base), so a gap is only detected as a lost
  socket.
- **Caches:** `apply.ts` patches by record id (`record.updated` cells merged into lists, view
  queries and details unless the cache already has that version or newer), drops deleted records
  from lists, refetches the table's lists for creates, restores, deletes and manual moves, and
  invalidates schema queries for field, table, view, section and base events. A record edited out
  of a view's filter stays until the next refetch (Airtable behaviour). Own echoes are recognised
  by `clientOpId` (`src/api/clientOps.ts` remembers the tab's last 1,000) and skipped.

## Implementation notes (presence)

- **Scope:** presence is per view. A `{ viewId }` subscription (authorized like any other) joins
  the view with an empty state; `presence { viewId, state }` replaces it (`recordId`, `fieldId`,
  `editing`, `expandedRecordId`; strict Zod). Presence for a view the socket isn't subscribed to
  is refused (`NOT_SUBSCRIBED`). Unsubscribing, revocation (access re-checks) and closing leave
  the view at once. Delivery requires an authorized subscription to the view in the entry's
  workspace, so a personal view's presence reaches only its owner's other sockets, which are
  skipped like every socket of the sender's own user.
- **Payload:** `{ connectionId, userId, name, initials, colour, state }`. `connectionId` is
  random per socket; the name is the display name without the email fallback (80 chars max).
  `editing` is forced off below `editor`.
- **Limits:** 10 presence messages a second per socket (burst 20) on top of the general bucket;
  50 entries per view per process; the client sends at most one per 120 ms, latest wins.
- **Bus:** `EventBus.publishPresence`/`onPresence`. The Postgres bus sends `NOTIFY presence`
  on its LISTEN connection (nothing is stored), batching a process's changes every 20 ms into
  frames under 8 kB tagged with a random process id (a process skips its own). Each gateway keeps
  a per-view table of local and remote entries; it re-announces its own every 10 s and drops a
  remote entry not heard of for 30 s, which covers a replica that died without its leaves. The
  Redis bus (M5) will publish the same frames on a channel; it is a no-op until then.
- **Client:** `RealtimeConnection.setPresence(viewId, state)` keeps this tab's state and sends
  it after each `subscribed` of the view; `peers(viewId)` and `onPeers` feed
  `usePresencePeers`. The base page subscribes to the open view and provides `PresenceProvider`
  (`features/realtime/Presence.tsx`); the grid reports its active cell and open editor, the base
  page the `?record=` id.

## Alternatives considered

- **CRDT (Yjs or Automerge) for whole tables.** It merges everything, but it is heavy for 500k
  rows, puts state on the client that the server then has to validate, and works against
  server-side permissions, formulas and constraints.
- **Operational transform.** Same objections, plus more complexity.
- **Optimistic locking on every cell edit (`WHERE version = $v`).** Spurious conflicts whenever
  two people edit different cells of the same row. That's unacceptable for a spreadsheet.
- **Redis only.** It would add a required dependency for self-hosters.
