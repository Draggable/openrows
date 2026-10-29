/** Read-path queries a grid view issues, run identically against both layouts. */
import { config } from './config.js';
import { log, one, type Pool, type Row, rows, type Stats, stats, timed } from './db.js';
import { B_COMPANIES, B_TASKS, bx, COMPANY_ID_OFFSET, fieldId, LINK_ID } from './schema.js';

export interface ReadCase {
  name: string;
  a: string;
  b: string;
  /** How to check that A and B returned the same answer. */
  compare: 'id' | 'all';
}

export interface ReadResult {
  suite: string;
  name: string;
  a: Stats;
  b: Stats;
  aRows: number;
  match: boolean;
  aPlan: string;
  bPlan: string;
}

const A = 'bench_a.tasks';
const B = 'bench_b.records';

export async function readCases(db: Pool): Promise<ReadCase[]> {
  const mid = Math.floor(config.rows / 2);
  const n01 = await one<{ n01: string; id: string }>(
    db,
    `SELECT n01::text, id FROM ${A} ORDER BY n01, id OFFSET $1 LIMIT 1`,
    [mid]
  );
  const d03 = await one<{ d03: string; id: string }>(
    db,
    `SELECT d03::text, id FROM ${A} ORDER BY d03, id OFFSET $1 LIMIT 1`,
    [mid]
  );
  const aPage = (where: string) => `SELECT * FROM ${A} WHERE ${where} ORDER BY id LIMIT 100`;
  const bPage = (where: string) =>
    `SELECT id, version, data FROM ${B} WHERE ${B_TASKS} AND ${where} ORDER BY id LIMIT 100`;
  const cases: ReadCase[] = [
    {
      name: 'Page of 100 rows, all fields (ORDER BY id)',
      a: `SELECT * FROM ${A} ORDER BY id LIMIT 100`,
      b: `SELECT id, version, data FROM ${B} WHERE ${B_TASKS} ORDER BY id LIMIT 100`,
      compare: 'id',
    },
    {
      name: 'Count all rows',
      a: `SELECT count(*) FROM ${A}`,
      b: `SELECT count(*) FROM ${B} WHERE ${B_TASKS}`,
      compare: 'all',
    },
    {
      name: 'Text contains, trigram index: page',
      a: aPage(`t01 ILIKE '%abc%'`),
      b: bPage(`${bx('t01')} ILIKE '%abc%'`),
      compare: 'id',
    },
    {
      name: 'Text contains, trigram index: count',
      a: `SELECT count(*) FROM ${A} WHERE t01 ILIKE '%abc%'`,
      b: `SELECT count(*) FROM ${B} WHERE ${B_TASKS} AND ${bx('t01')} ILIKE '%abc%'`,
      compare: 'all',
    },
    {
      name: 'Text contains, no index: count',
      a: `SELECT count(*) FROM ${A} WHERE t02 ILIKE '%abcd%'`,
      b: `SELECT count(*) FROM ${B} WHERE ${B_TASKS} AND ${bx('t02')} ILIKE '%abcd%'`,
      compare: 'all',
    },
    {
      name: 'Number range (1%), btree: page',
      a: aPage('n01 BETWEEN 400000 AND 410000'),
      b: bPage(`${bx('n01')} BETWEEN 400000 AND 410000`),
      compare: 'id',
    },
    {
      name: 'Number range (1%), btree: count',
      a: `SELECT count(*) FROM ${A} WHERE n01 BETWEEN 400000 AND 410000`,
      b: `SELECT count(*) FROM ${B} WHERE ${B_TASKS} AND ${bx('n01')} BETWEEN 400000 AND 410000`,
      compare: 'all',
    },
    {
      name: 'Number range (11%), no index: count',
      a: `SELECT count(*) FROM ${A} WHERE n03 BETWEEN 10 AND 20`,
      b: `SELECT count(*) FROM ${B} WHERE ${B_TASKS} AND ${bx('n03')} BETWEEN 10 AND 20`,
      compare: 'all',
    },
    {
      name: 'Select IN (2 of 8 options), btree: page',
      a: aPage(`s01 IN ('Option 2', 'Option 5')`),
      b: bPage(`${bx('s01')} IN ('Option 2', 'Option 5')`),
      compare: 'id',
    },
    {
      name: 'Select IN (2 of 8 options), btree: count',
      a: `SELECT count(*) FROM ${A} WHERE s01 IN ('Option 2', 'Option 5')`,
      b: `SELECT count(*) FROM ${B} WHERE ${B_TASKS} AND ${bx('s01')} IN ('Option 2', 'Option 5')`,
      compare: 'all',
    },
    {
      name: 'Multi-select has any of, no index: count',
      a: `SELECT count(*) FROM ${A} WHERE m01 && ARRAY['Green']`,
      b: `SELECT count(*) FROM ${B} WHERE ${B_TASKS} AND ${bx('m01')} ?| ARRAY['Green']`,
      compare: 'all',
    },
    {
      name: 'Compound AND (contains + number + checkbox): count',
      a: `SELECT count(*) FROM ${A} WHERE t01 ILIKE '%ab%' AND n02 > 5000 AND c01`,
      b: `SELECT count(*) FROM ${B} WHERE ${B_TASKS} AND ${bx('t01')} ILIKE '%ab%' AND ${bx('n02')} > 5000 AND ${bx('c01')}`,
      compare: 'all',
    },
    {
      name: 'Sort by 3 typed keys (select, number desc, datetime), no index: top 100',
      a: `SELECT * FROM ${A} ORDER BY s02, n02 DESC, d02, id LIMIT 100`,
      b: `SELECT id, version, data FROM ${B} WHERE ${B_TASKS} ORDER BY ${bx('s02')}, ${bx('n02')} DESC, ${bx('d02')}, id LIMIT 100`,
      compare: 'id',
    },
    {
      name: 'Filter (select =) + sort by 2 keys (datetime desc, text): top 100',
      a: `SELECT * FROM ${A} WHERE s01 = 'Option 3' ORDER BY d02 DESC, t01, id LIMIT 100`,
      b: `SELECT id, version, data FROM ${B} WHERE ${B_TASKS} AND ${bx('s01')} = 'Option 3' ORDER BY ${bx('d02')} DESC, ${bx('t01')}, id LIMIT 100`,
      compare: 'id',
    },
    {
      name: 'Group by select: count, sum, avg',
      a: `SELECT s01 AS g, count(*), sum(n02), round(avg(n03), 4) AS avg FROM ${A} GROUP BY 1 ORDER BY 1`,
      b: `SELECT ${bx('s01')} AS g, count(*), sum(${bx('n02')}), round(avg(${bx('n03')}), 4) AS avg FROM ${B} WHERE ${B_TASKS} GROUP BY 1 ORDER BY 1`,
      compare: 'all',
    },
    {
      name: 'Group by 2 fields (select, select): count, sum',
      a: `SELECT s01 AS g1, s03 AS g2, count(*), sum(n04) FROM ${A} GROUP BY 1, 2 ORDER BY 1, 2`,
      b: `SELECT ${bx('s01')} AS g1, ${bx('s03')} AS g2, count(*), sum(${bx('n04')}) FROM ${B} WHERE ${B_TASKS} GROUP BY 1, 2 ORDER BY 1, 2`,
      compare: 'all',
    },
    {
      name: 'Keyset page at the middle, indexed sort (number, id)',
      a: `SELECT * FROM ${A} WHERE (n01, id) > (${n01.n01}, ${n01.id}) ORDER BY n01, id LIMIT 100`,
      b: `SELECT id, version, data FROM ${B} WHERE ${B_TASKS} AND (${bx('n01')}, id) > (${n01.n01}, ${n01.id}) ORDER BY ${bx('n01')}, id LIMIT 100`,
      compare: 'id',
    },
    {
      name: 'Keyset page at the middle, unindexed sort (datetime, id)',
      a: `SELECT * FROM ${A} WHERE (d03, id) > ('${d03.d03}'::timestamptz, ${d03.id}) ORDER BY d03, id LIMIT 100`,
      b: `SELECT id, version, data FROM ${B} WHERE ${B_TASKS} AND (${bx('d03')}, id) > ('${d03.d03}'::timestamptz, ${d03.id}) ORDER BY ${bx('d03')}, id LIMIT 100`,
      compare: 'id',
    },
    {
      name: 'OFFSET page at the middle (ORDER BY id), for contrast',
      a: `SELECT * FROM ${A} ORDER BY id OFFSET ${mid} LIMIT 100`,
      b: `SELECT id, version, data FROM ${B} WHERE ${B_TASKS} ORDER BY id OFFSET ${mid} LIMIT 100`,
      compare: 'id',
    },
  ];
  return cases;
}

