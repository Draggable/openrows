import type {
  AssistantApplyResult,
  AssistantFieldType,
  AssistantPlan,
  AssistantPlanResult,
  Automation,
  FieldMeta,
  TableMeta,
  ViewMeta,
} from '@openrows/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  completion,
  type FakeOpenAi,
  type FakeRequest,
  fakeOutbound,
  startFakeOpenAi,
} from '../../src/ai/__fixtures__/fake-openai.js';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { workspaceMembers } from '../../src/db/index.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { createSession, createUser, createWorkspace } from '../helpers/factories.js';

/**
 * The AI assistant against real Postgres and a fake OpenAI-compatible provider: plans see
 * the schema and no records unless asked, a formula that doesn't type-check gets one more round,
 * planning never writes, applying goes through the services in one transaction (all or nothing),
 * creators only, and "Describe it" creates a new base.
 */
const t = useTestDb();
const ENCRYPTION_KEY = 'ai-assistant-test-encryption-key-012345678';

let fake: FakeOpenAi;
let app: ReturnType<typeof testApp>;
let noAi: ReturnType<typeof testApp>;

const field = (name: string, type: AssistantFieldType, extra: Record<string, unknown> = {}) => ({
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

/** The trigger keys a createAutomation operation leaves null unless its trigger needs them. */
const automationKeys = { filter: null, formView: null, buttonField: null, schedule: null };

/** What the fake model proposes for "track customers": a formula with a typo first. */
function proposal(formula: string): AssistantPlan {
  return {
    summary: 'Adds customers, an order total, a board by status and a notification.',
    baseName: null,
    operations: [
      {
        op: 'createTable',
        name: 'Customers',
        description: null,
        fields: [
          field('Company', 'singleLineText'),
          field('Tier', 'singleSelect', { choices: ['Gold', 'Silver'] }),
          field('Orders', 'link', { linkedTable: 'Orders' }),
        ],
      },
      { op: 'createField', table: 'Orders', field: field('Total', 'formula', { formula }) },
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
        name: 'Mark big orders',
        trigger: 'recordUpdated',
        watchFields: ['Qty'],
        actions: [
          { type: 'updateRecord', cells: [{ field: 'Notes', value: 'Big order' }], step: null },
        ],
        ...automationKeys,
      },
    ],
  };
}

type Operation = AssistantPlan['operations'][number];
const addField = (table: string, spec: ReturnType<typeof field>): Operation => ({
  op: 'createField',
  table,
  field: spec,
});

/**
 * Customers linked to Orders with a lookup, a rollup, a count, two buttons and two AI fields;
 * Orders' dates and a lookup through the inverse link; Tasks nested by a parent; a timeline
 * and a list view.
 */
function richerProposal(): AssistantPlan {
  return {
    summary: 'Adds customers with order figures, a timeline of orders and a task tree.',
    baseName: null,
    operations: [
      {
        op: 'createTable',
        name: 'Customers',
        description: null,
        fields: [
          field('Company', 'singleLineText'),
          field('Orders', 'link', { linkedTable: 'Orders' }),
        ],
      },
      addField(
        'Customers',
        field('Quantities', 'lookup', { linkField: 'Orders', linkedField: 'Qty' })
      ),
      addField(
        'Customers',
        field('Spent', 'rollup', { linkField: 'Orders', linkedField: 'Price', aggregation: 'SUM' })
      ),
      addField('Customers', field('Order count', 'count', { linkField: 'Orders' })),
      addField(
        'Customers',
        field('Website', 'button', {
          button: { label: 'Visit', action: 'openUrl' },
          formula: '"https://example.com/" & {Company}',
        })
      ),
      addField(
        'Customers',
        field('Follow up', 'button', { button: { label: 'Follow up', action: 'runAutomation' } })
      ),
      addField(
        'Customers',
        field('Summary', 'ai', { ai: { prompt: 'Summarize {Company}.', output: 'summary' } })
      ),
      addField(
        'Customers',
        field('Size', 'ai', {
          ai: { prompt: 'How big is {Company}?', output: 'singleSelect' },
          choices: ['Small', 'Large'],
        })
      ),
      addField('Orders', field('Ordered', 'date')),
      addField('Orders', field('Shipped', 'date')),
      addField(
        'Orders',
        field('Customer name', 'lookup', { linkField: 'Customers', linkedField: 'Company' })
      ),
      {
        op: 'createTable',
        name: 'Tasks',
        description: null,
        fields: [
          field('Title', 'singleLineText'),
          field('Parent', 'link', { linkedTable: 'Tasks' }),
        ],
      },
      {
        op: 'createView',
        table: 'Orders',
        name: 'Schedule',
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
  };
}

const messagesOf = (req: FakeRequest) =>
  (req.body['messages'] as { role: string; content: string }[]).map((m) => m.content).join('\n');

beforeAll(async () => {
  fake = await startFakeOpenAi();
  const config = {
    encryptionKey: ENCRYPTION_KEY,
    outbound: fakeOutbound(fake.port),
    ai: {
      instance: {
        baseUrl: fake.baseUrl,
        model: 'fake-model',
        apiKey: 'sk-test-assistant-0123456789',
      },
      allowedHosts: undefined,
      timeoutMs: 10_000,
    },
  };
  app = testApp({ db: t.appDb, config });
  noAi = testApp({
    db: t.appDb,
    config: { ...config, ai: { instance: undefined, allowedHosts: undefined, timeoutMs: 10_000 } },
  });
});
afterAll(() => fake.close());

async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  if (r.status !== status) throw new Error(`${r.status}: ${await r.text()}`);
  return (await r.json()) as T;
}

function client(cookie: string, target = app) {
  return (method: string, path: string, body?: unknown) =>
    target.app.request(path, {
      method,
      headers: {
        origin: target.config.appUrl,
        cookie: `${SESSION_COOKIE}=${cookie}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
}

describe('AI assistant', () => {
  let request: ReturnType<typeof client>;
  let editorRequest: ReturnType<typeof client>;
  let ownerCookie: string;
  let workspaceId: string;
  let baseId: string;
  let orders: TableMeta;

  const tables = async () =>
    (
      await ok<{ tables: { id: string; name: string }[] }>(
        request('GET', `/api/bases/${baseId}/tables`)
      )
    ).tables;
  const fieldsOf = async (tableId: string) =>
    (await ok<TableMeta>(request('GET', `/api/tables/${tableId}`))).fields;

  beforeEach(async () => {
    fake.requests.length = 0;
    const { workspace, owner } = await createWorkspace(t.db);
    workspaceId = workspace.id;
    ownerCookie = await createSession(t.db, owner);
    request = client(ownerCookie);
    const editor = await createUser(t.db);
    await t.db.insert(workspaceMembers).values({ workspaceId, userId: editor.id, role: 'editor' });
    editorRequest = client(await createSession(t.db, editor));
    baseId = (
      await ok<{ id: string }>(
        request('POST', `/api/workspaces/${workspaceId}/bases`, { name: 'Sales' }),
        201
      )
    ).id;
    orders = await ok<TableMeta>(
      request('POST', `/api/bases/${baseId}/tables`, { name: 'Orders' }),
      201
    );
    for (const [name, type] of [
      ['Qty', 'number'],
      ['Price', 'currency'],
    ]) {
      await ok<FieldMeta>(request('POST', `/api/tables/${orders.id}/fields`, { name, type }), 201);
    }
    await ok(
      request('POST', `/api/tables/${orders.id}/records`, {
        fields: { [orders.fields[0]?.id ?? '']: 'SECRET-ROW-VALUE' },
      }),
      201
    );
    let calls = 0;
    fake.respond = () =>
      completion(JSON.stringify(proposal(calls++ === 0 ? '{Qty} * {Prise}' : '{Qty} * {Price}')));
  });

  it('plans from the schema only, retries a formula that does not type-check, writes nothing', async () => {
    const before = await fieldsOf(orders.id);
    const result = await ok<AssistantPlanResult>(
      request('POST', `/api/bases/${baseId}/assistant/plan`, { prompt: 'Track customers' })
    );
    expect(result.attempts).toBe(2);
    expect(result.problems).toEqual([]);
    expect(result.plan.operations).toHaveLength(4);
    expect(fake.requests).toHaveLength(2);
    const sent = messagesOf(fake.requests[0] as FakeRequest);
    expect(sent).toContain('Table "Orders"');
    expect(sent).toContain('- Price (currency)');
    expect(sent).toContain('Track customers');
    expect(sent).not.toContain('SECRET-ROW-VALUE');
    // The second round names the error.
    expect(messagesOf(fake.requests[1] as FakeRequest)).toContain(
      "These formulas don't type-check"
    );
    // Planning changed nothing.
    expect((await tables()).map((x) => x.name)).toEqual(['Orders']);
    expect(await fieldsOf(orders.id)).toEqual(before);
  });

  it('sends a few records only when the user opts in', async () => {
    await ok(
      request('POST', `/api/bases/${baseId}/assistant/plan`, {
        prompt: 'Track customers',
        includeRecords: true,
      })
    );
    expect(messagesOf(fake.requests[0] as FakeRequest)).toContain('SECRET-ROW-VALUE');
  });

  it('returns the problems left after the retry', async () => {
    fake.respond = () => completion(JSON.stringify(proposal('{Qty} * {Prise}')));
    const result = await ok<AssistantPlanResult>(
      request('POST', `/api/bases/${baseId}/assistant/plan`, { prompt: 'Track customers' })
    );
    expect(result.attempts).toBe(2);
    expect(result.problems).toMatchObject([{ operation: 1, kind: 'formula', field: 'Total' }]);
  });

  it('applies a confirmed plan through the services', async () => {
    const applied = await ok<AssistantApplyResult>(
      request('POST', `/api/bases/${baseId}/assistant/apply`, { plan: proposal('{Qty} * {Price}') })
    );
    expect(applied).toMatchObject({ baseId, tables: 1, fields: 4, views: 1, automations: 1 });
    const customers = (await tables()).find((x) => x.name === 'Customers');
    expect(customers?.id).toBe(applied.firstTableId);
    const customerFields = await fieldsOf(customers?.id ?? '');
    expect(customerFields.map((f) => [f.name, f.type, f.isPrimary])).toEqual([
      ['Company', 'singleLineText', true],
      ['Tier', 'singleSelect', false],
      ['Orders', 'link', false],
    ]);
    const orderFields = await fieldsOf(orders.id);
    const total = orderFields.find((f) => f.name === 'Total');
    expect(total?.options).toMatchObject({ resultType: 'number', isValid: true });
    // The link's inverse, named after the table.
    expect(orderFields.some((f) => f.type === 'link' && f.name === 'Customers')).toBe(true);
    const { views } = await ok<{ views: ViewMeta[] }>(
      request('GET', `/api/tables/${orders.id}/views`)
    );
    const board = views.find((v) => v.name === 'Board');
    const status = orderFields.find((f) => f.name === 'Status');
    expect(board?.type).toBe('kanban');
    expect(board?.config).toMatchObject({ kanban: { stackFieldId: status?.id } });
    const { automations } = await ok<{ automations: Automation[] }>(
      request('GET', `/api/bases/${baseId}/automations`)
    );
    expect(automations).toHaveLength(1);
    expect(automations[0]).toMatchObject({ name: 'Mark big orders', enabled: false });
    expect(fake.requests).toHaveLength(0);
  });

  it('refuses a plan that no longer fits, and applies nothing of it', async () => {
    const plan = proposal('{Qty} * {Price}');
    plan.operations.push({ op: 'createField', table: 'Ghosts', field: field('A', 'number') });
    const res = await request('POST', `/api/bases/${baseId}/assistant/apply`, { plan });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain('Ghosts');
    expect((await tables()).map((x) => x.name)).toEqual(['Orders']);
    expect((await fieldsOf(orders.id)).map((f) => f.name)).not.toContain('Total');
  });

  it('rolls back every operation when a service refuses one', async () => {
    // The checker leaves automation tokens to the automation service, which refuses this one
    // after the table, fields and view were created: none of them stays.
    const plan = proposal('{Qty} * {Price}');
    const auto = plan.operations[3];
    if (auto?.op !== 'createAutomation') throw new Error('fixture');
    auto.actions = [
      { type: 'updateRecord', cells: [{ field: 'Notes', value: '{{nope}}' }], step: null },
    ];
    const res = await request('POST', `/api/bases/${baseId}/assistant/apply`, { plan });
    expect(res.status).toBe(422);
    expect((await tables()).map((x) => x.name)).toEqual(['Orders']);
  });

  it('is for creators, and needs a provider to plan', async () => {
    const plan = proposal('{Qty} * {Price}');
    expect(
      (await editorRequest('POST', `/api/bases/${baseId}/assistant/plan`, { prompt: 'x' })).status
    ).toBe(403);
    expect(
      (await editorRequest('POST', `/api/bases/${baseId}/assistant/apply`, { plan })).status
    ).toBe(403);
    const off = client(ownerCookie, noAi);
    const res = await off('POST', `/api/bases/${baseId}/assistant/plan`, { prompt: 'x' });
    expect(res.status).toBe(409);
    expect(fake.requests).toHaveLength(0);
  });

  it('describes a new base and creates it on confirm', async () => {
    fake.respond = () =>
      completion(
        JSON.stringify({
          summary: 'A small CRM.',
          baseName: 'CRM',
          operations: [
            {
              op: 'createTable',
              name: 'Contacts',
              description: 'People we talk to',
              fields: [
                field('Email', 'email'),
                field('Stage', 'singleSelect', { choices: ['Lead', 'Won'] }),
              ],
            },
            {
              op: 'createView',
              table: 'Contacts',
              name: 'Pipeline',
              type: 'kanban',
              field: 'Stage',
              endField: null,
            },
          ],
        })
      );
    const proposed = await ok<AssistantPlanResult>(
      request('POST', `/api/workspaces/${workspaceId}/assistant/plan`, { prompt: 'A small CRM' })
    );
    expect(proposed.plan.baseName).toBe('CRM');
    expect(messagesOf(fake.requests[0] as FakeRequest)).toContain('This is a new, empty base.');
    const created = await ok<AssistantApplyResult>(
      request('POST', `/api/workspaces/${workspaceId}/assistant/apply`, {
        name: 'CRM',
        plan: proposed.plan,
      }),
      201
    );
    expect(created).toMatchObject({ tables: 1, fields: 2, views: 1 });
    const contacts = await fieldsOf(created.firstTableId ?? '');
    expect(contacts.map((f) => [f.name, f.type, f.isPrimary])).toEqual([
      ['Email', 'email', true],
      ['Stage', 'singleSelect', false],
    ]);
    const base = await ok<{ name: string }>(request('GET', `/api/bases/${created.baseId}`));
    expect(base.name).toBe('CRM');
  });

  it('tells the model about the newer field and view types', async () => {
    await ok(request('POST', `/api/bases/${baseId}/assistant/plan`, { prompt: 'Track customers' }));
    const system = messagesOf(fake.requests[0] as FakeRequest);
    for (const type of ['lookup', 'rollup', 'count', 'button', 'ai']) {
      expect(system).toContain(`- ${type}: `);
    }
    expect(system).toContain('timeline needs field');
    expect(system).toContain('list needs field');
    expect(system).toContain('runAutomation');
  });

  it('plans and applies lookups, rollups, counts, buttons, AI fields, timelines and lists', async () => {
    fake.respond = () => completion(JSON.stringify(richerProposal()));
    const proposed = await ok<AssistantPlanResult>(
      request('POST', `/api/bases/${baseId}/assistant/plan`, { prompt: 'Customer figures' })
    );
    expect(proposed.problems).toEqual([]);
    expect(proposed.attempts).toBe(1);
    // Planning wrote nothing.
    expect((await tables()).map((x) => x.name)).toEqual(['Orders']);
    fake.requests.length = 0;

    const applied = await ok<AssistantApplyResult>(
      request('POST', `/api/bases/${baseId}/assistant/apply`, { plan: proposed.plan })
    );
    expect(applied).toMatchObject({ tables: 2, fields: 14, views: 2, automations: 0 });
    const all = await tables();
    const customers = all.find((x) => x.name === 'Customers');
    const tasks = all.find((x) => x.name === 'Tasks');
    const customerFields = await fieldsOf(customers?.id ?? '');
    const orderFields = await fieldsOf(orders.id);
    const taskFields = await fieldsOf(tasks?.id ?? '');
    const byName = (list: FieldMeta[], name: string) => {
      const f = list.find((x) => x.name === name);
      if (!f) throw new Error(`no field ${name}`);
      return f;
    };
    const link = byName(customerFields, 'Orders');
    expect(byName(customerFields, 'Quantities')).toMatchObject({
      type: 'lookup',
      options: { recordLinkFieldId: link.id, fieldIdInLinkedTable: byName(orderFields, 'Qty').id },
    });
    expect(byName(customerFields, 'Spent')).toMatchObject({
      type: 'rollup',
      options: {
        recordLinkFieldId: link.id,
        fieldIdInLinkedTable: byName(orderFields, 'Price').id,
        function: 'SUM',
      },
    });
    expect(byName(customerFields, 'Order count')).toMatchObject({
      type: 'count',
      options: { recordLinkFieldId: link.id },
    });
    expect(byName(customerFields, 'Website')).toMatchObject({
      type: 'button',
      options: { label: 'Visit', action: 'openUrl', isValid: true },
    });
    const followUp = byName(customerFields, 'Follow up');
    expect(followUp).toMatchObject({
      type: 'button',
      options: { label: 'Follow up', action: 'runAutomation' },
    });
    expect((followUp.options as { formula?: string }).formula ?? '').toBe('');
    const company = byName(customerFields, 'Company');
    const summary = byName(customerFields, 'Summary');
    expect(summary).toMatchObject({
      type: 'ai',
      options: { output: 'summary', referencedFieldIds: [company.id] },
    });
    const size = byName(customerFields, 'Size').options as { choices: { name: string }[] };
    expect(size.choices.map((c) => c.name)).toEqual(['Small', 'Large']);
    // Through the inverse link the Customers link added to Orders.
    const inverse = byName(orderFields, 'Customers');
    expect(byName(orderFields, 'Customer name')).toMatchObject({
      type: 'lookup',
      options: { recordLinkFieldId: inverse.id, fieldIdInLinkedTable: company.id },
    });

    const viewsOf = async (tableId: string) =>
      (await ok<{ views: ViewMeta[] }>(request('GET', `/api/tables/${tableId}/views`))).views;
    const schedule = (await viewsOf(orders.id)).find((v) => v.name === 'Schedule');
    expect(schedule).toMatchObject({
      type: 'timeline',
      config: {
        timeline: {
          startFieldId: byName(orderFields, 'Ordered').id,
          endFieldId: byName(orderFields, 'Shipped').id,
        },
      },
    });
    const tree = (await viewsOf(tasks?.id ?? '')).find((v) => v.name === 'Tree');
    expect(tree).toMatchObject({
      type: 'list',
      config: { list: { parentFieldId: byName(taskFields, 'Parent').id } },
    });
    // Applying asked the provider nothing; AI answers are the worker's, one field at a time.
    expect(fake.requests).toHaveLength(0);
  });

  it('leaves invalid newer operations as problems and applies nothing of a plan with them', async () => {
    const valid = richerProposal().operations[0] as Operation;
    const invalid: Operation[] = [
      // A loop through two formulas.
      addField('Orders', field('A', 'formula', { formula: '{B} + 1' })),
      addField('Orders', field('B', 'formula', { formula: '{A} + 1' })),
      // A lookup through a link that doesn't exist.
      addField('Orders', field('Lost', 'lookup', { linkField: 'Supplier', linkedField: 'Name' })),
      // A timeline on a number, a list on a select.
      {
        op: 'createView',
        table: 'Orders',
        name: 'Bad timeline',
        type: 'timeline',
        field: 'Qty',
        endField: null,
      },
      {
        op: 'createView',
        table: 'Orders',
        name: 'Bad list',
        type: 'list',
        field: 'Status',
        endField: null,
      },
      // A primary field that can't be one.
      {
        op: 'createTable',
        name: 'Counts',
        description: null,
        fields: [field('Total', 'count', { linkField: 'Orders' })],
      },
    ];
    const bad: AssistantPlan = { summary: 's', baseName: null, operations: [valid, ...invalid] };
    fake.respond = () => completion(JSON.stringify(bad));
    const proposed = await ok<AssistantPlanResult>(
      request('POST', `/api/bases/${baseId}/assistant/plan`, { prompt: 'Break things' })
    );
    // The loop is a formula problem: the model got one more round.
    expect(proposed.attempts).toBe(2);
    const flagged = new Set(proposed.problems.map((p) => p.operation));
    expect([...flagged].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(proposed.problems.find((p) => p.operation === 1)?.message).toContain(
      'circular reference'
    );

    // Sent as it is (every operation ticked), the plan is refused whole.
    const res = await request('POST', `/api/bases/${baseId}/assistant/apply`, { plan: bad });
    expect(res.status).toBe(422);
    expect((await tables()).map((x) => x.name)).toEqual(['Orders']);
    const before = (await fieldsOf(orders.id)).map((f) => f.name);
    for (const op of invalid) {
      const one = await request('POST', `/api/bases/${baseId}/assistant/apply`, {
        plan: { ...bad, operations: [valid, op] },
      });
      expect(one.status).toBe(422);
    }
    expect((await tables()).map((x) => x.name)).toEqual(['Orders']);
    expect((await fieldsOf(orders.id)).map((f) => f.name)).toEqual(before);
    const { views } = await ok<{ views: ViewMeta[] }>(
      request('GET', `/api/tables/${orders.id}/views`)
    );
    expect(views.map((v) => v.name)).not.toContain('Bad timeline');
  });
  it('leaves out what needs a left-out operation, so the ticked rest applies', async () => {
    const operations: Operation[] = [
      addField('Orders', field('Self', 'link', { linkedTable: 'Orders' })),
      // SUM of text can't be made, nor the formula over it.
      addField(
        'Orders',
        field('Name sum', 'rollup', {
          linkField: 'Self',
          linkedField: 'Name',
          aggregation: 'SUM',
        })
      ),
      addField('Orders', field('Twice', 'formula', { formula: '{Name sum} * 2' })),
      // A table with a lookup that can't be made, and a view of it.
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
      {
        op: 'createView',
        table: 'Suppliers',
        name: 'Dates',
        type: 'calendar',
        field: 'Since',
        endField: null,
      },
      addField('Orders', field('Double', 'formula', { formula: '{Qty} * 2' })),
    ];
    const proposedPlan: AssistantPlan = { summary: 's', baseName: null, operations };
    fake.respond = () => completion(JSON.stringify(proposedPlan));
    const proposed = await ok<AssistantPlanResult>(
      request('POST', `/api/bases/${baseId}/assistant/plan`, { prompt: 'Figures' })
    );
    // Nothing for the model to fix in a formula: one round.
    expect(proposed.attempts).toBe(1);
    expect([...new Set(proposed.problems.map((p) => p.operation))]).toEqual([1, 2, 3, 4]);

    // The operations ticked at first (those without a problem) apply.
    const flagged = new Set(proposed.problems.map((p) => p.operation));
    const ticked = {
      ...proposed.plan,
      operations: proposed.plan.operations.filter((_, i) => !flagged.has(i)),
    };
    const applied = await ok<AssistantApplyResult>(
      request('POST', `/api/bases/${baseId}/assistant/apply`, { plan: ticked })
    );
    expect(applied).toMatchObject({ tables: 0, fields: 2, views: 0 });
    expect((await tables()).map((x) => x.name)).toEqual(['Orders']);
    const names = (await fieldsOf(orders.id)).map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['Self', 'Double']));
    expect(names).not.toContain('Twice');
  });

  it('tells the model about the wider automation triggers and actions, and that they start off', async () => {
    await ok(
      request('POST', `/api/tables/${orders.id}/views`, {
        name: 'Intake',
        type: 'form',
      }),
      201
    );
    await ok(request('POST', `/api/bases/${baseId}/assistant/plan`, { prompt: 'Automate' }));
    const sent = messagesOf(fake.requests[0] as FakeRequest);
    for (const word of [
      'recordMatches',
      'formSubmitted',
      'buttonClicked',
      'scheduled',
      'webhookReceived',
      'findRecords',
      'httpRequest',
      'created switched off',
      'Never write secrets',
    ]) {
      expect(sent).toContain(word);
    }
    // The base's views, so a form trigger can name its form.
    expect(sent).toContain('"Intake" (form)');
  });

  it('plans and applies form, button, schedule, webhook, conditions, find and HTTP automations, all off', async () => {
    const hook = `http://127.0.0.1:${fake.port}/hooks/orders`;
    const automation = (extra: Record<string, unknown>): Operation =>
      ({
        op: 'createAutomation',
        table: 'Orders',
        name: 'Auto',
        trigger: 'recordCreated',
        watchFields: null,
        actions: [],
        ...automationKeys,
        ...extra,
      }) as Operation;
    const wider: AssistantPlan = {
      summary: 'Adds automations; they start off.',
      baseName: null,
      operations: [
        {
          op: 'createView',
          table: 'Orders',
          name: 'Intake',
          type: 'form',
          field: null,
          endField: null,
        },
        addField(
          'Orders',
          field('Escalate', 'button', { button: { label: 'Escalate', action: 'runAutomation' } })
        ),
        automation({
          name: 'Form intake',
          trigger: 'formSubmitted',
          formView: 'Intake',
          actions: [
            {
              type: 'updateRecord',
              cells: [{ field: 'Notes', value: 'From the form' }],
              step: null,
            },
          ],
        }),
        automation({
          name: 'Weekly big orders',
          table: null,
          trigger: 'scheduled',
          schedule: { kind: 'cron', expression: '0 9 * * 1', timeZone: 'Europe/Paris' },
          actions: [
            {
              type: 'findRecords',
              table: 'Orders',
              filter: {
                conjunction: 'and',
                conditions: [{ field: 'Qty', operator: '>', value: '10' }],
              },
              limit: 20,
            },
            { type: 'updateRecord', cells: [{ field: 'Notes', value: 'Big' }], step: 1 },
            {
              type: 'httpRequest',
              method: 'POST',
              url: hook,
              headers: [{ name: 'X-Source', value: 'orders' }],
              body: '{"count": "{{steps.1.count}}"}',
            },
          ],
        }),
        automation({
          name: 'Inbound',
          table: null,
          trigger: 'webhookReceived',
          actions: [
            {
              type: 'createRecord',
              table: 'Orders',
              cells: [{ field: 'Name', value: '{{trigger.body.name}}' }],
            },
          ],
        }),
        automation({
          name: 'Escalation',
          trigger: 'buttonClicked',
          buttonField: 'Escalate',
          actions: [
            {
              type: 'sendEmail',
              to: ['ops@example.com'],
              subject: 'Escalated: {{trigger.record.fields.Name}}',
              body: 'By {{trigger.user.name}}',
            },
          ],
        }),
        automation({
          name: 'Huge orders',
          trigger: 'recordMatches',
          filter: {
            conjunction: 'or',
            conditions: [
              { field: 'Qty', operator: '>=', value: '100' },
              { field: 'Price', operator: 'isEmpty', value: null },
            ],
          },
          actions: [
            {
              type: 'httpRequest',
              method: 'GET',
              url: `${hook}?id={{trigger.record.id}}`,
              headers: [],
              body: null,
            },
          ],
        }),
      ],
    };
    fake.respond = () => completion(JSON.stringify(wider));
    const proposed = await ok<AssistantPlanResult>(
      request('POST', `/api/bases/${baseId}/assistant/plan`, { prompt: 'Automate orders' })
    );
    expect(proposed.problems).toEqual([]);
    expect(proposed.attempts).toBe(1);
    // Planning wrote nothing.
    expect(
      (await ok<{ automations: Automation[] }>(request('GET', `/api/bases/${baseId}/automations`)))
        .automations
    ).toEqual([]);
    fake.requests.length = 0;

    const applied = await ok<AssistantApplyResult>(
      request('POST', `/api/bases/${baseId}/assistant/apply`, { plan: proposed.plan })
    );
    expect(applied).toMatchObject({ tables: 0, fields: 1, views: 1, automations: 5 });
    // Applying sent nothing anywhere: no provider call and no HTTP step ran.
    expect(fake.requests).toHaveLength(0);

    const { automations } = await ok<{ automations: Automation[] }>(
      request('GET', `/api/bases/${baseId}/automations`)
    );
    expect(automations.map((a) => [a.name, a.enabled, a.nextRunAt])).toEqual([
      ['Form intake', false, null],
      ['Weekly big orders', false, null],
      ['Inbound', false, null],
      ['Escalation', false, null],
      ['Huge orders', false, null],
    ]);
    const byName = (name: string) => {
      const a = automations.find((x) => x.name === name);
      if (!a) throw new Error(`no automation ${name}`);
      return a;
    };
    const fields = await fieldsOf(orders.id);
    const idOf = (name: string) => fields.find((f) => f.name === name)?.id;
    const { views } = await ok<{ views: ViewMeta[] }>(
      request('GET', `/api/tables/${orders.id}/views`)
    );
    const intake = views.find((v) => v.name === 'Intake');
    expect(intake?.type).toBe('form');

    expect(byName('Form intake')).toMatchObject({
      trigger: { type: 'formSubmitted', tableId: orders.id, viewId: intake?.id },
      actions: [
        {
          type: 'updateRecord',
          tableId: orders.id,
          recordId: '{{trigger.record.id}}',
          fields: { [idOf('Notes') ?? '']: 'From the form' },
        },
      ],
    });
    expect(byName('Weekly big orders')).toMatchObject({
      trigger: {
        type: 'scheduled',
        schedule: { kind: 'cron', expression: '0 9 * * 1', timeZone: 'Europe/Paris' },
      },
      actions: [
        {
          type: 'findRecords',
          tableId: orders.id,
          filter: {
            conjunction: 'and',
            conditions: [{ fieldId: idOf('Qty'), operator: '>', value: '10' }],
          },
          limit: 20,
        },
        {
          type: 'updateRecord',
          tableId: orders.id,
          recordId: '{{steps.1.records}}',
          fields: { [idOf('Notes') ?? '']: 'Big' },
        },
        {
          type: 'httpRequest',
          method: 'POST',
          url: hook,
          headers: [{ name: 'X-Source', value: 'orders', secret: false }],
          body: { count: '{{steps.1.count}}' },
        },
      ],
    });
    const inbound = byName('Inbound');
    expect(inbound.trigger).toEqual({ type: 'webhookReceived' });
    // The server made the webhook URL; the plan held no secret.
    expect(inbound.webhookUrl).toMatch(/\/hooks\/a\//);
    expect(byName('Escalation').trigger).toEqual({
      type: 'buttonClicked',
      tableId: orders.id,
      fieldId: idOf('Escalate'),
    });
    expect(byName('Huge orders')).toMatchObject({
      trigger: {
        type: 'recordMatches',
        tableId: orders.id,
        filter: {
          conjunction: 'or',
          conditions: [
            { fieldId: idOf('Qty'), operator: '>=', value: '100' },
            { fieldId: idOf('Price'), operator: 'isEmpty' },
          ],
        },
      },
      actions: [{ type: 'httpRequest', method: 'GET' }],
    });
  });

  it('leaves invalid automations as problems and applies nothing of a plan with them', async () => {
    const valid = addField('Orders', field('Extra', 'number'));
    const automation = (extra: Record<string, unknown>): Operation =>
      ({
        op: 'createAutomation',
        table: 'Orders',
        name: 'Auto',
        trigger: 'recordCreated',
        watchFields: null,
        actions: [{ type: 'sendEmail', to: ['ops@example.com'], subject: 'Hi', body: '' }],
        ...automationKeys,
        ...extra,
      }) as Operation;
    const http = (url: string, headers: { name: string; value: string }[] = []) => ({
      type: 'httpRequest' as const,
      method: 'POST' as const,
      url,
      headers,
      body: null,
    });
    const invalid: Operation[] = [
      // The table's grid view isn't a form.
      automation({ trigger: 'formSubmitted', formView: 'Grid view' }),
      // No such button.
      automation({ trigger: 'buttonClicked', buttonField: 'Launch' }),
      // Every minute: the engine refuses it.
      automation({
        table: null,
        trigger: 'scheduled',
        schedule: { kind: 'cron', expression: '* * * * *', timeZone: 'UTC' },
      }),
      // A find and an update naming fields the table doesn't have.
      automation({
        actions: [
          {
            type: 'findRecords',
            table: 'Orders',
            filter: {
              conjunction: 'and',
              conditions: [{ field: 'Region', operator: 'is', value: 'EU' }],
            },
            limit: null,
          },
        ],
      }),
      automation({
        actions: [{ type: 'updateRecord', cells: [{ field: 'Region', value: 'EU' }], step: null }],
      }),
      // An address the outbound rules refuse.
      automation({ actions: [http('http://10.1.2.3/hook')] }),
      // A credential in a plain header.
      automation({
        actions: [
          http(`http://127.0.0.1:${fake.port}/x`, [{ name: 'Authorization', value: 'Bearer abc' }]),
        ],
      }),
    ];
    const bad: AssistantPlan = { summary: 's', baseName: null, operations: [valid, ...invalid] };
    fake.respond = () => completion(JSON.stringify(bad));
    const proposed = await ok<AssistantPlanResult>(
      request('POST', `/api/bases/${baseId}/assistant/plan`, { prompt: 'Break automations' })
    );
    expect(proposed.attempts).toBe(1);
    expect([...new Set(proposed.problems.map((p) => p.operation))]).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(proposed.problems.find((p) => p.operation === 6)?.message).toContain("can't be used");
    expect(proposed.problems.find((p) => p.operation === 7)?.message).toContain('secret header');

    const automationsNow = async () =>
      (await ok<{ automations: Automation[] }>(request('GET', `/api/bases/${baseId}/automations`)))
        .automations;
    const before = (await fieldsOf(orders.id)).map((f) => f.name);
    // Sent as it is, the plan is refused whole; so is each invalid one next to a valid one.
    const res = await request('POST', `/api/bases/${baseId}/assistant/apply`, { plan: bad });
    expect(res.status).toBe(422);
    for (const op of invalid) {
      const one = await request('POST', `/api/bases/${baseId}/assistant/apply`, {
        plan: { ...bad, operations: [valid, op] },
      });
      expect(one.status).toBe(422);
    }
    expect((await fieldsOf(orders.id)).map((f) => f.name)).toEqual(before);
    expect(await automationsNow()).toEqual([]);

    // The ticked rest (the operation without a problem) applies.
    const flagged = new Set(proposed.problems.map((p) => p.operation));
    const applied = await ok<AssistantApplyResult>(
      request('POST', `/api/bases/${baseId}/assistant/apply`, {
        plan: {
          ...proposed.plan,
          operations: proposed.plan.operations.filter((_, i) => !flagged.has(i)),
        },
      })
    );
    expect(applied).toMatchObject({ fields: 1, automations: 0 });
    expect(await automationsNow()).toEqual([]);
  });
});
