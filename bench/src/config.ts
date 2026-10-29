/** Benchmark settings, all overridable through environment variables (see bench/README.md). */

export const SUITES = [
  'reads',
  'links',
  'rls',
  'backup',
  'writes',
  'ddl',
  'catalog',
  'windows',
] as const;
export type Suite = (typeof SUITES)[number];

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw.replaceAll('_', ''));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function suites(): Suite[] {
  const raw = process.env['BENCH_SUITES'];
  if (!raw) return [...SUITES];
  const picked = raw.split(',').map((s) => s.trim());
  for (const s of picked) {
    if (!(SUITES as readonly string[]).includes(s)) throw new Error(`Unknown suite "${s}"`);
  }
  return picked as Suite[];
}

export const config = {
  /** Rows in the main user table (30 fields). */
  rows: int('BENCH_ROWS', 500_000),
  /** Rows in the linked "companies" table. */
  companies: int('BENCH_COMPANIES', 10_000),
  /** Timed iterations per read query (after one warm-up run). */
  iterations: int('BENCH_ITERATIONS', 7),
  /** Concurrent clients in the write suite. */
  concurrency: int('BENCH_CONCURRENCY', 16),
  /** Seconds per write scenario. */
  writeSeconds: int('BENCH_WRITE_SECONDS', 8),
  /** User tables created by the catalog (multi-tenant) suite. */
  catalogTables: int('BENCH_CATALOG_TABLES', 5_000),
  /** Use an existing database instead of starting a container. Backup suite is then skipped. */
  databaseUrl: process.env['BENCH_DATABASE_URL'],
  image: process.env['BENCH_PG_IMAGE'] ?? 'postgres:16-alpine',
  /** Keep the container after the run (for poking at it with psql). */
  keep: process.env['BENCH_KEEP'] === '1',
  suites: suites(),
  outDir: process.env['BENCH_OUT'] ?? 'results',
};
