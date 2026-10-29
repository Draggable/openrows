# ADR-001: Record storage in physical per-table Postgres tables

- **Status:** Accepted (2026-10-25)
- **Related:** [ADR-002](002-tenancy.md) (tenancy and RLS), [ADR-003](003-realtime.md) (write path), [ADR-004](004-jobs.md) (jobs)
- **Evidence:** [`bench/`](../../bench/README.md), raw results in
  [bench/results/2026-10-25-500000rows.md](../../bench/results/2026-10-25-500000rows.md) (plus `.json` with every query plan)

## Context

The prototype stores each record as one JSONB blob keyed by field id, and links as UUID arrays
inside the blob. That gives no typed sorting, no efficient filtering, read-merge-write lost
updates, and tenant-wide scans to find links. This is the most consequential decision in the
project, so we benchmarked both candidates before writing M1 code:

- **(A) Physical tables.** One Postgres table per user table, one typed column per field
  (DDL when a field is created or changed), and a junction table per link field. This is what
  Teable, Baserow and NocoDB do.
- **(B) JSONB.** One shared `records` table with `data jsonb`, links as id arrays, and partial
  expression indexes per indexed field. This is the prototype's layout, plus the indexes it
  lacked.

## Benchmark

Both layouts were loaded with identical, deterministic data: **500,000 rows × 30 fields** (text,
long text, number, rating, single and multi select, date, datetime, checkbox and one link
field), plus a 10,000-row linked table with 749,954 links. Every read query returned the same
answer from A and B.

**Machine:** 8 vCPU Intel Xeon VM, 16 GiB RAM, Linux 6.12, Docker 26.1, `postgres:16-alpine`
(16.15) with `shared_buffers=2GB`, `work_mem=32MB`, `maintenance_work_mem=512MB`,
`random_page_cost=1.1` and `jit=off`. Node 22.23 client over loopback TCP. Medians of 7 runs,
after one warm-up. The full run took 436 s. Reproduce with `cd bench && npm run bench`.

### Reads (ms, median)

| Query | A | B | B / A |
| --- | ---: | ---: | ---: |
| Page of 100 rows, all fields | 2.2 | 1.3 | 0.6× |
| Text contains, trigram index: page / count | 2.5 / 1.0 | 124 / 0.7 | 49× / 0.7× |
| Text contains, no index: count | 90 | 174 | 1.9× |
| Number range 1%, btree: page / count | 2.9 / 1.0 | 5.1 / 2.9 | 1.8× / 2.8× |
| Number range 11%, no index: count | 72 | 172 | 2.4× |
| Select IN, btree: count | 5.2 | 82 | 16× |
| Sort by 3 typed keys, no index: top 100 | 63 | 456 | 7.2× |
| Filter + sort by 2 keys: top 100 | 49 | 163 | 3.4× |
| Group by 1 select (count, sum, avg) | 92 | 808 | 8.8× |
| Group by 2 selects | 95 | 2,392 | 25× |
| Keyset page at the middle, indexed sort | 1.9 | 1.1 | 0.6× |
| Keyset page at the middle, unindexed sort | 88 | 500 | 5.7× |
| OFFSET 250,000 (for contrast) | 45 | 73 | 1.6× |
| Links: page of 100 with linked names / rollup | 1.4 / 0.9 | 1.5 / 1.1 | ~1.1× |
| Backlinks for one record | 0.15 | 0.22 | 1.5× |
| Filter on a rollup over all rows | 386 | 594 | 1.5× |

Point lookups and indexed pages are about 1–3 ms in both layouts. Every query that touches many
rows (unindexed filters, sorts, group-bys, summary bars, counts) is **2–25× faster in A**,
because B has to detoast and parse the JSON and cast it for every row. B is 2× as big on disk
(872 MB vs 459 MB; 1,473 vs 628 bytes per row).

### Writes

| Scenario | A writes/s (p95 ms) | B writes/s (p95 ms) | WAL bytes per write A / B |
| --- | ---: | ---: | ---: |
| 16 clients, random rows, unindexed field | 23,558 (1.2) | 14,990 (1.7) | 2,775 / 7,957 |
| 16 clients, random rows, indexed field | 19,697 (1.3) | 15,020 (1.7) | 4,064 / 7,659 |
| 8 clients, 8 hot rows, one field each | 20,991 (0.6), **0 lost** | 11,832 (1.1), **0 lost** | 247 / 2,791 |
| Same, legacy read-merge-write | | 8,671, **27 lost updates** in 8 s | |

