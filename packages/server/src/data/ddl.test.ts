import { describe, expect, it } from 'vitest';
import type { Transaction } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import { createRecordTable, physicalName } from './ddl.js';

const failingTx = (err: unknown) =>
  ({
    execute: async () => {
      throw err;
    },
  }) as unknown as Transaction;

describe('DDL manager', () => {
  it('derives physical names from ids (ADR-001)', () => {
    const id = '01a17497-64f7-7c91-83fb-5bdd359e8f46';
    expect(physicalName.schema(id)).toBe('b_01a1749764f77c9183fb5bdd359e8f46');
    expect(physicalName.table(id)).toMatch(/^t_[0-9a-f]{32}$/);
    expect(physicalName.column(id)).toMatch(/^f_[0-9a-f]{32}$/);
  });

  it('turns an expired lock_timeout into a 503, also when wrapped', async () => {
    const lock = Object.assign(new Error('canceling statement due to lock timeout'), {
      code: '55P03',
    });
    const wrapped = new Error('Failed query', { cause: lock });
    await expect(createRecordTable(failingTx(wrapped), 'x')).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      status: 503,
    });
    await expect(createRecordTable(failingTx(wrapped), 'x')).rejects.toBeInstanceOf(AppError);
  });

  it('passes other database errors through', async () => {
    const other = Object.assign(new Error('boom'), { code: '42501' });
    await expect(createRecordTable(failingTx(other), 'x')).rejects.toBe(other);
  });
});
