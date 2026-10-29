/** Operational checks: RLS overhead, catalog growth with many tables, backup and restore. */
import { config } from './config.js';
import { createPool, log, one, type Pool, type Row, rows, type Stats, stats, timed } from './db.js';
import type { Container } from './docker.js';
import { B_TASKS, bx, OTHER_WORKSPACE_ID, WORKSPACE_ID } from './schema.js';

export interface RlsResult {
  name: string;
  aPlain: Stats;
  aRls: Stats;
  bPlain: Stats;
  bRls: Stats;
}

export interface RlsSummary {
  cases: RlsResult[];
  isolation: { aOther: number; bOther: number; aUnset: number; bUnset: number };
}

async function sample(db: Pool, sql: string): Promise<Stats> {
  await db.query(sql);
  const samples: number[] = [];
  for (let i = 0; i < config.iterations; i++) samples.push((await timed(() => db.query(sql))).ms);
  return stats(samples);
}

/**
 * Layout A needs no workspace_id column: every row of a physical table belongs to one workspace,
 * so the policy compares the session setting to a constant. Layout B needs the column.
 */
export async function runRls(db: Pool, url: string): Promise<RlsSummary> {
  await db.query(`
    DROP ROLE IF EXISTS bench_app;
    CREATE ROLE bench_app LOGIN PASSWORD 'bench' NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE ON SCHEMA bench_a, bench_b TO bench_app;
    GRANT SELECT ON ALL TABLES IN SCHEMA bench_a, bench_b TO bench_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA bench_b TO bench_app;
    ALTER TABLE bench_a.tasks ENABLE ROW LEVEL SECURITY;
    CREATE POLICY workspace ON bench_a.tasks
      USING ((SELECT current_setting('app.workspace_id', true)) = '${WORKSPACE_ID}');
    ALTER TABLE bench_b.records ENABLE ROW LEVEL SECURITY;
    CREATE POLICY workspace ON bench_b.records
      USING (workspace_id = (SELECT nullif(current_setting('app.workspace_id', true), '')::uuid));
  `);
  const appUrl = new URL(url);
  appUrl.username = 'bench_app';
  appUrl.password = 'bench';
  const app = createPool(appUrl.toString(), 1);
  try {
    const client = await app.connect();
    const count = async (sql: string) => Number((await one<{ n: string }>(client, sql)).n);
    const aCount = 'SELECT count(*) AS n FROM bench_a.tasks';
    const bCount = `SELECT count(*) AS n FROM bench_b.records WHERE ${B_TASKS}`;
    const aUnset = await count(aCount);
    const bUnset = await count(bCount);
    await client.query(`SELECT set_config('app.workspace_id', '${OTHER_WORKSPACE_ID}', false)`);
    const aOther = await count(aCount);
    const bOther = await count(bCount);
    await client.query(`SELECT set_config('app.workspace_id', '${WORKSPACE_ID}', false)`);
    client.release();

    // RLS quals run before user quals, so a user qual can only become an index condition if its
    // operator is LEAKPROOF. text/uuid/int8 equality is; numeric, ILIKE and most timestamptz
    // comparisons are not. These cases show both kinds.
    const cases: [string, string, string][] = [
      ['Count all rows', 'SELECT count(*) FROM bench_a.tasks', bCount],
      [
        'Select = (leakproof text equality), btree: page',
        `SELECT * FROM bench_a.tasks WHERE s01 = 'Option 3' ORDER BY id LIMIT 100`,
        `SELECT id, data FROM bench_b.records WHERE ${B_TASKS} AND ${bx('s01')} = 'Option 3' ORDER BY id LIMIT 100`,
      ],
      [
        'Number range (1%), btree: page',
        'SELECT * FROM bench_a.tasks WHERE n01 BETWEEN 400000 AND 410000 ORDER BY id LIMIT 100',
        `SELECT id, data FROM bench_b.records WHERE ${B_TASKS} AND ${bx('n01')} BETWEEN 400000 AND 410000 ORDER BY id LIMIT 100`,
      ],
      [
        'Text contains, trigram index: count',
        `SELECT count(*) FROM bench_a.tasks WHERE t01 ILIKE '%abc%'`,
        `SELECT count(*) FROM bench_b.records WHERE ${B_TASKS} AND ${bx('t01')} ILIKE '%abc%'`,
      ],
      [
        'Group by select: count, sum',
        'SELECT s01, count(*), sum(n02) FROM bench_a.tasks GROUP BY 1',
        `SELECT ${bx('s01')}, count(*), sum(${bx('n02')}) FROM bench_b.records WHERE ${B_TASKS} GROUP BY 1`,
      ],
    ];
    const results: RlsResult[] = [];
    for (const [name, a, b] of cases) {
      const r = {
        name,
        aPlain: await sample(db, a),
        aRls: await sample(app, a),
        bPlain: await sample(db, b),
        bRls: await sample(app, b),
      };
      log(
        `rls: ${name}: A ${r.aPlain.median.toFixed(1)} -> ${r.aRls.median.toFixed(1)} ms, ` +
          `B ${r.bPlain.median.toFixed(1)} -> ${r.bRls.median.toFixed(1)} ms`
      );
      results.push(r);
    }
    return { cases: results, isolation: { aOther, bOther, aUnset, bUnset } };
  } finally {
    await app.end();
    await db.query(`
      DROP POLICY workspace ON bench_a.tasks;
      ALTER TABLE bench_a.tasks DISABLE ROW LEVEL SECURITY;
      DROP POLICY workspace ON bench_b.records;
      ALTER TABLE bench_b.records DISABLE ROW LEVEL SECURITY;
    `);
  }
}

