import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk, _enc, done) {
      lines.push(JSON.parse(String(chunk)));
      done();
    },
  });
  return { lines, logger: createLogger({ level: 'info', destination }) };
}

describe('createLogger', () => {
  it('writes one JSON object per line with level label and ISO time', () => {
    const { lines, logger } = capture();
    logger.info({ requestId: 'r1' }, 'hello');
    expect(lines[0]).toMatchObject({
      level: 'info',
      service: 'openrows-server',
      requestId: 'r1',
      msg: 'hello',
    });
    expect(String(lines[0]?.['time'])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('redacts secrets, cookies and auth headers', () => {
    const { lines, logger } = capture();
    logger.info({
      password: 'p',
      config: { encryptionKey: 'k', databaseUrl: 'postgres://u:p@h/db', port: 3000 },
      req: { headers: { authorization: 'Bearer x', cookie: 'openrows_session=abc', host: 'h' } },
    });
    const line = JSON.stringify(lines[0]);
    for (const secret of ['Bearer x', 'openrows_session', 'postgres://', '"k"', '"p"']) {
      expect(line).not.toContain(secret);
    }
    expect(lines[0]).toMatchObject({
      password: '[redacted]',
      config: { port: 3000, encryptionKey: '[redacted]' },
      req: { headers: { host: 'h', authorization: '[redacted]' } },
    });
  });

  it('respects the level', () => {
    const { lines, logger } = capture();
    logger.debug('hidden');
    expect(lines).toHaveLength(0);
  });
});
