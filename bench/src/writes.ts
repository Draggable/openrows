/** Concurrent single-cell updates, lost-update checks and bulk inserts. */
import { config } from './config.js';
import { type Client, log, one, type Pool, rows, type Stats, sleep, stats, timed } from './db.js';
import { B_TASKS, FIELDS, fieldId, TASKS_TABLE_ID, WORKSPACE_ID } from './schema.js';

export type Approach = 'A' | 'B' | 'B-rmw';

export interface WriteResult {
  name: string;
  approach: Approach;
  workers: number;
  writes: number;
  perSecond: number;
  latency: Stats;
  walBytesPerWrite: number;
  hotPercent: number | null;
  lostUpdates: number | null;
}

const randomId = () => 1 + Math.floor(Math.random() * config.rows);

/** One single-cell write in the given layout. B-rmw is the legacy read-merge-write path. */
export async function setCell(
  client: Client,
  approach: Approach,
  id: number,
  key: string,
  value: string | number
): Promise<void> {
  if (approach === 'A') {
    await client.query(
      `UPDATE bench_a.tasks SET ${key} = $1, version = version + 1, updated_at = now() WHERE id = $2`,
      [value, id]
    );
  } else if (approach === 'B') {
    await client.query(
      `UPDATE bench_b.records SET data = jsonb_set(data, '{${fieldId(key)}}', to_jsonb($1::${typeof value === 'number' ? 'numeric' : 'text'})),
              version = version + 1, updated_at = now() WHERE id = $2`,
      [value, id]
    );
  } else {
    const [row] = await rows<{ data: Record<string, unknown> }>(
      client,
      'SELECT data FROM bench_b.records WHERE id = $1',
      [id]
    );
    if (!row) return;
    row.data[fieldId(key)] = value;
    await client.query(
      'UPDATE bench_b.records SET data = $1, version = version + 1, updated_at = now() WHERE id = $2',
      [row.data, id]
    );
  }
}

function table(approach: Approach) {
  return approach === 'A' ? 'tasks' : 'records';
}

async function counters(db: Pool, approach: Approach) {
  const schema = approach === 'A' ? 'bench_a' : 'bench_b';
  return one<{ lsn: string; upd: string; hot: string }>(
    db,
    `SELECT pg_current_wal_lsn()::text AS lsn, n_tup_upd AS upd, n_tup_hot_upd AS hot
     FROM pg_stat_user_tables WHERE schemaname = $1 AND relname = $2`,
    [schema, table(approach)]
  );
}

/** Runs `workers` loops of `op` for `seconds` and collects latencies. */
async function hammer(
  db: Pool,
  workers: number,
  seconds: number,
  op: (client: Client, worker: number, seq: number) => Promise<void>
): Promise<number[]> {
  const deadline = Date.now() + seconds * 1000;
  const latencies: number[] = [];
  await Promise.all(
    Array.from({ length: workers }, async (_, worker) => {
      const client = await db.connect();
      try {
        for (let seq = 0; Date.now() < deadline; seq++) {
          const run = await timed(() => op(client, worker, seq));
          latencies.push(run.ms);
        }
      } finally {
        client.release();
      }
    })
  );
  return latencies;
}

async function scenario(
  db: Pool,
  name: string,
  approach: Approach,
  workers: number,
  op: (client: Client, worker: number, seq: number) => Promise<void>,
  check?: () => Promise<number>
): Promise<WriteResult> {
  await db.query('CHECKPOINT');
  const before = await counters(db, approach);
  const latencies = await hammer(db, workers, config.writeSeconds, op);
  await sleep(1500); // let backends flush their table stats
  await db.query('SELECT pg_stat_clear_snapshot()');
  const after = await counters(db, approach);
  const wal = await one<{ bytes: string }>(db, 'SELECT pg_wal_lsn_diff($1, $2) AS bytes', [
    after.lsn,
    before.lsn,
  ]);
  const updates = Number(after.upd) - Number(before.upd);
  const hot = Number(after.hot) - Number(before.hot);
  const result: WriteResult = {
    name,
    approach,
    workers,
    writes: latencies.length,
    perSecond: Math.round(latencies.length / config.writeSeconds),
    latency: stats(latencies),
    walBytesPerWrite: Math.round(Number(wal.bytes) / Math.max(1, latencies.length)),
    hotPercent: updates > 0 ? Math.round((hot / updates) * 1000) / 10 : null,
    lostUpdates: check ? await check() : null,
  };
  log(
    `writes: ${name} [${approach}]: ${result.perSecond}/s, p95 ${result.latency.p95.toFixed(1)} ms` +
      (result.lostUpdates !== null ? `, lost ${result.lostUpdates}` : '')
  );
  return result;
}

