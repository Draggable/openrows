import type { FieldMeta, QueryRecordsResult, TableMeta } from '@openrows/shared';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { qualified } from '../../src/data/columns.js';
import { fields, tables } from '../../src/db/index.js';
import { useTestDb } from '../helpers/db.js';
import { authedClient, createWorkspace } from '../helpers/factories.js';

/**
 * A small-dataset benchmark of the ViewQuery engine against the ADR-001 numbers. ADR-001
 * measured 500k rows without field indexes: unindexed keyset page at the middle 88 ms, text
 * contains count 90 ms, number range count 72 ms, top 100 by 3 typed keys 63 ms, OFFSET 250,000
 * 45 ms. At 20k rows those scale to a few ms; the budget here is generous (shared CI runners,
 * HTTP and JSON included) and catches order-of-magnitude regressions such as a lost index-free
 * plan turning into per-row work, in-memory filtering or N+1 queries.
 *
 * Wall-clock times on the shared self-hosted runners swing by more than 10x with load (other jobs,
 * the other test files sharing the Postgres container), so each query takes the fastest of several
 * runs, and the budget scales with a trivial query (one record, no sort, no count) timed in
 * alternation with it, so both see the same load: a query may cost at most BUDGET_MS or SLOWDOWN
 * times the trivial one.
 */
const ROWS = 20_000;
const BUDGET_MS = 400;
const SLOWDOWN = 15;

describe('records query benchmark (20k rows)', () => {
  const t = useTestDb();
  let api: Awaited<ReturnType<typeof authedClient>>;
  let table: TableMeta;
  let ids: { name: string; num: string; status: string };

  const query = async (body: Record<string, unknown>) => {
    const res = await api.request(`/api/tables/${table.id}/records/query`, {
      method: 'POST',
      headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status !== 200) throw new Error(`${res.status}: ${await res.text()}`);
    return (await res.json()) as QueryRecordsResult;
  };

  const BASELINE = { limit: 1, count: false };

  /** The fastest of 9 runs after a warm-up, in ms, with its budget: each run is paired with a run
   *  of the trivial baseline query, so a load spike lifts the budget too. */
  async function measure(body: Record<string, unknown>) {
    await query(body);
    await query(BASELINE);
    let ms = Number.POSITIVE_INFINITY;
    let baseline = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 9; i++) {
      let start = performance.now();
      await query(BASELINE);
      baseline = Math.min(baseline, performance.now() - start);
      start = performance.now();
      await query(body);
      ms = Math.min(ms, performance.now() - start);
    }
    return { ms, baseline, budget: Math.max(BUDGET_MS, baseline * SLOWDOWN) };
  }

  beforeAll(async () => {
    const { owner, workspace } = await createWorkspace(t.db);
    api = await authedClient(t, owner);
    const json = async <T>(path: string, body: unknown) => {
      const res = await api.request(path, {
        method: 'POST',
        headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return (await res.json()) as T;
    };
    const base = await json<{ id: string }>(`/api/workspaces/${workspace.id}/bases`, {
      name: 'Bench',
    });
    table = await json<TableMeta>(`/api/bases/${base.id}/tables`, { name: 'Bench' });
    const num = await json<FieldMeta>(`/api/tables/${table.id}/fields`, {
      name: 'N',
      type: 'number',
    });
    const status = table.fields.find((f) => f.name === 'Status');
    const name = table.fields.find((f) => f.name === 'Name');
    if (!status || !name) throw new Error('default fields missing');
    ids = { name: name.id, num: num.id, status: status.id };

    const [loc] = await t.db.select().from(tables).where(eq(tables.id, table.id));
    const cols = await t.db.select().from(fields).where(eq(fields.tableId, table.id));
    const col = (id: string) => sql.identifier(cols.find((c) => c.id === id)?.dbColumn ?? '');
    const choices = (status.options as { choices: { id: string }[] }).choices.map((c) => c.id);
    if (!loc) throw new Error('no table');
    await t.db.execute(sql`
      INSERT INTO ${qualified(loc)} (id, created_by, updated_by, ${col(ids.name)}, ${col(ids.num)}, ${col(ids.status)})
      SELECT gen_random_uuid(), ${owner.id}::uuid, ${owner.id}::uuid,
             'Item ' || i || ' ' || md5(i::text),
             CASE WHEN i % 50 = 0 THEN NULL ELSE (i * 7919) % 1000 END,
             (${JSON.stringify(choices)}::jsonb ->> (i % 3))
        FROM generate_series(1, ${ROWS}) AS i`);
    await t.db.execute(sql`ANALYZE ${qualified(loc)}`);
  });

  it('stays within budget on windowed, keyset, filtered, grouped and searched queries', async () => {
    const sorts = [
      { fieldId: ids.num, direction: 'desc' },
      { fieldId: ids.status, direction: 'asc' },
      { fieldId: ids.name, direction: 'asc' },
    ];
    const middle = await query({ query: { sorts }, offset: ROWS / 2, limit: 100 });
    expect(middle.total).toBe(ROWS);
    expect(middle.records).toHaveLength(100);
    expect(middle.nextCursor).not.toBeNull();

    const results = {
      'window at the middle, 3 typed keys, with total': await measure({
        query: { sorts },
        offset: ROWS / 2,
        limit: 100,
      }),
      'keyset page at the middle, 3 typed keys': await measure({
        query: { sorts },
        cursor: middle.nextCursor,
        limit: 100,
        count: false,
      }),
      'text contains + number range, page and count': await measure({
        query: {
          filter: {
            conditions: [
              { fieldId: ids.name, operator: 'contains', value: 'a1' },
              { fieldId: ids.num, operator: '<', value: 110 },
            ],
          },
        },
        limit: 100,
      }),
      'group by status with counts and aggregates': await measure({
        query: { groupBy: [{ fieldId: ids.status }] },
        groups: true,
        limit: 100,
        aggregates: [
          { fieldId: ids.num, fn: 'sum' },
          { fieldId: ids.num, fn: 'avg' },
          { fieldId: ids.num, fn: 'empty' },
          { fieldId: ids.name, fn: 'unique' },
        ],
      }),
      'search, page and count': await measure({ query: { search: 'ff0' }, limit: 100 }),
    };
    console.info('ViewQuery benchmark (20k rows, fastest ms):', results);
    for (const [name, { ms, budget }] of Object.entries(results)) {
      expect(ms, name).toBeLessThan(budget);
    }
  });
});
