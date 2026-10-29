import type { FieldMeta, FormField } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import {
  addableFields,
  addField,
  conditionFields,
  formableFields,
  formEntries,
  labelOf,
  moveField,
  moveProblem,
  removeField,
} from './model';

const field = (id: string, type: string, extra: Partial<FieldMeta> = {}): FieldMeta =>
  ({
    id,
    tableId: 't',
    name: id.toUpperCase(),
    type,
    options: {},
    isPrimary: false,
    position: 0,
    description: null,
    deletedAt: null,
    ...extra,
  }) as FieldMeta;

const a = field('a', 'singleLineText');
const b = field('b', 'singleSelect', {
  options: { choices: [{ id: 'x', name: 'X', color: 'red' }] },
});
const c = field('c', 'longText');
const calc = field('calc', 'formula', { options: { formula: '1' } });
const name = field('name', 'singleLineText', { isPrimary: true });
const gone = field('gone', 'number', { deletedAt: '2026-10-26T00:00:00.000Z' });
const fields = [a, b, c, calc, name, gone];

const when = (fieldId: string) => ({
  conjunction: 'and' as const,
  conditions: [{ fieldId, operator: 'isNotEmpty' as const }],
});

describe('form builder model (#100)', () => {
  it('lists the fields a form can hold, primary first, and those not on it yet', () => {
    expect(formableFields(fields).map((f) => f.id)).toEqual(['name', 'a', 'b', 'c']);
    expect(addableFields({ fields: [{ fieldId: 'b' }] }, fields).map((f) => f.id)).toEqual([
      'name',
      'a',
      'c',
    ]);
    expect(
      formEntries(
        { fields: [{ fieldId: 'gone' }, { fieldId: 'calc' }, { fieldId: 'a' }] },
        fields
      ).map((e) => e.field.id)
    ).toEqual(['a']);
  });

  it('adds once, and removing a field drops the conditions that used it', () => {
    expect(addField([{ fieldId: 'a' }], 'a')).toEqual([{ fieldId: 'a' }]);
    expect(addField([{ fieldId: 'a' }], 'b')).toEqual([{ fieldId: 'a' }, { fieldId: 'b' }]);
    const list: FormField[] = [{ fieldId: 'a' }, { fieldId: 'b', condition: when('a') }];
    expect(removeField(list, 0, fields)).toEqual([{ fieldId: 'b', condition: null }]);
  });

  it('keeps a conditioned field below the fields its condition uses', () => {
    const list: FormField[] = [
      { fieldId: 'a' },
      { fieldId: 'b' },
      { fieldId: 'c', condition: when('a') },
    ];
    const nameOf = (id: string) => id.toUpperCase();
    expect(moveProblem(list, 2, 0, nameOf)).toBe('C shows depending on A, so it stays below it.');
    expect(moveProblem(list, 2, 1, nameOf)).toBeNull();
    expect(moveProblem(list, 0, 2, nameOf)).toBe('C shows depending on A, so it stays above it.');
    expect(moveProblem(list, 0, 1, nameOf)).toBeNull();
    expect(moveField(list, 0, 1).map((f) => f.fieldId)).toEqual(['b', 'a', 'c']);
    expect(moveField(list, 2, 1).map((f) => f.fieldId)).toEqual(['a', 'c', 'b']);
  });

  it('offers the fields above for conditions, and labels by override or name', () => {
    const list: FormField[] = [{ fieldId: 'a' }, { fieldId: 'b' }, { fieldId: 'c' }];
    expect(conditionFields(list, 2, fields).map((f) => f.id)).toEqual(['a', 'b']);
    expect(conditionFields(list, 0, fields)).toEqual([]);
    expect(labelOf({ fieldId: 'a', label: '  ' }, a)).toBe('A');
    expect(labelOf({ fieldId: 'a', label: 'Yours' }, a)).toBe('Yours');
  });
});
