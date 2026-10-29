# ADR-002: Tenancy, workspace scoping and row-level security

- **Status:** Accepted (2026-10-25)
- **Related:** [ADR-001](001-record-storage.md) (record storage), [ADR-006](006-auth-provider.md) (auth)
- **Implemented:** `packages/server/src/authz/`, `drizzle/0003_rls.sql`,
  [deploy/database.md](../deploy/database.md) and the tenancy entry in [000-notes](000-notes.md)
, which explains how the resolver reads past RLS (a `SECURITY DEFINER` function).

## Context

In the prototype, tenant isolation depended entirely on per-route checks, and about half of them
were missing. Several queries scanned every tenant (link scans, search, admin, backup). Hot
tables had no tenant id, so every check cost two or three joins (`records → tables → bases →
orgs`). "System admin" meant "owns any org", which was every user (claude-review C1). We need one
tenancy model before M1 adds any tenant data.

## Decision

1. **The workspace is the tenant.** It is the unit of billing, membership, quotas and data
   isolation. Hierarchy: workspace → base → table → field, view and record. A user can belong to
   many workspaces. Users, identities and sessions are global (not tenant-owned).
2. **`workspace_id uuid NOT NULL` on every tenant-owned row in shared tables**, denormalized
   even when it can be derived. This covers bases, tables, fields, views, members, invitations,
   comments, attachments, outbox events, API tokens, webhooks, automations and revisions.
   Child tables reference their parent through a composite foreign key that includes the
   workspace, e.g. `FOREIGN KEY (workspace_id, base_id) REFERENCES bases (workspace_id, id)`. A
   row then can't point at a parent in another workspace, even by a bug.
3. **One request, one workspace, one transaction context.** The authorization layer resolves
   the principal and the target workspace (from the route resource, never from a client-supplied
   header alone), runs `authorize(principal, action, resource)`, and only then opens the
   transaction:

   ```sql
   BEGIN;
   SELECT set_config('app.workspace_id', $1, true), set_config('app.user_id', $2, true);
   -- all queries for this request
   COMMIT;
   ```

   `set_config(..., true)` is `SET LOCAL`, so it works behind a transaction-mode pooler and can't
   leak to the next request on a pooled connection. Workers set the same values per job.
4. **Postgres RLS as defense in depth on the shared tables.** Every tenant-owned shared table
   gets `ENABLE` and `FORCE ROW LEVEL SECURITY` and one policy:

   ```sql
   CREATE POLICY tenant ON fields
     USING (workspace_id = (SELECT nullif(current_setting('app.workspace_id', true), '')::uuid))
     WITH CHECK (workspace_id = (SELECT nullif(current_setting('app.workspace_id', true), '')::uuid));
   ```

   The scalar subquery makes Postgres evaluate the setting once per query (an InitPlan), not once
   per row. With no workspace set, the policy matches nothing. `workspace_members` adds a second
   policy (`user_id = app.user_id`), so "list my workspaces" works before a workspace is chosen.
5. **Two database roles.** `openrows_owner` owns the schema and runs migrations and the
   physical-table DDL manager. `openrows_app` (`NOSUPERUSER NOBYPASSRLS`, not an owner) is what
   the API and the worker connect as. The CI cross-tenant test suite connects as
   `openrows_app` too.
6. **Physical record tables (ADR-001) have no RLS policy.** Each physical table belongs to
   exactly one workspace, so the only possible policy compares the setting with a constant. The
   ADR-001 benchmark shows the cost. RLS quals run before user quals, so a user qual can only
   become an index condition if its operator is `LEAKPROOF`. `numeric` comparisons, `ILIKE` and
   most `timestamptz` comparisons aren't, so a 1 ms indexed number-range page turned into a
   sequential scan under RLS. Isolation for record tables comes from three things instead:
   - Physical names are never derived from user input. The query compiler only accepts a
     `TableHandle` loaded from `tables`/`fields` metadata **inside the same RLS-scoped
     transaction**. Another workspace's table doesn't exist from the request's point of view.
   - Physical schema and table names contain random UUIDs, not sequential ids.
   - A generated cross-tenant test matrix (role × action × resource × same/other workspace)
     runs in CI against real Postgres.
