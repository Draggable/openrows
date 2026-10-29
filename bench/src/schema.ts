/**
 * The two storage layouts under test, loaded with identical data.
 *
 * (A) `bench_a`: one physical table per user table, one typed column per field, and a junction
 *     table per link field.
 * (B) `bench_b`: one shared `records` table with a JSONB `data` blob keyed by field id (the
 *     legacy layout), with links stored as id arrays inside the blob, plus partial expression
 *     indexes per indexed field.
 */
import { config } from './config.js';
import { log, one, type Pool, timed } from './db.js';

export const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
export const OTHER_WORKSPACE_ID = '00000000-0000-4000-8000-000000000099';
export const TASKS_TABLE_ID = '00000000-0000-4000-8000-000000000002';
export const COMPANIES_TABLE_ID = '00000000-0000-4000-8000-000000000003';
/** B stores companies in the same records table, so their ids are offset. */
export const COMPANY_ID_OFFSET = 1_000_000_000;

type Kind = 'text' | 'long' | 'number' | 'rating' | 'select' | 'multi' | 'date' | 'ts' | 'bool';

interface Field {
  key: string;
  kind: Kind;
  /** Column type in layout A. */
  type: string;
  /** SQL that generates a value (uses random(); the load runs after setseed). */
  gen: string;
}

const word = `substr(md5(floor(random() * 5000)::int::text), 1, 6)`;
const hex = (n: number) => `substr(md5(random()::text), 1, ${n})`;
const tags = (a: string, b: string, c: string) =>
  `(CASE floor(random() * 4)::int WHEN 0 THEN '{}'::text[] WHEN 1 THEN ARRAY['${a}'] ` +
  `WHEN 2 THEN ARRAY['${a}','${b}'] ELSE ARRAY['${b}','${c}'] END)`;
const longText = `md5(random()::text) || ' ' || md5(random()::text) || ' ' || md5(random()::text) || ' ' || md5(random()::text)`;
const ts = `(timestamptz '2020-01-01 00:00:00+00' + random() * interval '2000 days')`;

/** 29 scalar fields; the link field k01 makes 30. */
export const FIELDS: Field[] = [
  { key: 't01', kind: 'text', type: 'text', gen: `${word} || ' ' || ${word}` },
  { key: 't02', kind: 'text', type: 'text', gen: hex(16) },
  { key: 't03', kind: 'text', type: 'text', gen: `'Note ' || floor(random() * 1000)::int` },
  { key: 't04', kind: 'text', type: 'text', gen: hex(10) },
  { key: 't05', kind: 'text', type: 'text', gen: hex(12) },
  { key: 't06', kind: 'text', type: 'text', gen: hex(8) },
  {
    key: 't07',
    kind: 'text',
    type: 'text',
    gen: `'user' || floor(random() * 100000)::int || '@example.com'`,
  },
  { key: 't08', kind: 'text', type: 'text', gen: `'https://example.com/p/' || ${hex(8)}` },
  {
    key: 't09',
    kind: 'text',
    type: 'text',
    gen: `'+1-555-' || lpad(floor(random() * 10000)::int::text, 4, '0')`,
  },
  { key: 'l01', kind: 'long', type: 'text', gen: longText },
  { key: 'l02', kind: 'long', type: 'text', gen: longText },
  { key: 'n01', kind: 'number', type: 'numeric', gen: `floor(random() * 1000000)` },
  { key: 'n02', kind: 'number', type: 'numeric', gen: `round((random() * 10000)::numeric, 2)` },
  { key: 'n03', kind: 'number', type: 'numeric', gen: `floor(random() * 100)` },
  { key: 'n04', kind: 'number', type: 'numeric', gen: `round((random() * 5000)::numeric, 2)` },
  { key: 'n05', kind: 'number', type: 'numeric', gen: `round(random()::numeric, 4)` },
  { key: 'n06', kind: 'number', type: 'numeric', gen: `floor(random() * 86400)` },
  { key: 'r01', kind: 'rating', type: 'smallint', gen: `(1 + floor(random() * 5))::smallint` },
  { key: 's01', kind: 'select', type: 'text', gen: `'Option ' || (1 + floor(random() * 8))::int` },
  {
    key: 's02',
    kind: 'select',
    type: 'text',
    gen: `'Category ' || lpad((1 + floor(random() * 20))::int::text, 2, '0')`,
  },
  {
    key: 's03',
    kind: 'select',
    type: 'text',
    gen: `(ARRAY['Low','Medium','High','Urgent','None'])[1 + floor(random() * 5)::int]`,
  },
  { key: 'm01', kind: 'multi', type: 'text[]', gen: tags('Red', 'Green', 'Blue') },
  { key: 'm02', kind: 'multi', type: 'text[]', gen: tags('Alpha', 'Beta', 'Gamma') },
  {
    key: 'd01',
    kind: 'date',
    type: 'date',
    gen: `date '2020-01-01' + floor(random() * 2000)::int`,
  },
  { key: 'd02', kind: 'ts', type: 'timestamptz', gen: ts },
  { key: 'd03', kind: 'ts', type: 'timestamptz', gen: ts },
  { key: 'c01', kind: 'bool', type: 'boolean', gen: `random() < 0.5` },
  { key: 'c02', kind: 'bool', type: 'boolean', gen: `random() < 0.1` },
  // Numbers stored as text; the DDL suite converts this field's type.
  { key: 'x01', kind: 'text', type: 'text', gen: `floor(random() * 100000)::int::text` },
];

