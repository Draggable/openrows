import { FIELD_TYPE_NAMES, type FieldMeta, type FieldTypeName } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import {
  addChoice,
  cleanChoices,
  conversionPreview,
  copyName,
  defaultOptions,
  insertIntoOrder,
  insertPosition,
  missingComputedOption,
  moveChoice,
  nameTaken,
  optionsForType,
  problemMessages,
  removeChoice,
  typeGroups,
  updateChoice,
} from './model';

const field = (id: string, name: string, position: number, type: FieldTypeName = 'number') =>
  ({
    id,
    tableId: 't',
    name,
    description: null,
    type,
    options: {},
    isPrimary: position === 1,
    position,
    createdAt: '',
    updatedAt: '',
    deletedAt: null,
  }) satisfies FieldMeta;

const choices = [
  { id: 'a', name: 'Todo', color: 'green' as const },
  { id: 'b', name: 'Done', color: 'amber' as const },
];

describe('typeGroups', () => {
  it('lists every type once, grouped by category, but the sync-only "Sync source" (#154)', () => {
    const all = typeGroups().flatMap((g) => g.types);
    expect(all.sort()).toEqual([...FIELD_TYPE_NAMES].filter((t) => t !== 'syncSource').sort());
    expect(typeGroups()[0]?.label).toBe('Basic');
  });

  it('offers lookup, rollup and count under Computed, next to Formula (#82)', () => {
    const computed = typeGroups().find((g) => g.category === 'computed');
    expect(computed?.label).toBe('Computed');
    expect(computed?.types).toEqual(
      expect.arrayContaining(['lookup', 'rollup', 'count', 'formula'])
    );
  });

  it('filters by label, case-insensitively, and drops empty groups', () => {
    const groups = typeGroups('SELECT');
    expect(groups.map((g) => g.label)).toEqual(['Choice']);
    expect(groups[0]?.types).toEqual(['singleSelect', 'multipleSelect']);
    expect(typeGroups('nothing like this')).toEqual([]);
  });
});

describe('missingComputedOption', () => {
  const link = '01900000-0000-7000-8000-000000000001';
  const source = '01900000-0000-7000-8000-000000000002';
  it('asks for the link field, then for the linked field of a lookup or rollup', () => {
    expect(missingComputedOption('lookup', defaultOptions('lookup'))).toBe(
      'Pick a linked record field'
    );
    expect(missingComputedOption('rollup', { recordLinkFieldId: link })).toBe(
      'Pick a field of the linked table'
    );
    expect(
      missingComputedOption('rollup', { recordLinkFieldId: link, fieldIdInLinkedTable: source })
    ).toBeNull();
    expect(missingComputedOption('count', { recordLinkFieldId: link })).toBeNull();
    expect(missingComputedOption('singleLineText', {})).toBeNull();
  });
});

describe('problemMessages', () => {
  it("reads the server's 422 problems", () => {
    expect(
      problemMessages({ errors: [{ path: 'options', message: 'Circular reference.' }] })
    ).toEqual(['Circular reference.']);
    expect(problemMessages({ title: 'x' })).toEqual([]);
    expect(problemMessages(undefined)).toEqual([]);
  });
});

describe('optionsForType', () => {
  it('keeps the choices between the two selects and the precision between numbers', () => {
    expect(optionsForType('multipleSelect', { choices })).toEqual({ choices });
    expect(optionsForType('currency', { precision: 3, allowNegative: false })).toMatchObject({
      precision: 3,
      allowNegative: false,
      currencyCode: 'USD',
    });
  });

  it('falls back to the defaults for keys the new type reads differently', () => {
    expect(optionsForType('rating', { max: 99 })).toEqual({
      max: 5,
      icon: 'star',
      color: 'amber',
    });
    expect(optionsForType('singleLineText', { choices })).toEqual({});
  });
});