export interface CatalogResult {
  tables: number;
  schemas: number;
  createMs: Stats;
  totalCreateSeconds: number;
  relationsAdded: number;
  catalogBytesAdded: number;
  catalogBytesPerTable: number;
  coldFirstQueryMs: Stats;
  schemaDumpSeconds: number | null;
  dropSeconds: number;
}

const catalogColumns = Array.from({ length: 30 }, (_, i) => {
  const types = ['text', 'numeric', 'boolean', 'timestamptz', 'text[]', 'smallint'];
  return `f_${String(i).padStart(2, '0')} ${types[i % types.length]}`;
}).join(', ');

/** Creates N user tables (30 typed columns, pk, one index) spread over schemas of 25 tables. */
export async function runCatalog(
  db: Pool,
  url: string,
  container: Container | null
): Promise<CatalogResult> {
  const perSchema = 25;
  const n = config.catalogTables;
  const schemas = Math.ceil(n / perSchema);
  const catalogSize = async () =>
    Number(
      (
        await one<{ bytes: string; rels: string }>(
          db,
          `SELECT sum(pg_total_relation_size(c.oid)) AS bytes FROM pg_class c
           JOIN pg_namespace ns ON ns.oid = c.relnamespace
           WHERE ns.nspname = 'pg_catalog' AND c.relkind = 'r'`
        )
      ).bytes
    );
  const relCount = async () =>
    Number((await one<{ n: string }>(db, 'SELECT count(*) AS n FROM pg_class')).n);

  const sizeBefore = await catalogSize();
  const relsBefore = await relCount();
  const samples: number[] = [];
  const started = performance.now();
  for (let s = 0; s < schemas; s++) {
    await db.query(`CREATE SCHEMA bench_cat_${s}`);
    for (let t = 0; t < perSchema && s * perSchema + t < n; t++) {
      const name = `bench_cat_${s}.t_${t}`;
      const run = await timed(() =>
        db.query(`BEGIN;
          CREATE TABLE ${name} (
            id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            version integer NOT NULL DEFAULT 1,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            ${catalogColumns});
          CREATE INDEX ON ${name} (f_01);
          COMMIT;`)
      );
      samples.push(run.ms);
    }
    if (s % 40 === 0) log(`catalog: ${Math.min(n, (s + 1) * perSchema)} / ${n} tables`);
  }
  const totalCreateSeconds = (performance.now() - started) / 1000;
  const sizeAfter = await catalogSize();
  const relsAfter = await relCount();

  // A fresh connection pays for loading relcache entries; that is what a pooled server sees
  // the first time a connection touches a table.
  const cold: number[] = [];
  for (let i = 0; i < 20; i++) {
    const pool = createPool(url, 1);
    const client = await pool.connect();
    await client.query('SELECT 1');
    const s = Math.floor(Math.random() * schemas);
    const run = await timed(() => client.query(`SELECT * FROM bench_cat_${s}.t_0 LIMIT 1`));
    cold.push(run.ms);
    client.release();
    await pool.end();
  }

  let schemaDumpSeconds: number | null = null;
  if (container) {
    const dump = await timed(async () =>
      container.exec(['sh', '-c', 'pg_dump -U postgres -d bench --schema-only > /dev/null'])
    );
    schemaDumpSeconds = dump.ms / 1000;
  }

  const drop = await timed(async () => {
    for (let s = 0; s < schemas; s++) await db.query(`DROP SCHEMA bench_cat_${s} CASCADE`);
  });

  const result: CatalogResult = {
    tables: n,
    schemas,
    createMs: stats(samples),
    totalCreateSeconds,
    relationsAdded: relsAfter - relsBefore,
    catalogBytesAdded: sizeAfter - sizeBefore,
    catalogBytesPerTable: Math.round((sizeAfter - sizeBefore) / n),
    coldFirstQueryMs: stats(cold),
    schemaDumpSeconds,
    dropSeconds: drop.ms / 1000,
  };
  log(`catalog: ${JSON.stringify({ ...result, createMs: result.createMs.median })}`);
  return result;
}