/** Field id as stored in B's JSON keys (17 characters, like Airtable's `fld…` ids). */
export function fieldId(key: string): string {
  return `fld${key}Q7xK2mP9wZ4`.slice(0, 17);
}

const kinds = new Map(FIELDS.map((f) => [f.key, f.kind]));

/** Typed B expression for a field; must match the index expressions exactly. */
export function bx(key: string, alias = ''): string {
  const data = `${alias ? `${alias}.` : ''}data`;
  const id = fieldId(key);
  switch (kinds.get(key) ?? 'text') {
    case 'number':
      return `((${data}->>'${id}')::numeric)`;
    case 'rating':
      return `((${data}->>'${id}')::smallint)`;
    case 'bool':
      return `((${data}->>'${id}')::boolean)`;
    case 'date':
      return `bench_b.to_date(${data}->>'${id}')`;
    case 'ts':
      return `bench_b.to_ts(${data}->>'${id}')`;
    case 'multi':
      return `(${data}->'${id}')`;
    default:
      return `(${data}->>'${id}')`;
  }
}

export const LINK_ID = fieldId('k01');
export const B_TASKS = `table_id = '${TASKS_TABLE_ID}'`;
export const B_COMPANIES = `table_id = '${COMPANIES_TABLE_ID}'`;

export interface LoadTimings {
  aLoadMs: number;
  aIndexMs: number;
  bLoadMs: number;
  bIndexMs: number;
  vacuumMs: number;
  junctionRows: number;
}

