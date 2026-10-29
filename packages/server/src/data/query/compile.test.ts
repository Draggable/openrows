import { type FieldTypeName, getFieldType } from '@openrows/shared';
import { type SQL, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  afterCursor,
  compileViewQuery,
  containsPattern,
  decodeCursor,
  encodeCursor,
  ID_KEY,
  type QueryField,
  QueryValidationError,
  todayIn,
} from './compile.js';

const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q);

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
const FIELDS = [text, num];

function errorsOf(fn: () => unknown) {
  try {
    fn();
  } catch (err) {
    if (err instanceof QueryValidationError) return err.errors;
    throw err;
  }
  throw new Error('expected a QueryValidationError');
}

describe('compileViewQuery', () => {
  it('binds values as parameters and takes identifiers only from field metadata', () => {
    const evil = "x'); DROP TABLE users; --";
    const q = compileViewQuery(
      {
        filter: {
          conjunction: 'or',
          conditions: [{ fieldId: text.id, operator: 'contains', value: evil }],
        },
        sorts: [{ fieldId: num.id, direction: 'desc' }],
        groupBy: [],
      },
      FIELDS
    );
    const where = render(q.where);
    expect(where.sql).not.toContain('DROP');
    expect(where.params).toContain(`%${evil}%`);
    expect(where.sql).toContain(`r."${text.dbColumn}"`);
    expect(q.keys).toHaveLength(2);
    expect(q.indexHints).toEqual([
      { fieldId: num.id, column: num.dbColumn, method: 'btree' },
      { fieldId: text.id, column: text.dbColumn, method: 'trgm' },
    ]);
  });

  it('refuses unknown field ids, unsupported operators and unsortable fields', () => {
    const other = '00000000-0000-4000-8000-0000000000ff';
    const errors = errorsOf(() =>
      compileViewQuery(
        {
          filter: {
            conjunction: 'and',
            conditions: [
              { fieldId: other, operator: 'is', value: 'x' },
              { fieldId: num.id, operator: 'contains', value: '1' },
            ],
          },
          sorts: [{ fieldId: field('attachment', 3).id, direction: 'asc' }],
          groupBy: [{ fieldId: other, direction: 'asc' }],
          fields: [other],
        },
        FIELDS
      )
    );
    expect(errors.map((e) => e.path)).toEqual([
      'query.fields.0',
      'query.filter.conditions.0.fieldId',
      'query.filter.conditions.1',
      'query.groupBy.0.fieldId',
      'query.sorts.0.fieldId',
    ]);
  });

  it('refuses a column name that is not a field column', () => {
    const bad = { ...text, dbColumn: 'id"; --' };
    expect(() =>
      compileViewQuery(
        {
          filter: { conjunction: 'and', conditions: [{ fieldId: bad.id, operator: 'isEmpty' }] },
          sorts: [],
          groupBy: [],
        },
        [bad]
      )
    ).toThrow(/invalid column/);
  });

  it('ignores blank values and refuses an unknown time zone', () => {
    const q = compileViewQuery(
      {
        filter: { conjunction: 'and', conditions: [{ fieldId: num.id, operator: '=', value: '' }] },
        sorts: [],
        groupBy: [],
      },
      FIELDS
    );
    expect(render(q.where).sql).toBe('r.deleted_at IS NULL');
    expect(
      errorsOf(() => compileViewQuery({ sorts: [], groupBy: [], timeZone: 'Mars/Base' }, FIELDS))
    ).toEqual([{ path: 'query.timeZone', message: 'Unknown time zone.' }]);
  });
});

