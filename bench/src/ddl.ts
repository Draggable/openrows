/**
 * Field create/alter/delete and their effect on concurrent writers, plus the safety checks
 * (transactional DDL, lock_timeout) that layout A depends on.
 */
import { config } from './config.js';
import { type Client, log, one, type Pool, sleep, stats, timed } from './db.js';
import { B_TASKS, bx, fieldId } from './schema.js';
import { type Approach, setCell } from './writes.js';

export interface DdlResult {
  name: string;
  approach: 'A' | 'B';
  opMs: number;
  /** Longest single write seen by the background writers while the operation ran. */
  writerMaxMs: number;
  writerP99Ms: number;
  writes: number;
  note?: string;
}

const WRITERS = 4;
const BATCH = 10_000;

/** Runs `op` while WRITERS clients keep updating random rows of the same table. */
async function underLoad(
  db: Pool,
  approach: 'A' | 'B',
  op: () => Promise<unknown>
): Promise<{ opMs: number; writerMaxMs: number; writerP99Ms: number; writes: number }> {
  let running = true;
  const latencies: number[] = [];
  const writers = Array.from({ length: WRITERS }, async () => {
    const client = await db.connect();
    try {
      while (running) {
        const id = 1 + Math.floor(Math.random() * config.rows);
        const run = await timed(() =>
          setCell(client, approach as Approach, id, 'n03', Math.floor(Math.random() * 100))
        );
        latencies.push(run.ms);
      }
    } finally {
      client.release();
    }
  });
  await sleep(300);
  const run = await timed(op);
  await sleep(300);
  running = false;
  await Promise.all(writers);
  const s = stats(latencies);
  return { opMs: run.ms, writerMaxMs: s.max, writerP99Ms: s.p99, writes: latencies.length };
}

/** Runs statements in one transaction with a lock_timeout, as the M1 DDL manager will. */
async function ddl(db: Pool, statements: string[], lockTimeout = '5s'): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '${lockTimeout}'`);
    for (const s of statements) await client.query(s);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Runs an UPDATE over the whole table in id batches (one transaction per batch). */
async function batched(db: Pool, sql: (from: number, to: number) => string): Promise<void> {
  for (let from = 1; from <= config.rows; from += BATCH) {
    await db.query(sql(from, from + BATCH - 1));
  }
}

async function record(
  results: DdlResult[],
  db: Pool,
  name: string,
  approach: 'A' | 'B',
  op: () => Promise<unknown>,
  note?: string
): Promise<void> {
  const r = await underLoad(db, approach, op);
  const result: DdlResult = { name, approach, ...r, ...(note ? { note } : {}) };
  results.push(result);
  log(
    `ddl: ${name} [${approach}]: ${r.opMs.toFixed(0)} ms, worst concurrent write ${r.writerMaxMs.toFixed(0)} ms`
  );
}

export interface SafetyResult {
  transactionalRollback: boolean;
  lockTimeoutSetting: string;
  ddlFailedAfterMs: number;
  ddlErrorCode: string;
  readerWaitedMs: number;
  retryAfterReleaseMs: number;
}

/** DDL rolls back with its metadata, and lock_timeout bounds how long a queued DDL blocks readers. */
async function safety(db: Pool): Promise<SafetyResult> {
  await db.query(
    'CREATE TABLE IF NOT EXISTS bench_a.fields_meta (id text PRIMARY KEY, column_name text NOT NULL)'
  );
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO bench_a.fields_meta VALUES ('fld_rollback', 'f_rollback')`);
    await client.query('ALTER TABLE bench_a.tasks ADD COLUMN f_rollback text');
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  const leftover = await one<{ cols: string; meta: string }>(
    db,
    `SELECT (SELECT count(*) FROM information_schema.columns
             WHERE table_schema = 'bench_a' AND table_name = 'tasks' AND column_name = 'f_rollback') AS cols,
            (SELECT count(*) FROM bench_a.fields_meta WHERE id = 'fld_rollback') AS meta`
  );

  // A long-running reader holds ACCESS SHARE; the DDL queues behind it and, while queued, blocks
  // new readers. lock_timeout makes the DDL give up so the readers proceed.
  const lockTimeout = '1s';
  const holder: Client = await db.connect();
  const ddlClient: Client = await db.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM bench_a.tasks LIMIT 1');
    const ddlRun = timed(async () => {
      try {
        await ddlClient.query(`SET lock_timeout = '${lockTimeout}'`);
        await ddlClient.query('ALTER TABLE bench_a.tasks ADD COLUMN f_blocked text');
        return 'ok';
      } catch (err) {
        return (err as { code?: string }).code ?? 'error';
      } finally {
        await ddlClient.query('RESET lock_timeout');
      }
    });
    await sleep(100);
    const reader = await timed(() => db.query('SELECT id FROM bench_a.tasks WHERE id = 1'));
    const ddlResult = await ddlRun;
    await holder.query('COMMIT');
    const retry = await timed(() =>
      ddl(db, ['ALTER TABLE bench_a.tasks ADD COLUMN f_blocked text'], lockTimeout)
    );
    await ddl(db, ['ALTER TABLE bench_a.tasks DROP COLUMN f_blocked']);
    return {
      transactionalRollback: leftover.cols === '0' && leftover.meta === '0',
      lockTimeoutSetting: lockTimeout,
      ddlFailedAfterMs: ddlResult.ms,
      ddlErrorCode: ddlResult.value,
      readerWaitedMs: reader.ms,
      retryAfterReleaseMs: retry.ms,
    };
  } finally {
    holder.release();
    ddlClient.release();
  }
}

