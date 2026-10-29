import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  computedSourceOf,
  lookupValue,
  type RollupFunction,
  rollupItems,
  rollupOptionsSchema,
  rollupValue,
} from './computed.js';
import { getFieldType } from './index.js';

const number = {
  def: getFieldType('number'),
  options: getFieldType('number').optionsSchema.parse({}),
};
const select = {
  def: getFieldType('multipleSelect'),
  options: getFieldType('multipleSelect').optionsSchema.parse({
    choices: [
      { id: 'selA', name: 'Todo', color: 'green' },
      { id: 'selB', name: 'Done', color: 'blue' },
    ],
  }),
};
const text = { def: getFieldType('singleLineText'), options: {} };
const fn = (f: RollupFunction, extra: object = {}) =>
  rollupOptionsSchema.parse({ function: f, ...extra });

describe('computed field values (#35)', () => {
  it('reads the link and source a computed field names', () => {
    expect(computedSourceOf('number', {})).toBeNull();
    expect(
      computedSourceOf('count', { recordLinkFieldId: 'l', fieldIdInLinkedTable: 's' })
    ).toEqual({ linkFieldId: 'l', sourceFieldId: null });
    expect(
      computedSourceOf('lookup', { recordLinkFieldId: 'l', fieldIdInLinkedTable: 's' })
    ).toEqual({ linkFieldId: 'l', sourceFieldId: 's' });
  });

  it('looks up display text in link order, list values flattened, empties skipped', () => {
    expect(lookupValue(text, ['a', null, 'b'])).toEqual(['a', 'b']);
    expect(lookupValue(select, [['selB', 'selA'], null, ['selA']])).toEqual([
      'Done',
      'Todo',
      'Todo',
    ]);
    expect(lookupValue(number, [1.5, 2])).toEqual(['2', '2']);
    expect(lookupValue(text, [])).toBeNull();
  });

  it('aggregates with Airtable semantics', () => {
    const items = rollupItems(number, [3, null, 5, 2]);
    expect(rollupValue(items, fn('SUM'))).toBe(10);
    expect(rollupValue(items, fn('AVG', { precision: 2 }))).toBe(3.33);
    expect(rollupValue(items, fn('MIN'))).toBe(2);
    expect(rollupValue(items, fn('MAX'))).toBe(5);
    expect(rollupValue(items, fn('COUNT'))).toBe(3);
    expect(rollupValue(items, fn('COUNTA'))).toBe(3);
    expect(rollupValue(items, fn('COUNTALL'))).toBe(4);
    expect(rollupValue(items, fn('AND'))).toBe(0);
    expect(rollupValue(items, fn('OR'))).toBe(1);
    expect(rollupValue(items, fn('XOR'))).toBe(1);
    expect(rollupValue(items, fn('ARRAYJOIN', { separator: '; ' }))).toBe('3; ; 5; 2');
    expect(rollupValue(items, fn('ARRAYCOMPACT'))).toBe('3, 5, 2');
    expect(rollupValue(rollupItems(text, ['a', 'b', 'a']), fn('ARRAYUNIQUE'))).toBe('a, b');
    expect(rollupValue(rollupItems(text, ['a', 'b']), fn('CONCATENATE'))).toBe('ab');
    expect(rollupValue(rollupItems(select, [['selA', 'selB'], ['selA']]), fn('COUNTALL'))).toBe(3);
  });

  it('gives Airtable results over no linked records', () => {
    expect(rollupValue([], fn('SUM'))).toBe(0);
    expect(rollupValue([], fn('AVG'))).toBeNull();
    expect(rollupValue([], fn('MAX'))).toBeNull();
    expect(rollupValue([], fn('COUNTALL'))).toBe(0);
    expect(rollupValue([], fn('ARRAYJOIN'))).toBeNull();
  });

  it('SUM, MIN and MAX agree with a reference over random numbers (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.option(fc.integer({ min: -1e6, max: 1e6 }))), (xs) => {
        const items = rollupItems(number, xs);
        const ns = xs.filter((x): x is number => x !== null);
        expect(rollupValue(items, fn('SUM'))).toBe(ns.reduce((a, b) => a + b, 0) || 0);
        expect(rollupValue(items, fn('MIN'))).toBe(ns.length ? Math.min(...ns) : null);
        expect(rollupValue(items, fn('MAX'))).toBe(ns.length ? Math.max(...ns) : null);
        expect(rollupValue(items, fn('COUNTALL'))).toBe(xs.length);
      })
    );
  });
});
