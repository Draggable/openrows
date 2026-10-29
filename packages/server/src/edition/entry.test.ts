import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The core's own entry points with EDITION=cloud: they refuse to start, before they touch
// a database, because only the hosted edition's composition root brings its providers.
const server = resolve(import.meta.dirname, '..', '..');

function start(entry: string, env: Record<string, string>) {
  return spawnSync(process.execPath, ['--import', 'tsx', entry], {
    cwd: server,
    // A database nobody listens on: a start that got past the edition check would fail later.
    env: {
      PATH: process.env['PATH'] ?? '',
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      DATABASE_URL: 'postgresql://openrows_app:x@127.0.0.1:1/none',
      ...env,
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

describe.each(['src/index.ts', 'src/worker.ts'])('%s', (entry) => {
  it('refuses EDITION=cloud without the ee providers', () => {
    const run = start(entry, { EDITION: 'cloud' });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('refusing to start');
    expect(run.stdout).toContain('EDITION=cloud needs the hosted providers');
  }, 60_000);

  it('refuses an unknown EDITION', () => {
    const run = start(entry, { EDITION: 'enterprise' });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('EDITION');
  }, 60_000);
});
