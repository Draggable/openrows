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
  ...extra,
});

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
      { op: 'createView', table: 'Orders', name: 'Board', type: 'kanban', field: 'Status' },
      {
        op: 'createAutomation',
        table: 'Orders',
        name: 'Mark big orders',
        trigger: 'recordUpdated',
        watchFields: ['Qty'],
        actions: [{ type: 'updateRecord', cells: [{ field: 'Notes', value: 'Big order' }] }],
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
    auto.actions = [{ type: 'updateRecord', cells: [{ field: 'Notes', value: '{{nope}}' }] }];
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
});
