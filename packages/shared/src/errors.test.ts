import { describe, expect, it } from 'vitest';
import { ERROR_CATALOG, ERROR_CODES, ProblemDetailsSchema, problemType } from './errors.js';

describe('error catalog', () => {
  it('uses UPPER_SNAKE_CASE codes with error statuses', () => {
    for (const code of ERROR_CODES) {
      expect(code).toMatch(/^[A-Z]+(_[A-Z]+)*$/);
      expect(ERROR_CATALOG[code].status).toBeGreaterThanOrEqual(400);
      expect(ERROR_CATALOG[code].status).toBeLessThan(600);
    }
  });

  it('builds a stable type URI per code', () => {
    expect(problemType('NOT_FOUND')).toBe('https://openrows.io/problems/not-found');
    expect(new Set(ERROR_CODES.map(problemType)).size).toBe(ERROR_CODES.length);
  });

  it('parses a problem body and keeps extension members', () => {
    const body = {
      type: problemType('NOT_READY'),
      title: 'Service not ready',
      status: 503,
      code: 'NOT_READY',
      requestId: 'abc',
      checks: { database: { status: 'error' } },
    };
    expect(ProblemDetailsSchema.parse(body)).toEqual(body);
  });

  it('rejects unknown codes and bodies without a request id', () => {
    const base = { type: 'x', title: 'x', status: 500, requestId: 'r', code: 'INTERNAL_ERROR' };
    expect(ProblemDetailsSchema.safeParse(base).success).toBe(true);
    expect(ProblemDetailsSchema.safeParse({ ...base, code: 'NOPE' }).success).toBe(false);
    const { requestId: _, ...noId } = base;
    expect(ProblemDetailsSchema.safeParse(noId).success).toBe(false);
  });
});
