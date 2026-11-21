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
  linkField: null,
  linkedField: null,
  aggregation: null,
  button: null,
  ai: null,
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
    {
      op: 'createView',
      table: 'Orders',
      name: 'Board',
      type: 'kanban',
      field: 'Status',
      endField: null,
    },
    {
      op: 'createAutomation',
      table: 'Orders',
      name: 'Notify',
      trigger: 'recordUpdated',
      watchFields: ['Status'],
      actions: [{ type: 'sendEmail', to: ['ops@example.com'], subject: 'Changed', body: '' }],
      filter: null,
      formView: null,
      buttonField: null,
      schedule: null,
    },
  ],
};

const automation = (extra: Record<string, unknown>) => ({
  op: 'createAutomation' as const,
  table: 'Orders',
  name: 'A',
  trigger: 'recordCreated' as const,
  watchFields: null,
  actions: [],
  filter: null,
  formView: null,
  buttonField: null,
  schedule: null,
  ...extra,
});

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

  it('describes the wider automation triggers and actions', () => {
    const wider = {
      summary: 's',
      baseName: null,
      operations: [
        automation({
          trigger: 'formSubmitted',
          formView: 'Intake',
          actions: [
            {
              type: 'findRecords',
              table: 'Orders',
              filter: {
                conjunction: 'and',
                conditions: [{ field: 'Status', operator: 'is', value: 'Open' }],
              },
              limit: null,
            },
            { type: 'updateRecord', step: 1, cells: [{ field: 'Notes', value: 'Seen' }] },
          ],
        }),
        automation({
          table: null,
          trigger: 'scheduled',
          schedule: { kind: 'cron', expression: '0 9 * * 1', timeZone: 'UTC' },
          actions: [
            {
              type: 'httpRequest',
              method: 'POST',
              url: 'https://example.com/hook',
              headers: [{ name: 'X-Source', value: 'base' }],
              body: '{}',
            },
          ],
        }),
        automation({ table: null, trigger: 'webhookReceived' }),
        automation({ trigger: 'buttonClicked', buttonField: 'Go' }),
        automation({
          trigger: 'recordMatches',
          filter: {
            conjunction: 'or',
            conditions: [
              { field: 'Qty', operator: '>', value: '10' },
              { field: 'Notes', operator: 'isEmpty', value: null },
            ],
          },
        }),
      ],
    } as AssistantPlan;
    expect(planRows(wider, []).map((r) => r.details)).toEqual([
      [
        'When the form Intake of Orders is submitted',
        'Find records in Orders: Status is Open',
        'Update the records step 1 found: Notes = Seen',
      ],
      ['On a schedule: 0 9 * * 1 (UTC)', 'Send POST https://example.com/hook (headers X-Source)'],
      ['When a webhook is received (its URL is shown once the automation exists)'],
      ['When the button Go in Orders is clicked'],
      ['When a record in Orders matches: Qty > 10 or Notes isEmpty'],
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

  it('describes lookups, rollups, counts, buttons, AI fields, timelines and lists', () => {
    const onCustomers = (f: ReturnType<typeof field>) => ({
      op: 'createField' as const,
      table: 'Customers',
      field: f,
    });
    const rows = planRows(
      {
        summary: 's',
        baseName: null,
        operations: [
          onCustomers(
            field('Qtys', 'lookup', { type: 'lookup', linkField: 'Orders', linkedField: 'Qty' })
          ),
          onCustomers(
            field('Spent', 'rollup', {
              type: 'rollup',
              linkField: 'Orders',
              linkedField: 'Price',
              aggregation: 'SUM',
            })
          ),
          onCustomers(field('Order count', 'count', { type: 'count', linkField: 'Orders' })),
          onCustomers(
            field('Site', 'button', {
              type: 'button',
              button: { label: 'Open', action: 'openUrl' },
              formula: '"https://example.com"',
            })
          ),
          onCustomers(
            field('Notify', 'button', {
              type: 'button',
              button: { label: 'Notify', action: 'runAutomation' },
            })
          ),
          onCustomers(
            field('Summary', 'ai', {
              type: 'ai',
              ai: { prompt: 'Summarize {Company}', output: 'summary' },
            })
          ),
          {
            op: 'createView',
            table: 'Orders',
            name: 'Plan',
            type: 'timeline',
            field: 'Ordered',
            endField: 'Shipped',
          },
          {
            op: 'createView',
            table: 'Tasks',
            name: 'Tree',
            type: 'list',
            field: 'Parent',
            endField: null,
          },
        ],
      },
      []
    );
    expect(rows.map((r) => r.details[0])).toEqual([
      'Qtys: Lookup ("Qty" through Orders)',
      'Spent: Rollup (SUM of "Price" through Orders)',
      'Order count: Count (records through Orders)',
      'Site: Button "Open" (opens a URL) = "https://example.com"',
      'Notify: Button "Notify" (runs automations)',
      'Summary: AI (answers summary): Summarize {Company}',
      'From Ordered to Shipped',
      'Nested by Parent',
    ]);
    expect(rows.slice(6).map((r) => r.title)).toEqual([
      'Timeline view Plan in Orders',
      'List view Tree in Tasks',
    ]);
  });
});