describe('kanban stacks and manual order (#39)', () => {
  const manual = { expr: sql`p.position`, direction: 'asc' as const, cast: 'float8' as const };

  it('ands `within` conditions with the filter and checks them like the filter', () => {
    const q = compileViewQuery(
      {
        filter: {
          conjunction: 'or',
          conditions: [{ fieldId: text.id, operator: 'is', value: 'a' }],
        },
        within: [{ fieldId: num.id, operator: 'isEmpty' }],
        sorts: [],
        groupBy: [],
      },
      FIELDS
    );
    expect(render(q.where).sql).toMatch(/^r\.deleted_at IS NULL AND \(.+\) AND \(.+\)$/);
    expect(
      errorsOf(() =>
        compileViewQuery(
          {
            within: [{ fieldId: num.id, operator: 'contains', value: 'x' }],
            sorts: [],
            groupBy: [],
          },
          FIELDS
        )
      ).map((e) => e.path)
    ).toEqual(['query.within.conditions.0']);
  });

  it('orders by the manual order before the id, unless the query sorts', () => {
    const unsorted = compileViewQuery({ sorts: [], groupBy: [] }, FIELDS, { manualOrder: manual });
    expect(unsorted.keys).toEqual([manual, ID_KEY]);
    const sorted = compileViewQuery(
      { sorts: [{ fieldId: num.id, direction: 'asc' }], groupBy: [] },
      FIELDS,
      { manualOrder: manual }
    );
    expect(sorted.keys).not.toContain(manual);
    expect(sorted.keys).toHaveLength(2);
  });
});

describe('keyset cursors', () => {
  it('round-trips key values and refuses foreign shapes', () => {
    const c = encodeCursor(['10', null, 'abc']);
    expect(decodeCursor(c, 3)).toEqual(['10', null, 'abc']);
    expect(decodeCursor(c, 2)).toBeNull();
    expect(decodeCursor('not base64 json', 3)).toBeNull();
    expect(decodeCursor(encodeCursor([1 as unknown as string]), 1)).toBeNull();
  });

  it('casts cursor values to a fixed type list and binds them', () => {
    const q = render(afterCursor([ID_KEY], ['0190a000-0000-7000-8000-000000000000']));
    expect(q.sql).toBe('((r.id > $1::uuid))');
  });

  it('bounds an ascending first key, so a keyset page starts on the index (#72)', () => {
    const key = { expr: sql`lower(r.f)`, direction: 'asc' as const, cast: 'text' as const };
    const q = render(afterCursor([key, ID_KEY], ['m', '0190a000-0000-7000-8000-000000000000']));
    expect(q.sql).toBe(
      '(lower(r.f) >= $1::text AND ((lower(r.f) > $2::text) OR (lower(r.f) = $3::text AND r.id > $4::uuid)))'
    );
    const desc = render(afterCursor([{ ...key, direction: 'desc' }, ID_KEY], ['m', 'x']));
    expect(desc.sql).not.toContain('>=');
    const empty = render(afterCursor([key, ID_KEY], [null, 'x']));
    expect(empty.sql).not.toContain('>=');
  });
});