export async function runDdl(db: Pool): Promise<{ ops: DdlResult[]; safety: SafetyResult }> {
  const results: DdlResult[] = [];
  const T = 'bench_a.tasks';
  const R = 'bench_b.records';
  const x01 = fieldId('x01');
  const t04 = fieldId('t04');

  // Add a field.
  await record(results, db, 'Add field (nullable column)', 'A', () =>
    ddl(db, [`ALTER TABLE ${T} ADD COLUMN f_new text`])
  );
  await record(results, db, 'Add field with default (checkbox NOT NULL DEFAULT false)', 'A', () =>
    ddl(db, [`ALTER TABLE ${T} ADD COLUMN f_flag boolean NOT NULL DEFAULT false`])
  );
  await record(results, db, 'Add field', 'B', async () => {}, 'metadata only, no DDL');

  // Index a field (e.g. when it is first used in a filter or sort).
  await record(results, db, 'Index a text field (CREATE INDEX CONCURRENTLY)', 'A', () =>
    db.query(`CREATE INDEX CONCURRENTLY tasks_t03 ON ${T} (t03)`)
  );
  await record(results, db, 'Index a text field (CREATE INDEX CONCURRENTLY)', 'B', () =>
    db.query(`CREATE INDEX CONCURRENTLY records_t03 ON ${R} (${bx('t03')}) WHERE ${B_TASKS}`)
  );

  // Change a field's type: text -> number.
  await record(
    results,
    db,
    'Change type text -> number, in place (ALTER COLUMN TYPE, table rewrite)',
    'A',
    () => ddl(db, [`ALTER TABLE ${T} ALTER COLUMN x01 TYPE numeric USING x01::numeric`], '5s'),
    'ACCESS EXCLUSIVE for the whole rewrite, including every index'
  );
  await record(
    results,
    db,
    'Change type text -> number, one UPDATE (jsonb_set every row)',
    'B',
    () =>
      db.query(
        `UPDATE ${R} SET data = jsonb_set(data, '{${x01}}', to_jsonb((data->>'${x01}')::numeric)) WHERE ${B_TASKS}`
      ),
    'row locks on every row until commit'
  );

  // Change it back, online: new column + trigger + batched backfill + swap.
  await record(
    results,
    db,
    'Change type number -> text, online (new column, trigger, batched backfill, swap)',
    'A',
    async () => {
      await ddl(db, [
        `ALTER TABLE ${T} ADD COLUMN x01_new text`,
        `CREATE FUNCTION bench_a.x01_sync() RETURNS trigger LANGUAGE plpgsql AS
           $$ BEGIN NEW.x01_new := NEW.x01::text; RETURN NEW; END $$`,
        `CREATE TRIGGER x01_sync BEFORE INSERT OR UPDATE ON ${T}
           FOR EACH ROW EXECUTE FUNCTION bench_a.x01_sync()`,
      ]);
      await batched(
        db,
        (from, to) => `UPDATE ${T} SET x01_new = x01::text WHERE id BETWEEN ${from} AND ${to}`
      );
      await ddl(db, [
        `DROP TRIGGER x01_sync ON ${T}`,
        'DROP FUNCTION bench_a.x01_sync()',
        `ALTER TABLE ${T} DROP COLUMN x01`,
        `ALTER TABLE ${T} RENAME COLUMN x01_new TO x01`,
      ]);
    },
    `batches of ${BATCH.toLocaleString('en-US')} rows; leaves dead tuples for autovacuum`
  );
  await record(
    results,
    db,
    'Change type number -> text, batched UPDATEs',
    'B',
    () =>
      batched(
        db,
        (from, to) =>
          `UPDATE ${R} SET data = jsonb_set(data, '{${x01}}', to_jsonb(data->>'${x01}'))
           WHERE ${B_TASKS} AND id BETWEEN ${from} AND ${to}`
      ),
    `batches of ${BATCH.toLocaleString('en-US')} rows`
  );

  // Delete a field.
  await record(results, db, 'Delete field (DROP COLUMN)', 'A', () =>
    ddl(db, [`ALTER TABLE ${T} DROP COLUMN t04`])
  );
  await record(
    results,
    db,
    'Delete field (strip the key, batched UPDATEs)',
    'B',
    () =>
      batched(
        db,
        (from, to) =>
          `UPDATE ${R} SET data = data - '${t04}' WHERE ${B_TASKS} AND id BETWEEN ${from} AND ${to}`
      ),
    'or leave the key behind and filter it on read'
  );

  const safetyResult = await safety(db);
  log(`ddl: safety ${JSON.stringify(safetyResult)}`);
  return { ops: results, safety: safetyResult };
}