export interface BackupResult {
  approach: 'A' | 'B';
  dumpSeconds: number;
  dumpBytes: number;
  restoreSeconds: number;
  restoredRows: number;
}

/** pg_dump -Fc of each layout's schema, restored into a fresh database with 4 jobs. */
export async function runBackup(container: Container): Promise<BackupResult[]> {
  const results: BackupResult[] = [];
  const sql = (dbName: string, query: string) =>
    container.exec(['psql', '-U', 'postgres', '-d', dbName, '-tAc', query]).trim();
  for (const approach of ['A', 'B'] as const) {
    const schema = approach === 'A' ? 'bench_a' : 'bench_b';
    const file = `/tmp/${schema}.dump`;
    const target = `restore_${schema}`;
    const dump = await timed(async () =>
      container.exec(['pg_dump', '-U', 'postgres', '-d', 'bench', '-Fc', '-n', schema, '-f', file])
    );
    const bytes = Number(container.exec(['stat', '-c', '%s', file]).trim());
    sql('bench', `DROP DATABASE IF EXISTS ${target}`);
    sql('bench', `CREATE DATABASE ${target}`);
    sql(target, 'CREATE EXTENSION pg_trgm');
    const restore = await timed(async () =>
      container.exec(['pg_restore', '-U', 'postgres', '-d', target, '-j', '4', file])
    );
    const count = sql(
      target,
      approach === 'A'
        ? 'SELECT count(*) FROM bench_a.tasks'
        : 'SELECT count(*) FROM bench_b.records'
    );
    sql('bench', `DROP DATABASE ${target}`);
    container.exec(['rm', '-f', file]);
    const r: BackupResult = {
      approach,
      dumpSeconds: dump.ms / 1000,
      dumpBytes: bytes,
      restoreSeconds: restore.ms / 1000,
      restoredRows: Number(count),
    };
    log(`backup: ${JSON.stringify(r)}`);
    results.push(r);
  }
  return results;
}

export async function serverInfo(db: Pool): Promise<{ version: string; settings: Row[] }> {
  const version = (await one<{ v: string }>(db, 'SELECT version() AS v')).v;
  const settings = await rows(
    db,
    `SELECT name, setting, unit FROM pg_settings WHERE name = ANY($1) ORDER BY name`,
    [
      [
        'shared_buffers',
        'effective_cache_size',
        'work_mem',
        'maintenance_work_mem',
        'max_wal_size',
        'random_page_cost',
        'max_parallel_workers_per_gather',
        'jit',
      ],
    ]
  );
  return { version, settings };
}
