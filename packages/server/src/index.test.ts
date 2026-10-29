import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ENTRY = fileURLToPath(new URL('./index.ts', import.meta.url));

describe('server entrypoint', () => {
  it('refuses to boot in production without secrets', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', ENTRY], {
      env: { PATH: process.env['PATH'], NODE_ENV: 'production', PORT: '0' },
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(result.status).toBe(1);
    const line = JSON.parse(result.stdout.trim().split('\n')[0] ?? '{}');
    expect(line).toMatchObject({ level: 'fatal', msg: 'invalid configuration, refusing to start' });
    expect(line.issues).toEqual(
      expect.arrayContaining([
        'ENCRYPTION_KEY: required in production',
        'DATABASE_URL: required in production',
      ])
    );
  }, 20_000);
});