7. **The system admin is a separate flag**, `users.is_system_admin`, set only from the CLI or
   from `OPENROWS_SYSTEM_ADMINS` (a list of emails) at boot. It is never derived from workspace
   ownership. System-admin endpoints live in their own module (the ops console is in the hosted
   edition, per [ADR-005](005-open-core.md)), use an explicit `openrows_admin` connection with `BYPASSRLS`,
   and write an audit entry for every action.
8. **Tenant routing from day one.** `workspaces.db_cluster` (default `'default'`) names the
   Postgres cluster that holds the workspace's data. Data access gets its connection from
   `dbFor(workspaceId)`, even though there is only one cluster until hosted load needs more
   (see ADR-001 for the catalog-size trigger).

## Consequences

- Every new tenant table needs a `workspace_id`, a composite FK and the RLS policy. A migration
  test fails if a table in `public` has a `workspace_id` column but no policy, or has neither
  and isn't on an explicit allowlist of global tables (users, identities, sessions, and so on).
- Queries on shared tables should filter by uuid/text equality, which is leakproof, so the
  policy doesn't block their indexes. Anything heavier belongs in the record tables.
- Forgetting `set_config` fails closed (no rows), not open.
- Moving a base to another workspace means updating `workspace_id` on its metadata rows. The
  physical tables don't change.
- Cross-workspace features (system admin, global search for support) must go through the
  admin path and are audited.

## Implementation notes

- **Personal access tokens.** A token belongs to a user, not a tenant:
  `personal_access_tokens` has no `workspace_id` (it is on the global-table allowlist) and an
  owner policy on `app.user_id` instead of the tenant policy; bearer auth reads it by public id
  through the SECURITY DEFINER `pat_lookup`. A token stores scopes and grants (workspaces or
  bases), never a role: `authorize()` computes the user's live role as for a session, then
  answers `not_found` outside the grants and `forbidden` when the action's scope
  (`ACTION_SCOPES` in `packages/shared/src/authz.ts`) is missing or null (session only). So a
  token never exceeds its user, and loses access the moment the user does.
- **REST API v1.** `/api/v1/:baseId/:tableIdOrName` names a table by id or name, so it
  can't be resolved by `authz_resolve` alone: each route is a resource route on the base (404
  outside the tenancy or the token's grants), and the handler then looks the table up among the
  base's live tables only and runs `authorize()` for the table action on it (`authorizeTable` in
  `packages/server/src/v1/records.ts`). A table name of another base never matches.

- **Interface-only collaborators.** An interface is a resource kind of its own
  (`interface`): `authz_resolve('interface', id, user)` answers the workspace and base roles and,
  from `interface_members`, the user's interface role (editor or read-only). `effectiveRole`
  counts that role on the interface only, never on its base, tables, fields, views or other
  interfaces, so the base's API stays a 404 to someone who has nothing else. Their requests run
  with `app.interface_id` set (`withResource`), and RESTRICTIVE `interface_scope` policies on
  `interfaces`, `interface_pages` and `interface_members` then show that interface's rows only.
  What a page reads leaves through a share-like projection (only the fields it shows, its filter
  applied with `me` as the viewer), and what it writes goes through the RecordService with the
  viewer's role, limited to the page's editable fields and form fields. Every route of the
  matrix also runs as an interface-only editor and viewer.

- **Data residency.** A region is a separate stack with its own database, so tenancy
  inside a region is unchanged. `db_cluster` (§8) stays a within-region knob; a workspace's region
  is the stack it was created on (the hosted edition runs one stack per region; ADR-005).

## Alternatives considered

- **Database or schema per workspace.** Strong isolation, but connection pools and migrations
  multiply with the tenant count, and it doesn't suit a free tier with many small workspaces.
  Schema per *base* for record tables (ADR-001) gives most of the operational benefit.
- **RLS on record tables too.** Rejected because of the leakproof index problem measured in
  ADR-001. Marking `numeric` and `ILIKE` operators `LEAKPROOF` would need superuser on every
  self-hosted install and is unsafe for operators that can raise errors.
- **App-layer checks only.** That's what the prototype had. One missed check is a cross-tenant
  leak.