export async function load(db: Pool): Promise<LoadTimings> {
  const { rows, companies } = config;
  await db.query(`
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    DROP SCHEMA IF EXISTS bench_a CASCADE;
    DROP SCHEMA IF EXISTS bench_b CASCADE;
    CREATE SCHEMA bench_a;
    CREATE SCHEMA bench_b;
  `);

  const columns = FIELDS.map((f) => `${f.key} ${f.type}`).join(',\n      ');
  await db.query(`
    CREATE TABLE bench_a.companies (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      name text,
      revenue numeric,
      country text
    );
    CREATE TABLE bench_a.tasks (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      ${columns}
    );
    CREATE TABLE bench_a.l_k01 (
      from_id bigint NOT NULL REFERENCES bench_a.tasks (id) ON DELETE CASCADE,
      to_id bigint NOT NULL REFERENCES bench_a.companies (id) ON DELETE CASCADE,
      PRIMARY KEY (from_id, to_id)
    );
  `);

  log(`A: generating ${rows} tasks, ${companies} companies and links`);
  const aLoad = await timed(async () => {
    const client = await db.connect();
    try {
      await client.query('SELECT setseed(0.42)');
      await client.query(
        `INSERT INTO bench_a.companies (id, name, revenue, country)
         SELECT i, 'Company ' || i, round((random() * 1000000)::numeric, 2),
                (ARRAY['US','DE','FR','GB','CA','JP'])[1 + floor(random() * 6)::int]
         FROM generate_series(1, $1::int) i`,
        [companies]
      );
      await client.query(
        `INSERT INTO bench_a.tasks (id, ${FIELDS.map((f) => f.key).join(', ')})
         SELECT i, ${FIELDS.map((f) => f.gen).join(',\n')}
         FROM generate_series(1, $1::int) i`,
        [rows]
      );
      // 0-3 links per task (1.5 on average).
      await client.query(
        `INSERT INTO bench_a.l_k01 (from_id, to_id)
         SELECT i, 1 + floor(random() * $2::int)::bigint
         FROM generate_series(1, $1::int) i, generate_series(1, i % 4) j
         ON CONFLICT DO NOTHING`,
        [rows, companies]
      );
      await client.query(
        `SELECT setval(pg_get_serial_sequence('bench_a.tasks', 'id'), $1::bigint),
                setval(pg_get_serial_sequence('bench_a.companies', 'id'), $2::bigint)`,
        [rows, companies]
      );
    } finally {
      client.release();
    }
  });

  log('A: building indexes');
  const aIndex = await timed(() =>
    db.query(`
      CREATE INDEX tasks_t01_trgm ON bench_a.tasks USING gin (t01 gin_trgm_ops);
      CREATE INDEX tasks_n01 ON bench_a.tasks (n01, id);
      CREATE INDEX tasks_s01 ON bench_a.tasks (s01);
      CREATE INDEX l_k01_to ON bench_a.l_k01 (to_id, from_id);
    `)
  );

  await db.query(`
    CREATE SEQUENCE bench_b.records_id_seq;
    CREATE TABLE bench_b.records (
      id bigint PRIMARY KEY DEFAULT nextval('bench_b.records_id_seq'),
      workspace_id uuid NOT NULL,
      table_id uuid NOT NULL,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      data jsonb NOT NULL DEFAULT '{}'
    );
    -- Text -> date/timestamptz casts are only STABLE, so expression indexes need wrappers that
    -- claim IMMUTABLE. That is safe only because the app always writes ISO 8601 with an offset.
    CREATE FUNCTION bench_b.to_ts(text) RETURNS timestamptz
      LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT $1::timestamptz $$;
    CREATE FUNCTION bench_b.to_date(text) RETURNS date
      LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT $1::date $$;
  `);

  log('B: copying the same data into JSONB');
  const pairs = FIELDS.map((f) => `'${fieldId(f.key)}', to_jsonb(t.${f.key})`).join(', ');
  const bLoad = await timed(async () => {
    await db.query(`
      INSERT INTO bench_b.records (id, workspace_id, table_id, data)
      SELECT t.id, '${WORKSPACE_ID}', '${TASKS_TABLE_ID}',
             jsonb_build_object(${pairs}) || jsonb_build_object('${LINK_ID}',
               coalesce((SELECT jsonb_agg(l.to_id + ${COMPANY_ID_OFFSET} ORDER BY l.to_id)
                         FROM bench_a.l_k01 l WHERE l.from_id = t.id), '[]'::jsonb))
      FROM bench_a.tasks t ORDER BY t.id;
      INSERT INTO bench_b.records (id, workspace_id, table_id, data)
      SELECT c.id + ${COMPANY_ID_OFFSET}, '${WORKSPACE_ID}', '${COMPANIES_TABLE_ID}',
             jsonb_build_object('${fieldId('name')}', c.name, '${fieldId('rev')}', c.revenue,
                                '${fieldId('cty')}', c.country)
      FROM bench_a.companies c ORDER BY c.id;
      SELECT setval('bench_b.records_id_seq', ${rows});
    `);
  });

  log('B: building expression indexes');
  const bIndex = await timed(() =>
    db.query(`
      CREATE INDEX records_table ON bench_b.records (table_id, id);
      CREATE INDEX records_t01_trgm ON bench_b.records USING gin (${bx('t01')} gin_trgm_ops)
        WHERE ${B_TASKS};
      CREATE INDEX records_n01 ON bench_b.records (${bx('n01')}, id) WHERE ${B_TASKS};
      CREATE INDEX records_s01 ON bench_b.records (${bx('s01')}) WHERE ${B_TASKS};
      CREATE INDEX records_k01 ON bench_b.records USING gin ((data->'${LINK_ID}') jsonb_path_ops)
        WHERE ${B_TASKS};
    `)
  );

  log('VACUUM ANALYZE');
  const vacuum = await timed(() =>
    db.query('VACUUM ANALYZE bench_a.tasks, bench_a.companies, bench_a.l_k01, bench_b.records')
  );
  const junction = await one<{ n: string }>(db, 'SELECT count(*) AS n FROM bench_a.l_k01');

  return {
    aLoadMs: aLoad.ms,
    aIndexMs: aIndex.ms,
    bLoadMs: bLoad.ms,
    bIndexMs: bIndex.ms,
    vacuumMs: vacuum.ms,
    junctionRows: Number(junction.n),
  };
}

export interface StorageSizes {
  aTableBytes: number;
  aIndexBytes: number;
  aJunctionBytes: number;
  bTableBytes: number;
  bIndexBytes: number;
  aAvgRowBytes: number;
  bAvgRowBytes: number;
}

export async function storageSizes(db: Pool): Promise<StorageSizes> {
  const r = await one<Record<string, string>>(
    db,
    `SELECT
       pg_table_size('bench_a.tasks') + pg_table_size('bench_a.companies') AS a_table,
       pg_indexes_size('bench_a.tasks') + pg_indexes_size('bench_a.companies') AS a_index,
       pg_total_relation_size('bench_a.l_k01') AS a_junction,
       pg_table_size('bench_b.records') AS b_table,
       pg_indexes_size('bench_b.records') AS b_index,
       (SELECT avg(pg_column_size(t.*)) FROM bench_a.tasks t) AS a_row,
       (SELECT avg(pg_column_size(r.*)) FROM bench_b.records r WHERE ${B_TASKS}) AS b_row`
  );
  return {
    aTableBytes: Number(r['a_table']),
    aIndexBytes: Number(r['a_index']),
    aJunctionBytes: Number(r['a_junction']),
    bTableBytes: Number(r['b_table']),
    bIndexBytes: Number(r['b_index']),
    aAvgRowBytes: Math.round(Number(r['a_row'])),
    bAvgRowBytes: Math.round(Number(r['b_row'])),
  };
}
