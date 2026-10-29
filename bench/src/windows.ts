/**
 * Sorted and filtered windows on layout A with the indexes the field index job builds,
 * against the targets below. The queries have the query compiler's shape
 * (packages/server/src/data/query/compile.ts): text sorts on lower(), ascending NULLS FIRST,
 * descending NULLS LAST, the id last (plain ascending), 100-row windows by OFFSET (the grid) or
 * a keyset condition (the API). The indexes have the job's shapes and names, built with
 * CREATE INDEX CONCURRENTLY. Each case runs before and after the build.
 */
import { config } from './config.js';
import { log, one, type Pool, rows, type Stats, stats, timed } from './db.js';

const A = 'bench_a.tasks';

/**
 * p95 targets (ms) for a 100-row window, set by from ADR-001's measurements: indexed pages
 * took 1–3 ms there, so a window the grid fetches while scrolling (anywhere in the first 10,000
 * rows), a keyset page and a filtered window get 50 ms; a jump far down the scrollbar (an
 * OFFSET deep into the table walks the index up to it) gets 150 ms.
 */
export const WINDOW_TARGETS = { near: 50, keyset: 50, filtered: 50, deep: 150 } as const;

export interface WindowCase {
  name: string;
  sql: string;
  params?: unknown[];
  target: keyof typeof WINDOW_TARGETS;
}

export interface WindowResult {
  name: string;
  target: number;
  before: Stats;
  after: Stats;
  pass: boolean;
  plan: string;
}

export interface WindowsResult {
  /** Each index build (CONCURRENTLY), in ms. */
  builds: { name: string; ms: number }[];
  cases: WindowResult[];
  pass: boolean;
}

/** The job's indexes for three saved views: by text, by number (desc), by date (desc) then text. */
const INDEXES = [
  ['i_text_sort', 'btree ((lower(t02)) ASC NULLS FIRST, id)'],
  ['i_number_sort', 'btree (n02 ASC NULLS FIRST, id)'],
  ['i_composite', 'btree (d03 DESC NULLS LAST, (lower(t02)) ASC NULLS FIRST, id)'],
  ['i_text_trgm', 'gin (t03 gin_trgm_ops)'],
  ['i_number_filter', 'btree (n04 ASC NULLS FIRST)'],
] as const;

const window = (order: string, offset: number, where = 'true') =>
  `SELECT * FROM ${A} r WHERE ${where} ORDER BY ${order} LIMIT 100 OFFSET ${offset}`;

async function cases(db: Pool): Promise<WindowCase[]> {
  const textOrder = 'lower(r.t02) ASC NULLS FIRST, r.id ASC';
  const numberOrder = 'r.n02 DESC NULLS LAST, r.id ASC';
  const twoKeys = 'r.d03 DESC NULLS LAST, lower(r.t02) ASC NULLS FIRST, r.id ASC';
  const mid = Math.floor(config.rows / 2);
  const last = Math.max(0, config.rows - 100);
  // The keyset cursor at the middle of the text order, as afterCursor compiles it.
  const cursor = await one<{ k: string; id: string }>(
    db,
    `SELECT lower(t02) AS k, id::text AS id FROM ${A} r ORDER BY ${textOrder} OFFSET $1 LIMIT 1`,
    [mid]
  );
  return [
    { name: 'Text sort, first window', sql: window(textOrder, 0), target: 'near' },
    { name: 'Text sort, window at row 10,000', sql: window(textOrder, 10_000), target: 'near' },
    { name: 'Text sort, window at the middle', sql: window(textOrder, mid), target: 'deep' },
    { name: 'Text sort, last window', sql: window(textOrder, last), target: 'deep' },
    { name: 'Number sort (desc), first window', sql: window(numberOrder, 0), target: 'near' },
    {
      name: 'Number sort (desc), window at the middle',
      sql: window(numberOrder, mid),
      target: 'deep',
    },
    { name: 'Date desc + text sort, first window', sql: window(twoKeys, 0), target: 'near' },
    {
      name: 'Date desc + text sort, window at row 10,000',
      sql: window(twoKeys, 10_000),
      target: 'near',
    },
    {
      name: 'Text sort, keyset page at the middle',
      sql: `SELECT * FROM ${A} r
             WHERE lower(r.t02) >= $1::text
               AND ((lower(r.t02) > $1::text) OR (lower(r.t02) = $1::text AND r.id > $2::bigint))
             ORDER BY ${textOrder} LIMIT 100`,
      params: [cursor.k, cursor.id],
      target: 'keyset',
    },
    {
      name: 'Text contains (trigram), first window',
      sql: window('r.id ASC', 0, `r.t03 ILIKE '%note 42%'`),
      target: 'filtered',
    },
    {
      name: 'Number range 1% + text sort, first window',
      sql: window(textOrder, 0, 'r.n04 >= 1000 AND r.n04 < 1050'),
      target: 'filtered',
    },
    {
      name: 'Unsorted view (id order), window at row 10,000',
      sql: window('r.id ASC', 10_000),
      target: 'near',
    },
  ];
}

async function sample(db: Pool, c: WindowCase, iterations: number): Promise<Stats> {
  await db.query(c.sql, c.params); // warm-up
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    samples.push((await timed(() => db.query(c.sql, c.params))).ms);
  }
  return stats(samples);
}

/** Runs every case, builds the job's indexes concurrently, runs every case again. */
export async function runWindows(db: Pool): Promise<WindowsResult> {
  const iterations = Math.max(20, config.iterations * 3);
  const list = await cases(db);
  log(`windows: ${list.length} cases × ${iterations} runs, before the job's indexes`);
  const before = new Map<string, Stats>();
  for (const c of list) before.set(c.name, await sample(db, c, iterations));

  const builds: WindowsResult['builds'] = [];
  for (const [name, definition] of INDEXES) {
    const { ms } = await timed(() =>
      db.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON ${A} USING ${definition}`)
    );
    builds.push({ name, ms });
    log(`windows: built ${name} in ${Math.round(ms)} ms`);
  }
  await db.query(`ANALYZE ${A}`);

  log('windows: after');
  const results: WindowResult[] = [];
  for (const c of list) {
    const after = await sample(db, c, iterations);
    const plan = (await rows<{ 'QUERY PLAN': string }>(db, `EXPLAIN ${c.sql}`, c.params))
      .map((r) => r['QUERY PLAN'])
      .join('\n');
    const target = WINDOW_TARGETS[c.target];
    results.push({
      name: c.name,
      target,
      before: before.get(c.name) ?? after,
      after,
      pass: after.p95 <= target,
      plan,
    });
  }
  for (const [name] of INDEXES) await db.query(`DROP INDEX CONCURRENTLY IF EXISTS bench_a.${name}`);
  return { builds, cases: results, pass: results.every((r) => r.pass) };
}
