import { describe, expect, it } from 'vitest';
import { AppError } from '../lib/errors.js';
import { ExportLimiter } from './routes.js';

describe('ExportLimiter', () => {
  it('allows `count` exports per user and window, then 429 until the window ends', () => {
    let now = 0;
    const limiter = new ExportLimiter({ count: 2, windowMs: 1000 }, () => now);
    limiter.take('a');
    limiter.take('a');
    limiter.take('b');
    let err: unknown;
    try {
      limiter.take('a');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('RATE_LIMITED');
    now = 1000;
    expect(() => limiter.take('a')).not.toThrow();
  });
});
