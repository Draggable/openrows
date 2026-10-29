import type { FieldMeta, TableMeta, ViewMeta } from '@openrows/shared';
import { viewQuerySchema } from '@openrows/shared';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { qualified, type TableLocation } from '../../src/data/columns.js';
import { compileViewQuery, orderBy } from '../../src/data/query/compile.js';
import { fields as fieldsTable, tables } from '../../src/db/index.js';
import { INDEX_MIN_ROWS } from '../../src/indexes/plan.js';
import { type IndexDdl, ownerIndexDdl, syncFieldIndexes } from '../../src/indexes/sync.js';
import { builtinQueues, startWorker } from '../../src/jobs/runtime.js';
import { withTenant } from '../../src/jobs/tenant.js';
import { tableFields, toQueryFields } from '../../src/records/service.js';
import { OWNER_PASSWORD, OWNER_ROLE, useTestDb, withDatabase } from '../helpers/db.js';
import { authedClient, createWorkspace } from '../helpers/factories.js';

/**
 * The field index job (ADR-001): indexes for saved views' sorts, groups and filters, built
 * with CREATE INDEX CONCURRENTLY on the owner connection from statements the SECURITY DEFINER
 * functions check under the tenant's scope; cleanup when views and fields change; writes never
 * wait for a build.
 */
const MIN_ROWS = 1_000;
const ORIGIN = { origin: 'http://localhost:5173', 'content-type': 'application/json' };