In A, 71% of updates to unindexed fields are HOT (heap-only tuple) updates. In B, any update
rewrites the whole blob, so HOT updates are about 0% and B writes 2–11× more WAL per write.
Bulk insert of 1,000 rows takes 38 ms (A) and 48 ms (B).

### Schema changes, with 4 clients writing to the same table

| Operation | A duration / worst write | B duration / worst write |
| --- | --- | --- |
| Add field | 8 ms / 3 ms (`ADD COLUMN`, metadata only) | 0 ms (no DDL) |
| Add field with `NOT NULL DEFAULT` | 3 ms / 38 ms | n/a |
| Index a field (`CREATE INDEX CONCURRENTLY`) | 404 ms / 10 ms | 616 ms / 337 ms |
| Change type, in place | **4.7 s / 4.6 s** (`ALTER TYPE` rewrite, `ACCESS EXCLUSIVE`) | **19.3 s / 19.3 s** (one `UPDATE`, row locks) |
| Change type, online (batched) | 15.8 s / 1.0 s (shadow column, trigger, 10k batches, swap) | 26.6 s / 0.65 s |
| Delete field | 3 ms / 19 ms (`DROP COLUMN`) | 26.2 s / 0.65 s (strip the key) or leave garbage |

Safety checks passed. `ALTER TABLE` and the metadata `INSERT` roll back together in one
transaction. A DDL queued behind a long reader with `lock_timeout = 1s` gave up after 1,002 ms
(`55P03`). A reader queued behind it waited 902 ms, so `lock_timeout` bounds the stall. The
retry after the reader finished took 1.2 ms.

### Operations

- **RLS** (non-superuser role, ADR-002): a policy on A's tables wrecked the plans. A
  number-range page went from 2.7 to 75 ms, and trigram contains from 0.8 to 93 ms. RLS quals
  run first, so only `LEAKPROOF` operators can become index conditions, and `numeric`, `ILIKE`
  and most `timestamptz` operators aren't leakproof. B suffers the same way (contains went from
  0.9 to 180 ms). Isolation itself worked in both layouts: 0 rows visible with another
  workspace set, or with none set.
- **Backup:** `pg_dump -Fc` took 10.8 s (141 MB) for A and 12.4 s (159 MB) for B. `pg_restore
  -j 4` took 6.4 s for A and 11.2 s for B.
- **Many tables (A):** 5,000 user tables (30 columns, a primary key and one index each, in 200
  schemas) took 5.0 ms median per `CREATE` (p95 7.6 ms) and 28 s in total. They added 30,000
  `pg_class` rows and 92 MB of system catalog (18.8 kB per table). The first query on a fresh
  connection took 1.7 ms. `pg_dump --schema-only` of the whole database took 2.9 s, and
  dropping all the schemas took 13.5 s.

## Decision

**We adopt (A): one physical Postgres table per user table, with typed columns and a junction
table per link field.** It wins every scan-heavy query by 2–25×, uses half the storage and
writes 2–11× less WAL per update. Adding and deleting fields takes milliseconds. Only type changes are
costly. An in-place change stalls writes for about 1 s per 100k rows (4.7 s at 500k). The online
path keeps the worst stall at about 1 s at 500k, which is the manager's "DDL latency
acceptable" condition. B has no compensating advantage at the scale we're targeting. Its own
type changes and deletes are slower (19–26 s), and it still needs per-field index DDL.

## Consequences for M1

**Physical layout and naming.** Names come from ids, never from user-visible names, so renames
are metadata-only. They're stored in metadata (`tables.db_schema`, `tables.db_table`,
`fields.db_column`) and never re-derived.

| Object | Name | Notes |
| --- | --- | --- |
| Schema per base | `b_<base uuid, 32 hex>` | `DROP SCHEMA … CASCADE` deletes a base; `pg_dump -n` exports one |
| Table | `t_<table uuid hex>` | Inside the base schema |
| Column | `f_<field uuid hex>` | Under 63 bytes. Always quoted by the compiler, never taken from input |
| Junction | `l_<link field uuid hex>` | One per link pair, in the base schema; the inverse field reuses it with the roles swapped |

**System columns** are `id uuid PRIMARY KEY` (UUIDv7, generated by the app), `version integer`,
`created_at`, `created_by`, `updated_at`, `updated_by` and `deleted_at` (soft delete). Autonumber
fields get their own identity column. The bench used `bigint` ids, so expect slightly larger
indexes with UUIDs.