export function linkCases(): ReadCase[] {
  const mid = Math.floor(config.rows / 2);
  const company = 42;
  const name = fieldId('name');
  const rev = fieldId('rev');
  return [
    {
      name: 'Page of 100 rows with linked record names',
      a: `SELECT t.id, ARRAY(SELECT c.name FROM bench_a.l_k01 l JOIN bench_a.companies c ON c.id = l.to_id
                            WHERE l.from_id = t.id ORDER BY c.id) AS names
          FROM bench_a.tasks t WHERE t.id > ${mid} ORDER BY t.id LIMIT 100`,
      b: `SELECT r.id, ARRAY(SELECT c.data->>'${name}' FROM jsonb_array_elements_text(r.data->'${LINK_ID}') e(v)
                            JOIN ${B} c ON c.id = e.v::bigint ORDER BY c.id) AS names
          FROM ${B} r WHERE r.${B_TASKS} AND r.id > ${mid} ORDER BY r.id LIMIT 100`,
      compare: 'all',
    },
    {
      name: 'Backlinks: count rows linking to one record',
      a: `SELECT count(*) FROM bench_a.l_k01 WHERE to_id = ${company}`,
      b: `SELECT count(*) FROM ${B} WHERE ${B_TASKS} AND data->'${LINK_ID}' @> '[${company + COMPANY_ID_OFFSET}]'`,
      compare: 'all',
    },
    {
      name: 'Rollup sum(linked revenue) for a page of 100 rows',
      a: `SELECT t.id, (SELECT sum(c.revenue) FROM bench_a.l_k01 l JOIN bench_a.companies c ON c.id = l.to_id
                       WHERE l.from_id = t.id) AS total
          FROM bench_a.tasks t WHERE t.id > ${mid} ORDER BY t.id LIMIT 100`,
      b: `SELECT r.id, (SELECT sum((c.data->>'${rev}')::numeric) FROM jsonb_array_elements_text(r.data->'${LINK_ID}') e(v)
                       JOIN ${B} c ON c.id = e.v::bigint) AS total
          FROM ${B} r WHERE r.${B_TASKS} AND r.id > ${mid} ORDER BY r.id LIMIT 100`,
      compare: 'all',
    },
    {
      name: 'Reverse rollup: 100 linked-to rows with count + sum of linking rows',
      a: `SELECT c.id, count(t.id) AS n, sum(t.n02) AS total
          FROM (SELECT id FROM bench_a.companies ORDER BY id LIMIT 100) c
          LEFT JOIN bench_a.l_k01 l ON l.to_id = c.id
          LEFT JOIN bench_a.tasks t ON t.id = l.from_id
          GROUP BY c.id ORDER BY c.id`,
      b: `SELECT c.id - ${COMPANY_ID_OFFSET} AS id, x.n, x.total
          FROM (SELECT id FROM ${B} WHERE ${B_COMPANIES} ORDER BY id LIMIT 100) c
          CROSS JOIN LATERAL (SELECT count(*) AS n, sum(${bx('n02', 't')}) AS total FROM ${B} t
                              WHERE t.${B_TASKS} AND t.data->'${LINK_ID}' @> jsonb_build_array(c.id)) x
          ORDER BY c.id`,
      compare: 'all',
    },
    {
      name: 'Filter on a rollup over all rows (linked revenue > 1M): count',
      a: `SELECT count(*) FROM (SELECT l.from_id FROM bench_a.l_k01 l JOIN bench_a.companies c ON c.id = l.to_id
                                GROUP BY l.from_id HAVING sum(c.revenue) > 1000000) s`,
      b: `SELECT count(*) FROM (SELECT r.id FROM ${B} r
                                CROSS JOIN LATERAL jsonb_array_elements_text(r.data->'${LINK_ID}') e(v)
                                JOIN ${B} c ON c.id = e.v::bigint
                                WHERE r.${B_TASKS}
                                GROUP BY r.id HAVING sum((c.data->>'${rev}')::numeric) > 1000000) s`,
      compare: 'all',
    },
  ];
}

