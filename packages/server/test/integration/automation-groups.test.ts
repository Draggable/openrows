// biome-ignore-all lint/suspicious/noThenProperty: `then` is an If / Otherwise step's list of steps (an array)
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  MAX_AUTOMATION_ACTIONS,
  MAX_REPEAT_ITEMS,
  MAX_RUN_ACTIONS,
  MAX_RUN_EXTERNAL_ACTIONS,
} from '@openrows/shared';
import { eq, sql } from 'drizzle-orm';
import type { JobInsert } from 'pg-boss';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCipher } from '../../src/auth/crypto.js';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { inScope } from '../../src/authz/scope.js';
import type { OutboundDeps } from '../../src/automations/outbound.js';
import { runAutomationJob } from '../../src/automations/run.js';
import { automationSubscriber } from '../../src/automations/subscriber.js';
import { qualified } from '../../src/data/columns.js';
import { automations, type bases, fields, type tables, type users } from '../../src/db/index.js';
import { unlimitedEntitlements } from '../../src/edition/oss.js';
import { memoryTransport } from '../../src/email/transport.js';
import { createField } from '../../src/fields/service.js';
import { type RelayJobData, relayOutbox } from '../../src/jobs/relay.js';
import { createLogger } from '../../src/lib/logger.js';
import { createSafeFetch, outboundPolicy } from '../../src/lib/safe-fetch/index.js';
import { createRecords, updateRecords } from '../../src/records/service.js';
import { createTable, loadTable } from '../../src/tables/service.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, createBase, createSession, createWorkspace } from '../helpers/factories.js';

type User = typeof users.$inferSelect;
type Base = typeof bases.$inferSelect;
type Table = typeof tables.$inferSelect;
type Json = ReturnType<typeof JSON.parse>;

interface Step {
  index: number;
  type: string;
  status: string;
  input: Json;
  output: Json;
  error: string | null;
  path?: string;
  then?: Step[];
  otherwise?: Step[];
  actions?: Step[];
  iterations?: { index: number; status: string; steps: Step[] }[];
}
interface Run {
  id: string;
  status: string;
  depth: number;
  error: string | null;
  steps: Step[];
}

/** A step tree as `type:status`, nested lists in brackets: for compact expectations. */
const shape = (steps: Step[] | undefined): unknown =>
  (steps ?? []).map((s) => {
    const own = `${s.type}:${s.status}`;
    if (s.type === 'branch')
      return { [own]: { then: shape(s.then), otherwise: shape(s.otherwise) } };
    if (s.type === 'repeat') {
      return s.iterations
        ? { [own]: s.iterations.map((it) => shape(it.steps)) }
        : { [own]: shape(s.actions) };
    }
    return own;
  });

/**
 * If / Otherwise and Repeat for each, as openrows_app: which path runs and what the other one
 * records, items and their tokens, the item cap and the per-run ceiling, nested steps' person
 * and permissions, the loop guard, outbound steps and their secrets inside groups, test runs.
 */
