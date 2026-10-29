import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ENTRY = fileURLToPath(new URL('./worker.ts', import.meta.url));

describe('worker entrypoint', () => {
  it('starts without a database, reports unhealthy, and exits 0 on SIGTERM', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
      env: {
        PATH: process.env['PATH'],
        NODE_ENV: 'production',
        WORKER_PORT: '0',
        WORKER_HOST: '127.0.0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const started = new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk) => {
        out += String(chunk);
        if (out.includes('worker started')) resolve();
      });
    });
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    await started;

    const lines = () =>
      out
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    const startLine = lines().find((l) => l['msg'] === 'OpenRows worker started');
    expect(startLine).toMatchObject({ level: 'info', service: 'openrows-server', jobs: [] });
    const res = await fetch(`http://127.0.0.1:${String(startLine?.['port'])}/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'error' });

    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(lines().map((l) => l['msg'])).toEqual(
      expect.arrayContaining(['worker shutting down', 'worker stopped'])
    );
    expect(lines().find((l) => l['msg'] === 'worker shutting down')).toMatchObject({
      signal: 'SIGTERM',
    });
  }, 20_000);
});
