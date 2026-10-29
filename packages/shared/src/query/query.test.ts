import { describe, expect, it } from 'vitest';
import { pruneViewQuery, queryRecordsSchema, savedQueryOf, viewQuerySchema } from './index.js';

const id = '00000000-0000-4000-8000-000000000001';

describe('viewQuerySchema', () => {
  it('fills defaults and accepts one level of nested groups', () => {
    const q = viewQuerySchema.parse({
      filter: {
        conditions: [
          { fieldId: id, operator: 'is', value: 'x' },
          { conjunction: 'or', conditions: [{ fieldId: id, operator: 'isEmpty' }] },
        ],
      },
    });
    expect(q.sorts).toEqual([]);
    expect(q.groupBy).toEqual([]);
    expect(q.filter?.conjunction).toBe('and');
  });

  it('refuses deeper nesting, unknown operators, more than 3 group levels and extra keys', () => {
    const nested = { conditions: [{ conditions: [{ conditions: [] }] }] };
    expect(viewQuerySchema.safeParse({ filter: nested }).success).toBe(false);
    expect(
      viewQuerySchema.safeParse({
        filter: { conditions: [{ fieldId: id, operator: 'like', value: 'x' }] },
      }).success
    ).toBe(false);
    expect(
      viewQuerySchema.safeParse({
        groupBy: [{ fieldId: id }, { fieldId: id }, { fieldId: id }, { fieldId: id }],
      }).success
    ).toBe(false);
    expect(viewQuerySchema.safeParse({ sql: 'x' }).success).toBe(false);
  });
});

describe('queryRecordsSchema', () => {
  it('takes either an offset or a cursor', () => {
    expect(queryRecordsSchema.parse({ offset: 100 })).toMatchObject({ limit: 100, count: true });
    expect(queryRecordsSchema.safeParse({ offset: 0, cursor: 'x' }).success).toBe(false);
    expect(queryRecordsSchema.safeParse({ limit: 1001 }).success).toBe(false);
  });
});

describe('savedQueryOf and pruneViewQuery', () => {
  const other = '00000000-0000-4000-8000-000000000002';
  const gone = '00000000-0000-4000-8000-000000000003';

  it('reads the saved keys and ignores an unreadable config', () => {
    const sorts = [{ fieldId: id, direction: 'desc' as const }];
    expect(savedQueryOf({ sorts, grid: { rowHeight: 'tall' } })).toEqual({ sorts });
    expect(savedQueryOf({ sorts: 'nope' })).toEqual({});
    expect(savedQueryOf(undefined)).toEqual({});
  });

  it('drops entries of missing fields and operators the type no longer offers', () => {
    const fields = [
      { id, type: 'singleLineText' },
      { id: other, type: 'number' },
    ];
    const pruned = pruneViewQuery(
      {
        filter: {
          conjunction: 'or',
          conditions: [
            { fieldId: id, operator: 'contains', value: 'a' },
            { fieldId: other, operator: 'contains', value: 'a' },
            { fieldId: gone, operator: 'isEmpty' },
            { conjunction: 'and', conditions: [{ fieldId: gone, operator: 'isEmpty' }] },
            { conjunction: 'and', conditions: [{ fieldId: other, operator: '>', value: 1 }] },
          ],
        },
        sorts: [
          { fieldId: gone, direction: 'asc' },
          { fieldId: other, direction: 'desc' },
        ],
        groupBy: [{ fieldId: gone, direction: 'asc' }],
      },
      fields
    );
    expect(pruned).toEqual({
      filter: {
        conjunction: 'or',
        conditions: [
          { fieldId: id, operator: 'contains', value: 'a' },
          { conjunction: 'and', conditions: [{ fieldId: other, operator: '>', value: 1 }] },
        ],
      },
      sorts: [{ fieldId: other, direction: 'desc' }],
      groupBy: [],
    });
  });
});
