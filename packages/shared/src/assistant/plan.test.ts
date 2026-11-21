import { describe, expect, it } from 'vitest';
import { type AssistantBaseInfo, checkFormulaSuggestion, checkPlan } from './check.js';
import {
  type AssistantPlan,
  assistantPlanOutputSchema,
  assistantPlanSchema,
  MAX_PLAN_ACTIONS,
  MAX_PLAN_CONDITIONS,
  MAX_PLAN_OPERATIONS,
} from './plan.js';

const field = (name: string, type: string, extra: Record<string, unknown> = {}) => ({
  name,
  type,
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
      {
        op: 'createView',
        table: 'Orders',
        name: 'By status',
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
      {
        op: 'createView',
        table: 'Orders',
        name: 'Cal',
        type: 'calendar',
        field: 'Qty',
        endField: null,
      },
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

  it('keeps reading plans written before the newer keys', () => {
    const old = plan([
      {
        op: 'createField',
        table: 'Orders',
        field: {
          name: 'Note',
          type: 'longText',
          description: null,
          choices: null,
          formula: null,
          linkedTable: null,
        },
      },
      { op: 'createView', table: 'Orders', name: 'Board', type: 'kanban', field: 'Status' },
    ]);
    expect(old.operations[0]).toMatchObject({ field: { linkField: null, ai: null, button: null } });
    expect(old.operations[1]).toMatchObject({ endField: null });
    expect(checkPlan(old, base)).toEqual([]);
  });
});

/** A base with links both ways, dates and an AI field, for the newer field and view types. */
const linked = {
  tables: [
    {
      name: 'Orders',
      fields: [
        { name: 'Name', type: 'singleLineText' },
        { name: 'Qty', type: 'number' },
        { name: 'Price', type: 'currency' },
        { name: 'Status', type: 'singleSelect' },
        { name: 'Ordered', type: 'date' },
        { name: 'Shipped', type: 'dateTime' },
        { name: 'Customer', type: 'link', linkedTable: 'Customers' },
        { name: 'Blurb', type: 'ai', fromAi: true, numeric: false },
        { name: 'Shout', type: 'formula', resultType: 'text' as const, fromAi: true },
      ],
    },
    {
      name: 'Customers',
      fields: [
        { name: 'Company', type: 'singleLineText' },
        { name: 'Orders', type: 'link', linkedTable: 'Orders' },
      ],
    },
  ],
};

const lookup = (name: string, linkField: string | null, linkedField: string | null) =>
  field(name, 'lookup', { linkField, linkedField });
const rollup = (name: string, linkField: string, linkedField: string, aggregation: unknown) =>
  field(name, 'rollup', { linkField, linkedField, aggregation });
const onCustomers = (f: unknown) => ({ op: 'createField', table: 'Customers', field: f });
const onOrders = (f: unknown) => ({ op: 'createField', table: 'Orders', field: f });
const view = (type: string, f: string | null, endField: string | null = null) => ({
  op: 'createView',
  table: 'Orders',
  name: `${type} view`,
  type,
  field: f,
  endField,
});
const kinds = (p: AssistantPlan, b: AssistantBaseInfo = linked) =>
  checkPlan(p, b).map((x) => [x.operation, x.kind, x.field]);

describe('assistant plans: lookups, rollups, counts, buttons, AI fields, timelines and lists', () => {
  it('accepts every newer field and view type when it fits', () => {
    const p = plan([
      onCustomers(lookup('Quantities', 'Orders', 'Qty')),
      onCustomers(rollup('Spent', 'Orders', 'Price', 'SUM')),
      onCustomers(rollup('Names', 'Orders', 'Name', 'ARRAYJOIN')),
      onCustomers(field('Order count', 'count', { linkField: 'Orders' })),
      // A rollup of numbers looked up from the linked table.
      onOrders(lookup('Customer orders', 'Customer', 'Order count')),
      onCustomers(rollup('Most', 'Orders', 'Customer orders', 'MAX')),
      // A formula over a rollup made earlier in the plan.
      onCustomers(field('Big', 'formula', { formula: 'IF({Spent} > 100, "yes", "no")' })),
      onCustomers(
        field('Open', 'button', {
          button: { label: 'Open', action: 'openUrl' },
          formula: '"https://example.com/c/" & {Company}',
        })
      ),
      onCustomers(
        field('Notify', 'button', { button: { label: 'Notify', action: 'runAutomation' } })
      ),
      onCustomers(
        field('Summary', 'ai', { ai: { prompt: 'Summarize {Company}.', output: 'summary' } })
      ),
      onCustomers(
        field('Size', 'ai', {
          ai: { prompt: 'How big is {Company}?', output: 'singleSelect' },
          choices: ['Small', 'Large'],
        })
      ),
      // Through the inverse link a new link adds to the linked table.
      {
        op: 'createTable',
        name: 'Tasks',
        description: null,
        fields: [
          field('Title', 'singleLineText'),
          field('Parent', 'link', { linkedTable: 'Tasks' }),
          field('Order', 'link', { linkedTable: 'Orders' }),
          field('Due', 'date'),
          field('Done', 'dateTime'),
        ],
      },
      onOrders(lookup('Task titles', 'Tasks', 'Title')),
      view('timeline', 'Ordered', 'Shipped'),
      view('timeline', 'Ordered'),
      { ...view('list', 'Parent'), table: 'Tasks' },
      { ...view('timeline', 'Due', 'Done'), table: 'Tasks' },
    ]);
    expect(checkPlan(p, linked)).toEqual([]);
  });

  it('still caps plans with the newer operations', () => {
    const many = Array.from({ length: MAX_PLAN_OPERATIONS + 1 }, (_, i) =>
      onCustomers(field(`Count ${i}`, 'count', { linkField: 'Orders' }))
    );
    expect(() => plan(many)).toThrow();
    expect(() => plan(many.slice(0, MAX_PLAN_OPERATIONS))).not.toThrow();
    const long = {
      summary: 's',
      baseName: null,
      operations: [
        onCustomers(field('A', 'ai', { ai: { prompt: 'x'.repeat(20_000), output: 'text' } })),
        onCustomers(
          field('B', 'button', { button: { label: 'x'.repeat(200), action: 'openUrl' } })
        ),
      ],
    };
    expect(assistantPlanOutputSchema.safeParse(long).success).toBe(true);
    expect(assistantPlanSchema.safeParse(long).success).toBe(false);
    // Only the known aggregations, outputs and actions parse at all.
    for (const bad of [
      rollup('R', 'Orders', 'Qty', 'MEDIAN'),
      field('A', 'ai', { ai: { prompt: 'x', output: 'image' } }),
      field('B', 'button', { button: { label: 'Go', action: 'deleteRecord' } }),
    ]) {
      expect(
        assistantPlanSchema.safeParse({ ...long, operations: [onCustomers(bad)] }).success
      ).toBe(false);
    }
  });

  it('reports lookups, rollups and counts without a fitting link or field', () => {
    const p = plan([
      onCustomers(lookup('No link', null, 'Qty')),
      onCustomers(lookup('Ghost link', 'Nope', 'Qty')),
      onCustomers(lookup('Not a link', 'Company', 'Qty')),
      onCustomers(lookup('No field', 'Orders', 'Nope')),
      onCustomers(rollup('Sum of text', 'Orders', 'Name', 'SUM')),
      onCustomers(rollup('Average date', 'Orders', 'Ordered', 'AVG')),
      onCustomers(field('No aggregation', 'rollup', { linkField: 'Orders', linkedField: 'Qty' })),
      onCustomers(field('Count nothing', 'count')),
      onCustomers(field('Count text', 'count', { linkField: 'Company' })),
      // A field of the linked table is looked up there, not in this table.
      onCustomers(lookup('Own field', 'Orders', 'Company')),
      // A lookup of text rolls up as text: MAX doesn't apply.
      onOrders(lookup('Companies', 'Customer', 'Company')),
      onCustomers(rollup('Max company', 'Orders', 'Companies', 'MAX')),
    ]);
    expect(kinds(p)).toEqual([
      [0, 'reference', 'No link'],
      [1, 'reference', 'Ghost link'],
      [2, 'type', 'Not a link'],
      [3, 'reference', 'No field'],
      [4, 'type', 'Sum of text'],
      [5, 'type', 'Average date'],
      [6, 'type', 'No aggregation'],
      [7, 'reference', 'Count nothing'],
      [8, 'type', 'Count text'],
      [9, 'reference', 'Own field'],
      [11, 'type', 'Max company'],
    ]);
  });

  it('reports malformed buttons and AI fields', () => {
    const p = plan([
      onOrders(field('No action', 'button')),
      onOrders(field('No label', 'button', { button: { label: ' ', action: 'runAutomation' } })),
      onOrders(field('No URL', 'button', { button: { label: 'Go', action: 'openUrl' } })),
      onOrders(
        field('Bad URL', 'button', {
          button: { label: 'Go', action: 'openUrl' },
          formula: '"https://x/" & {Nope}',
        })
      ),
      onOrders(field('No prompt', 'ai')),
      onOrders(field('Empty prompt', 'ai', { ai: { prompt: '  ', output: 'text' } })),
      onOrders(field('Unknown', 'ai', { ai: { prompt: 'About {Nope}', output: 'text' } })),
      onOrders(field('Reads AI', 'ai', { ai: { prompt: 'Rewrite {Blurb}', output: 'text' } })),
      onOrders(field('Reads AI too', 'ai', { ai: { prompt: 'Rewrite {Shout}', output: 'text' } })),
      onOrders(field('Pick', 'ai', { ai: { prompt: 'Pick for {Name}', output: 'singleSelect' } })),
      // A formula over a planned AI field reads AI too.
      onOrders(field('Answer', 'ai', { ai: { prompt: 'Price of {Name}', output: 'number' } })),
      onOrders(field('Twice', 'formula', { formula: '{Answer} * 2' })),
      onOrders(field('Again', 'ai', { ai: { prompt: 'Check {Twice}', output: 'text' } })),
    ]);
    expect(kinds(p)).toEqual([
      [0, 'type', 'No action'],
      [1, 'type', 'No label'],
      [2, 'type', 'No URL'],
      [3, 'formula', 'Bad URL'],
      [4, 'type', 'No prompt'],
      [5, 'type', 'Empty prompt'],
      [6, 'reference', 'Unknown'],
      [7, 'reference', 'Reads AI'],
      [8, 'reference', 'Reads AI too'],
      [9, 'type', 'Pick'],
      [12, 'reference', 'Again'],
    ]);
  });

  it('reports fields that would read themselves in a loop', () => {
    const p = plan([
      onOrders(field('A', 'formula', { formula: '{B} + 1' })),
      onOrders(field('B', 'formula', { formula: '{A} + 1' })),
      onOrders(field('Self', 'formula', { formula: '{Self} + 1' })),
      // Customers' lookup reads Orders' lookup, which reads it back.
      onCustomers(lookup('Back', 'Orders', 'There')),
      onOrders(lookup('There', 'Customer', 'Back')),
      onCustomers(rollup('Loop sum', 'Orders', 'Loop count', 'SUM')),
      onOrders(rollup('Loop count', 'Customer', 'Loop sum', 'SUM')),
      onOrders(field('Fine', 'formula', { formula: '{Qty} * 2' })),
    ]);
    const problems = checkPlan(p, linked);
    expect(problems.map((x) => [x.operation, x.kind])).toEqual([
      [0, 'formula'],
      [1, 'formula'],
      [2, 'formula'],
      [3, 'reference'],
      [4, 'reference'],
      [5, 'reference'],
      [6, 'reference'],
    ]);
    expect(problems[0]?.message).toBe('"A" would make a circular reference (A → B → A).');
    expect(problems[3]?.message).toContain('circular reference (Back → There → Back)');
  });

  it("refuses primary fields that can't be one, the newer types included", () => {
    const types = ['link', 'formula', 'lookup', 'rollup', 'count', 'button', 'ai'];
    const p = plan(
      types.map((type, i) => ({
        op: 'createTable',
        name: `T${i}`,
        description: null,
        fields: [field('Primary', type)],
      }))
    );
    const problems = checkPlan(p, linked);
    types.forEach((type, i) => {
      expect(problems).toContainEqual({
        operation: i,
        field: 'Primary',
        kind: 'type',
        message: `The primary field "Primary" can't be a ${type} field.`,
      });
    });
  });

  it('reports operations that need one with a problem, which is left out', () => {
    const p = plan([
      // SUM of text: left out, and so is the formula over it.
      onCustomers(rollup('Total', 'Orders', 'Name', 'SUM')),
      onCustomers(field('Double', 'formula', { formula: '{Total} * 2' })),
      // A table with a field that can't be made: left out with its view and its fields' readers.
      {
        op: 'createTable',
        name: 'Suppliers',
        description: null,
        fields: [
          field('Name', 'singleLineText'),
          field('Lost', 'lookup', { linkField: 'Nope', linkedField: 'Name' }),
          field('Since', 'date'),
        ],
      },
      { ...view('calendar', 'Since'), table: 'Suppliers' },
      onOrders(field('Supplier', 'link', { linkedTable: 'Suppliers' })),
      // Two steps down: needs Supplier, which needs Suppliers.
      onOrders(field('Supplier count', 'count', { linkField: 'Supplier' })),
      // Fine on its own.
      onOrders(field('Fine', 'formula', { formula: '{Qty} * 2' })),
    ]);
    const problems = checkPlan(p, linked);
    expect(problems.map((x) => [x.operation, x.kind])).toEqual([
      [0, 'type'],
      [1, 'reference'],
      [2, 'reference'],
      [3, 'reference'],
      [4, 'reference'],
      [5, 'reference'],
    ]);
    expect(problems[1]?.message).toContain("It needs a change above that can't be made.");
    // What's left applies as it is.
    const kept = new Set(problems.map((x) => x.operation));
    const rest = { ...p, operations: p.operations.filter((_, i) => !kept.has(i)) };
    expect(checkPlan(rest, linked)).toEqual([]);
    // A formula that only fails because what it reads is left out isn't sent back to the model.
    expect(problems.filter((x) => x.kind === 'formula')).toEqual([]);
  });

  it("doesn't read the formula of a button that runs automations", () => {
    const p = plan([
      onOrders(
        field('Go', 'button', {
          button: { label: 'Go', action: 'runAutomation' },
          formula: '{Go}',
        })
      ),
    ]);
    expect(checkPlan(p, linked)).toEqual([]);
  });

  it('reports timeline and list views on missing fields or fields of the wrong type', () => {
    const p = plan([
      view('timeline', null),
      view('timeline', 'Nope'),
      view('timeline', 'Name'),
      view('timeline', 'Ordered', 'Qty'),
      view('timeline', 'Ordered', 'Nope'),
      view('list', null),
      view('list', 'Status'),
      // A link to another table names no parent record.
      view('list', 'Customer'),
    ]);
    expect(kinds(p)).toEqual([
      [0, 'reference', null],
      [1, 'reference', null],
      [2, 'type', 'Name'],
      [3, 'type', 'Qty'],
      [4, 'reference', 'Nope'],
      [5, 'reference', null],
      [6, 'type', 'Status'],
      [7, 'type', 'Customer'],
    ]);
  });
});

/** A base with a form view and buttons, for the wider automation triggers and actions. */
const withForms: AssistantBaseInfo = {
  tables: [
    {
      name: 'Orders',
      fields: [
        { name: 'Name', type: 'singleLineText' },
        { name: 'Qty', type: 'number' },
        { name: 'Status', type: 'singleSelect' },
        { name: 'Paid', type: 'checkbox' },
        { name: 'Owner', type: 'user' },
        { name: 'Customer', type: 'link', linkedTable: 'Customers' },
        { name: 'Total', type: 'formula', resultType: 'number' },
        { name: 'Notify', type: 'button', buttonAction: 'runAutomation' },
        { name: 'Open', type: 'button', buttonAction: 'openUrl' },
      ],
      views: [
        { name: 'Grid view', type: 'grid' },
        { name: 'Intake', type: 'form' },
      ],
    },
    {
      name: 'Customers',
      fields: [
        { name: 'Company', type: 'singleLineText' },
        { name: 'Orders', type: 'link', linkedTable: 'Orders' },
      ],
    },
  ],
};

const automation = (extra: Record<string, unknown>) => ({
  op: 'createAutomation',
  table: 'Orders',
  name: 'Auto',
  trigger: 'recordCreated',
  watchFields: null,
  actions: [{ type: 'sendEmail', to: ['ops@example.com'], subject: 'Hi', body: '' }],
  ...extra,
});
const where = (conditions: unknown[], conjunction = 'and') => ({ conjunction, conditions });
const cond = (f: string, operator: string, value: string | null) => ({ field: f, operator, value });
const find = (table: string, filter: unknown = null, limit: number | null = null) => ({
  type: 'findRecords',
  table,
  filter,
  limit,
});
const http = (extra: Record<string, unknown> = {}) => ({
  type: 'httpRequest',
  method: 'POST',
  url: 'https://example.com/hooks/orders',
  headers: [],
  body: null,
  ...extra,
});
const update = (cells: { field: string; value: string }[], step: number | null = null) => ({
  type: 'updateRecord',
  cells,
  step,
});

describe('assistant plans: wider automation triggers and actions', () => {
  it('accepts every trigger and action the assistant proposes when they fit', () => {
    const p = plan([
      automation({
        trigger: 'formSubmitted',
        formView: 'Intake',
        actions: [update([{ field: 'Status', value: 'New' }])],
      }),
      automation({
        table: null,
        trigger: 'scheduled',
        schedule: { kind: 'cron', expression: '0 9 * * 1', timeZone: 'Europe/Paris' },
        actions: [
          find('Orders', where([cond('Status', 'is', 'Open'), cond('Qty', '>', '10')]), 50),
          update([{ field: 'Status', value: 'Late' }], 1),
          http({
            body: '{"count": "{{steps.1.count}}"}',
            headers: [{ name: 'X-Source', value: 'a' }],
          }),
        ],
      }),
      automation({
        table: null,
        trigger: 'scheduled',
        schedule: {
          kind: 'interval',
          every: 2,
          unit: 'hours',
          startAt: '2026-01-05T08:00',
          timeZone: 'UTC',
        },
      }),
      automation({
        table: null,
        trigger: 'webhookReceived',
        actions: [
          {
            type: 'createRecord',
            table: 'Customers',
            cells: [{ field: 'Company', value: '{{trigger.body.company}}' }],
          },
        ],
      }),
      automation({ trigger: 'buttonClicked', buttonField: 'Notify' }),
      automation({
        trigger: 'recordMatches',
        filter: where([cond('Paid', 'is', 'true'), cond('Customer', 'isEmpty', null)], 'or'),
        actions: [http({ method: 'GET', url: 'https://example.com/{{trigger.record.id}}' })],
      }),
      // A form view and a button created earlier in the plan.
      { op: 'createView', table: 'Customers', name: 'Sign up', type: 'form', field: null },
      automation({ table: 'Customers', trigger: 'formSubmitted', formView: 'sign up' }),
      onCustomers(field('Ping', 'button', { button: { label: 'Ping', action: 'runAutomation' } })),
      automation({ table: 'Customers', trigger: 'buttonClicked', buttonField: 'Ping' }),
      // Find with a token and no filter.
      automation({
        actions: [
          find('Customers', where([cond('Company', 'is', '{{trigger.record.fields.Name}}')])),
          find('Customers'),
          update([{ field: 'Company', value: 'Seen' }], 2),
        ],
      }),
    ]);
    expect(checkPlan(p, withForms)).toEqual([]);
    // Keys added later default to null, so older bodies still read.
    expect(p.operations[0]).toMatchObject({ filter: null, buttonField: null, schedule: null });
    const first = p.operations[0];
    expect(first?.op === 'createAutomation' && first.actions[0]).toMatchObject({ step: null });
  });

  it('still caps automations', () => {
    const many = Array.from({ length: MAX_PLAN_ACTIONS + 1 }, () => http());
    expect(() => plan([automation({ actions: many })])).toThrow();
    expect(() => plan([automation({ actions: many.slice(1) })])).not.toThrow();
    const conditions = Array.from({ length: MAX_PLAN_CONDITIONS + 1 }, () => cond('Qty', '>', '1'));
    expect(() => plan([automation({ actions: [find('Orders', where(conditions))] })])).toThrow();
    // Only the known triggers, actions and methods parse at all.
    for (const bad of [
      automation({ trigger: 'emailReceived' }),
      automation({ actions: [{ type: 'slackMessage', text: 'Hi' }] }),
      automation({ actions: [{ type: 'runScript', script: 'x' }] }),
      automation({ actions: [http({ method: 'TRACE' })] }),
      automation({ actions: [http({ headers: [{ name: 'X', value: 'y', secret: true }] })] }),
    ]) {
      expect(
        assistantPlanSchema.safeParse({ summary: 's', baseName: null, operations: [bad] }).success
      ).toBe(false);
    }
  });

  it('reports triggers that name no form view, button, conditions or valid schedule', () => {
    const p = plan([
      automation({ trigger: 'formSubmitted', formView: 'Nope' }),
      automation({ trigger: 'formSubmitted', formView: 'Grid view' }),
      automation({ trigger: 'formSubmitted' }),
      automation({ trigger: 'buttonClicked', buttonField: 'Nope' }),
      automation({ trigger: 'buttonClicked', buttonField: 'Qty' }),
      automation({ trigger: 'buttonClicked', buttonField: 'Open' }),
      automation({ trigger: 'recordMatches' }),
      automation({ table: null, trigger: 'scheduled' }),
      automation({
        table: null,
        trigger: 'scheduled',
        schedule: { kind: 'cron', expression: '* * * * *', timeZone: 'UTC' },
      }),
      automation({
        table: null,
        trigger: 'scheduled',
        schedule: { kind: 'cron', expression: 'every day', timeZone: 'UTC' },
      }),
      automation({
        table: null,
        trigger: 'scheduled',
        schedule: { kind: 'cron', expression: '@daily', timeZone: 'Mars/Olympus' },
      }),
      automation({
        table: null,
        trigger: 'scheduled',
        schedule: {
          kind: 'interval',
          every: 0,
          unit: 'days',
          startAt: '2026-01-01T00:00',
          timeZone: 'UTC',
        },
      }),
      automation({
        table: null,
        trigger: 'scheduled',
        schedule: {
          kind: 'interval',
          every: 1,
          unit: 'days',
          startAt: 'tomorrow',
          timeZone: 'UTC',
        },
      }),
      automation({ table: null, trigger: 'recordCreated' }),
      automation({ table: 'Ghosts', trigger: 'webhookReceived' }),
    ]);
    expect(kinds(p, withForms)).toEqual([
      [0, 'reference', null],
      [1, 'type', null],
      [2, 'reference', null],
      [3, 'reference', null],
      [4, 'type', 'Qty'],
      [5, 'type', 'Open'],
      [6, 'type', null],
      [7, 'type', null],
      [8, 'type', null],
      [9, 'type', null],
      [10, 'type', null],
      [11, 'type', null],
      [12, 'type', null],
      [13, 'reference', null],
      [14, 'reference', null],
    ]);
    expect(checkPlan(p, withForms)[8]?.message).toContain('at most every 5 minutes');
  });

  it('reports filters, finds and updates that name unknown fields or values that do not fit', () => {
    const p = plan([
      automation({ actions: [find('Orders', where([cond('Nope', 'is', 'x')]))] }),
      automation({ actions: [find('Ghosts')] }),
      automation({ actions: [find('Orders', where([cond('Qty', 'contains', '1')]))] }),
      automation({ actions: [find('Orders', where([cond('Qty', '>', 'ten')]))] }),
      automation({ actions: [find('Orders', where([cond('Status', 'is', null)]))] }),
      automation({ actions: [find('Orders', where([cond('Paid', 'is', 'yes')]))] }),
      automation({ actions: [find('Orders', where([cond('Owner', 'hasAnyOf', 'Ann')]))] }),
      automation({ actions: [find('Orders', where([cond('Customer', 'hasAnyOf', 'Acme')]))] }),
      automation({ actions: [find('Orders', null, 500)] }),
      automation({
        trigger: 'recordMatches',
        filter: where([cond('Name', 'is', '{{trigger.record.id}}')]),
      }),
      automation({ actions: [update([{ field: 'Nope', value: 'x' }])] }),
      automation({ actions: [update([{ field: 'Total', value: '1' }])] }),
      automation({ actions: [find('Customers'), update([{ field: 'Qty', value: '1' }], 1)] }),
      // Step 1 isn't a find; step 3 comes later.
      automation({ actions: [http(), update([{ field: 'Qty', value: '1' }], 1)] }),
      automation({ actions: [update([{ field: 'Qty', value: '1' }], 3), find('Orders')] }),
      // A schedule or webhook has no record to update.
      automation({
        table: null,
        trigger: 'webhookReceived',
        actions: [update([{ field: 'Qty', value: '1' }])],
      }),
    ]);
    expect(kinds(p, withForms)).toEqual([
      [0, 'reference', 'Nope'],
      [1, 'reference', null],
      [2, 'type', 'Qty'],
      [3, 'type', 'Qty'],
      [4, 'type', 'Status'],
      [5, 'type', 'Paid'],
      [6, 'type', 'Owner'],
      [7, 'type', 'Customer'],
      [8, 'type', null],
      [9, 'type', 'Name'],
      [10, 'reference', 'Nope'],
      [11, 'type', 'Total'],
      [12, 'reference', 'Qty'],
      [13, 'reference', null],
      [14, 'reference', null],
      [15, 'reference', null],
    ]);
  });

  it('reports date conditions whose value the query engine would refuse', () => {
    const dated: AssistantBaseInfo = {
      tables: [
        {
          name: 'Orders',
          fields: [
            { name: 'Name', type: 'singleLineText' },
            { name: 'Due', type: 'date' },
            { name: 'Shipped', type: 'dateTime' },
          ],
        },
      ],
    };
    const ok = plan([
      automation({
        trigger: 'recordMatches',
        filter: where([
          cond('Due', 'is', 'today'),
          cond('Due', 'isBefore', '2026-12-31'),
          cond('Shipped', 'isOnOrAfter', 'yesterday'),
          cond('Shipped', 'isWithin', 'pastWeek'),
        ]),
      }),
      automation({
        actions: [
          find('Orders', where([cond('Due', 'is', '{{trigger.record.fields.Due}}')])),
          find('Orders', where([cond('Due', 'isWithin', 'nextMonth')])),
        ],
      }),
    ]);
    expect(kinds(ok, dated)).toEqual([]);
    const p = plan([
      automation({ actions: [find('Orders', where([cond('Due', 'isWithin', 'next 7 days')]))] }),
      automation({ actions: [find('Orders', where([cond('Due', 'isWithin', '2026-01-01')]))] }),
      automation({ actions: [find('Orders', where([cond('Due', 'is', 'next tuesday')]))] }),
      automation({ actions: [find('Orders', where([cond('Due', 'isAfter', '2026-02-30')]))] }),
      automation({
        trigger: 'recordMatches',
        filter: where([cond('Shipped', 'isBefore', '12/31/2026')]),
      }),
    ]);
    expect(kinds(p, dated)).toEqual([
      [0, 'type', 'Due'],
      [1, 'type', 'Due'],
      [2, 'type', 'Due'],
      [3, 'type', 'Due'],
      [4, 'type', 'Shipped'],
    ]);
  });

  it('reports HTTP steps that are not allowed or would carry a secret', () => {
    const p = plan([
      automation({ actions: [http({ url: 'ftp://example.com/x' })] }),
      automation({ actions: [http({ url: 'not a url' })] }),
      automation({ actions: [http({ url: ' ' })] }),
      automation({ actions: [http({ headers: [{ name: 'Authorization', value: 'Bearer x' }] })] }),
      automation({ actions: [http({ headers: [{ name: 'X-Api-Key', value: 'k' }] })] }),
      automation({ actions: [http({ headers: [{ name: 'Bad header', value: 'v' }] })] }),
      automation({ actions: [http({ headers: [{ name: 'X-Ok', value: 'a\nb' }] })] }),
      automation({ actions: [http({ body: '{not json' })] }),
      automation({ actions: [http({ method: 'GET', body: '{}' })] }),
    ]);
    const problems = checkPlan(p, withForms);
    expect(problems.map((x) => [x.operation, x.kind])).toEqual(
      Array.from({ length: 9 }, (_, i) => [i, 'type'])
    );
    expect(problems[3]?.message).toContain('secret header');
  });

  it('reports automations that need a left-out operation', () => {
    const p = plan([
      // A form view of a table that can't be made, and an automation on it.
      {
        op: 'createTable',
        name: 'Orders',
        description: null,
        fields: [field('Name', 'singleLineText')],
      },
      {
        op: 'createTable',
        name: 'Leads',
        description: null,
        fields: [field('Name', 'singleLineText'), field('Lost', 'count', { linkField: 'Nope' })],
      },
      { op: 'createView', table: 'Leads', name: 'Sign up', type: 'form', field: null },
      automation({ table: 'Leads', trigger: 'formSubmitted', formView: 'Sign up' }),
      // A field that can't be made, and a find over it.
      onOrders(field('Bad', 'formula', { formula: '{Nope}' })),
      automation({ actions: [find('Orders', where([cond('Bad', 'isEmpty', null)]))] }),
      automation({ trigger: 'formSubmitted', formView: 'Intake' }),
    ]);
    expect(checkPlan(p, withForms).map((x) => x.operation)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
