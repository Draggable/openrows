import { describe, expect, it } from 'vitest';
import { AppError } from '../lib/errors.js';
import { equalsPredicate, type FilterField, formulaPredicate } from './formula-filter.js';

const FIELDS: FilterField[] = [
  { id: '00000000-0000-7000-8000-000000000001', name: 'Name', type: 'singleLineText' },
  { id: '00000000-0000-7000-8000-000000000002', name: 'Points', type: 'number' },
  { id: '00000000-0000-7000-8000-000000000003', name: 'Done', type: 'checkbox' },
  { id: '00000000-0000-7000-8000-000000000004', name: 'Due', type: 'date' },
  { id: '00000000-0000-7000-8000-000000000005', name: 'Status', type: 'singleSelect' },
  { id: '00000000-0000-7000-8000-000000000006', name: 'Tags', type: 'multipleSelect' },
];
const [name, points, done, due, status, tags] = FIELDS.map((f) => f.id);

const cond = (fieldId: string | undefined, operator: string, value?: unknown) => ({
  kind: 'condition',
  condition: { fieldId, operator, ...(value === undefined ? {} : { value }) },
});
const translate = (formula: string) => formulaPredicate(formula, FIELDS);

function refusal(formula: string): string {
  try {
    translate(formula);
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('INVALID_FILTER_BY_FORMULA');
    return (err as AppError).detail ?? '';
  }
  throw new Error(`${formula} was translated`);
}

describe('filterByFormula → conditions (#103)', () => {
  it('translates comparisons with each type’s operator', () => {
    expect(translate("{Name} = 'Alpha'")).toEqual(cond(name, 'is', 'Alpha'));
    expect(translate('{Points} >= 3')).toEqual(cond(points, '>=', 3));
    expect(translate('3 < {Points}')).toEqual(cond(points, '>', 3));
    expect(translate('{Points} = -2')).toEqual(cond(points, '=', -2));
    expect(translate("{Due} < '2026-01-31'")).toEqual(cond(due, 'isBefore', '2026-01-31'));
    expect(translate('{Due} = TODAY()')).toEqual(cond(due, 'is', 'today'));
    expect(translate("IS_AFTER({Due}, '2026-01-01')")).toEqual(cond(due, 'isAfter', '2026-01-01'));
    expect(translate("IS_SAME({Due}, '2026-01-01', 'day')")).toEqual(cond(due, 'is', '2026-01-01'));
    expect(translate("{Status} != 'Done'")).toEqual(cond(status, 'isNot', 'Done'));
    expect(translate("{Tags} = 'a'")).toEqual(cond(tags, 'isExactly', 'a'));
  });

  it('reads blanks, checkboxes and bare fields', () => {
    expect(translate("{Name} = ''")).toEqual(cond(name, 'isEmpty'));
    expect(translate('{Name} != BLANK()')).toEqual(cond(name, 'isNotEmpty'));
    expect(translate('{Name}')).toEqual(cond(name, 'isNotEmpty'));
    expect(translate('Done')).toEqual(cond(done, 'is', true));
    expect(translate('{Done} = 0')).toEqual(cond(done, 'is', false));
    expect(translate('{Done} = TRUE()')).toEqual(cond(done, 'is', true));
    expect(translate('{Done} != TRUE()')).toEqual(cond(done, 'is', false));
  });

  it('nests AND, OR and NOT and reads FIND, SEARCH and RECORD_ID', () => {
    expect(translate("AND({Points} > 1, OR(NOT({Done}), FIND('x', {Name})))")).toEqual({
      kind: 'and',
      items: [
        cond(points, '>', 1),
        {
          kind: 'or',
          items: [{ kind: 'not', item: cond(done, 'is', true) }, cond(name, 'contains', 'x')],
        },
      ],
    });
    expect(translate("SEARCH('x', {Name}) = 0")).toEqual({
      kind: 'not',
      item: cond(name, 'contains', 'x'),
    });
    expect(translate("RECORD_ID() = 'abc'")).toEqual({ kind: 'recordIds', ids: ['abc'] });
    expect(translate('TRUE()')).toEqual({ kind: 'constant', value: true });
    expect(translate('0')).toEqual({ kind: 'constant', value: false });
  });

  it('refuses what has no SQL translation', () => {
    expect(refusal("LOWER({Name}) = 'a'")).toContain('LOWER() isn');
    expect(refusal('{Points} * 2 > 3')).toContain('compares a field with a value');
    expect(refusal('{Points} = {Points}')).toContain('compares a field with a value');
    expect(refusal('{Points} & "x"')).toContain('& operator');
    expect(refusal('-{Points}')).toContain('operator');
    expect(refusal("{Done} < 'x'")).toContain('"Done"');
    expect(refusal('{Name} = TODAY()')).toContain('TODAY()');
    expect(refusal("IS_SAME({Due}, '2026-01-01', 'month')")).toContain('by day');
    expect(refusal("IS_BEFORE({Name}, '2026-01-01')")).toContain('date field');
    expect(refusal('{Nope} = 1')).toContain('invalid');
    expect(refusal('AND(')).toContain('invalid');
    expect(refusal('AND()')).toContain('at least one');
  });

  it('builds the equality of an upsert merge', () => {
    expect(equalsPredicate(FIELDS[0] as FilterField, 'A')).toEqual(cond(name, 'is', 'A'));
    expect(equalsPredicate(FIELDS[1] as FilterField, null)).toEqual(cond(points, 'isEmpty'));
    expect(() => equalsPredicate(FIELDS[0] as FilterField, { a: 1 })).toThrow(AppError);
  });
});