function fingerprint(result: Row[], compare: ReadCase['compare']): string {
  if (compare === 'id') return result.map((r) => String(r['id'])).join(',');
  return JSON.stringify(result.map((r) => Object.values(r).map((v) => String(v))));
}

async function plan(db: Pool, sql: string): Promise<string> {
  const lines = await rows<{ 'QUERY PLAN': string }>(db, `EXPLAIN ${sql}`);
  return lines.map((l) => l['QUERY PLAN']).join('\n');
}

async function measure(db: Pool, sql: string): Promise<{ stats: Stats; result: Row[] }> {
  let result = await rows(db, sql); // warm-up
  const samples: number[] = [];
  for (let i = 0; i < config.iterations; i++) {
    const run = await timed(() => rows(db, sql));
    samples.push(run.ms);
    result = run.value;
  }
  return { stats: stats(samples), result };
}

export async function runReadCases(
  db: Pool,
  suite: string,
  cases: ReadCase[]
): Promise<ReadResult[]> {
  const results: ReadResult[] = [];
  for (const c of cases) {
    const a = await measure(db, c.a);
    const b = await measure(db, c.b);
    const match = fingerprint(a.result, c.compare) === fingerprint(b.result, c.compare);
    log(
      `${suite}: ${c.name}: A ${a.stats.median.toFixed(1)} ms, B ${b.stats.median.toFixed(1)} ms` +
        (match ? '' : '  ** RESULTS DIFFER **')
    );
    results.push({
      suite,
      name: c.name,
      a: a.stats,
      b: b.stats,
      aRows: a.result.length,
      match,
      aPlan: await plan(db, c.a),
      bPlan: await plan(db, c.b),
    });
  }
  return results;
}
