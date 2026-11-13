import type { SearchHit } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import { hitContext, hitTitle, recordSearchTerm } from './recordSearch';

const hit: SearchHit = {
  id: '0190a000-0000-7000-8000-000000000001',
  baseId: '0190a000-0000-7000-8000-000000000002',
  baseName: 'Sales',
  tableId: '0190a000-0000-7000-8000-000000000003',
  tableName: 'Contacts',
  name: 'Grace Hopper',
  matches: [
    { fieldId: '0190a000-0000-7000-8000-000000000004', fieldName: 'Notes', text: 'Knows Ada' },
    { fieldId: '0190a000-0000-7000-8000-000000000005', fieldName: 'Email', text: 'ada@x.test' },
  ],
};

describe('record search in the palette', () => {
  it('searches only trimmed queries of 3 to 200 characters', () => {
    expect(recordSearchTerm('')).toBeNull();
    expect(recordSearchTerm('  ad ')).toBeNull();
    expect(recordSearchTerm(' ada ')).toBe('ada');
    expect(recordSearchTerm('x'.repeat(200))).toBe('x'.repeat(200));
    expect(recordSearchTerm('x'.repeat(201))).toBeNull();
  });

  it('titles a hit by its primary field, and places it with its first other match', () => {
    expect(hitTitle(hit)).toBe('Grace Hopper');
    expect(hitTitle({ ...hit, name: '  ' })).toBe('Unnamed record');
    expect(hitContext(hit)).toEqual({ where: 'Sales › Contacts', match: 'Notes: Knows Ada' });
    expect(hitContext({ ...hit, matches: [] }).match).toBeNull();
  });
});