describe('helpers', () => {
  it('escapes LIKE wildcards', () => {
    expect(containsPattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });

  it("computes today's date in a zone", () => {
    const now = new Date('2024-01-01T03:00:00Z');
    expect(todayIn('UTC', now)).toBe('2024-01-01');
    expect(todayIn('America/New_York', now)).toBe('2023-12-31');
  });

  it('reads `me` as the signed-in user in user filters (#71)', () => {
    const by = field('createdBy', 3);
    const me = '0190a000-0000-7000-8000-00000000abcd';
    const where = (value: unknown, operator: 'is' | 'isAnyOf' | 'isNoneOf', userId?: string) =>
      render(
        compileViewQuery(
          {
            filter: { conjunction: 'and', conditions: [{ fieldId: by.id, operator, value }] },
            sorts: [],
            groupBy: [],
          },
          [by],
          { userId }
        ).where
      ).params;
    expect(where('me', 'is', me)).toContain(me);
    expect(where(['me', '0190a000-0000-7000-8000-000000000001'], 'isAnyOf', me)).toContain(
      JSON.stringify([me, '0190a000-0000-7000-8000-000000000001'])
    );
    // Without a user, `me` is nobody.
    expect(where('me', 'is')).toContain('00000000-0000-0000-0000-000000000000');
    expect(() => where('someone', 'is', me)).toThrow(QueryValidationError);
  });

  it('sorts and groups users by name, then id, so equal names never interleave (#71)', () => {
    const by = field('lastModifiedBy', 4);
    const q = compileViewQuery(
      {
        sorts: [{ fieldId: by.id, direction: 'desc' }],
        groupBy: [{ fieldId: by.id, direction: 'asc' }],
      },
      [by]
    );
    expect(q.keys.map((k) => [k.cast, k.direction])).toEqual([
      ['text', 'asc'],
      ['uuid', 'asc'],
      ['text', 'desc'],
      ['uuid', 'desc'],
      ['uuid', 'asc'],
    ]);
    expect(q.groups[0]?.keys).toHaveLength(2);
    const name = render(q.keys[0]?.expr as SQL).sql;
    expect(name).toContain('FROM users u');
    expect(name).toContain('workspace_members');
    expect(name).toContain('"updated_by"');
  });
});

describe('dateRange (#40)', () => {
  const day = field('date', 10);
  const end = field('date', 11);
  const at = field('dateTime', 12, { timeZone: 'America/New_York' });
  const RANGE_FIELDS = [text, day, end, at];
  const base = { sorts: [], groupBy: [] };

  it('matches ranges that meet the window, by day, in each field zone', () => {
    const q = compileViewQuery(
      {
        ...base,
        dateRange: {
          from: '2026-03-01',
          to: '2026-03-31',
          fields: [{ startFieldId: day.id, endFieldId: end.id }, { startFieldId: at.id }],
        },
      },
      RANGE_FIELDS
    );
    const { sql: text, params } = render(q.where);
    expect(text).toContain(`r."${day.dbColumn}" < $`);
    expect(text).toContain(`r."${end.dbColumn}" >= $`);
    expect(text).toContain('::date::timestamp AT TIME ZONE');
    expect(text).toContain(' OR ');
    expect(params).toEqual(
      expect.arrayContaining(['2026-04-01', '2026-03-01', 'America/New_York'])
    );
    expect(q.indexHints.map((h) => h.column)).toEqual(
      expect.arrayContaining([day.dbColumn, end.dbColumn, at.dbColumn])
    );
  });

  it('refuses non-date fields, unknown fields, reversed and overlong windows', () => {
    const errs = errorsOf(() =>
      compileViewQuery(
        {
          ...base,
          dateRange: {
            from: '2026-03-01',
            to: '2026-02-01',
            fields: [{ startFieldId: text.id, endFieldId: GONE_ID }],
          },
        },
        RANGE_FIELDS
      )
    );
    expect(errs.map((e) => e.path)).toEqual(['query.dateRange.to']);
    const fieldErrs = errorsOf(() =>
      compileViewQuery(
        {
          ...base,
          dateRange: {
            from: '2026-03-01',
            to: '2026-03-02',
            fields: [{ startFieldId: text.id, endFieldId: GONE_ID }],
          },
        },
        RANGE_FIELDS
      )
    );
    expect(fieldErrs.map((e) => e.path)).toEqual([
      'query.dateRange.fields.0.startFieldId',
      'query.dateRange.fields.0.endFieldId',
    ]);
    const long = errorsOf(() =>
      compileViewQuery(
        {
          ...base,
          dateRange: { from: '2026-01-01', to: '2027-12-31', fields: [{ startFieldId: day.id }] },
        },
        RANGE_FIELDS
      )
    );
    expect(long[0]?.message).toMatch(/at most/);
    const bad = errorsOf(() =>
      compileViewQuery(
        {
          ...base,
          dateRange: { from: '2026-02-30', to: '2026-03-01', fields: [{ startFieldId: day.id }] },
        },
        RANGE_FIELDS
      )
    );
    expect(bad.map((e) => e.path)).toEqual(['query.dateRange.from']);
  });
});

const GONE_ID = '00000000-0000-4000-8000-999999999999';
