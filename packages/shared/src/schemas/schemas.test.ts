import { describe, expect, it } from 'vitest';
import {
  bulkUpdateRecordsSchema,
  createFieldSchema,
  createRecordsSchema,
  createTableSchema,
  FIELD_TYPE_NAMES,
  MAX_RECORDS_PER_REQUEST,
  updateBaseSchema,
  updateFieldSchema,
} from '../index.js';

describe('shared schemas (zod v4)', () => {
  it('accepts a field of every registry type', () => {
    for (const type of FIELD_TYPE_NAMES) {
      expect(createFieldSchema.safeParse({ name: 'F', type }).success, type).toBe(true);
    }
  });

  it('rejects an unknown field type and unknown keys', () => {
    expect(createFieldSchema.safeParse({ name: 'X', type: 'nope' }).success).toBe(false);
    expect(createFieldSchema.safeParse({ name: 'X', type: 'number', x: 1 }).success).toBe(false);
    expect(updateFieldSchema.safeParse({ type: 'single_select' }).success).toBe(false);
  });

  it('trims names and refuses blank ones', () => {
    expect(createTableSchema.parse({ name: '  Tasks ' })).toEqual({ name: 'Tasks' });
    expect(createTableSchema.safeParse({ name: '   ' }).success).toBe(false);
  });

  it('rejects a malformed uuid', () => {
    expect(
      bulkUpdateRecordsSchema.safeParse({ records: [{ id: 'nope', fields: {} }] }).success
    ).toBe(false);
  });

  it('accepts one record or a batch of up to 1,000, keyed by field id', () => {
    const fieldId = '0190a8b2-0000-7000-8000-000000000001';
    expect(createRecordsSchema.parse({ fields: { [fieldId]: 'x' } })).toEqual({
      fields: { [fieldId]: 'x' },
    });
    expect(createRecordsSchema.parse({ records: [{}] })).toEqual({ records: [{ fields: {} }] });
    const tooMany = Array.from({ length: MAX_RECORDS_PER_REQUEST + 1 }, () => ({}));
    expect(createRecordsSchema.safeParse({ records: tooMany }).success).toBe(false);
    expect(createRecordsSchema.safeParse({ fields: { Name: 'x' } }).success).toBe(false);
  });

  it('allows nulls to clear optional base properties', () => {
    expect(updateBaseSchema.parse({ description: null })).toEqual({ description: null });
  });
});
