import { describe, expect, it } from 'vitest';
import { checkFormulaSuggestion, checkPlan } from './check.js';
import { type AssistantPlan, assistantPlanOutputSchema, assistantPlanSchema } from './plan.js';

const field = (name: string, type: string, extra: Record<string, unknown> = {}) => ({
  name,
  type,
  description: null,
  choices: null,
  formula: null,
  linkedTable: null,
  ...extra,
});

const base = {
  tables: [
    {
      name: 'Orders',
      fields: [
        { name: 'Name', type: 'singleLineText' },
        { name: 'Qty', type: 'number' },
        { name: 'Price', type: 'currency' },
        { name: 'Status', type: 'singleSelect' },
      ],
    },
  ],
};

function plan(operations: unknown[]): AssistantPlan {
  return assistantPlanSchema.parse({ summary: 's', baseName: null, operations });
}

describe('assistant plans', () => {
  it('accepts a plan of every operation and caps sizes', () => {
    const p = plan([
      {
        op: 'createTable',
        name: 'Customers',
        description: null,
        fields: [
          field('Name', 'singleLineText'),
          field('Orders', 'link', { linkedTable: 'Orders' }),
        ],
      },
      {
        op: 'createField',
        table: 'Orders',
        field: field('Total', 'formula', { formula: '{Qty} * {Price}' }),
      },
      { op: 'createView', table: 'Orders', name: 'By status', type: 'kanban', field: 'Status' },
      {
        op: 'createAutomation',
        table: 'Orders',
        name: 'Notify',
        trigger: 'recordUpdated',
        watchFields: ['Status'],
        actions: [
          {
            type: 'sendEmail',
            to: ['ops@example.com'],
            subject: 'Hi',
            body: '{{trigger.record.fields.Name}}',
          },
          { type: 'updateRecord', cells: [{ field: 'Qty', value: '1' }] },
        ],
      },
    ]);
    expect(checkPlan(p, base)).toEqual([]);
    expect(() =>
      plan(
        Array.from({ length: 41 }, () => ({
          op: 'createField',
          table: 'Orders',
          field: field('X', 'number'),
        }))
      )
    ).toThrow();
    // The provider's schema has no caps, the request's does.
    const long = {
      summary: 's',
      baseName: null,
      operations: [{ op: 'createField', table: 'x'.repeat(200), field: field('A', 'number') }],
    };
    expect(assistantPlanOutputSchema.safeParse(long).success).toBe(true);
    expect(assistantPlanSchema.safeParse(long).success).toBe(false);
  });

  it('reports formulas that do not type-check, unknown references and taken names', () => {
    const p = plan([
      {
        op: 'createField',
        table: 'Orders',
        field: field('Bad', 'formula', { formula: '{Qty} * {Nope}' }),
      },
      {
        op: 'createField',
        table: 'Orders',
        field: field('Typed', 'formula', { formula: 'UPPER({Qty}, 2, 3)' }),
      },
      { op: 'createField', table: 'Ghosts', field: field('A', 'number') },
      { op: 'createField', table: 'Orders', field: field('qty', 'number') },
      { op: 'createView', table: 'Orders', name: 'Cal', type: 'calendar', field: 'Qty' },
      {
        op: 'createTable',
        name: 'orders',
        description: null,
        fields: [field('Name', 'singleLineText')],
      },
      {
        op: 'createTable',
        name: 'T',
        description: null,
        fields: [field('L', 'link', { linkedTable: 'Nowhere' })],
      },
    ]);
    const problems = checkPlan(p, base);
    expect(problems.map((x) => [x.operation, x.kind])).toEqual([
      [0, 'formula'],
      [1, 'formula'],
      [2, 'reference'],
      [3, 'name'],
      [4, 'type'],
      [5, 'name'],
      [6, 'type'],
      [6, 'reference'],
    ]);
  });

  it('checks formulas against fields created earlier in the plan', () => {
    const p = plan([
      {
        op: 'createField',
        table: 'Orders',
        field: field('Total', 'formula', { formula: '{Qty} * {Price}' }),
      },
      {
        op: 'createField',
        table: 'Orders',
        field: field('Big', 'formula', { formula: 'IF({Total} > 100, "yes", "no")' }),
      },
    ]);
    expect(checkPlan(p, base)).toEqual([]);
    expect(checkFormulaSuggestion('{Qty} &', base.tables[0]?.fields ?? []).ok).toBe(false);
    expect(checkFormulaSuggestion('LEN({Name})', base.tables[0]?.fields ?? [])).toEqual({
      ok: true,
      type: 'number',
    });
  });
});