**Field type → column type.** Text, long text, email, URL, phone and single select map to
`text`; multi-select maps to `text[]`. Number, currency, percent and duration map to `numeric`.
Rating maps to `smallint`, checkbox to `boolean`, date to `date`, and datetime to `timestamptz`.
Created/modified time and by map to the system columns. Select columns store the option id;
sorting by option order joins a small options CTE. The field-type registry in `shared` owns the
mapping and the conversion SQL for each `(from, to)` pair.

**The DDL manager**, in `server/data`, runs as `openrows_owner`.

- **Create field:** one transaction: `SET LOCAL lock_timeout = '2s'`, insert the `fields` row,
  `ALTER TABLE … ADD COLUMN` (nullable, no default, so it's instant), bump
  `tables.schema_version`, and write an outbox event. On `55P03`, retry three times with backoff,
  then return `503`. Empty means `NULL`, so a checkbox is false when `NULL` and new fields never
  rewrite the table.
- **Change type:** for tables with up to 100k rows (configurable), an in-place `ALTER COLUMN TYPE
  … USING <registry conversion>` in a transaction with `lock_timeout`. That stalls for about 1 s.
  Above the threshold, a pg-boss job (ADR-004) takes the online path: a shadow column, a sync
  trigger, 10k-row batches, and a swap transaction that also repoints `fields.db_column`. The old
  column is renamed and kept for 7 days for undo, then dropped.
- **Delete field:** soft delete in metadata (trash), then `DROP COLUMN` when the trash is
  emptied (instant). Postgres caps a table at 1,600 columns, and dropped columns still count
  toward that. We cap fields per table at 500, as Airtable does. A maintenance job rebuilds a
  table whose `pg_attribute` count passes 1,400.
- **Indexes:** primary key and junction indexes only. A pg-boss job creates others with `CREATE
  INDEX CONCURRENTLY` (outside a transaction). It indexes a field when a saved view on a table
  with more than 10k rows filters or sorts by it: btree for scalars, `gin_trgm_ops` for "contains"
  on text.

**Links, lookups and rollups.** The junction is `(from_id uuid, to_id uuid, position double
precision)` with `PRIMARY KEY (from_id, to_id)`, an index on `(to_id, from_id)`, and foreign keys
to both tables with `ON DELETE CASCADE`. Links can't cross bases (Airtable doesn't allow it
either). Lookups and rollups are joins at read time, which costs about 1 ms for a page of 100.
Filtering or sorting a large table by a rollup (386 ms at 500k) uses a cached column, which the
worker recomputes from outbox events.

**Workspace scoping and RLS** (ADR-002). Physical tables carry no `workspace_id` and get no RLS
policy, because of the leakproof cost measured above. A query can only reach a table through a
`TableHandle` loaded from RLS-protected metadata in the same transaction. The app role has DML
rights on record tables but no DDL rights.

**Drizzle** manages only the metadata schema (`public`). drizzle-kit is configured with a schema
filter, so it never diffs the `b_*` schemas.

**Query engine.** `ViewQuery` compiles to parameterized SQL over typed columns, with keyset
paging on `(sort keys…, id)`. Paging with `OFFSET` is avoided.

**Multi-tenant limits.** Each user table costs about 19 kB of catalog and 6 relations. Postgres
has no hard limit, but catalog size, `pg_dump` time and per-connection relcache memory grow with
the table count. We cap tables per base at 1,000 (Airtable's limit), and hosted caps bases per
free workspace. `workspaces.db_cluster` (ADR-002) lets hosted move workspaces to another cluster.
We plan that move at about 100k user tables per database (about 2 GB of catalog), and revisit
the threshold with production metrics. pgBackRest physical backups don't depend on the table
count.

## Implementation notes (2026-10-25)

- **DDL as the owner, in the request's transaction.** The server connects as `openrows_app`
  only. Instead of a second owner connection (which couldn't share a transaction with the
  metadata writes), the DDL manager (`packages/server/src/data/ddl.ts`) calls `SECURITY
  DEFINER` functions owned by the schema owner (`drizzle/0005_ddl_manager.sql`):
  `ddl_create_base_schema`, `ddl_create_table`, `ddl_add_column`, `ddl_drop_column`. So the
  metadata rows (under RLS), the DDL and the outbox event commit or roll back together, under
  `SET LOCAL lock_timeout = '2s'`; an expired lock answers `503 SERVICE_UNAVAILABLE` (no automatic
  retry yet). Each function only acts on a base or table whose metadata row belongs to
  `app.workspace_id`, takes schema and table names from metadata, checks column names against
  `f_<32 hex>` and column types against the `SqlColumnType` list, and quotes with `format('%I')`.
  `openrows_app` gets `USAGE` on each `b_*` schema and `SELECT, INSERT, UPDATE, DELETE` on each
  record table, never DDL. The database must be owned by the schema owner (it creates schemas).
- **Record-table isolation is authz-only**, as decided above: no `workspace_id` or RLS on record
  tables. Every access goes through a table loaded from RLS-protected metadata inside the
  authorized transaction. The DDL functions add a second check (the workspace match).
- **Type changes** convert values in JS with the registry's `convertValue` (not SQL `USING`
  expressions), inside the request's transaction: a new column of the target type is filled in
  5,000-row batches, `fields.db_column` is repointed and the old column is dropped. Option-only
  changes on the same type (adding a choice, changing precision) rewrite only the values that
  change. 100k rows convert in about 0.7 s on the dev machine. The 7-day undo copy of the old
  column, the online (shadow column + trigger) path and the pg-boss job for large tables aren't
  built yet.
