/**
 * ADR-001 storage benchmark: physical per-table Postgres tables (A) vs one JSONB records table (B).
 * Starts a throwaway Postgres container (unless BENCH_DATABASE_URL is set), loads identical data
 * into both layouts, runs the suites and writes results/<date>-<rows>rows.{json,md}.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { config } from './config.js';
import { createPool, log, waitForDb } from './db.js';
import { runDdl } from './ddl.js';
import { type Container, startPostgres } from './docker.js';
import { runBackup, runCatalog, runRls, serverInfo } from './ops.js';
import { linkCases, readCases, runReadCases } from './reads.js';
import { type Results, renderMarkdown } from './report.js';
import { load, storageSizes } from './schema.js';
import { runWindows } from './windows.js';
import { runWrites } from './writes.js';

function dockerVersion(): string {
  try {
    return execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'n/a';
  }
}

async function main(): Promise<void> {
  const started = new Date();
  let container: Container | null = null;
  const cleanup = () => {
    if (container && !config.keep) {
      log(`Removing container ${container.name}`);
      container.remove();
      container = null;
    }
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });

  try {
    let url = config.databaseUrl;
    if (!url) {
      log(`Starting ${config.image}`);
      container = startPostgres(config.image);
      url = container.url;
    }
    await waitForDb(url);
    const db = createPool(url, config.concurrency + 8);
    const has = (s: (typeof config.suites)[number]) => config.suites.includes(s);

    const results: Results = {
      startedAt: started.toISOString(),
      durationSeconds: 0,
      machine: {
        cpu: os.cpus()[0]?.model ?? 'unknown',
        vcpus: os.cpus().length,
        memoryGiB: Math.round(os.totalmem() / 1024 ** 3),
        os: `${os.type()} ${os.release()}`,
        node: process.version,
        docker: dockerVersion(),
        postgresImage: container ? config.image : 'external (BENCH_DATABASE_URL)',
      },
      postgres: await serverInfo(db),
      config: {
        rows: config.rows,
        fields: 30,
        companies: config.companies,
        iterations: config.iterations,
        concurrency: config.concurrency,
        writeSeconds: config.writeSeconds,
        catalogTables: config.catalogTables,
        suites: config.suites,
      },
    };

    results.load = await load(db);
    results.storage = await storageSizes(db);
    if (has('reads')) results.reads = await runReadCases(db, 'reads', await readCases(db));
    if (has('links')) results.links = await runReadCases(db, 'links', linkCases());
    if (has('rls')) results.rls = await runRls(db, url);
    if (has('backup')) {
      if (container) results.backup = await runBackup(container);
      else log('backup: skipped (needs the bench container)');
    }
    if (has('writes')) results.writes = await runWrites(db);
    if (has('ddl')) results.ddl = await runDdl(db);
    if (has('catalog')) results.catalog = await runCatalog(db, url, container);
    if (has('windows')) results.windows = await runWindows(db);
    await db.end();

    results.durationSeconds = (Date.now() - started.getTime()) / 1000;
    mkdirSync(config.outDir, { recursive: true });
    const base = join(config.outDir, `${started.toISOString().slice(0, 10)}-${config.rows}rows`);
    writeFileSync(`${base}.json`, `${JSON.stringify(results, null, 2)}\n`);
    writeFileSync(`${base}.md`, renderMarkdown(results));
    log(`Wrote ${base}.md and ${base}.json in ${Math.round(results.durationSeconds)} s`);
  } finally {
    cleanup();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