describe('conversionPreview', () => {
  it('counts the values a lossy conversion clears, lossy examples first', () => {
    const p = conversionPreview(
      { type: 'singleLineText', options: {} },
      { type: 'number', options: {} },
      ['12', 'abc', null, '', '7']
    );
    expect(p).toMatchObject({ sampled: 3, cleared: 1, changed: 0, computedTarget: false });
    expect(p.examples[0]).toEqual({ before: 'abc', after: '', cleared: true });
    expect(p.examples).toHaveLength(3);
  });

  it('counts changed values (rounding, dropped choices) apart from cleared ones', () => {
    const rounded = conversionPreview(
      { type: 'number', options: { precision: 2 } },
      { type: 'number', options: { precision: 0 } },
      [1.25, 3]
    );
    expect(rounded).toMatchObject({ sampled: 2, cleared: 0, changed: 1 });
    expect(rounded.examples[0]).toEqual({ before: '1.25', after: '1', cleared: false });

    const fewer = conversionPreview(
      { type: 'multipleSelect', options: { choices } },
      { type: 'singleSelect', options: { choices } },
      [['a', 'b'], ['b']]
    );
    expect(fewer).toMatchObject({ cleared: 0, changed: 1 });
  });

  it('finds no loss for a lossless change', () => {
    const p = conversionPreview(
      { type: 'singleLineText', options: {} },
      { type: 'longText', options: {} },
      ['one', 'two']
    );
    expect(p).toMatchObject({ sampled: 2, cleared: 0, changed: 0 });
  });

  it('clears values when a select choice in use is removed', () => {
    const p = conversionPreview(
      { type: 'singleSelect', options: { choices } },
      { type: 'singleSelect', options: { choices: removeChoice(choices, 'b') } },
      ['a', 'b']
    );
    expect(p).toMatchObject({ cleared: 1 });
  });

  it('flags computed targets: every stored value is discarded', () => {
    const p = conversionPreview(
      { type: 'singleLineText', options: {} },
      { type: 'createdTime', options: {} },
      ['x']
    );
    expect(p).toMatchObject({ computedTarget: true, cleared: 1 });
  });

  it('ignores unchecked checkboxes (their empty value)', () => {
    const p = conversionPreview(
      { type: 'checkbox', options: {} },
      { type: 'singleLineText', options: {} },
      [false, true]
    );
    expect(p.sampled).toBe(1);
  });
});

describe('names', () => {
  const fields = [field('1', 'Name', 1), field('2', 'Estimate', 2), field('3', 'Estimate copy', 3)];

  it('checks names case-insensitively, except for the field itself', () => {
    expect(nameTaken(' estimate ', fields)).toBe(true);
    expect(nameTaken('Estimate', fields, '2')).toBe(false);
  });

  it('numbers copies past the taken names', () => {
    expect(copyName('Name', fields)).toBe('Name copy');
    expect(copyName('Estimate', fields)).toBe('Estimate copy 2');
  });
});

describe('insert left and right', () => {
  const fields = [field('a', 'A', 1), field('b', 'B', 2), field('c', 'C', 4)];

  it('places the table position between the anchor and its neighbour', () => {
    expect(insertPosition(fields, 'b', 'right')).toBe(3);
    expect(insertPosition(fields, 'b', 'left')).toBe(1.5);
    expect(insertPosition(fields, 'c', 'right')).toBe(5);
    expect(insertPosition(fields, 'missing', 'left')).toBe(5);
  });

  it('places the new id next to the anchor in the view order', () => {
    expect(insertIntoOrder(['a', 'b', 'c'], 'n', 'b', 'left')).toEqual(['a', 'n', 'b', 'c']);
    expect(insertIntoOrder(['a', 'b', 'c'], 'n', 'c', 'right')).toEqual(['a', 'b', 'c', 'n']);
    expect(insertIntoOrder(['a'], 'n', 'zz', 'right')).toEqual(['a', 'n']);
  });
});

describe('choices', () => {
  it('adds with the next palette colour and a fresh id', () => {
    const next = addChoice(choices, 'Later');
    expect(next[2]).toMatchObject({ name: 'Later', color: 'blue' });
    expect(next[2]?.id).toMatch(/^sel[0-9a-f]{12}$/);
  });

  it('renames, recolours, reorders, removes and cleans', () => {
    expect(updateChoice(choices, 'a', { name: 'To do', color: 'red' })[0]).toEqual({
      id: 'a',
      name: 'To do',
      color: 'red',
    });
    expect(moveChoice(choices, 0, 1).map((c) => c.id)).toEqual(['b', 'a']);
    expect(moveChoice(choices, 1, -5).map((c) => c.id)).toEqual(['b', 'a']);
    expect(removeChoice(choices, 'a').map((c) => c.id)).toEqual(['b']);
    expect(cleanChoices([...choices, { id: 'c', name: '  ', color: 'red' }])).toEqual(choices);
  });
});
