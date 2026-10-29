import { describe, expect, it } from 'vitest';
import { DependencyGraph, type GraphField } from './graph.js';

const T = '0190f5a2-7b3c-7d4e-8f00-000000000001';
const P = '0190f5a2-7b3c-7d4e-8f00-000000000002';
const link = (id: string, tableId: string, linkedTableId: string): GraphField => ({
  id,
  tableId,
  type: 'link',
  options: { linkedTableId },
});
const lookup = (id: string, tableId: string, via: string, source: string): GraphField => ({
  id,
  tableId,
  type: 'lookup',
  options: { recordLinkFieldId: via, fieldIdInLinkedTable: source },
});

const base: GraphField[] = [
  { id: 'name', tableId: T, type: 'singleLineText', options: {} },
  link('project', T, P),
  link('tasks', P, T),
  lookup('names', P, 'tasks', 'name'),
  lookup('siblings', T, 'project', 'names'),
  { id: 'n', tableId: P, type: 'count', options: { recordLinkFieldId: 'tasks' } },
];

describe('DependencyGraph (#35)', () => {
  it('resolves computed fields and orders them after what they read', () => {
    const g = new DependencyGraph(base);
    expect([...g.nodes.keys()].sort()).toEqual(['n', 'names', 'siblings']);
    expect(g.directDependents('tasks').sort()).toEqual(['n', 'names']);
    expect(g.downstream(['name'])).toEqual(['names', 'siblings']);
    const order = g.order();
    expect(order.indexOf('names')).toBeLessThan(order.indexOf('siblings'));
  });

  it('leaves out computed fields whose link or source is missing or elsewhere', () => {
    const g = new DependencyGraph([
      ...base,
      lookup('bad1', P, 'project', 'name'),
      lookup('bad2', P, 'tasks', 'n'),
      { id: 'bad3', tableId: P, type: 'count', options: {} },
    ]);
    expect(g.nodes.has('bad1')).toBe(false);
    expect(g.nodes.has('bad2')).toBe(false);
    expect(g.nodes.has('bad3')).toBe(false);
  });

  it('finds the cycle a reconfigured field would close', () => {
    const g = new DependencyGraph(base);
    expect(g.cycleThrough(lookup('names', P, 'tasks', 'siblings'))).toEqual([
      'names',
      'siblings',
      'names',
    ]);
    expect(g.cycleThrough(lookup('names', P, 'tasks', 'name'))).toBeNull();
    expect(g.cycleThrough(lookup('new', P, 'tasks', 'siblings'))).toBeNull();
  });
});

describe('DependencyGraph formulas (#37)', () => {
  const formula = (id: string, tableId: string, text: string): GraphField => ({
    id,
    tableId,
    type: 'formula',
    options: { formula: text },
  });
  const fields: GraphField[] = [
    ...base,
    formula('label', T, '{name} & ": " & {siblings}'),
    formula('shout', T, 'UPPER({label})'),
    formula('total', P, '{n} * 2'),
    // References outside the table are ignored; unreadable formulas are left out.
    formula('foreign', P, '{name}'),
    formula('broken', T, '1 +'),
  ];

  it('orders formulas after the computed fields they read, across lookups', () => {
    const g = new DependencyGraph(fields);
    expect([...g.formulas.keys()].sort()).toEqual(['foreign', 'label', 'shout', 'total']);
    expect(g.formulas.get('foreign')?.deps).toEqual([]);
    expect(g.has('broken')).toBe(false);
    expect(g.downstream(['name'])).toEqual(['names', 'siblings', 'label', 'shout']);
    expect(g.downstream(['tasks'])).toEqual(expect.arrayContaining(['n', 'total']));
    const order = g.order();
    expect(order.indexOf('siblings')).toBeLessThan(order.indexOf('label'));
    expect(order.indexOf('label')).toBeLessThan(order.indexOf('shout'));
  });

  it('finds cycles through formulas and lookups', () => {
    const g = new DependencyGraph(fields);
    expect(g.cycleThrough(formula('label', T, '{shout}'))).toEqual(['label', 'shout', 'label']);
    expect(g.cycleThrough(formula('self', T, '{self} + 1'))).toEqual(['self', 'self']);
    // names (P) reads label (T) through the link, label reads siblings, siblings reads names.
    expect(g.cycleThrough(lookup('names', P, 'tasks', 'label'))).toEqual([
      'names',
      'label',
      'siblings',
      'names',
    ]);
    expect(g.cycleThrough(formula('label', T, '{name}'))).toBeNull();
  });

  it('marks formulas that read the clock, and zoned ones (#86)', () => {
    const formula = (id: string, text: string): GraphField => ({
      id,
      tableId: T,
      type: 'formula',
      options: { formula: text },
    });
    const g = new DependencyGraph([
      ...base,
      formula('now', 'NOW()'),
      formula('today', 'DATETIME_DIFF(TODAY(), {name}, "days")'),
      formula('zoned', 'DATETIME_FORMAT(SET_TIMEZONE(NOW(), "Asia/Kolkata"), "YYYY-MM-DD")'),
      formula('plain', 'UPPER({name})'),
      formula('literal', '"NOW()"'),
    ]);
    expect(g.formulas.get('now')?.clock).toEqual({ zoned: false });
    expect(g.formulas.get('today')?.clock).toEqual({ zoned: false });
    expect(g.formulas.get('zoned')?.clock).toEqual({ zoned: true });
    expect(g.formulas.get('plain')?.clock).toBeNull();
    expect(g.formulas.get('literal')?.clock).toBeNull();
  });
});