/** Each worker owns one text field and writes it on a few shared hot rows. */
async function contention(db: Pool, approach: Approach): Promise<WriteResult> {
  const hotRows = 8;
  const keys = FIELDS.filter((f) => f.kind === 'text' && f.key !== 't01').map((f) => f.key);
  const workers = Math.min(keys.length, 8);
  const last = new Map<string, string>();
  return scenario(
    db,
    `Contention: ${workers} clients, ${hotRows} hot rows, one field each`,
    approach,
    workers,
    async (client, worker, seq) => {
      const id = 1 + Math.floor(Math.random() * hotRows);
      const key = keys[worker] ?? 't02';
      const value = `w${worker}:${seq}`;
      await setCell(client, approach, id, key, value);
      last.set(`${id}/${key}`, value);
    },
    async () => {
      let lost = 0;
      for (const [cell, expected] of last) {
        const [id, key] = cell.split('/') as [string, string];
        const actual =
          approach === 'A'
            ? await one<{ v: string }>(db, `SELECT ${key} AS v FROM bench_a.tasks WHERE id = $1`, [
                id,
              ])
            : await one<{ v: string }>(
                db,
                `SELECT data->>'${fieldId(key)}' AS v FROM bench_b.records WHERE id = $1`,
                [id]
              );
        if (actual.v !== expected) lost++;
      }
      return lost;
    }
  );
}

export interface BulkResult {
  approach: 'A' | 'B';
  rowsPerCall: number;
  latency: Stats;
}

/** Inserts 1,000 full records per statement from a JSON payload, as an import or paste would. */
async function bulkInsert(db: Pool): Promise<BulkResult[]> {
  const keys = FIELDS.map((f) => f.key);
  const aPayload = await one<{ p: unknown }>(
    db,
    `SELECT json_agg(t) AS p FROM (SELECT ${keys.join(', ')} FROM bench_a.tasks ORDER BY id LIMIT 1000) t`
  );
  const bPayload = await one<{ p: unknown }>(
    db,
    `SELECT jsonb_agg(data) AS p FROM (SELECT data FROM bench_b.records WHERE ${B_TASKS} ORDER BY id LIMIT 1000) r`
  );
  const results: BulkResult[] = [];
  for (const approach of ['A', 'B'] as const) {
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const run = await timed(() =>
        approach === 'A'
          ? db.query(
              `INSERT INTO bench_a.tasks (${keys.join(', ')})
               SELECT ${keys.join(', ')} FROM json_populate_recordset(null::bench_a.tasks, $1)`,
              [JSON.stringify(aPayload.p)]
            )
          : db.query(
              `INSERT INTO bench_b.records (workspace_id, table_id, data)
               SELECT '${WORKSPACE_ID}', '${TASKS_TABLE_ID}', value FROM jsonb_array_elements($1)`,
              [JSON.stringify(bPayload.p)]
            )
      );
      samples.push(run.ms);
    }
    results.push({ approach, rowsPerCall: 1000, latency: stats(samples) });
    log(
      `writes: bulk insert 1000 rows [${approach}]: median ${stats(samples).median.toFixed(1)} ms`
    );
  }
  // Remove them again so later suites see the original row count.
  await db.query(`DELETE FROM bench_a.tasks WHERE id > ${config.rows}`);
  await db.query(`DELETE FROM bench_b.records WHERE ${B_TASKS} AND id > ${config.rows}`);
  await db.query('VACUUM ANALYZE bench_a.tasks, bench_b.records');
  return results;
}

export async function runWrites(db: Pool): Promise<{ cells: WriteResult[]; bulk: BulkResult[] }> {
  const cells: WriteResult[] = [];
  const n = config.concurrency;
  for (const approach of ['A', 'B'] as const) {
    cells.push(
      await scenario(db, `Random rows, unindexed number field (${n} clients)`, approach, n, (c) =>
        setCell(c, approach, randomId(), 'n03', Math.floor(Math.random() * 100))
      )
    );
    cells.push(
      await scenario(db, `Random rows, indexed number field (${n} clients)`, approach, n, (c) =>
        setCell(c, approach, randomId(), 'n01', Math.floor(Math.random() * 1_000_000))
      )
    );
  }
  for (const approach of ['A', 'B', 'B-rmw'] as const) cells.push(await contention(db, approach));
  const bulk = await bulkInsert(db);
  return { cells, bulk };
}
