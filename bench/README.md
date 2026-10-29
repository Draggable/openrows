# Storage benchmark (ADR-001)

Compares two ways to store user records in Postgres:

- **A, physical tables.** One table per user table, one typed column per field, and a junction
  table per link field.
- **B, JSONB.** One shared `records` table with a `data jsonb` blob keyed by field id. Links
  are id arrays inside the blob, and indexed fields get partial expression indexes. This is the
  legacy prototype's layout, plus the indexes it lacked.

Both layouts are loaded with identical data: 500,000 rows × 30 fields, plus a 10,000-row
linked table. The suites then run the same logical queries against each. The results and the
decision are in [docs/adr/001-record-storage.md](../docs/adr/001-record-storage.md).

## Running it

Requirements: Docker, and the repo's root `npm ci`. The bench reuses `pg` and `tsx` from the
root `node_modules`, so it has no lockfile of its own. It isn't an npm workspace, and it isn't
part of the root build, type-check or tests.

```sh
cd bench
npm run bench          # full run: 500k rows, about 15 minutes on 8 vCPUs
npm run bench:quick    # 20k-row smoke test, under a minute
npm run typecheck
```

`npm run bench` starts a throwaway `postgres:16-alpine` container on a random loopback port,
with the settings in [src/docker.ts](src/docker.ts). It removes the container when it finishes,
even on failure or Ctrl-C. Results go to `results/<date>-<rows>rows.md` (the tables quoted in the
ADR) and `.json` (every sample statistic and every query plan).

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `BENCH_ROWS` | `500000` | Rows in the 30-field table |
| `BENCH_COMPANIES` | `10000` | Rows in the linked table |
| `BENCH_ITERATIONS` | `7` | Timed runs per read query, after one warm-up |
| `BENCH_CONCURRENCY` | `16` | Clients in the random-row write scenarios |
| `BENCH_WRITE_SECONDS` | `8` | Duration of each write scenario |
| `BENCH_CATALOG_TABLES` | `5000` | User tables created by the multi-tenant catalog test |
| `BENCH_SUITES` | all | Comma-separated subset of `reads,links,rls,backup,writes,ddl,catalog,windows` |
| `BENCH_DATABASE_URL` | unset | Use an existing database instead of Docker. The backup suite is skipped, and the database must allow `CREATE EXTENSION pg_trgm` and `CREATE ROLE` |
| `BENCH_PG_IMAGE` | `postgres:16-alpine` | Image for the throwaway container |
| `BENCH_KEEP` | unset | `1` keeps the container afterwards so you can inspect it with `psql` |
| `BENCH_OUT` | `results` | Output directory |

## What each suite does

| Suite | File | What it measures |
| --- | --- | --- |
| load | [schema.ts](src/schema.ts) | Data generation (deterministic, `setseed`), index builds, sizes |
| reads | [reads.ts](src/reads.ts) | Text contains, number range, select IN, multi-select, compound filters, typed multi-key sorts, group-by, keyset vs offset paging. A and B results are compared for equality |
| links | [reads.ts](src/reads.ts) | Linked names for a page, backlinks, rollups (forward, reverse, over all rows) |
| rls | [ops.ts](src/ops.ts) | Cost of workspace RLS policies for a non-superuser role, and isolation checks |
| backup | [ops.ts](src/ops.ts) | `pg_dump -Fc` and `pg_restore -j 4` per layout |
| writes | [writes.ts](src/writes.ts) | Concurrent single-cell updates (throughput, latency, WAL per write, HOT %), lost updates on hot rows (including legacy read-merge-write), 1,000-row bulk inserts |
| ddl | [ddl.ts](src/ddl.ts) | Add, index, retype and delete a field while 4 clients keep writing, plus transactional DDL rollback and `lock_timeout` behaviour |
| windows | [windows.ts](src/windows.ts) | 100-row sorted and filtered windows in the query compiler's shape, before and after the field index job's indexes (built `CONCURRENTLY`), against p95 targets (`BENCH_SUITES=windows`) |
| catalog | [ops.ts](src/ops.ts) | Creating thousands of 30-column tables: latency, catalog growth, cold-connection cost, `pg_dump --schema-only` time |
