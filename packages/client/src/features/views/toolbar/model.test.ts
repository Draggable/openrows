import type { FieldMeta, FilterGroup } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import {
  activeConditionCount,
  conditionCount,
  findMatches,
  groupHeaders,
  newCondition,
  operatorsFor,
  setEntry,
  valueInputFor,
  withOperator,
} from './model';

const field = (type: string, options: Record<string, unknown> = {}): FieldMeta =>
  ({
    id: `00000000-0000-4000-8000-${type.length.toString().padStart(12, '0')}`,
    tableId: '00000000-0000-4000-8000-000000000000',
    name: type,
    description: null,
    type,
    options,
    isPrimary: false,
    position: 1,
    createdAt: '2026-10-25T10:00:00.000Z',
    updatedAt: '2026-10-25T10:00:00.000Z',
  }) as FieldMeta;

describe('value inputs', () => {
  it('follows the registry per type and operator', () => {
    expect(valueInputFor(field('singleLineText'), 'contains')).toBe('text');
    expect(valueInputFor(field('singleLineText'), 'isEmpty')).toBe('none');
    expect(valueInputFor(field('number'), '>')).toBe('number');
    expect(valueInputFor(field('percent'), '=')).toBe('number');
    expect(valueInputFor(field('checkbox'), 'is')).toBe('boolean');
    expect(valueInputFor(field('date'), 'isBefore')).toBe('date');
    expect(valueInputFor(field('dateTime'), 'isWithin')).toBe('within');
    expect(valueInputFor(field('singleSelect'), 'is')).toBe('choice');
    expect(valueInputFor(field('singleSelect'), 'isAnyOf')).toBe('choices');
    expect(valueInputFor(field('multipleSelect'), 'hasAllOf')).toBe('choices');
    expect(valueInputFor(field('createdBy'), 'is')).toBe('user');
    expect(valueInputFor(field('lastModifiedBy'), 'isNoneOf')).toBe('users');
    // Links: specific records, or text against the linked records' names.
    expect(valueInputFor(field('link'), 'hasAnyOf')).toBe('records');
    expect(valueInputFor(field('link'), 'hasNoneOf')).toBe('records');
    expect(valueInputFor(field('link'), 'contains')).toBe('text');
  });

  it('offers only operators the toolbar can fill', () => {
    expect(operatorsFor(field('createdBy'))).toEqual([
      'is',
      'isNot',
      'isAnyOf',
      'isNoneOf',
      'isEmpty',
      'isNotEmpty',
    ]);
    expect(operatorsFor(field('checkbox'))).toEqual(['is']);
    expect(newCondition(field('checkbox'))).toMatchObject({ operator: 'is', value: true });
  });

  it('keeps the value across operators with the same input only', () => {
    const f = field('singleLineText');
    const cond = { fieldId: f.id, operator: 'contains' as const, value: 'x' };
    expect(withOperator(f, cond, 'is')).toEqual({ ...cond, operator: 'is' });
    expect(withOperator(f, cond, 'isEmpty')).toEqual({ fieldId: f.id, operator: 'isEmpty' });
  });
});

describe('the filter tree', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const filter: FilterGroup = {
    conjunction: 'and',
    conditions: [
      { fieldId: id, operator: 'contains', value: 'a' },
      { fieldId: id, operator: 'contains', value: ' ' },
      {
        conjunction: 'or',
        conditions: [
          { fieldId: id, operator: 'isEmpty' },
          { fieldId: id, operator: 'is' },
        ],
      },
    ],
  };

  it('counts conditions and the complete ones', () => {
    expect(conditionCount(filter)).toBe(4);
    expect(activeConditionCount(filter)).toBe(2);
    expect(activeConditionCount(undefined)).toBe(0);
  });

  it('replaces and removes entries; an emptied group goes away', () => {
    expect(setEntry(filter, 0, null).conditions).toHaveLength(2);
    expect(setEntry(filter, 2, { conjunction: 'or', conditions: [] }).conditions).toHaveLength(2);
  });
});

describe('groupHeaders', () => {
  it('puts headers above the first record of each group, with counts per level', () => {
    const headers = groupHeaders([
      { key: ['a', 1], count: 2 },
      { key: ['a', 2], count: 3 },
      { key: ['b', 1], count: 1 },
    ]);
    expect([...headers.keys()]).toEqual([0, 2, 5]);
    expect(headers.get(0)).toEqual([
      { level: 0, key: 'a', count: 5 },
      { level: 1, key: 1, count: 2 },
    ]);
    expect(headers.get(2)).toEqual([{ level: 1, key: 2, count: 3 }]);
    expect(headers.get(5)).toEqual([
      { level: 0, key: 'b', count: 1 },
      { level: 1, key: 1, count: 1 },
    ]);
  });

  it('handles one level and empty keys', () => {
    const headers = groupHeaders([
      { key: [null], count: 2 },
      { key: ['x'], count: 1 },
    ]);
    expect(headers.get(0)).toEqual([{ level: 0, key: null, count: 2 }]);
    expect(headers.get(2)).toEqual([{ level: 0, key: 'x', count: 1 }]);
  });
});

describe('findMatches', () => {
  it('returns the indexes of fields whose text contains the term, ignoring case', () => {
    const fields = [field('singleLineText'), field('number')];
    const text = (f: FieldMeta) => (f.type === 'number' ? '42' : 'Keyboard grid');
    expect(findMatches('GRID', fields, text)).toEqual([0]);
    expect(findMatches('4', fields, text)).toEqual([1]);
    expect(findMatches('  ', fields, text)).toEqual([]);
  });
});
