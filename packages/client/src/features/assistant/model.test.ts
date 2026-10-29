import type { AssistantPlan } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import { changeCount, initialSelection, planRows, selectedPlan } from './model';

const field = (name: string, type: string, extra: Record<string, unknown> = {}) => ({
  name,
  type: type as 'singleLineText',
  description: null,
  choices: null,
  formula: null,
  linkedTable: null,
  ...extra,
});

const plan: AssistantPlan = {
  summary: 'Customers and a total.',
  baseName: null,
  operations: [
    {
      op: 'createTable',
      name: 'Customers',
      description: null,
      fields: [
        field('Company', 'singleLineText'),
        field('Tier', 'singleSelect', { choices: ['Gold', 'Silver'] }),
      ],
    },
    {
      op: 'createField',
      table: 'Orders',
      field: field('Total', 'formula', { formula: '{Qty} * {Price}' }),
    },
    { op: 'createView', table: 'Orders', name: 'Board', type: 'kanban', field: 'Status' },
    {
      op: 'createAutomation',
      table: 'Orders',
      name: 'Notify',
      trigger: 'recordUpdated',
      watchFields: ['Status'],
      actions: [{ type: 'sendEmail', to: ['ops@example.com'], subject: 'Changed', body: '' }],
    },
  ],
};

describe('assistant model', () => {
  it('describes each operation as a diff row', () => {
    const rows = planRows(plan, [
      { operation: 1, field: 'Total', kind: 'formula', message: 'Unknown field {Price}.' },
    ]);
    expect(rows.map((r) => [r.kind, r.title])).toEqual([
      ['table', 'Table Customers'],
      ['field', 'Field Total in Orders'],
      ['view', 'Kanban view Board in Orders'],
      ['automation', 'Automation Notify (off)'],
    ]);
    expect(rows[0]?.details).toEqual([
      'Company: Single line text (primary)',
      'Tier: Single select (Gold, Silver)',
    ]);
    expect(rows[1]?.details).toEqual(['Total: Formula = {Qty} * {Price}']);
    expect(rows[1]?.problems).toEqual(['Unknown field {Price}.']);
    expect(rows[3]?.details).toEqual([
      'When a record is updated in Orders (Status)',
      'Send an email to ops@example.com: Changed',
    ]);
  });

  it('ticks operations without problems and sends only the ticked ones', () => {
    const selected = initialSelection(plan, [
      { operation: 1, field: null, kind: 'formula', message: 'x' },
    ]);
    expect([...selected]).toEqual([0, 2, 3]);
    selected.delete(3);
    expect(selectedPlan(plan, selected).operations.map((o) => o.op)).toEqual([
      'createTable',
      'createView',
    ]);
    expect(changeCount(1)).toBe('1 change');
    expect(changeCount(3)).toBe('3 changes');
  });
});