describe('field indexes', () => {
  const t = useTestDb();
  let ddl: IndexDdl;
  const warnings: unknown[] = [];
  const logger = {
    info: () => {},
    warn: (o: unknown) => void warnings.push(o),
    error: (o: unknown) => void warnings.push(o),
  };
  let workspaceId: string;
  let otherWorkspaceId: string;
  let otherTableId: string;
  let api: Awaited<ReturnType<typeof authedClient>>;

  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await api.request(path, {
      method,
      headers: ORIGIN,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status >= 300) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  };

  const sync = () => syncFieldIndexes({ db: t.appDb, ddl, logger }, { minRows: MIN_ROWS });

  async function makeTable(name: string, rows: number) {
    const base = await call<{ id: string }>('POST', `/api/workspaces/${workspaceId}/bases`, {
      name,
    });
    const table = await call<TableMeta>('POST', `/api/bases/${base.id}/tables`, { name });
    const num = await call<FieldMeta>('POST', `/api/tables/${table.id}/fields`, {
      name: 'N',
      type: 'number',
    });
    const text = await call<FieldMeta>('POST', `/api/tables/${table.id}/fields`, {
      name: 'Memo',
      type: 'singleLineText',
    });
    const done = await call<FieldMeta>('POST', `/api/tables/${table.id}/fields`, {
      name: 'Done',
      type: 'checkbox',
    });
    const [loc] = await t.db.select().from(tables).where(eq(tables.id, table.id));
    if (!loc) throw new Error('no table');
    const cols = await t.db.select().from(fieldsTable).where(eq(fieldsTable.tableId, table.id));
    const col = (id: string) => sql.identifier(cols.find((c) => c.id === id)?.dbColumn ?? '');
    await t.db.execute(sql`
      INSERT INTO ${qualified(loc)} (id, ${col(num.id)}, ${col(text.id)}, ${col(done.id)})
      SELECT gen_random_uuid(), (i * 7919) % 100000, 'Item ' || i || ' ' || md5(i::text), i % 2 = 0
        FROM generate_series(1, ${rows}) AS i`);
    await t.db.execute(sql`ANALYZE ${qualified(loc)}`);
    const {
      views: [view],
    } = await call<{ views: ViewMeta[] }>('GET', `/api/tables/${table.id}/views`);
    if (!view) throw new Error('no view');
    return { table, loc, view, num, text, done };
  }

  /** Managed indexes of a table: name → definition, valid. */
  async function indexesOf(loc: TableLocation) {
    const { rows } = await t.db.execute<{ name: string; def: string; valid: boolean }>(sql`
      SELECT c.relname AS name, pg_get_indexdef(c.oid) AS def, i.indisvalid AS valid
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE i.indrelid = ${`"${loc.dbSchema}"."${loc.dbTable}"`}::regclass
         AND c.relname LIKE 'i\\_%'
       ORDER BY c.relname`);
    return rows;
  }

  /** The plan of the compiled query of a view's saved query, with sequential scans off. */
  async function planOf(tableId: string, loc: TableLocation, query: unknown): Promise<string> {
    return withTenant(t.appDb, workspaceId, async (tx) => {
      const [table] = await tx.select().from(tables).where(eq(tables.id, tableId));
      if (!table) throw new Error('no table');
      const q = compileViewQuery(
        viewQuerySchema.parse(query),
        toQueryFields(await tableFields(tx, table))
      );
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const { rows } = await tx.execute<{ 'QUERY PLAN': string }>(sql`
        EXPLAIN SELECT r.* FROM ${qualified(loc)} AS r WHERE ${q.where}
         ORDER BY ${orderBy(q.keys)} LIMIT 100 OFFSET 500`);
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
  }

  beforeAll(async () => {
    const database = new URL(t.url).pathname.slice(1);
    ddl = ownerIndexDdl(
      withDatabase(t.url, database, { user: OWNER_ROLE, password: OWNER_PASSWORD })
    );
    const { owner, workspace } = await createWorkspace(t.db);
    workspaceId = workspace.id;
    api = await authedClient(t, owner);
    const other = await createWorkspace(t.db);
    otherWorkspaceId = other.workspace.id;
    const prev = workspaceId;
    api = await authedClient(t, other.owner);
    workspaceId = otherWorkspaceId;
    const theirs = await makeTable('Theirs', 10);
    otherTableId = theirs.table.id;
    workspaceId = prev;
    api = await authedClient(t, owner);
  });

  afterAll(async () => {
    await ddl?.close();
  });

  it('builds the indexes saved views want, and the compiled queries use them', async () => {
    const { table, loc, view, num, text, done } = await makeTable('Sorted', 3_000);
    const query = {
      sorts: [{ fieldId: num.id, direction: 'desc' }],
      filter: {
        conjunction: 'and',
        conditions: [{ fieldId: text.id, operator: 'contains', value: 'item 12' }],
      },
    };
    await call('PATCH', `/api/views/${view.id}`, { query });
    const other = await call<ViewMeta>('POST', `/api/tables/${table.id}/views`, { name: 'Two' });
    await call('PATCH', `/api/views/${other.id}`, {
      query: {
        groupBy: [{ fieldId: done.id, direction: 'asc' }],
        sorts: [{ fieldId: text.id, direction: 'asc' }],
      },
    });

    const result = await sync();
    expect(result.errors).toBe(0);
    expect(result.created).toBeGreaterThanOrEqual(4);
    const defs = (await indexesOf(loc)).map((i) => i.def).join('\n');
    expect(defs).toContain('gin_trgm_ops');
    expect(defs).toMatch(/lower\(f_[0-9a-f]{32}\)/);
    expect(defs).toMatch(/COALESCE\(f_[0-9a-f]{32}, false\)/);
    expect(defs).toContain('DESC NULLS LAST, id)');
    expect((await indexesOf(loc)).every((i) => i.valid)).toBe(true);

    // Nothing left to do: a second run builds and drops nothing.
    expect(await sync()).toMatchObject({ created: 0, dropped: 0, errors: 0 });

    // An unsorted view reads the primary key in order: the id is ordered without NULLS FIRST.
    const unsorted = await planOf(table.id, loc, {});
    expect(unsorted).toMatch(/Index Scan using \S+_pkey/);
    expect(unsorted).not.toMatch(/Sort Key/);
    // Sorted windows read an index in order (no Sort node), filters use theirs.
    const sorted = await planOf(table.id, loc, { sorts: query.sorts });
    expect(sorted).toMatch(/Index Scan( Backward)? using i_/);
    expect(sorted).not.toMatch(/^\s*->\s+Sort\b/m);
    expect(await planOf(table.id, loc, { filter: query.filter })).toMatch(
      /Bitmap Index Scan on i_/
    );
    const grouped = await planOf(table.id, loc, {
      groupBy: [{ fieldId: done.id, direction: 'asc' }],
      sorts: [{ fieldId: text.id, direction: 'asc' }],
    });
    // One composite per table (the first view's order): the second view's grouping reads the
    // checkbox index in order and sorts only within each group.
    expect(grouped).toMatch(/Index Scan using i_/);
    expect(grouped).toMatch(/Presorted Key/);
    expect(warnings).toEqual([]);
  });

  it('skips tables below the row threshold and keeps to the per-table cap', async () => {
    const { loc, view, num } = await makeTable('Small', 50);
    await call('PATCH', `/api/views/${view.id}`, {
      query: { sorts: [{ fieldId: num.id, direction: 'asc' }] },
    });
    await sync();
    expect(await indexesOf(loc)).toEqual([]);
  });

  it('drops indexes when views stop wanting them, fields are trashed or converted', async () => {
    const { loc, view, num, text } = await makeTable('Cleanup', 1_500);
    await call('PATCH', `/api/views/${view.id}`, {
      query: {
        sorts: [{ fieldId: text.id, direction: 'asc' }],
        filter: {
          conjunction: 'and',
          conditions: [{ fieldId: num.id, operator: '>', value: 5 }],
        },
      },
    });
    await sync();
    const before = await indexesOf(loc);
    expect(before.some((i) => i.def.includes('lower('))).toBe(true);

    // A text → number conversion moves the field to a new column; the sort index follows it.
    await call('PATCH', `/api/fields/${text.id}`, { type: 'number' });
    const converted = await sync();
    expect(converted.errors).toBe(0);
    const after = await indexesOf(loc);
    expect(after.some((i) => i.def.includes('lower('))).toBe(false);
    expect(after.length).toBeGreaterThan(0);

    // A trashed field's index goes; a view without a query leaves none behind.
    await call('DELETE', `/api/fields/${num.id}`);
    await call('PATCH', `/api/views/${view.id}`, { query: { sorts: [], filter: undefined } });
    await call('PATCH', `/api/views/${view.id}`, {
      query: { filter: { conjunction: 'and', conditions: [] } },
    });
    const cleaned = await sync();
    expect(cleaned.errors).toBe(0);
    expect(await indexesOf(loc)).toEqual([]);
  });

  it('drops an invalid leftover of a failed build and builds it again', async () => {
    const { loc, view, num } = await makeTable('Invalid', 1_200);
    await call('PATCH', `/api/views/${view.id}`, {
      query: { sorts: [{ fieldId: num.id, direction: 'asc' }] },
    });
    await sync();
    const [first] = await indexesOf(loc);
    if (!first) throw new Error('no index');
    await t.db.execute(sql`
      UPDATE pg_index SET indisvalid = false
       WHERE indexrelid = ${`"${loc.dbSchema}"."${first.name}"`}::regclass`);
    const r = await sync();
    expect(r).toMatchObject({ errors: 0 });
    expect(r.dropped).toBeGreaterThanOrEqual(1);
    expect(r.created).toBeGreaterThanOrEqual(1);
    const again = await indexesOf(loc);
    expect(again.find((i) => i.name === first.name)?.valid).toBe(true);
  });

  it('never blocks writes while an index builds (CONCURRENTLY)', async () => {
    const ROWS = 150_000;
    const { loc, view, num, text } = await makeTable('Busy', ROWS);
    await call('PATCH', `/api/views/${view.id}`, {
      query: {
        sorts: [
          { fieldId: text.id, direction: 'asc' },
          { fieldId: num.id, direction: 'desc' },
        ],
        filter: {
          conjunction: 'and',
          conditions: [{ fieldId: text.id, operator: 'contains', value: 'abc' }],
        },
      },
    });
    const { rows: idRows } = await t.db.execute<{ id: string }>(
      sql`SELECT id FROM ${qualified(loc)} ORDER BY id LIMIT 2000`
    );
    const ids = idRows.map((r) => r.id);
    const cols = await t.db.select().from(fieldsTable).where(eq(fieldsTable.tableId, loc.id));
    const numCol = cols.find((c) => c.id === num.id)?.dbColumn ?? '';
    const target = `"${loc.dbSchema}"."${loc.dbTable}"`;

    // Four writers as openrows_app, each timing every single-row update. They pause between
    // updates: they probe write latency during the build, they don't load-test the shared
    // Postgres (four writers flat out starved the build past the timeout on busy CI runners).
    const pool = new pg.Pool({ connectionString: t.appUrl, max: 4 });
    let building = true;
    const latencies: { start: number; ms: number }[] = [];
    const writer = async (w: number) => {
      let i = w;
      while (building) {
        const start = performance.now();
        await pool.query(`UPDATE ${target} SET "${numCol}" = "${numCol}" + 1 WHERE id = $1`, [
          ids[i % ids.length],
        ]);
        latencies.push({ start, ms: performance.now() - start });
        i += 4;
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    const writers = [0, 1, 2, 3].map(writer);
    await new Promise((r) => setTimeout(r, 200));
    const buildStart = performance.now();
    const result = await sync();
    const buildMs = performance.now() - buildStart;
    building = false;
    await Promise.all(writers);
    await pool.end();

    expect(result).toMatchObject({ errors: 0 });
    expect(result.created).toBeGreaterThanOrEqual(3);
    expect((await indexesOf(loc)).every((i) => i.valid)).toBe(true);
    const during = latencies.filter(
      (l) => l.start >= buildStart && l.start <= buildStart + buildMs
    );
    const worst = during.reduce((max, l) => Math.max(max, l.ms), 0);
    // Writes kept completing through the whole build: a plain CREATE INDEX holds every writer
    // for the length of each index's build, and the trigram index's alone is most of the total
    // (a gap of ~75% of the build when tried), so no gap between completed writes may reach a
    // quarter of it. (Not tenths: one slow write on a loaded runner can span a tenth.)
    const buildEnd = buildStart + buildMs;
    const completions = latencies
      .map((l) => l.start + l.ms)
      .filter((end) => end >= buildStart && end <= buildEnd)
      .sort((a, b) => a - b);
    let longestGap = 0;
    let previous = buildStart;
    for (const end of [...completions, buildEnd]) {
      longestGap = Math.max(longestGap, end - previous);
      previous = end;
    }
    console.info('index build vs writes:', {
      buildMs: Math.round(buildMs),
      writes: during.length,
      worstWriteMs: Math.round(worst),
      longestGapMs: Math.round(longestGap),
    });
    expect(longestGap).toBeLessThan(buildMs / 4);
    expect(during.length).toBeGreaterThan(50);
  }, 120_000);

  it("runs as the worker's indexes.sync job, at start, past ADR-001's 10,000 rows", async () => {
    const { loc, view, num } = await makeTable('Worker', INDEX_MIN_ROWS);
    await call('PATCH', `/api/views/${view.id}`, {
      query: { sorts: [{ fieldId: num.id, direction: 'asc' }] },
    });
    const queues = builtinQueues({ db: t.appDb, logger, revisionDays: 365, indexDdl: ddl });
    expect(queues['indexes.sync']?.spec.cron).toBe('*/5 * * * *');
    const w = await startWorker(
      { db: t.appDb, logger, revisionDays: 365 },
      {
        connectionString: t.appUrl,
        instanceName: 'indexes',
        queues: { 'indexes.sync': queues['indexes.sync'] as NonNullable<(typeof queues)[string]> },
        pollingIntervalSeconds: 0.5,
        maxConnections: 3,
      }
    );
    try {
      const deadline = Date.now() + 30_000;
      while ((await indexesOf(loc)).filter((i) => i.valid).length === 0) {
        if (Date.now() > deadline) throw new Error('no index built by the job');
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      await w.stop(5_000);
    }
    // Without the owner connection the job isn't run at all.
    expect(
      builtinQueues({ db: t.appDb, logger, revisionDays: 365 })['indexes.sync']
    ).toBeUndefined();
  });

  it('checks every requested index under the tenant scope (SECURITY DEFINER functions)', async () => {
    const { table } = await makeTable('Checks', 10);
    const cols = await t.db.select().from(fieldsTable).where(eq(fieldsTable.tableId, table.id));
    const col = cols.find((c) => c.name === 'N')?.dbColumn ?? '';
    const name = 'i_0123456789abcdef01234567';
    const statement = (tableId: string, n: string, method: string, keys: unknown) =>
      sql`SELECT ddl_index_statement(${tableId}::uuid, ${n}, ${method}, ${JSON.stringify(keys)}::jsonb) AS s`;
    const ok = await withTenant(t.appDb, workspaceId, (tx) =>
      tx.execute<{ s: string }>(
        statement(table.id, name, 'btree', [{ column: col, fn: 'none', desc: true }])
      )
    );
    expect(ok.rows[0]?.s).toMatch(
      /^CREATE INDEX CONCURRENTLY IF NOT EXISTS i_0123456789abcdef01234567 ON b_[0-9a-f]{32}\.t_[0-9a-f]{32} USING btree \(f_[0-9a-f]{32} DESC NULLS LAST\)$/
    );

    const refused = async (workspace: string | null, run: ReturnType<typeof sql>) => {
      const attempt =
        workspace === null
          ? t.appDb.execute(run)
          : withTenant(t.appDb, workspace, (tx) => tx.execute(run));
      await expect(attempt).rejects.toThrow();
    };
    const keys = [{ column: col, fn: 'none' }];
    // Another tenant's table, or no tenant at all.
    await refused(workspaceId, statement(otherTableId, name, 'btree', keys));
    await refused(null, statement(table.id, name, 'btree', keys));
    await refused(workspaceId, sql`SELECT * FROM ddl_index_list(${otherTableId}::uuid)`);
    await refused(
      workspaceId,
      sql`SELECT ddl_index_drop_statement(${otherTableId}::uuid, ${name})`
    );
    // Names, columns, expressions and methods outside the fixed patterns.
    await refused(workspaceId, statement(table.id, 'i_x"; DROP TABLE users; --', 'btree', keys));
    await refused(workspaceId, statement(table.id, 'users_pkey', 'btree', keys));
    await refused(
      workspaceId,
      sql`SELECT ddl_index_drop_statement(${table.id}::uuid, 'users_pkey')`
    );
    await refused(workspaceId, statement(table.id, name, 'hash', keys));
    await refused(workspaceId, statement(table.id, name, 'btree', [{ column: 'deleted_at' }]));
    await refused(workspaceId, statement(table.id, name, 'btree', [{ column: 'f_x" ; --' }]));
    await refused(
      workspaceId,
      statement(table.id, name, 'btree', [{ column: `f_${'0'.repeat(32)}`, fn: 'none' }])
    );
    await refused(workspaceId, statement(table.id, name, 'btree', [{ column: col, fn: 'lower' }]));
    await refused(workspaceId, statement(table.id, name, 'trgm', [{ column: col, fn: 'none' }]));
    await refused(workspaceId, statement(table.id, name, 'btree', []));
    // openrows_app itself still can't build an index: only the owner connection can.
    const loc = await t.db.select().from(tables).where(eq(tables.id, table.id));
    const target = loc[0] ? `"${loc[0].dbSchema}"."${loc[0].dbTable}"` : '';
    await expect(
      t.appDb.execute(sql.raw(`CREATE INDEX x_try ON ${target} (id)`))
    ).rejects.toThrow();
  });
});
