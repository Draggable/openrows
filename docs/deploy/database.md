# Database roles and row-level security

OpenRows isolates tenants in two layers ([ADR-002](../adr/002-tenancy.md)). Every route goes
through `authorize()` in `packages/server/src/authz/`. Behind that, Postgres row-level security
(RLS) hides every other workspace's metadata rows. RLS only helps if the server connects as a
role it applies to, so OpenRows uses two roles.

| Role | What it does | Attributes |
| --- | --- | --- |
| Schema owner (`openrows_owner`, or the Postgres superuser) | Owns the `public` schema, runs migrations (and, from M1, the DDL manager and pg-boss). Owns the `SECURITY DEFINER` functions `authz_resolve` and the DDL manager's `ddl_*` (migration `0005`), and the per-base `b_*` schemas and record tables they create. Must own the database, because `ddl_create_base_schema` creates schemas | Superuser, **or** `LOGIN CREATEROLE BYPASSRLS` and owner of the database |
| `openrows_app` | What the API server (and, from M1, the worker) connects as | `LOGIN NOSUPERUSER NOBYPASSRLS`, owns nothing, DML on `public` tables and on record tables (granted by the DDL manager), `EXECUTE` on the `ddl_*` functions, no DDL |

Migration `0003_rls` refuses to run as an owner that RLS would apply to, because
`authz_resolve` must read past RLS to find a resource's workspace. It also creates
`openrows_app` (without `LOGIN`) if it doesn't exist, and grants it `SELECT, INSERT, UPDATE,
DELETE` on every `public` table, now and in later migrations (default privileges). The tenant
tables (`workspaces`, `workspace_members`, `base_members`, `bases`, `tables`, `fields`, `views`)
have `ENABLE` and `FORCE ROW LEVEL SECURITY`. `users` and `sessions` are global and have none.

At startup the server checks its own role. With `NODE_ENV=production` it exits if
`DATABASE_URL` connects as a superuser or a `BYPASSRLS` role. Elsewhere it logs a warning.

## Environment

| Variable | Used by | Value |
| --- | --- | --- |
| `MIGRATION_DATABASE_URL` | `node dist/migrate.js` / `npm run db:migrate` | The schema owner. Falls back to `DATABASE_URL` |
| `OPENROWS_APP_DB_PASSWORD` | the migrate one-shot | When set, migrations end with `ALTER ROLE openrows_app LOGIN PASSWORD '…'`. Known defaults are refused in production |
| `DATABASE_URL` | the server | `postgresql://openrows_app:<password>@host:5432/openrows` |

So one migrate run both creates the role and gives it the password the server uses. If a DBA
manages roles instead, leave `OPENROWS_APP_DB_PASSWORD` unset and create the role first:

```sql
CREATE ROLE openrows_app LOGIN PASSWORD '…' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
```

## Setups

**Development** (`docker/compose.sh dev`, Postgres on `localhost:5432`). The `openrows` user
from `PG_USER` is a superuser. With no database variables set, `npm run db:migrate` connects as `openrows` and gives
`openrows_app` the password `openrows_app_dev`, and the server's default `DATABASE_URL` connects
as `openrows_app`. Run `npm run db:migrate` once after pulling this change.

**Docker / self-host** ([docker/compose.yml](../../docker/README.md)). The `migrate`
one-shot connects as the Postgres superuser (`PG_USER`/`PG_PASSWORD`, as
`MIGRATION_DATABASE_URL`) with `OPENROWS_APP_DB_PASSWORD` set. The `api` and `worker` services
connect as `openrows_app` with that password. Postgres doesn't need an init script.

**Production on a shared Postgres.** Run this once as a superuser:

```sql
CREATE ROLE openrows_owner LOGIN PASSWORD '…' NOSUPERUSER CREATEROLE BYPASSRLS;
CREATE DATABASE openrows OWNER openrows_owner;
```

Then point `MIGRATION_DATABASE_URL` at `openrows_owner` and set `OPENROWS_APP_DB_PASSWORD`. The
integration tests migrate their template database exactly this way (a non-superuser owner with
`BYPASSRLS`) and run the app as `openrows_app`.

## How a request is scoped

1. `withResource(kind, action)` opens one transaction for the request and calls
   `authz_resolve(kind, id, user_id)`. That returns the resource's workspace, base and the
   user's workspace and base roles in one query.
2. `authorize(principal, action, resource)` decides: 404 if the resource doesn't exist or the
   user has no role there (so other tenants' ids don't leak), 403 if the role is too low.
3. Only then: `set_config('app.workspace_id', …, true)` and `set_config('app.user_id', …, true)`.
   These are `SET LOCAL`, so they end with the transaction and are safe behind a
   transaction-mode pooler. The handler runs on that transaction.

Without `app.workspace_id`, the tenant policies match nothing, so a forgotten scope fails
closed. With only `app.user_id` set, a user sees just their own `workspace_members` and
`base_members` rows and their workspaces ("list my workspaces").

Every new tenant table needs `workspace_id`, a composite foreign key to its parent and the RLS
policy (copy one from `drizzle/0003_rls.sql` into a `drizzle-kit generate --custom` migration).
`test/integration/migrations.test.ts` fails otherwise.