- **Trash.** Deleting a record, field, view, table or base is a soft delete (`deleted_at`, and
  `deleted_by` on the metadata rows); everything is restorable until purged, and items past
  30 days (`TRASH_RETENTION_DAYS`) are shown as due for purging. "Delete permanently" drops
  a field's column (`ddl_drop_column`), a link pair's junction, a table's record table
  (`ddl_drop_table`, refused outside the trash and while a junction still references it) or a
  base's schema (`ddl_drop_base_schema`, `drizzle/0035_trash_ddl.sql`), then deletes the metadata
  rows.
- **Computed fields.** createdTime/lastModifiedTime/createdBy/lastModifiedBy get no column (their
  `db_column` name is reserved but never created); autonumber gets a `bigint` identity column.
  A table duplicated with its records renumbers autonumbers in the original order.

## Implementation notes (2026-10-26): links

- **Junction per link pair**, as decided: `l_<owner field hex>` in the base schema, created by the
  SECURITY DEFINER `ddl_create_junction(field id)` (`drizzle/0010_link_junctions.sql`), which
  reads the field's metadata row (same workspace), checks the name and refuses a linked table in
  another schema (base). Both link fields store the junction name in `fields.db_column`; the field
  whose id names it reads `from_id` as its side, the inverse `to_id`.
- **One deviation**: besides `position` (the order on the from side) the junction has
  `inverse_position`, so the inverse side keeps its own order (new links go last there).
- **Soft-deleted records keep their junction rows**; every read joins the linked table and skips
  deleted records, so a link disappears from both sides at once and comes back on restore. Purging
  a record cascades through the foreign keys. Rewriting a cell keeps links to records in the
  trash.
- **Trashed link fields keep their junction**: deleting either side trashes both fields (the
  other one `trashed_with` it) and leaves the junction, so the pair comes back with its links;
  deleting a table trashes the inverse fields of its links in other tables (`trashed_with` the
  table) and restores them with it, so no live link points at a trashed table. Only "delete
  permanently" drops the junction. A link converted to another type still drops it at once.
- **No cross-table locks**: a link write locks and bumps only the records written; the other
  side's records get a `record.updated` event with their inverse cell but no version bump.
- **Reads** aggregate the junction per record (`jsonb_agg` of `{ id, primary value }` in order) as
  a correlated subquery in the select list; filters, sorts and search use `EXISTS` and
  `string_agg` subqueries on the linked records' primary text. Grouping by a link isn't supported
  yet. Lookups and rollups will read through the same junctions.

## Implementation notes (2026-10-26): field indexes

- **The `indexes.sync` worker job** (pg-boss, every 5 minutes and at start; ADR-004) indexes the
  fields saved views sort, group and filter by, on tables past 10,000 rows (counted with a
  `LIMIT`, not `reltuples`). `packages/server/src/indexes/plan.ts` decides; `sync.ts` builds and
  drops. Per table: up to 8 single-field indexes, the ones the most views use first (a sort or
  group key gets `(key, id)`, so a one-key order is a keyset scan; "contains" on text gets a
  `gin_trgm_ops` index; text equality, number and date conditions and single-select matches get
  a btree), plus one keyset composite `(group keys, sort keys…, id)` for the most common whole
  order (ties go to the first view in the sidebar, the one a table opens on). Keys are the
  compiler's own expressions (`lower(col)`, `coalesce(col, false)`, the column) in its orders
  (ascending `NULLS FIRST`, descending `NULLS LAST`); a sort the compiler runs through a subquery
  or the options' order (people, selects, lookups, rollups, formulas) can't be indexed and ends a
  composite's prefix. Negations, emptiness and checkbox filters get none. The integration test
  `field-indexes.test.ts` checks the compiled queries' plans use them.