describe('automation groups', () => {
  const t = useTestDb();
  const logger = createLogger({ level: 'silent' });
  let app: ReturnType<typeof testApp>['app'];
  let owner: User;
  let creator: User;
  let cookies: Map<string, string>;
  let workspaceId: string;
  let base: Base;
  let server: Server;
  let port: number;
  let outbound: OutboundDeps;
  const received: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];

  const call = async (
    who: User,
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; body: Json }> => {
    const headers = new Headers({ cookie: `${SESSION_COOKIE}=${cookies.get(who.id)}` });
    if (body !== undefined) headers.set('content-type', 'application/json');
    const res = await app.request(path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const autos = () => `/api/bases/${base.id}/automations`;

  interface Made {
    table: Table;
    name: string;
    notes: string;
    points: string;
  }
  const makeTable = (name: string): Promise<Made> =>
    inScope(t.appDb, { userId: owner.id, workspaceId }, async (tx) => {
      const ctx = { tx, workspaceId, userId: owner.id };
      const created = await createTable(ctx, base, { name });
      const table = await loadTable(tx, created.id);
      const points = await createField(ctx, table, { name: 'Points', type: 'number' });
      const byName = (n: string) => {
        const f = created.fields.find((x) => x.name === n);
        if (!f) throw new Error(`no ${n}`);
        return f.id;
      };
      return { table, name: byName('Name'), notes: byName('Notes'), points: points.id };
    });
  const addRecord = async (m: Made, cells: Record<string, unknown>) => {
    const [r] = await inScope(t.appDb, { userId: owner.id, workspaceId }, (tx) =>
      createRecords(
        {
          tx,
          workspaceId,
          userId: owner.id,
          role: 'owner',
          entitlements: unlimitedEntitlements(),
          table: m.table,
        },
        [cells]
      )
    );
    if (!r) throw new Error('no record');
    return r;
  };
  const columnOf = new Map<string, string>();
  /** The live records' cells of one field, in id (creation) order. */
  const column = async (m: Made, fieldId: string) => {
    for (const f of await t.db.select().from(fields)) columnOf.set(f.id, f.dbColumn);
    const { rows } = await t.db.execute<Record<string, unknown>>(
      sql`SELECT * FROM ${qualified(m.table)} WHERE deleted_at IS NULL ORDER BY id`
    );
    return rows.map((r) => r[columnOf.get(fieldId) ?? '']);
  };

  const create = async (body: Record<string, unknown>, who = creator) => {
    const res = await call(who, 'POST', autos(), {
      name: 'Groups',
      enabled: true,
      trigger: { type: 'webhookReceived' },
      ...body,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; actions: Json[] };
  };
  /** Runs a webhook-received automation with this body, as the worker would. */
  const fire = (id: string, body: unknown, deps: Partial<OutboundDeps> = {}) =>
    runAutomationJob(
      { db: t.appDb, logger, outbound: { ...outbound, ...deps } },
      {
        workspaceId,
        subscriberId: id,
        hook: { requestId: uuidv7(), receivedAt: new Date().toISOString(), body },
      }
    );
  const lastRun = async (id: string): Promise<Run> => {
    const res = await call(creator, 'GET', `${autos()}/${id}/runs?limit=1`);
    expect(res.status).toBe(200);
    return res.body.runs[0] as Run;
  };
  const off = (id: string) => call(creator, 'PATCH', `${autos()}/${id}`, { enabled: false });

  /** Relays the outbox to automations and runs the jobs, until the chain ends. */
  const seen = new Set<string>();
  const pump = async () => {
    for (let i = 0; i < 10; i++) {
      const jobs: JobInsert<RelayJobData>[] = [];
      const deadline = Date.now() + 20_000;
      for (;;) {
        await relayOutbox(
          t.appDb,
          async (_queue, batch) => {
            jobs.push(...batch);
          },
          [automationSubscriber]
        );
        const { rows } = await t.db.execute<{ pending: string }>(
          sql`SELECT pending FROM outbox_relay_lag()`
        );
        if (Number(rows[0]?.pending ?? 0) === 0) break;
        if (Date.now() > deadline) throw new Error('pump: the relay is held back');
        await new Promise((r) => setTimeout(r, 100));
      }
      let ran = 0;
      for (const job of jobs) {
        if (job.id && seen.has(job.id)) continue;
        if (job.id) seen.add(job.id);
        await runAutomationJob({ db: t.appDb, logger }, job.data);
        ran++;
      }
      if (ran === 0) break;
    }
  };

  const noFilter = { conjunction: 'and', conditions: [] };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        received.push({ url: req.url ?? '', headers: req.headers, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
    );
    const built = testApp({
      db: t.appDb,
      env: {
        OUTBOUND_HTTP_ALLOW_HTTP: 'true',
        OUTBOUND_HTTP_PORTS: String(port),
        OUTBOUND_HTTP_ALLOW: '127.0.0.1',
      },
    });
    app = built.app;
    outbound = {
      cipher: createCipher(built.config.encryptionKey, 'automation-secret'),
      http: createSafeFetch(
        outboundPolicy({ allowHttp: true, extraPorts: [port], allow: ['127.0.0.1'], deny: [] })
      ),
      email: memoryTransport(),
      emailDailyLimit: 100,
    };
    const w = await createWorkspace(t.db);
    owner = w.owner;
    workspaceId = w.workspace.id;
    creator = await addMember(t.db, workspaceId, 'creator');
    cookies = new Map();
    for (const u of [owner, creator]) cookies.set(u.id, await createSession(t.db, u));
    base = await createBase(t.db, workspaceId, { name: 'Groups' });
    await pump();
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  describe('If / Otherwise', () => {
    it('runs Then when the record meets the conditions, Otherwise when not, nothing without one', async () => {
      const tasks = await makeTable('Branch tasks');
      const log = await makeTable('Branch log');
      const big = await addRecord(tasks, { [tasks.name]: 'Big', [tasks.points]: 10 });
      const small = await addRecord(tasks, { [tasks.name]: 'Small', [tasks.points]: 2 });
      const writeLog = (text: string) => ({
        type: 'createRecord',
        tableId: log.table.id,
        fields: { [log.name]: text },
      });
      const a = await create({
        actions: [
          {
            type: 'branch',
            tableId: tasks.table.id,
            recordId: '{{trigger.body.id}}',
            filter: {
              conjunction: 'and',
              conditions: [
                { fieldId: tasks.points, operator: '>=', value: '{{trigger.body.min}}' },
              ],
            },
            then: [writeLog('then {{trigger.body.id}}'), writeLog('then 2 {{steps.1.then.1.id}}')],
            otherwise: [writeLog('otherwise')],
          },
          writeLog('after: {{steps.1.path}} {{steps.1.matched}} [{{steps.1.then.1.id}}]'),
        ],
      });
      const b = await create({
        actions: [
          {
            type: 'branch',
            tableId: tasks.table.id,
            recordId: '{{trigger.body.id}}',
            filter: {
              conjunction: 'and',
              conditions: [{ fieldId: tasks.name, operator: 'is', value: 'Big' }],
            },
            then: [writeLog('only then')],
          },
        ],
      });

      // The record meets the conditions: Then runs; tokens see its steps and its path.
      expect(await fire(a.id, { id: big.id, min: 5 })).toMatchObject({ status: 'succeeded' });
      let run = await lastRun(a.id);
      expect(shape(run.steps)).toEqual([
        {
          'branch:succeeded': {
            then: ['createRecord:succeeded', 'createRecord:succeeded'],
            otherwise: ['createRecord:skipped'],
          },
        },
        'createRecord:succeeded',
      ]);
      expect(run.steps[0]?.path).toBe('then');
      expect(run.steps[0]?.output).toEqual({ path: 'then', matched: true });
      expect(run.steps[0]?.input).toMatchObject({ recordId: big.id });
      const firstThen = run.steps[0]?.then?.[0]?.output.id as string;
      expect(await column(log, log.name)).toEqual([
        `then ${big.id}`,
        `then 2 ${firstThen}`,
        `after: then true [${firstThen}]`,
      ]);

      // It doesn't: Otherwise runs, and tokens into Then are empty.
      await fire(a.id, { id: small.id, min: 5 });
      run = await lastRun(a.id);
      expect(run.steps[0]?.path).toBe('otherwise');
      expect((shape(run.steps) as unknown[])[0]).toEqual({
        'branch:succeeded': {
          then: ['createRecord:skipped', 'createRecord:skipped'],
          otherwise: ['createRecord:succeeded'],
        },
      });
      expect((await column(log, log.name)).slice(3)).toEqual([
        'otherwise',
        'after: otherwise false []',
      ]);

      // No record (an empty token): the conditions don't hold.
      await fire(a.id, { min: 5 });
      expect((await lastRun(a.id)).steps[0]?.path).toBe('otherwise');

      // Without an Otherwise, a record that doesn't match runs nothing and succeeds.
      await fire(b.id, { id: small.id });
      run = await lastRun(b.id);
      expect(run.status).toBe('succeeded');
      expect(shape(run.steps)).toEqual([
        { 'branch:succeeded': { then: ['createRecord:skipped'], otherwise: [] } },
      ]);
      // A value that isn't a record id fails the step clearly.
      await fire(b.id, { id: 'nope' });
      run = await lastRun(b.id);
      expect(run.status).toBe('failed');
      expect(run.error).toBe('Step 1 failed: "nope" isn\'t a record id.');
      for (const id of [a.id, b.id]) await off(id);
    });
  });

  describe('Repeat for each', () => {
    it('runs its steps per item with the item, its number and earlier steps as tokens', async () => {
      const people = await makeTable('Repeat people');
      const log = await makeTable('Repeat log');
      for (const [name, points] of [
        ['Ada', 3],
        ['Grace', 8],
        ['Linus', 1],
      ] as const) {
        await addRecord(people, { [people.name]: name, [people.points]: points });
      }
      const a = await create({
        actions: [
          { type: 'findRecords', tableId: people.table.id, filter: noFilter, limit: 10 },
          {
            type: 'repeat',
            items: '{{steps.1.records}}',
            actions: [
              {
                type: 'createRecord',
                tableId: log.table.id,
                fields: {
                  [log.name]:
                    '{{steps.2.index}}/{{steps.1.count}} {{steps.2.item.fields.Name}} {{trigger.body.tag}}',
                },
              },
              {
                type: 'branch',
                tableId: people.table.id,
                recordId: '{{steps.2.item.id}}',
                filter: {
                  conjunction: 'and',
                  conditions: [{ fieldId: people.points, operator: '>', value: 2 }],
                },
                then: [
                  {
                    type: 'updateRecord',
                    tableId: log.table.id,
                    recordId: '{{steps.2.actions.1.id}}',
                    fields: {
                      [log.notes]: 'high, logged as {{steps.2.actions.1.record.fields.Name}}',
                    },
                  },
                ],
              },
            ],
          },
          {
            type: 'createRecord',
            tableId: log.table.id,
            fields: { [log.name]: 'done: {{steps.2.count}} [{{steps.2.item}}]' },
          },
        ],
      });
      await fire(a.id, { tag: '#1' });
      const run = await lastRun(a.id);
      expect(run.status).toBe('succeeded');
      const repeat = run.steps[1];
      expect(repeat?.output).toEqual({ count: 3 });
      expect(repeat?.iterations?.map((it) => [it.index, it.status])).toEqual([
        [1, 'succeeded'],
        [2, 'succeeded'],
        [3, 'succeeded'],
      ]);
      expect(repeat?.iterations?.map((it) => it.steps[1]?.path)).toEqual([
        'then',
        'then',
        'otherwise',
      ]);
      expect(await column(log, log.name)).toEqual([
        '1/3 Ada #1',
        '2/3 Grace #1',
        '3/3 Linus #1',
        // After the group, its current item is gone.
        'done: 3 []',
      ]);
      expect(await column(log, log.notes)).toEqual([
        'high, logged as 1/3 Ada #1',
        'high, logged as 2/3 Grace #1',
        null,
        null,
      ]);
      await off(a.id);
    });

    it(`runs for at most ${MAX_REPEAT_ITEMS} items: a longer list fails before any item`, async () => {
      const log = await makeTable('Cap log');
      const a = await create({
        actions: [
          {
            type: 'repeat',
            items: '{{trigger.body.list}}',
            actions: [
              {
                type: 'createRecord',
                tableId: log.table.id,
                fields: { [log.name]: '{{steps.1.item}}' },
              },
            ],
          },
          { type: 'createRecord', tableId: log.table.id, fields: { [log.name]: 'after' } },
        ],
      });
      const list = (n: number) => Array.from({ length: n }, (_, i) => `item ${i + 1}`);
      await fire(a.id, { list: list(MAX_REPEAT_ITEMS + 1) });
      let run = await lastRun(a.id);
      expect(run.status).toBe('failed');
      expect(run.error).toBe(
        `Step 1 failed: The list has ${MAX_REPEAT_ITEMS + 1} items; a Repeat for each runs for at most ${MAX_REPEAT_ITEMS}.`
      );
      expect(shape(run.steps)).toEqual([
        { 'repeat:failed': ['createRecord:skipped'] },
        'createRecord:skipped',
      ]);
      expect(await column(log, log.name)).toEqual([]);

      await fire(a.id, { list: list(MAX_REPEAT_ITEMS) });
      run = await lastRun(a.id);
      expect(run.status).toBe('succeeded');
      expect(run.steps[0]?.iterations).toHaveLength(MAX_REPEAT_ITEMS);
      // The history keeps the first items' input and output; the rest, their status.
      expect(run.steps[0]?.iterations?.[0]?.steps[0]?.input).not.toBeNull();
      expect(run.steps[0]?.iterations?.[50]?.steps[0]).toMatchObject({
        status: 'succeeded',
        input: null,
        output: null,
      });
      expect(await column(log, log.name)).toHaveLength(MAX_REPEAT_ITEMS + 1);

      // One value that isn't a list runs once; nothing runs none.
      await fire(a.id, { list: 'single' });
      expect((await lastRun(a.id)).steps[0]?.output).toEqual({ count: 1 });
      await fire(a.id, {});
      expect((await lastRun(a.id)).steps[0]?.output).toEqual({ count: 0 });
      await off(a.id);
    });

    it(`stops a run at ${MAX_RUN_ACTIONS} actions in all, counting each item's`, async () => {
      const m = await makeTable('Ceiling');
      await addRecord(m, { [m.name]: 'only' });
      const find = { type: 'findRecords', tableId: m.table.id, filter: noFilter, limit: 1 };
      const a = await create({
        actions: [
          {
            type: 'repeat',
            items: '{{trigger.body.outer}}',
            actions: [{ type: 'repeat', items: '{{trigger.body.inner}}', actions: [find, find] }],
          },
          find,
        ],
      });
      // The outer repeat, then per item the inner repeat and 3 × 2 actions: 1 + 71 × 7 = 498,
      // so item 72's inner repeat is the 499th and its first item's second action the 501st.
      await fire(a.id, {
        outer: Array.from({ length: 100 }, (_, i) => i),
        inner: ['a', 'b', 'c'],
      });
      const run = await lastRun(a.id);
      expect(run.status).toBe('failed');
      expect(run.error).toBe(
        `Item 72: Item 1: Step 1.actions.1.actions.2 failed: This run reached its limit of ${MAX_RUN_ACTIONS} actions; the rest weren't run.`
      );
      const outer = run.steps[0];
      expect(outer?.status).toBe('failed');
      expect(outer?.iterations).toHaveLength(72);
      expect(outer?.iterations?.at(-1)?.status).toBe('failed');
      expect(run.steps[1]?.status).toBe('skipped');
      await off(a.id);
    });

    it('counts each repeat it starts, so repeats that run no action still stop', async () => {
      // Three levels of repeats over 100 items, the innermost empty: without counting the
      // repeats themselves, a million iterations (and their history) for no action at all.
      const a = await create({
        actions: [
          {
            type: 'repeat',
            items: '{{trigger.body.list}}',
            actions: [
              {
                type: 'repeat',
                items: '{{trigger.body.list}}',
                actions: [{ type: 'repeat', items: '{{trigger.body.list}}', actions: [] }],
              },
            ],
          },
        ],
      });
      await fire(a.id, { list: Array.from({ length: MAX_REPEAT_ITEMS }, (_, i) => i) });
      const run = await lastRun(a.id);
      expect(run.status).toBe('failed');
      // 1 + 4 × (1 + 100) = 405; item 5's middle repeat is the 406th, its 95th innermost the 501st.
      expect(run.error).toBe(
        `Item 5: Item 95: Step 1.actions.1.actions.1 failed: This run reached its limit of ${MAX_RUN_ACTIONS} actions; the rest weren't run.`
      );
      const iterations = (steps: Step[] | undefined): number =>
        (steps ?? []).reduce(
          (n, s) => n + (s.iterations ?? []).reduce((m, it) => m + 1 + iterations(it.steps), 0),
          0
        );
      expect(iterations(run.steps)).toBeLessThan(MAX_RUN_ACTIONS * MAX_REPEAT_ITEMS);
      expect(run.steps[0]?.iterations).toHaveLength(5);
      await off(a.id);
    });
  });

  describe('failures, permissions and the loop guard', () => {
    it('records skipped steps after a failure inside a group, nested ones too', async () => {
      const log = await makeTable('Skip log');
      const a = await create({
        actions: [
          {
            type: 'repeat',
            items: '{{trigger.body.list}}',
            actions: [
              {
                type: 'updateRecord',
                tableId: log.table.id,
                recordId: '{{steps.1.item}}',
                fields: { [log.name]: 'x' },
              },
              { type: 'createRecord', tableId: log.table.id, fields: {} },
            ],
          },
          {
            type: 'branch',
            tableId: log.table.id,
            recordId: '{{trigger.body.id}}',
            filter: noFilter,
            then: [{ type: 'createRecord', tableId: log.table.id, fields: {} }],
            otherwise: [{ type: 'repeat', items: '{{trigger.body.list}}', actions: [] }],
          },
        ],
      });
      await fire(a.id, { list: ['not-an-id'] });
      const run = await lastRun(a.id);
      expect(run.status).toBe('failed');
      expect(run.error).toBe('Item 1: Step 1.actions.1 failed: "not-an-id" isn\'t a record id.');
      expect(shape(run.steps)).toEqual([
        { 'repeat:failed': [['updateRecord:failed', 'createRecord:skipped']] },
        {
          'branch:skipped': {
            then: ['createRecord:skipped'],
            otherwise: [{ 'repeat:skipped': [] }],
          },
        },
      ]);
      await off(a.id);
    });

    it("runs nested steps as the automation's person: a field permission refuses them like top-level ones", async () => {
      const log = await makeTable('Perm log');
      // Only owners may edit the log's Notes; the automation runs as a creator.
      await t.db
        .update(fields)
        .set({ permissions: { edit: { level: 'specific', userIds: [], roles: ['owner'] } } })
        .where(eq(fields.id, log.notes));
      const allowed = { type: 'createRecord', tableId: log.table.id, fields: { [log.name]: 'ok' } };
      const refused = {
        type: 'createRecord',
        tableId: log.table.id,
        fields: { [log.notes]: 'not allowed' },
      };
      const top = await create({ actions: [allowed, refused] });
      const nested = await create({
        actions: [
          {
            type: 'branch',
            tableId: log.table.id,
            recordId: '{{trigger.body.id}}',
            filter: noFilter,
            then: [],
            otherwise: [
              { type: 'repeat', items: '{{trigger.body.list}}', actions: [allowed, refused] },
            ],
          },
        ],
      });
      await fire(top.id, {});
      await fire(nested.id, { list: [1, 2] });
      const topRun = await lastRun(top.id);
      const nestedRun = await lastRun(nested.id);
      expect(topRun.status).toBe('failed');
      expect(nestedRun.status).toBe('failed');
      const topError = topRun.steps[1]?.error;
      expect(topError).toBeTruthy();
      const inner = nestedRun.steps[0]?.otherwise?.[0];
      expect(inner?.iterations).toHaveLength(1);
      expect(inner?.iterations?.[0]?.steps.map((s) => [s.status, s.error])).toEqual([
        ['succeeded', null],
        ['failed', topError],
      ]);
      expect(nestedRun.error).toBe(`Item 1: Step 1.otherwise.1.actions.2 failed: ${topError}`);
      // The refused write was rolled back alone; the steps before it stay.
      expect(await column(log, log.name)).toEqual(['ok', 'ok']);
      expect(await column(log, log.notes)).toEqual([null, null]);
      for (const id of [top.id, nested.id]) await off(id);
    });

    it('keeps the loop guard for writes made inside groups', async () => {
      const m = await makeTable('Group loop');
      const a = await create({
        trigger: { type: 'recordUpdated', tableId: m.table.id, fieldIds: [m.notes] },
        actions: [
          {
            type: 'branch',
            tableId: m.table.id,
            recordId: '{{trigger.record.id}}',
            filter: noFilter,
            then: [
              {
                type: 'repeat',
                items: '{{trigger.record.id}}',
                actions: [
                  {
                    type: 'updateRecord',
                    tableId: m.table.id,
                    recordId: '{{steps.1.then.1.item}}',
                    fields: { [m.notes]: '{{trigger.record.fields.Notes}}!' },
                  },
                ],
              },
            ],
          },
        ],
      });
      const r = await addRecord(m, { [m.name]: 'Ping' });
      await pump();
      await inScope(t.appDb, { userId: owner.id, workspaceId }, (tx) =>
        updateRecords(
          {
            tx,
            workspaceId,
            userId: owner.id,
            role: 'owner',
            entitlements: unlimitedEntitlements(),
            table: m.table,
          },
          [{ id: r.id, fields: { [m.notes]: 'go' } }]
        )
      );
      await pump();
      const res = await call(creator, 'GET', `${autos()}/${a.id}/runs?limit=10`);
      const runs = res.body.runs as Run[];
      expect(runs.map((x) => [x.depth, x.status]).reverse()).toEqual([
        [1, 'succeeded'],
        [2, 'succeeded'],
        [3, 'succeeded'],
        [4, 'skipped'],
      ]);
      expect(runs[0]?.error).toMatch(/loop guard/);
      expect(await column(m, m.notes)).toEqual(['go!!!']);
      await off(a.id);
    });
  });

  describe('outbound steps inside groups', () => {
    it('keeps nested secrets encrypted and sends through the safe client; private addresses stay refused', async () => {
      received.length = 0;
      const hook = {
        type: 'httpRequest',
        method: 'POST',
        url: `http://127.0.0.1:${port}/each`,
        headers: [{ name: 'X-Key', value: 'nested-secret-value', secret: true }],
        body: { item: '{{steps.1.item}}' },
      };
      const a = await create({
        actions: [
          {
            type: 'repeat',
            items: '{{trigger.body.list}}',
            actions: [
              hook,
              {
                type: 'httpRequest',
                method: 'GET',
                url: '{{steps.1.item}}',
                headers: [],
              },
            ],
          },
        ],
      });
      // The stored actions hold no secret value; the response shows the header as secret.
      const [row] = await t.db.select().from(automations).where(eq(automations.id, a.id));
      expect(JSON.stringify(row?.actions)).not.toContain('nested-secret-value');
      expect(row?.secretsEncrypted).not.toBeNull();
      expect(a.actions[0].actions[0].headers).toEqual([{ name: 'X-Key', secret: true }]);

      // Saving again without the value keeps it (same place, same URL).
      const kept = await call(creator, 'PATCH', `${autos()}/${a.id}`, { actions: a.actions });
      expect(kept.status, JSON.stringify(kept.body)).toBe(200);

      // A loop over private, link-local and metadata addresses: each GET is refused.
      const targets = [
        `http://127.0.0.1:${port}/allowed`,
        'http://10.0.0.1/',
        'http://169.254.169.254/latest/meta-data/',
        'http://[::1]/',
      ];
      const strict = createSafeFetch(
        outboundPolicy({ allowHttp: true, extraPorts: [port], allow: [], deny: [] })
      );
      await fire(a.id, { list: targets }, { http: strict });
      let run = await lastRun(a.id);
      expect(run.status).toBe('failed');
      // The worker's rules refuse even the first (loopback) request inside the loop.
      expect(run.steps[0]?.iterations?.[0]?.steps[0]?.error).toMatch(/request failed/);
      expect(received).toEqual([]);

      // With the allowlisted local server, the nested step sends its secret header per item;
      // the run log redacts it. The private targets are then refused one by one.
      for (const target of targets.slice(1)) {
        await fire(a.id, { list: [target] });
        run = await lastRun(a.id);
        expect(run.status).toBe('failed');
        expect(run.steps[0]?.iterations?.[0]?.steps[1]?.error).toMatch(/request failed/);
      }
      expect(received).toHaveLength(3);
      expect(received.every((r) => r.headers['x-key'] === 'nested-secret-value')).toBe(true);
      expect(JSON.parse(received[0]?.body ?? '{}')).toEqual({ item: 'http://10.0.0.1/' });
      expect(JSON.stringify(run.steps)).not.toContain('nested-secret-value');
      await off(a.id);
    });
  });

  describe('external steps per run', () => {
    const limitMessage = `This run reached its limit of ${MAX_RUN_EXTERNAL_ACTIONS} external steps (HTTP requests, Slack and Discord messages, emails and scripts); the rest weren't run.`;

    it(`stops a run at ${MAX_RUN_EXTERNAL_ACTIONS} external steps, live and in a test run; record steps still count only toward the actions`, async () => {
      const m = await makeTable('External');
      const log = await makeTable('External log');
      await inScope(t.appDb, { userId: owner.id, workspaceId }, (tx) =>
        createRecords(
          {
            tx,
            workspaceId,
            userId: owner.id,
            role: 'owner',
            entitlements: unlimitedEntitlements(),
            table: m.table,
          },
          Array.from({ length: 30 }, (_, i) => ({ [m.name]: `r${i + 1}` }))
        )
      );
      const actions = [
        { type: 'findRecords', tableId: m.table.id, filter: noFilter, limit: 30 },
        {
          type: 'repeat',
          items: '{{steps.1.records}}',
          actions: [
            {
              type: 'createRecord',
              tableId: log.table.id,
              fields: { [log.name]: '{{steps.2.item.fields.Name}}' },
            },
            {
              type: 'httpRequest',
              method: 'POST',
              url: `http://127.0.0.1:${port}/external`,
              headers: [],
              body: { item: '{{steps.2.item.fields.Name}}' },
            },
          ],
        },
        { type: 'createRecord', tableId: log.table.id, fields: { [log.name]: 'after' } },
      ];
      const expected = `Item ${MAX_RUN_EXTERNAL_ACTIONS + 1}: Step 2.actions.2 failed: ${limitMessage}`;

      received.length = 0;
      const a = await create({ actions });
      await fire(a.id, {});
      const run = await lastRun(a.id);
      expect(run.status).toBe('failed');
      expect(run.error).toBe(expected);
      const repeat = run.steps[1];
      expect(repeat?.iterations).toHaveLength(MAX_RUN_EXTERNAL_ACTIONS + 1);
      expect(shape(repeat?.iterations?.at(-1)?.steps)).toEqual([
        'createRecord:succeeded',
        'httpRequest:failed',
      ]);
      expect(run.steps[2]?.status).toBe('skipped');
      // 25 requests went out; the 26th item's record step still ran (its own savepoint).
      expect(received).toHaveLength(MAX_RUN_EXTERNAL_ACTIONS);
      expect(received.map((r) => JSON.parse(r.body).item)).toEqual(
        Array.from({ length: MAX_RUN_EXTERNAL_ACTIONS }, (_, i) => `r${i + 1}`)
      );
      expect(await column(log, log.name)).toHaveLength(MAX_RUN_EXTERNAL_ACTIONS + 1);
      await off(a.id);

      // A test run counts the same way.
      received.length = 0;
      const tested = await create({
        trigger: { type: 'recordCreated', tableId: m.table.id },
        enabled: false,
        actions,
      });
      const [first] = await t.db
        .execute<{ id: string }>(sql`SELECT id FROM ${qualified(m.table)} ORDER BY id LIMIT 1`)
        .then((r) => r.rows);
      const res = await call(creator, 'POST', `${autos()}/${tested.id}/test`, {
        recordId: first?.id,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((res.body as Run).status).toBe('failed');
      expect((res.body as Run).error).toBe(expected);
      expect(received).toHaveLength(MAX_RUN_EXTERNAL_ACTIONS);
    });

    it('lets a flat automation run as many external steps as it can hold', async () => {
      received.length = 0;
      const a = await create({
        actions: Array.from({ length: MAX_AUTOMATION_ACTIONS }, (_, i) => ({
          type: 'httpRequest',
          method: 'POST',
          url: `http://127.0.0.1:${port}/flat`,
          headers: [],
          body: { n: i + 1 },
        })),
      });
      await fire(a.id, {});
      const run = await lastRun(a.id);
      expect(run.status, run.error ?? '').toBe('succeeded');
      expect(received).toHaveLength(MAX_AUTOMATION_ACTIONS);
      await off(a.id);
    });
  });

  describe('the builder', () => {
    it('saves nested steps and refuses too many, too deep or misplaced tokens with their paths', async () => {
      const m = await makeTable('Builder');
      const leaf = { type: 'createRecord', tableId: m.table.id, fields: {} };
      const branch = (then: unknown[]) => ({
        type: 'branch',
        tableId: m.table.id,
        recordId: '{{trigger.body.id}}',
        filter: noFilter,
        then,
      });
      const repeat = (actions: unknown[]) => ({
        type: 'repeat',
        items: '{{trigger.body.l}}',
        actions,
      });
      const post = (actions: unknown[]) =>
        call(creator, 'POST', autos(), {
          name: 'B',
          trigger: { type: 'webhookReceived' },
          actions,
        });
      const ok = await post([branch([repeat([leaf])])]);
      expect(ok.status).toBe(201);
      expect(ok.body.actions).toEqual([{ ...branch([repeat([leaf])]), otherwise: [] }]);
      const deep = await post([branch([repeat([branch([leaf])])])]);
      expect(deep.status).toBe(422);
      expect(deep.body.errors[0].path).toBe('actions.0.then.0.actions.0.then.0');
      const many = await post([repeat(Array.from({ length: 25 }, () => leaf))]);
      expect(many.status).toBe(422);
      const wrongTable = await post([
        branch([{ ...leaf, tableId: '01a17db5-dd06-713a-bc40-74cc8eb80a47' }]),
      ]);
      expect(wrongTable.status).toBe(422);
      expect(wrongTable.body.errors[0]).toEqual({
        path: 'actions.0.then.0.tableId',
        message: 'No such table in this base.',
      });
      const badFilter = await post([
        {
          ...branch([]),
          filter: {
            conjunction: 'and',
            conditions: [{ fieldId: m.points, operator: 'contains', value: 'x' }],
          },
        },
      ]);
      expect(badFilter.status).toBe(422);
      expect(badFilter.body.errors[0].path).toMatch(/^actions\.0\b/);
    });

    it('test runs show which path ran and each item', async () => {
      const m = await makeTable('Tested');
      const r = await addRecord(m, { [m.name]: 'Sample', [m.points]: 4 });
      const a = await create({
        trigger: { type: 'recordCreated', tableId: m.table.id },
        enabled: false,
        actions: [
          {
            type: 'branch',
            tableId: m.table.id,
            recordId: '{{trigger.record.id}}',
            filter: {
              conjunction: 'and',
              conditions: [{ fieldId: m.points, operator: '>', value: 3 }],
            },
            then: [
              {
                type: 'repeat',
                items: '{{trigger.record.fields.Name}}',
                actions: [
                  {
                    type: 'updateRecord',
                    tableId: m.table.id,
                    recordId: '{{trigger.record.id}}',
                    fields: { [m.notes]: 'tested {{steps.1.then.1.item}}' },
                  },
                ],
              },
            ],
          },
        ],
      });
      const res = await call(creator, 'POST', `${autos()}/${a.id}/test`, { recordId: r.id });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const run = res.body as Run;
      expect(run.status).toBe('succeeded');
      expect(run.steps[0]?.path).toBe('then');
      expect(shape(run.steps)).toEqual([
        {
          'branch:succeeded': {
            then: [{ 'repeat:succeeded': [['updateRecord:succeeded']] }],
            otherwise: [],
          },
        },
      ]);
      expect(await column(m, m.notes)).toEqual(['tested Sample']);
    });
  });
});
