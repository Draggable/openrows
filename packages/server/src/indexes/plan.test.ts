import { type FieldTypeName, getFieldType, type SavedViewQuery } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import type { QueryField } from '../data/query/compile.js';
import { filterIndexOf, indexName, planIndexes, sortKeyOf } from './plan.js';

function field(type: FieldTypeName, n: number, options: unknown = {}): QueryField {
  const def = getFieldType(type);
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return {
    id,
    name: type,
    type,
    dbColumn: `f_${id.replaceAll('-', '')}`,
    def,
    options: def.optionsSchema.parse(options),
  };
}

const text = field('singleLineText', 1);
const num = field('number', 2);
const date = field('dateTime', 3);
const check = field('checkbox', 4);
const select = field('singleSelect', 5, { choices: [{ id: 'a', name: 'A', color: 'green' }] });
const user = field('user', 6);
const lookup = field('lookup', 7);
const created = field('createdTime', 8);
const multi = field('multipleSelect', 9);
const long = field('longText', 10);
const FIELDS = [text, num, date, check, select, user, lookup, created, multi, long];

const sort = (f: QueryField, direction: 'asc' | 'desc' = 'asc') => ({ fieldId: f.id, direction });
const where = (...conditions: { fieldId: string; operator: string; value?: unknown }[]) =>
  ({ filter: { conjunction: 'and', conditions } }) as SavedViewQuery;
const ID = { column: 'id', fn: 'none', desc: false };

describe('sortKeyOf', () => {
  it('mirrors the compiler: lower(text), coalesce(checkbox), plain numbers and dates', () => {
    expect(sortKeyOf(text)).toEqual({ column: text.dbColumn, fn: 'lower' });
    expect(sortKeyOf(num)).toEqual({ column: num.dbColumn, fn: 'none' });
    expect(sortKeyOf(date)).toEqual({ column: date.dbColumn, fn: 'none' });
    expect(sortKeyOf(check)).toEqual({ column: check.dbColumn, fn: 'coalesce_false' });
    expect(sortKeyOf(created)).toEqual({ column: 'created_at', fn: 'none' });
  });

  it('refuses keys an index cannot hold: choice order, people names, lookups', () => {
    expect(sortKeyOf(select)).toBeNull();
    expect(sortKeyOf(multi)).toBeNull();
    expect(sortKeyOf(user)).toBeNull();
    expect(sortKeyOf(lookup)).toBeNull();
    // Long text can pass btree's entry size limit.
    expect(sortKeyOf(long)).toBeNull();
    expect(sortKeyOf({ ...text, dbColumn: 'f_x"; DROP' })).toBeNull();
  });
});

describe('filterIndexOf', () => {
  it('uses trigram for contains, lower() for text equality, the column for ranges', () => {
    expect(filterIndexOf(text, 'contains')).toEqual({
      method: 'trgm',
      key: { column: text.dbColumn, fn: 'none' },
    });
    expect(filterIndexOf(text, 'is')?.key.fn).toBe('lower');
    expect(filterIndexOf(num, '>')?.method).toBe('btree');
    expect(filterIndexOf(date, 'isBefore')?.method).toBe('btree');
    expect(filterIndexOf(select, 'isAnyOf')?.key.fn).toBe('none');
  });

  it('skips negations, emptiness and low-selectivity fields', () => {
    expect(filterIndexOf(text, 'doesNotContain')).toBeNull();
    expect(filterIndexOf(text, 'isNot')).toBeNull();
    expect(filterIndexOf(num, 'isEmpty')).toBeNull();
    expect(filterIndexOf(num, '!=')).toBeNull();
    expect(filterIndexOf(check, 'is')).toBeNull();
    expect(filterIndexOf(select, 'isNoneOf')).toBeNull();
    expect(filterIndexOf(user, 'is')).toBeNull();
    expect(filterIndexOf(long, 'is')).toBeNull();
    expect(filterIndexOf(long, 'contains')?.method).toBe('trgm');
  });
});

describe('indexName', () => {
  it('is stable, short and differs by direction and method', () => {
    const k = [{ column: num.dbColumn, fn: 'none' as const, desc: false }];
    expect(indexName('btree', k)).toMatch(/^i_[0-9a-f]{24}$/);
    expect(indexName('btree', k)).toBe(indexName('btree', [...k]));
    expect(indexName('btree', k)).not.toBe(indexName('btree', [{ ...k[0], desc: true }] as never));
    expect(indexName('btree', k)).not.toBe(indexName('trgm', k));
  });
});

describe('planIndexes', () => {
  it('plans nothing for views without filters, sorts or groups', () => {
    expect(planIndexes(FIELDS, [{}, {}])).toEqual([]);
  });

  it('indexes sort keys with the id, filters by operator, deduped across views', () => {
    const plan = planIndexes(FIELDS, [
      { sorts: [sort(num, 'desc')] },
      { sorts: [sort(num)], ...where({ fieldId: text.id, operator: 'contains', value: 'x' }) },
      where({ fieldId: num.id, operator: '>', value: 3 }),
    ]);
    const numSort = plan.find((p) => p.kind === 'sort');
    expect(numSort).toMatchObject({
      method: 'btree',
      keys: [{ column: num.dbColumn, fn: 'none', desc: false }, ID],
      views: 3,
    });
    expect(plan.filter((p) => p.kind === 'filter')).toEqual([
      expect.objectContaining({
        method: 'trgm',
        keys: [{ column: text.dbColumn, fn: 'none', desc: false }],
      }),
    ]);
    // The most used order (desc on the first view) becomes the keyset composite.
    expect(plan.filter((p) => p.kind === 'composite')).toEqual([
      expect.objectContaining({ keys: [{ column: num.dbColumn, fn: 'none', desc: true }, ID] }),
    ]);
  });

  it('builds the composite from group keys, then sorts, stopping at an unindexable key', () => {
    const [composite] = planIndexes(FIELDS, [
      { groupBy: [sort(check)], sorts: [sort(date, 'desc'), sort(text)] },
    ]).filter((p) => p.kind === 'composite');
    expect(composite?.keys).toEqual([
      { column: check.dbColumn, fn: 'coalesce_false', desc: false },
      { column: date.dbColumn, fn: 'none', desc: true },
      { column: text.dbColumn, fn: 'lower', desc: false },
      ID,
    ]);
    const [prefix] = planIndexes(FIELDS, [{ sorts: [sort(num), sort(select), sort(text)] }]).filter(
      (p) => p.kind === 'composite'
    );
    expect(prefix?.keys).toEqual([{ column: num.dbColumn, fn: 'none', desc: false }]);
    expect(
      planIndexes(FIELDS, [{ sorts: [sort(select)] }]).filter((p) => p.kind === 'composite')
    ).toEqual([]);
  });

  it('keeps to the per-table caps, most used first', () => {
    const many = Array.from({ length: 12 }, (_, i) => field('number', 100 + i));
    const queries: SavedViewQuery[] = many.map((f, i) => ({
      sorts: [sort(f)],
      ...(i > 0 ? where({ fieldId: many[0]?.id ?? '', operator: '>', value: 1 }) : {}),
    }));
    const plan = planIndexes(many, queries, { fields: 3, composites: 1 });
    expect(plan.filter((p) => p.kind !== 'composite')).toHaveLength(3);
    expect(plan[0]?.keys[0]?.column).toBe(many[0]?.dbColumn);
    expect(plan[0]?.views).toBe(12);
    expect(plan.filter((p) => p.kind === 'composite')).toHaveLength(1);
    expect(planIndexes(many, queries, { fields: 0, composites: 0 })).toEqual([]);
  });
});