- **Keyset cursors** get a redundant `first key >= value` bound when the first key is ascending,
  so a page starts on the index; a descending first key (`NULLS LAST` after values) has no such
  bound yet.
- **The record id is ordered as plain `ASC`** (never NULL, so the same order), not `ASC NULLS
  FIRST`: Postgres doesn't use `NOT NULL` when it matches an `ORDER BY` to an index, so the old
  form couldn't read the primary key (or any index ending in the id) in order, and even an
  unsorted view sorted the whole table.
- **CREATE INDEX CONCURRENTLY can't run in a function** (nor a transaction), and only the table's
  owner may run it, so the DDL manager's pattern changes for indexes: SECURITY DEFINER functions
  (`drizzle/0049_field_indexes.sql`) still do the checks under the tenant's scope
  (`ddl_index_statement`: the table is the workspace's, the name is `i_<24 hex>` (a hash of the
  definition), columns are `f_<32 hex>` or system columns that exist, expressions and methods
  from a fixed list, all quoted with `%I`; `ddl_index_drop_statement`: only managed names of that
  table; `ddl_index_list`: the table's managed indexes and whether each is valid), and answer
  the one statement; the worker runs it on a separate owner connection (`INDEX_DATABASE_URL`, one
  pooled connection, `lock_timeout` 10 s), which accepts nothing but `CREATE INDEX CONCURRENTLY`
  and `DROP INDEX CONCURRENTLY`. `openrows_app` still can't run DDL. Primary keys and junction
  indexes are never listed or dropped.
- **Writes never wait** for a build (tested: four writers keep committing in every tenth of a
  multi-index build over 150k rows; a plain `CREATE INDEX` fails the same test). A schema change
  on that table during a build waits for it up to its own `lock_timeout` (2 s, then 503).
- **Cleanup**: each run drops managed indexes no live view wants (a view deleted or changed, a
  field trashed or converted: a conversion to a new column drops the old one with its indexes,
  and the next run builds what the converted field needs) and invalid leftovers of a failed build
  (then builds them again). A table below the threshold keeps the indexes it has but gets no new
  ones. Trashed tables and bases are skipped; purging drops their indexes with them.
- **Measured**: [bench/results/windows/](../../bench/results/windows/) (`BENCH_SUITES=windows`),
  100-row windows at 500k rows before and after the job's indexes, against p95 targets set by
  (ADR-001 had none for windows): 50 ms for windows within the first 10,000 rows, keyset pages
  and filtered windows, 150 ms for an `OFFSET` jump deep into the table. **9 of 12 met**: text,
  number and two-key sorted windows up to row 10,000 went from 190–340 ms to 1.4–10 ms p95, a
  keyset page at the middle from 168 to 2.5 ms (with the cursor's lower bound on an ascending
  first key, which `afterCursor` now adds: an `OR` alone made Postgres scan the index from its
  start), filtered windows to 7–8 ms. **Missed**: a window by `OFFSET` at the middle or the end
  (333–659 ms): the index walks every entry and its row up to the offset. Expression indexes
  (`lower()`) can't serve index-only scans, so a deferred join wouldn't fix text sorts; the fix is
  for the grid to jump by keyset anchors instead of deep offsets (a follow-up).

## Alternatives considered

- **(B) JSONB with expression indexes.** It's simpler DDL (adding a field is free). But it's
  2–25× slower on scans, takes 2× the storage and 2–11× the WAL per write, and its type changes
  and deletes are slower. It still needs per-field index DDL and `IMMUTABLE` cast wrappers for
  dates, and it's vulnerable to read-merge-write lost updates unless every write uses
  `jsonb_set`. Claude's review put the ceiling at about 50k rows per table, and the numbers agree.
- **Hybrid** (typed columns for some fields, JSONB for the rest). Two code paths for every
  operator. We'd consider it only if the column limit becomes a problem.
- **EAV (one row per cell).** Rejected without benchmarking: every record read needs 30 joins or
  a pivot.
