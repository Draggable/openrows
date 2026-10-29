import { describe, expect, it } from 'vitest';
import {
  listParamsFromQuery,
  v1CreateRecordsSchema,
  v1DeleteRecordsQuerySchema,
  v1ListQuerySchema,
  v1UpdateRecordsSchema,
} from './index.js';

const ID = '00000000-0000-7000-8000-000000000001';

describe('REST API v1 parameters (#103)', () => {
  it("reads Airtable's bracketed query string", () => {
    expect(
      listParamsFromQuery({
        'fields[]': ['Name', 'Points'],
        'sort[1][field]': ['Due'],
        'sort[0][field]': ['Points'],
        'sort[0][direction]': ['desc'],
        pageSize: ['10'],
      })
    ).toEqual({
      fields: ['Name', 'Points'],
      sort: [{ field: 'Points', direction: 'desc' }, { field: 'Due' }],
      pageSize: '10',
    });
    expect(v1ListQuerySchema.parse({ pageSize: ['20'], returnFieldsByFieldId: ['true'] })).toEqual({
      pageSize: 20,
      cellFormat: 'json',
      returnFieldsByFieldId: true,
    });
  });

  it('caps pages, batches and refuses unknown parameters', () => {
    expect(v1ListQuerySchema.safeParse({ pageSize: ['101'] }).success).toBe(false);
    expect(v1ListQuerySchema.safeParse({ limit: ['5'] }).success).toBe(false);
    const eleven = Array.from({ length: 11 }, () => ({ fields: {} }));
    expect(v1CreateRecordsSchema.safeParse({ records: eleven }).success).toBe(false);
    expect(v1CreateRecordsSchema.safeParse({ records: eleven.slice(1) }).success).toBe(true);
    expect(
      v1DeleteRecordsQuerySchema.safeParse({ 'records[]': Array.from({ length: 11 }, () => ID) })
        .success
    ).toBe(false);
    expect(v1DeleteRecordsQuerySchema.parse({ 'records[]': [ID] })).toEqual({ records: [ID] });
  });

  it('needs record ids on updates unless upserting', () => {
    expect(v1UpdateRecordsSchema.safeParse({ records: [{ fields: {} }] }).success).toBe(false);
    expect(
      v1UpdateRecordsSchema.safeParse({
        records: [{ fields: { Code: 'A' } }],
        performUpsert: { fieldsToMergeOn: ['Code'] },
      }).success
    ).toBe(true);
  });
});
