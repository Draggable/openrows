import pg from 'pg';

export type Pool = pg.Pool;
export type Client = pg.PoolClient;
export type Row = Record<string, unknown>;

export function createPool(url: string, max: number): Pool {
  const pool = new pg.Pool({ connectionString: url, max });
  pool.on('error', () => {
    // Idle clients can be terminated by DDL tests; the pool replaces them.
  });
  return pool;
}

export async function waitForDb(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (err) {
      await client.end().catch(() => {});
      if (Date.now() > deadline) throw err;
      await sleep(500);
    }
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function rows<T extends Row = Row>(
  db: Pool | Client,
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const result = await db.query<T>(sql, params);
  return result.rows;
}

export async function one<T extends Row = Row>(
  db: Pool | Client,
  sql: string,
  params?: unknown[]
): Promise<T> {
  const [row] = await rows<T>(db, sql, params);
  if (!row) throw new Error(`Query returned no rows: ${sql}`);
  return row;
}

export async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await fn();
  return { ms: performance.now() - start, value };
}

export interface Stats {
  n: number;
  min: number;
  median: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export function stats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min: sorted[0] ?? 0,
    median: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1] ?? 0,
    mean: sorted.length ? sum / sorted.length : 0,
  };
}

/** Rounds to a readable precision for reports. */
export function round(ms: number): number {
  if (ms >= 100) return Math.round(ms);
  if (ms >= 10) return Math.round(ms * 10) / 10;
  return Math.round(ms * 100) / 100;
}

export function log(message: string): void {
  const time = new Date().toISOString().slice(11, 19);
  process.stdout.write(`[${time}] ${message}\n`);
}
