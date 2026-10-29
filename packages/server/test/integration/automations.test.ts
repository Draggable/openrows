import { eq, sql } from 'drizzle-orm';
import type { JobInsert } from 'pg-boss';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { inScope } from '../../src/authz/scope.js';
import { runAutomationJob } from '../../src/automations/run.js';
import {
  automationSubscriber,
  pruneAutomationRuns,
  scheduleDueAutomations,
} from '../../src/automations/subscriber.js';
import { qualified } from '../../src/data/columns.js';
import {
  automationMatches,
  automationRunCounts,
  automationRuns,
  automations,
  type bases,
  fields,
  outbox,
  recordRevisions,
  type tables,
  type users,
  workspaceMembers,
} from '../../src/db/index.js';
import { unlimitedEntitlements } from '../../src/edition/oss.js';
import { createField } from '../../src/fields/service.js';
import { type RelayJobData, relayOutbox } from '../../src/jobs/relay.js';
import { builtinQueues, type RunningWorker, startWorker } from '../../src/jobs/runtime.js';
import { createLogger } from '../../src/lib/logger.js';
import { createRecords, updateRecords } from '../../src/records/service.js';
import { createTable, loadTable } from '../../src/tables/service.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, createBase, createSession, createWorkspace } from '../helpers/factories.js';

type User = typeof users.$inferSelect;
type Table = typeof tables.$inferSelect;
type Base = typeof bases.$inferSelect;
type Json = ReturnType<typeof JSON.parse>;

/**
 * Automations as openrows_app: management (creators only, checked configs, 50 per base),
 * each trigger type through the outbox relay (or the scheduler) and the run job, the steps and
 * tokens, the loop guard, idempotency on replays, field permissions and lost access.
 */
describe('automations', () => {
  const t = useTestDb();
  const logger = createLogger({ level: 'silent' });
  let app: ReturnType<typeof testApp>['app'];
  let owner: User;
  let creator: User;
  let editor: User;
  let cookies: Map<string, string>;
  let workspaceId: string;
  let base: Base;
  let otherBase: Base;
  let otherBaseId: string;

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
  const autos = (b = base.id) => `/api/bases/${b}/automations`;

  interface Made {
    table: Table;
    name: string;
    notes: string;
    points: string;
  }

  /** A table (Name, Notes, Status and a Points number) in the base, as the owner. */
  const makeTable = (name: string, inBase: Base = base): Promise<Made> =>
    inScope(t.appDb, { userId: owner.id, workspaceId }, async (tx) => {
      const ctx = { tx, workspaceId, userId: owner.id };
      const created = await createTable(ctx, inBase, { name });
      const table = await loadTable(tx, created.id);
      const points = await createField(ctx, table, { name: 'Points', type: 'number' });
      const byName = (n: string) => {
        const f = created.fields.find((x) => x.name === n);
        if (!f) throw new Error(`no ${n}`);
        return f.id;
      };
      return { table, name: byName('Name'), notes: byName('Notes'), points: points.id };
    });

  const write = <T>(
    who: User,
    fn: (ctx: Parameters<typeof createRecords>[0]) => Promise<T>,
    table: Table
  ) =>
    inScope(t.appDb, { userId: who.id, workspaceId }, (tx) =>
      fn({
        tx,
        workspaceId,
        userId: who.id,
        role: 'owner',
        entitlements: unlimitedEntitlements(),
        table,
      })
    );
  const addRecord = async (m: Made, cells: Record<string, unknown>) => {
    const [r] = await write(owner, (ctx) => createRecords(ctx, [cells]), m.table);
    if (!r) throw new Error('no record');
    return r;
  };
  const edit = (m: Made, id: string, cells: Record<string, unknown>) =>
    write(owner, (ctx) => updateRecords(ctx, [{ id, fields: cells }]), m.table);

  const recordsOf = async (m: Made) =>
    (
      await t.db.execute<Record<string, unknown>>(
        sql`SELECT * FROM ${qualified(m.table)} WHERE deleted_at IS NULL ORDER BY id`
      )
    ).rows;
  const cell = (row: Record<string, unknown>, fieldId: string) => row[columnOf.get(fieldId) ?? ''];
  const columnOf = new Map<string, string>();
  const loadColumns = async () => {
    for (const f of await t.db.select().from(fields)) columnOf.set(f.id, f.dbColumn);
  };

  /** Jobs pg-boss would have: ids already seen are skipped (its ON CONFLICT DO NOTHING). */
  const seen = new Set<string>();
  const runAll = async (jobs: JobInsert<RelayJobData>[]) => {
    const outcomes = [];
    for (const job of jobs) {
      if (job.id && seen.has(job.id)) continue;
      if (job.id) seen.add(job.id);
      outcomes.push(await runAutomationJob({ db: t.appDb, logger }, job.data));
    }
    return outcomes;
  };
  /**
   * Waits until the relay can read every event past its cursor: it holds events back while an
   * older transaction anywhere in the cluster is open, as other test files' are.
   */
  const relayable = async () => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const { rows } = await t.db.execute<{ pending: string; readable: string }>(
        sql`SELECT (SELECT pending FROM outbox_relay_lag()) AS pending,
                   (SELECT count(*) FROM outbox_relay_next(100000)) AS readable`
      );
      if (Number(rows[0]?.readable ?? 0) >= Number(rows[0]?.pending ?? 0)) return;
      if (Date.now() > deadline) throw new Error('relayable: the relay is held back');
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  /**
   * Relays the outbox to automations and runs the jobs, until the chain ends. The relay only
   * reads events once no older transaction in the cluster is still open, so each round
   * waits until it has read every event written so far: one event at a time, as a live worker.
   */
  const pump = async () => {
    const outcomes = [];
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
      const ran = await runAll(jobs);
      outcomes.push(...ran);
      if (ran.length === 0) break;
    }
    return outcomes;
  };

  const createAutomation = async (body: Record<string, unknown>, who = creator) => {
    const res = await call(who, 'POST', autos(), { enabled: true, ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; createdBy: string; nextRunAt: string | null };
  };
  const runsOf = async (id: string) => {
    const res = await call(creator, 'GET', `${autos()}/${id}/runs?limit=100`);
    expect(res.status).toBe(200);
    return res.body.runs as {
      id: string;
      status: string;
      mode: string;
      depth: number;
      error: string | null;
      steps: { index: number; status: string; error: string | null; output: Json }[];
      trigger: Json;
    }[];
  };
  const off = (id: string) => call(creator, 'PATCH', `${autos()}/${id}`, { enabled: false });

  beforeAll(async () => {
    app = testApp({ db: t.appDb }).app;
    const w = await createWorkspace(t.db);
    owner = w.owner;
    workspaceId = w.workspace.id;
    creator = await addMember(t.db, workspaceId, 'creator');
    editor = await addMember(t.db, workspaceId, 'editor');
    cookies = new Map();
    for (const u of [owner, creator, editor]) cookies.set(u.id, await createSession(t.db, u));
    base = await createBase(t.db, workspaceId, { name: 'Ops' });
    otherBase = await createBase(t.db, workspaceId, { name: 'Other' });
    otherBaseId = otherBase.id;
    // Start the relay past the setup's events.
    await pump();
  });

  describe('management', () => {
    it('creates, reads, lists, changes and deletes; off by default', async () => {
      const m = await makeTable('Manage');
      const res = await call(creator, 'POST', autos(), {
        name: 'Greet',
        trigger: { type: 'recordCreated', tableId: m.table.id },
        actions: [
          {
            type: 'updateRecord',
            tableId: m.table.id,
            recordId: '{{trigger.record.id}}',
            fields: { [m.notes]: 'hi' },
          },
        ],
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        name: 'Greet',
        enabled: false,
        createdBy: creator.id,
        nextRunAt: null,
      });
      const id = res.body.id as string;
      expect((await call(creator, 'GET', `${autos()}/${id}`)).body).toMatchObject({ id });
      const listed = await call(owner, 'GET', autos());
      expect(listed.body.automations.map((a: { id: string }) => a.id)).toContain(id);
      const on = await call(owner, 'PATCH', `${autos()}/${id}`, { enabled: true, name: 'Hello' });
      // Turned on by the owner: it runs as the owner from now on.
      expect(on.body).toMatchObject({ enabled: true, name: 'Hello', createdBy: owner.id });
      expect((await call(creator, 'DELETE', `${autos()}/${id}`)).status).toBe(204);
      expect((await call(creator, 'GET', `${autos()}/${id}`)).status).toBe(404);
    });

    it('checks tables, fields, filters and tokens against the base', async () => {
      const m = await makeTable('Checks');
      const other = await makeTable('Elsewhere', otherBase);
      const bad = async (body: Record<string, unknown>, path: string) => {
        const res = await call(creator, 'POST', autos(), { name: 'Bad', ...body });
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        expect(JSON.stringify(res.body)).toContain(path);
      };
      await bad({ trigger: { type: 'recordCreated', tableId: other.table.id } }, 'trigger.tableId');
      await bad(
        { trigger: { type: 'recordUpdated', tableId: m.table.id, fieldIds: [other.notes] } },
        'trigger.fieldIds.0'
      );
      await bad(
        {
          trigger: {
            type: 'recordMatches',
            tableId: m.table.id,
            filter: { conditions: [{ fieldId: m.points, operator: 'contains', value: 'x' }] },
          },
        },
        'trigger.filter'
      );
      await bad(
        {
          trigger: { type: 'recordCreated', tableId: m.table.id },
          actions: [{ type: 'createRecord', tableId: m.table.id, fields: { [other.notes]: 'x' } }],
        },
        `actions.0.fields.${other.notes}`
      );
      await bad(
        {
          trigger: { type: 'recordCreated', tableId: m.table.id },
          actions: [
            {
              type: 'createRecord',
              tableId: m.table.id,
              fields: { [m.notes]: '{{steps.1.records}}' },
            },
          ],
        },
        'actions'
      );
      await bad(
        {
          trigger: { type: 'recordCreated', tableId: m.table.id },
          actions: [
            { type: 'createRecord', tableId: m.table.id, fields: { [m.notes]: '{{process.env}}' } },
          ],
        },
        'actions'
      );
      await bad(
        { trigger: { type: 'recordCreated', tableId: m.table.id }, enabled: true },
        'enabled'
      );
      await bad(
        {
          trigger: {
            type: 'scheduled',
            schedule: { kind: 'cron', expression: '* * * * *', timeZone: 'UTC' },
          },
        },
        'trigger'
      );
      const tooMany = Array.from({ length: 26 }, () => ({
        type: 'findRecords',
        tableId: m.table.id,
      }));
      expect(
        (
          await call(creator, 'POST', autos(), {
            name: 'x',
            trigger: { type: 'recordCreated', tableId: m.table.id },
            actions: tooMany,
          })
        ).status
      ).toBe(422);
    });

    it('is for creators; another base’s automation ids are 404', async () => {
      const m = await makeTable('Who');
      const created = await createAutomation({
        name: 'Mine',
        trigger: { type: 'recordCreated', tableId: m.table.id },
        enabled: false,
      });
      expect((await call(editor, 'GET', autos())).status).toBe(403);
      expect(
        (
          await call(editor, 'POST', autos(), {
            name: 'x',
            trigger: { type: 'recordCreated', tableId: m.table.id },
          })
        ).status
      ).toBe(403);
      expect((await call(editor, 'GET', `${autos()}/${created.id}/runs`)).status).toBe(403);
      expect(
        (await call(creator, 'PATCH', `${autos(otherBaseId)}/${created.id}`, { enabled: false }))
          .status
      ).toBe(404);
      expect((await call(creator, 'GET', `${autos(otherBaseId)}/${created.id}/runs`)).status).toBe(
        404
      );
      await call(creator, 'DELETE', `${autos()}/${created.id}`);
    });

    it('allows 50 automations per base', async () => {
      const m = await makeTable('Cap');
      const before = (await call(creator, 'GET', autos())).body.automations.length as number;
      const ids: string[] = [];
      for (let i = before; i < 50; i++) {
        ids.push(
          (
            await createAutomation({
              name: `n${i}`,
              trigger: { type: 'recordCreated', tableId: m.table.id },
              enabled: false,
            })
          ).id
        );
      }
      const extra = await call(creator, 'POST', autos(), {
        name: 'x',
        trigger: { type: 'recordCreated', tableId: m.table.id },
      });
      expect(extra.status).toBe(409);
      for (const id of ids)
        expect((await call(creator, 'DELETE', `${autos()}/${id}`)).status).toBe(204);
    });
  });

  describe('triggers', () => {
    it('record created: creates a record from tokens, once, at depth 1, counted', async () => {
      const tasks = await makeTable('Created tasks');
      const log = await makeTable('Created log');
      await loadColumns();
      const a = await createAutomation({
        name: 'Log new tasks',
        trigger: { type: 'recordCreated', tableId: tasks.table.id },
        actions: [
          {
            type: 'createRecord',
            tableId: log.table.id,
            fields: {
              [log.name]: 'New: {{trigger.record.fields.Name}}',
              [log.points]: '{{trigger.record.fields.Points}}',
              [log.notes]: 'from {{trigger.record.id}}',
            },
          },
        ],
      });
      const task = await addRecord(tasks, { [tasks.name]: 'Launch', [tasks.points]: 8 });
      const outcomes = await pump();
      expect(outcomes).toContainEqual(expect.objectContaining({ status: 'succeeded' }));
      const rows = await recordsOf(log);
      expect(rows).toHaveLength(1);
      expect(cell(rows[0] ?? {}, log.name)).toBe('New: Launch');
      expect(Number(cell(rows[0] ?? {}, log.points))).toBe(8);
      expect(cell(rows[0] ?? {}, log.notes)).toBe(`from ${task.id}`);
      const [run] = await runsOf(a.id);
      expect(run).toMatchObject({ status: 'succeeded', depth: 1, error: null });
      expect(run?.trigger).toMatchObject({
        type: 'recordCreated',
        record: { id: task.id, fields: { Name: 'Launch', Points: 8 } },
      });
      expect(run?.steps[0]).toMatchObject({ index: 1, status: 'succeeded' });
      // The automation's write carries its id and depth into the outbox.
      const [ev] = await t.db
        .select()
        .from(outbox)
        .where(sql`${outbox.tableId} = ${log.table.id} AND ${outbox.kind} = 'record.created'`);
      expect(ev).toMatchObject({ automationId: a.id, automationDepth: 1, actorId: creator.id });
      // Its revision says "Automation", with the person it ran as.
      const [revision] = await t.db
        .select()
        .from(recordRevisions)
        .where(eq(recordRevisions.tableId, log.table.id));
      expect(revision).toMatchObject({ kind: 'created', via: 'automation', actorId: creator.id });
      const [counted] = await t.db
        .select()
        .from(automationRunCounts)
        .where(eq(automationRunCounts.workspaceId, workspaceId));
      expect(counted?.runs).toBeGreaterThanOrEqual(1);
      const [row] = await t.db.select().from(automations).where(eq(automations.id, a.id));
      expect(row?.lastRunStatus).toBe('succeeded');
      // A person's write afterwards carries no depth.
      await addRecord(log, { [log.name]: 'manual' });
      const [manual] = await t.db
        .select()
        .from(outbox)
        .where(sql`${outbox.tableId} = ${log.table.id} AND ${outbox.kind} = 'record.created'`)
        .orderBy(sql`${outbox.id} DESC`)
        .limit(1);
      expect(manual).toMatchObject({ automationId: null, automationDepth: null });
      await off(a.id);
    });

    it('record updated: only when a watched field changed', async () => {
      const m = await makeTable('Updated');
      await loadColumns();
      const a = await createAutomation({
        name: 'Points changed',
        trigger: { type: 'recordUpdated', tableId: m.table.id, fieldIds: [m.points] },
        actions: [
          {
            type: 'updateRecord',
            tableId: m.table.id,
            recordId: '{{trigger.record.id}}',
            fields: { [m.notes]: 'Points now {{trigger.record.fields.Points}}' },
          },
        ],
      });
      const r = await addRecord(m, { [m.name]: 'A' });
      await edit(m, r.id, { [m.name]: 'B' });
      expect(await pump()).not.toContainEqual(
        expect.objectContaining({ status: expect.any(String) })
      );
      await edit(m, r.id, { [m.points]: 3 });
      await pump();
      const [row] = await recordsOf(m);
      expect(cell(row ?? {}, m.notes)).toBe('Points now 3');
      const runs = await runsOf(a.id);
      // Its own write changed Notes, which it doesn't watch: one run.
      expect(runs).toHaveLength(1);
      expect(runs[0]?.trigger).toMatchObject({ changedFieldIds: [m.points] });
      await off(a.id);
    });

    it('record matches conditions: fires on the way in, not while it stays, not for those already in', async () => {
      const m = await makeTable('Matches');
      await loadColumns();
      const already = await addRecord(m, { [m.name]: 'Big already', [m.points]: 9 });
      const small = await addRecord(m, { [m.name]: 'Small', [m.points]: 2 });
      await pump();
      const a = await createAutomation({
        name: 'Big ones',
        trigger: {
          type: 'recordMatches',
          tableId: m.table.id,
          filter: { conditions: [{ fieldId: m.points, operator: '>', value: 5 }] },
        },
        actions: [{ type: 'findRecords', tableId: m.table.id, limit: 1 }],
      });
      await edit(m, already.id, { [m.points]: 10 });
      await pump();
      expect(await runsOf(a.id)).toHaveLength(0);
      await edit(m, small.id, { [m.points]: 8 });
      await pump();
      expect(await runsOf(a.id)).toHaveLength(1);
      await edit(m, small.id, { [m.points]: 9 });
      await pump();
      expect(await runsOf(a.id)).toHaveLength(1);
      await edit(m, small.id, { [m.points]: 1 });
      await pump();
      await edit(m, small.id, { [m.points]: 7 });
      await pump();
      expect(await runsOf(a.id)).toHaveLength(2);
      // A new record created matching enters too.
      await addRecord(m, { [m.name]: 'Born big', [m.points]: 6 });
      await pump();
      const runs = await runsOf(a.id);
      expect(runs).toHaveLength(3);
      expect(runs[0]?.trigger).toMatchObject({
        type: 'recordMatches',
        record: { fields: { Name: 'Born big' } },
      });
      expect(runs[0]?.steps[0]?.output).toMatchObject({ count: 1 });
      await off(a.id);
    });

    it('scheduled: due runs are sent once, run, and the next run moves past now', async () => {
      const m = await makeTable('Scheduled');
      await loadColumns();
      const a = await createAutomation({
        name: 'Every 5 minutes',
        trigger: {
          type: 'scheduled',
          schedule: {
            kind: 'interval',
            every: 5,
            unit: 'minutes',
            startAt: '2026-01-01T00:00',
            timeZone: 'Europe/Lisbon',
          },
        },
        actions: [
          {
            type: 'createRecord',
            tableId: m.table.id,
            fields: { [m.name]: 'Tick {{trigger.scheduledAt}}' },
          },
        ],
      });
      expect(new Date(a.nextRunAt ?? 0).getTime()).toBeGreaterThan(Date.now());
      // Pretend the worker was away for a while.
      const due = new Date(Date.now() - 17 * 60_000);
      due.setUTCSeconds(0, 0);
      await t.db.update(automations).set({ nextRunAt: due }).where(eq(automations.id, a.id));
      const jobs: JobInsert<RelayJobData>[] = [];
      const capture = async (_q: string, batch: JobInsert<Record<string, unknown>>[]) => {
        jobs.push(...(batch as unknown as JobInsert<RelayJobData>[]));
      };
      await scheduleDueAutomations(t.appDb, capture);
      expect(jobs).toHaveLength(1);
      const [row] = await t.db.select().from(automations).where(eq(automations.id, a.id));
      // One catch-up run, then back on the 5-minute grid after now.
      expect(row?.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
      expect((row?.nextRunAt?.getTime() ?? 0) % (5 * 60_000)).toBe(0);
      await scheduleDueAutomations(t.appDb, capture);
      expect(jobs).toHaveLength(1);
      const first = await runAutomationJob({ db: t.appDb, logger }, jobs[0]?.data);
      expect(first).toMatchObject({ status: 'succeeded' });
      // The same scheduled time again (a retried or duplicate job): nothing.
      expect(await runAutomationJob({ db: t.appDb, logger }, jobs[0]?.data)).toEqual({
        skipped: 'duplicate',
      });
      const rows = await recordsOf(m);
      expect(rows).toHaveLength(1);
      expect(cell(rows[0] ?? {}, m.name)).toBe(`Tick ${due.toISOString()}`);
      await off(a.id);
      const [offRow] = await t.db.select().from(automations).where(eq(automations.id, a.id));
      expect(offRow?.nextRunAt).toBeNull();
    });
  });

  describe('steps', () => {
    it('finds records with tokens in the filter and updates what it found', async () => {
      const tasks = await makeTable('Chain tasks');
      const projects = await makeTable('Chain projects');
      await loadColumns();
      await addRecord(projects, { [projects.name]: 'Apollo' });
      await addRecord(projects, { [projects.name]: 'Apollo II' });
      await addRecord(projects, { [projects.name]: 'Gemini' });
      await pump();
      const a = await createAutomation({
        name: 'Tag projects',
        trigger: { type: 'recordCreated', tableId: tasks.table.id },
        actions: [
          {
            type: 'findRecords',
            tableId: projects.table.id,
            filter: {
              conditions: [
                {
                  fieldId: projects.name,
                  operator: 'contains',
                  value: '{{trigger.record.fields.Name}}',
                },
              ],
            },
          },
          {
            type: 'updateRecord',
            tableId: projects.table.id,
            recordId: '{{steps.1.records}}',
            fields: {
              [projects.notes]:
                'Task {{trigger.record.id}}; first {{steps.1.records[0].fields.Name}}',
            },
          },
        ],
      });
      const task = await addRecord(tasks, { [tasks.name]: 'apollo' });
      await pump();
      const rows = await recordsOf(projects);
      const notes = rows.map((r) => cell(r, projects.notes));
      expect(notes).toEqual([
        `Task ${task.id}; first Apollo`,
        `Task ${task.id}; first Apollo`,
        null,
      ]);
      const [run] = await runsOf(a.id);
      expect(run?.steps.map((s) => s.status)).toEqual(['succeeded', 'succeeded']);
      expect(run?.steps[0]?.output).toMatchObject({ count: 2 });
      await off(a.id);
    });

    it('stops at depth 3 when it keeps triggering itself (loop guard)', async () => {
      const m = await makeTable('Loop');
      await loadColumns();
      const a = await createAutomation({
        name: 'Echo',
        trigger: { type: 'recordUpdated', tableId: m.table.id, fieldIds: null },
        actions: [
          {
            type: 'updateRecord',
            tableId: m.table.id,
            recordId: '{{trigger.record.id}}',
            fields: { [m.notes]: '{{trigger.record.fields.Notes}}!' },
          },
        ],
      });
      const r = await addRecord(m, { [m.name]: 'Ping' });
      await pump();
      await edit(m, r.id, { [m.notes]: 'go' });
      await pump();
      const runs = await runsOf(a.id);
      expect(runs.map((x) => [x.depth, x.status]).reverse()).toEqual([
        [1, 'succeeded'],
        [2, 'succeeded'],
        [3, 'succeeded'],
        [4, 'skipped'],
      ]);
      expect(runs[0]?.error).toMatch(/loop guard/);
      const [row] = await recordsOf(m);
      expect(cell(row ?? {}, m.notes)).toBe('go!!!');
      // And then quiet: nothing left to relay.
      expect(await pump()).toEqual([]);
      await off(a.id);
    });

    it('is idempotent when the relay replays a batch and when a job runs twice', async () => {
      const tasks = await makeTable('Replay tasks');
      const log = await makeTable('Replay log');
      await loadColumns();
      const a = await createAutomation({
        name: 'Copy',
        trigger: { type: 'recordCreated', tableId: tasks.table.id },
        actions: [
          {
            type: 'createRecord',
            tableId: log.table.id,
            fields: { [log.name]: '{{trigger.record.fields.Name}}' },
          },
        ],
      });
      await addRecord(tasks, { [tasks.name]: 'Once' });
      // The relay crashes after sending, before moving its cursor: the batch comes again.
      const first: JobInsert<RelayJobData>[] = [];
      await relayable();
      await expect(
        relayOutbox(t.appDb, async (_q, b) => void first.push(...b), [automationSubscriber], {
          afterEnqueue: async () => {
            throw new Error('crash');
          },
        })
      ).rejects.toThrow('crash');
      const again: JobInsert<RelayJobData>[] = [];
      await relayable();
      await relayOutbox(t.appDb, async (_q, b) => void again.push(...b), [automationSubscriber]);
      expect(first.length).toBeGreaterThan(0);
      expect(again.map((j) => [j.id, j.singletonKey])).toEqual(
        first.map((j) => [j.id, j.singletonKey])
      );
      expect(first[0]?.singletonKey).toBe(`${first[0]?.data?.outboxId}:${a.id}`);
      // Even if both copies of the job ran (a duplicate send, a retry after success).
      const job = first[0]?.data;
      const outcomes = [
        await runAutomationJob({ db: t.appDb, logger }, job),
        await runAutomationJob({ db: t.appDb, logger }, job),
      ];
      expect(outcomes[0]).toMatchObject({ status: 'succeeded' });
      expect(outcomes[1]).toEqual({ skipped: 'duplicate' });
      // Two at the same moment: one runs, the other waits on the run row, then skips.
      const raced = await makeTable('Race');
      await loadColumns();
      const b = await createAutomation({
        name: 'Race',
        trigger: { type: 'recordCreated', tableId: raced.table.id },
        actions: [{ type: 'createRecord', tableId: log.table.id, fields: { [log.name]: 'raced' } }],
      });
      await addRecord(raced, { [raced.name]: 'x' });
      const jobs: JobInsert<RelayJobData>[] = [];
      await relayable();
      await relayOutbox(t.appDb, async (_q, batch) => void jobs.push(...batch), [
        automationSubscriber,
      ]);
      const mine = jobs.find((j) => j.data?.subscriberId === b.id)?.data;
      const both = await Promise.all([
        runAutomationJob({ db: t.appDb, logger }, mine),
        runAutomationJob({ db: t.appDb, logger }, mine),
      ]);
      expect(both.filter((o) => 'status' in o)).toHaveLength(1);
      const names = (await recordsOf(log)).map((r) => cell(r, log.name));
      expect(names.filter((n) => n === 'Once')).toHaveLength(1);
      expect(names.filter((n) => n === 'raced')).toHaveLength(1);
      await off(a.id);
      await off(b.id);
    });
  });

  describe('permissions', () => {
    it('runs as its creator: field permissions apply, a failed step is rolled back alone', async () => {
      const tasks = await makeTable('Perm tasks');
      const log = await makeTable('Perm log');
      await loadColumns();
      // Only owners may edit the log's Notes.
      await t.db
        .update(fields)
        .set({ permissions: { edit: { level: 'specific', userIds: [], roles: ['owner'] } } })
        .where(eq(fields.id, log.notes));
      const a = await createAutomation({
        name: 'Restricted',
        trigger: { type: 'recordCreated', tableId: tasks.table.id },
        actions: [
          { type: 'createRecord', tableId: log.table.id, fields: { [log.name]: 'step one' } },
          { type: 'createRecord', tableId: log.table.id, fields: { [log.notes]: 'not allowed' } },
          { type: 'createRecord', tableId: log.table.id, fields: { [log.name]: 'step three' } },
        ],
      });
      await addRecord(tasks, { [tasks.name]: 'x' });
      await pump();
      const [run] = await runsOf(a.id);
      expect(run?.status).toBe('failed');
      expect(run?.steps.map((s) => s.status)).toEqual(['succeeded', 'failed', 'skipped']);
      expect(run?.error).toMatch(/^Step 2 failed/);
      const names = (await recordsOf(log)).map((r) => cell(r, log.name));
      expect(names).toEqual(['step one']);
      // An owner taking it over (changing its actions) makes it run as the owner.
      const taken = await call(owner, 'PATCH', `${autos()}/${a.id}`, {
        actions: [
          { type: 'createRecord', tableId: log.table.id, fields: { [log.notes]: 'allowed now' } },
        ],
      });
      expect(taken.body.createdBy).toBe(owner.id);
      await addRecord(tasks, { [tasks.name]: 'y' });
      await pump();
      expect((await runsOf(a.id))[0]?.status).toBe('succeeded');
      await off(a.id);
    });

    it('turns itself off when its creator lost access to the base', async () => {
      const m = await makeTable('Leaver');
      const leaver = await addMember(t.db, workspaceId, 'creator');
      cookies.set(leaver.id, await createSession(t.db, leaver));
      const a = await createAutomation(
        {
          name: 'Theirs',
          trigger: { type: 'recordCreated', tableId: m.table.id },
          actions: [{ type: 'findRecords', tableId: m.table.id }],
        },
        leaver
      );
      await t.db.delete(workspaceMembers).where(eq(workspaceMembers.userId, leaver.id));
      await addRecord(m, { [m.name]: 'x' });
      await pump();
      const [row] = await t.db.select().from(automations).where(eq(automations.id, a.id));
      expect(row).toMatchObject({ enabled: false, disabledReason: 'creator_access' });
      const [run] = await runsOf(a.id);
      expect(run).toMatchObject({ status: 'failed' });
      expect(run?.error).toMatch(/no longer has access/);
    });
  });

  describe('test runs and retries (#111)', () => {
    type Run = {
      id: string;
      status: string;
      mode: string;
      retryOf: string | null;
      depth: number;
      triggeredBy: string | null;
      error: string | null;
      trigger: Json;
      steps: { status: string; error: string | null }[];
    };
    const test = (who: User, id: string, body: Record<string, unknown> = {}) =>
      call(who, 'POST', `${autos()}/${id}/test`, body);
    const retry = (who: User, id: string, runId: string) =>
      call(who, 'POST', `${autos()}/${id}/runs/${runId}/retry`);
    const monthRuns = async () => {
      const [row] = await t.db
        .select()
        .from(automationRunCounts)
        .where(eq(automationRunCounts.workspaceId, workspaceId));
      return row?.runs ?? 0;
    };
    const automationRow = async (id: string) => {
      const [row] = await t.db.select().from(automations).where(eq(automations.id, id));
      if (!row) throw new Error('no automation');
      return row;
    };

    it('tests with a record for real, as the tester, while off; not counted, last run unchanged', async () => {
      const tasks = await makeTable('Test tasks');
      const log = await makeTable('Test log');
      await loadColumns();
      const a = await createAutomation({
        name: 'Log tasks',
        enabled: false,
        trigger: { type: 'recordCreated', tableId: tasks.table.id },
        actions: [
          {
            type: 'createRecord',
            tableId: log.table.id,
            fields: { [log.name]: 'Test: {{trigger.record.fields.Name}}' },
          },
        ],
      });
      const task = await addRecord(tasks, { [tasks.name]: 'Launch' });
      const elsewhere = await addRecord(log, { [log.name]: 'not a task' });
      await pump();
      const counted = await monthRuns();

      const missing = await test(owner, a.id);
      expect(missing.status).toBe(422);
      expect(missing.body.errors).toEqual([
        { path: 'recordId', message: 'Pick a record to test with.' },
      ]);
      expect((await test(owner, a.id, { recordId: uuidv7() })).status).toBe(404);
      expect((await test(owner, a.id, { recordId: elsewhere.id })).status).toBe(404);
      expect((await test(editor, a.id, { recordId: task.id })).status).toBe(403);
      expect((await call(creator, 'POST', `${autos(otherBaseId)}/${a.id}/test`, {})).status).toBe(
        404
      );

      const res = await test(owner, a.id, { recordId: task.id });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({
        automationId: a.id,
        status: 'succeeded',
        mode: 'test',
        retryOf: null,
        depth: 1,
        triggeredBy: owner.id,
        error: null,
      });
      expect(res.body.trigger).toMatchObject({
        type: 'recordCreated',
        record: { id: task.id, fields: { Name: 'Launch' } },
      });
      expect((await recordsOf(log)).map((r) => cell(r, log.name))).toContain('Test: Launch');
      // The write is the tester's, at depth 1.
      const [ev] = await t.db
        .select()
        .from(outbox)
        .where(sql`${outbox.tableId} = ${log.table.id} AND ${outbox.kind} = 'record.created'`)
        .orderBy(sql`${outbox.id} DESC`)
        .limit(1);
      expect(ev).toMatchObject({ automationId: a.id, automationDepth: 1, actorId: owner.id });
      expect(await monthRuns()).toBe(counted);
      const row = await automationRow(a.id);
      expect(row).toMatchObject({ enabled: false, lastRunAt: null, lastRunStatus: null });
      const runs = await runsOf(a.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ mode: 'test' });
      const listed = await call(creator, 'GET', autos());
      expect(listed.body.automations.find((x: { id: string }) => x.id === a.id)?.runCount).toBe(1);
      expect(
        listed.body.automations.every((x: { runCount: unknown }) => typeof x.runCount === 'number')
      ).toBe(true);

      // No actions: nothing to test.
      const empty = await createAutomation({
        name: 'Empty',
        enabled: false,
        trigger: { type: 'recordCreated', tableId: tasks.table.id },
      });
      const none = await test(creator, empty.id, { recordId: task.id });
      expect(none.status).toBe(422);
      expect(none.body.errors[0].path).toBe('actions');
      await call(creator, 'DELETE', `${autos()}/${empty.id}`);
    });

    it('runs as the tester with their permissions, not as the creator', async () => {
      const tasks = await makeTable('Tester tasks');
      const log = await makeTable('Tester log');
      await loadColumns();
      await t.db
        .update(fields)
        .set({ permissions: { edit: { level: 'specific', userIds: [], roles: ['owner'] } } })
        .where(eq(fields.id, log.notes));
      // The owner's automation: it would run as the owner, who may edit Notes.
      const a = await createAutomation(
        {
          name: 'Notes',
          enabled: false,
          trigger: { type: 'recordCreated', tableId: tasks.table.id },
          actions: [
            { type: 'createRecord', tableId: log.table.id, fields: { [log.notes]: 'note' } },
          ],
        },
        owner
      );
      const task = await addRecord(tasks, { [tasks.name]: 'x' });
      const asCreator = await test(creator, a.id, { recordId: task.id });
      expect(asCreator.status).toBe(200);
      expect(asCreator.body).toMatchObject({ status: 'failed', triggeredBy: creator.id });
      expect(asCreator.body.steps[0]).toMatchObject({ status: 'failed' });
      expect(await recordsOf(log)).toHaveLength(0);
      const asOwner = await test(owner, a.id, { recordId: task.id });
      expect(asOwner.body).toMatchObject({ status: 'succeeded', triggeredBy: owner.id });
      expect((await recordsOf(log)).map((r) => cell(r, log.notes))).toEqual(['note']);
      // A failed test doesn't change the automation's last run either.
      expect(await automationRow(a.id)).toMatchObject({ lastRunStatus: null });
    });

    it('gives each trigger type its data; a match test needs no match and leaves the set', async () => {
      const m = await makeTable('Test kinds');
      await loadColumns();
      const big = await addRecord(m, { [m.name]: 'Big', [m.points]: 9 });
      const small = await addRecord(m, { [m.name]: 'Small', [m.points]: 1 });
      await pump();
      const find = [{ type: 'findRecords', tableId: m.table.id, limit: 1 }];
      const matches = await createAutomation({
        name: 'Big ones',
        trigger: {
          type: 'recordMatches',
          tableId: m.table.id,
          filter: { conditions: [{ fieldId: m.points, operator: '>', value: 5 }] },
        },
        actions: find,
      });
      const matchSet = async () =>
        (
          await t.db
            .select()
            .from(automationMatches)
            .where(eq(automationMatches.automationId, matches.id))
        ).map((r) => r.recordId);
      expect(await matchSet()).toEqual([big.id]);
      const tested = await test(creator, matches.id, { recordId: small.id });
      expect(tested.body).toMatchObject({ status: 'succeeded', mode: 'test' });
      expect(tested.body.trigger).toMatchObject({
        type: 'recordMatches',
        record: { id: small.id },
      });
      expect(await matchSet()).toEqual([big.id]);
      expect((await test(creator, matches.id, { recordId: big.id })).status).toBe(200);
      expect(await matchSet()).toEqual([big.id]);
      await off(matches.id);

      const updated = await createAutomation({
        name: 'Points',
        enabled: false,
        trigger: { type: 'recordUpdated', tableId: m.table.id, fieldIds: [m.points] },
        actions: find,
      });
      const u = await test(creator, updated.id, { recordId: big.id });
      expect(u.body.trigger).toMatchObject({ type: 'recordUpdated', changedFieldIds: [m.points] });

      const scheduled = await createAutomation({
        name: 'Tick',
        enabled: false,
        trigger: {
          type: 'scheduled',
          schedule: {
            kind: 'interval',
            every: 1,
            unit: 'days',
            startAt: '2026-01-01T09:00',
            timeZone: 'UTC',
          },
        },
        actions: [
          {
            type: 'createRecord',
            tableId: m.table.id,
            fields: { [m.name]: 'Tick {{trigger.scheduledAt}}' },
          },
        ],
      });
      const s = await test(creator, scheduled.id);
      expect(s.status, JSON.stringify(s.body)).toBe(200);
      expect(s.body).toMatchObject({ status: 'succeeded', mode: 'test' });
      const at = s.body.trigger.scheduledAt as string;
      expect(Math.abs(Date.parse(at) - Date.now())).toBeLessThan(60_000);
      expect((await recordsOf(m)).map((r) => cell(r, m.name))).toContain(`Tick ${at}`);
      expect((await automationRow(scheduled.id)).nextRunAt).toBeNull();
    });

    it('keeps the loop guard for what a test’s writes trigger', async () => {
      const m = await makeTable('Test loop');
      await loadColumns();
      const a = await createAutomation({
        name: 'Echo',
        trigger: { type: 'recordUpdated', tableId: m.table.id, fieldIds: null },
        actions: [
          {
            type: 'updateRecord',
            tableId: m.table.id,
            recordId: '{{trigger.record.id}}',
            fields: { [m.notes]: '{{trigger.record.fields.Notes}}!' },
          },
        ],
      });
      const r = await addRecord(m, { [m.name]: 'Ping', [m.notes]: 'go' });
      await pump();
      expect((await test(creator, a.id, { recordId: r.id })).body.status).toBe('succeeded');
      await pump();
      const runs = (await runsOf(a.id)) as unknown as Run[];
      expect(runs.map((x) => [x.mode, x.depth, x.status]).reverse()).toEqual([
        ['test', 1, 'succeeded'],
        ['live', 2, 'succeeded'],
        ['live', 3, 'succeeded'],
        ['live', 4, 'skipped'],
      ]);
      const [row] = await recordsOf(m);
      expect(cell(row ?? {}, m.notes)).toBe('go!!!');
      await off(a.id);
    });

    it('retries a failed run once, from its record as it is now, as the retrier; counted', async () => {
      const tasks = await makeTable('Retry tasks');
      await loadColumns();
      // Only owners may edit Notes: the creator's live runs fail.
      await t.db
        .update(fields)
        .set({ permissions: { edit: { level: 'specific', userIds: [], roles: ['owner'] } } })
        .where(eq(fields.id, tasks.notes));
      const a = await createAutomation({
        name: 'Greet',
        trigger: { type: 'recordCreated', tableId: tasks.table.id },
        actions: [
          {
            type: 'updateRecord',
            tableId: tasks.table.id,
            recordId: '{{trigger.record.id}}',
            fields: { [tasks.notes]: 'Hi {{trigger.record.fields.Name}}' },
          },
        ],
      });
      const task = await addRecord(tasks, { [tasks.name]: 'Ada' });
      const gone = await addRecord(tasks, { [tasks.name]: 'Gone' });
      await pump();
      const failedRuns = (await runsOf(a.id)) as unknown as Run[];
      expect(failedRuns.map((r) => [r.mode, r.status])).toEqual([
        ['live', 'failed'],
        ['live', 'failed'],
      ]);
      const failed = failedRuns.find((r) => r.trigger.record.id === task.id);
      const failedGone = failedRuns.find((r) => r.trigger.record.id === gone.id);
      if (!failed || !failedGone) throw new Error('no failed runs');
      await edit(tasks, task.id, { [tasks.name]: 'Ada Lovelace' });
      await pump();
      const counted = await monthRuns();

      // The builder's failed runs: both, newest first, named, for creators only.
      const failedPath = `/api/bases/${base.id}/automation-runs/failed`;
      const dead = await call(creator, 'GET', failedPath);
      expect(dead.status, JSON.stringify(dead.body)).toBe(200);
      const mine = dead.body.runs.filter(
        (r: Run & { automationId: string }) => r.automationId === a.id
      );
      expect(mine.map((r: Run) => r.id).sort()).toEqual([failed.id, failedGone.id].sort());
      expect(mine[0]).toMatchObject({ automationName: 'Greet', status: 'failed' });
      expect((await call(editor, 'GET', failedPath)).status).toBe(403);

      // Creators only; unknown runs are 404. The owner may edit Notes: the retry succeeds.
      expect((await retry(editor, a.id, failed.id)).status).toBe(403);
      expect((await retry(creator, a.id, uuidv7())).status).toBe(404);
      const res = await retry(owner, a.id, failed.id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({
        status: 'succeeded',
        mode: 'retry',
        retryOf: failed.id,
        triggeredBy: owner.id,
        depth: 1,
      });
      expect(res.body.trigger).toMatchObject({
        type: 'recordCreated',
        record: { id: task.id, fields: { Name: 'Ada Lovelace' } },
      });
      const row = (await recordsOf(tasks)).find((r) => r['id'] === task.id);
      expect(cell(row ?? {}, tasks.notes)).toBe('Hi Ada Lovelace');
      expect(await monthRuns()).toBe(counted + 1);
      expect(await automationRow(a.id)).toMatchObject({ lastRunStatus: 'succeeded' });

      // A retried run leaves the failed runs.
      const left = (await call(creator, 'GET', failedPath)).body.runs.map((r: Run) => r.id);
      expect(left).not.toContain(failed.id);
      expect(left).toContain(failedGone.id);

      const twice = await retry(owner, a.id, failed.id);
      expect(twice.status).toBe(409);
      expect(twice.body.detail).toBe('This run was already retried.');
      const notFailed = await retry(owner, a.id, res.body.id);
      expect(notFailed.status).toBe(409);
      expect(notFailed.body.detail).toBe('Only failed runs can be retried.');
      // Another automation's run: 404.
      const b = await createAutomation({
        name: 'Other',
        enabled: false,
        trigger: { type: 'recordCreated', tableId: tasks.table.id },
        actions: [{ type: 'findRecords', tableId: tasks.table.id }],
      });
      expect((await retry(owner, b.id, failedGone.id)).status).toBe(404);

      // The record is gone since.
      await t.db.execute(
        sql`UPDATE ${qualified(tasks.table)} SET deleted_at = now() WHERE id = ${gone.id}::uuid`
      );
      const goneRes = await retry(owner, a.id, failedGone.id);
      expect(goneRes.status).toBe(409);
      expect(goneRes.body.detail).toBe('The record is gone.');
      // Nothing was written by refused retries.
      expect(
        ((await runsOf(a.id)) as unknown as Run[]).filter((r) => r.mode === 'retry')
      ).toHaveLength(1);

      // A run that failed before its trigger was read (lost access, an unexpected failure).
      const [early] = await t.db
        .insert(automationRuns)
        .values({
          workspaceId,
          automationId: a.id,
          idempotencyKey: `early:${uuidv7()}`,
          status: 'failed',
          depth: 1,
          error: 'The run failed unexpectedly.',
        })
        .returning();
      const noData = await retry(owner, a.id, early?.id ?? '');
      expect(noData.status).toBe(409);
      expect(noData.body.detail).toBe("This run can't be retried: it has no trigger data.");

      // Filtered by outcome.
      const onlyFailed = await call(creator, 'GET', `${autos()}/${a.id}/runs?status=failed`);
      expect(onlyFailed.body.runs.length).toBe(3);
      expect(onlyFailed.body.runs.every((r: Run) => r.status === 'failed')).toBe(true);
      const ok = await call(creator, 'GET', `${autos()}/${a.id}/runs?status=succeeded`);
      expect(ok.body.runs.map((r: Run) => r.id)).toEqual([res.body.id]);
      expect((await call(creator, 'GET', `${autos()}/${a.id}/runs?status=nope`)).status).toBe(422);
      const listed = await call(creator, 'GET', autos());
      expect(listed.body.automations.find((x: { id: string }) => x.id === a.id)?.runCount).toBe(4);
      await off(a.id);
    });

    it('retries a failed run as the retrier: a retry can fail too and be retried in turn', async () => {
      const tasks = await makeTable('Retry chain');
      await loadColumns();
      await t.db
        .update(fields)
        .set({ permissions: { edit: { level: 'specific', userIds: [], roles: ['owner'] } } })
        .where(eq(fields.id, tasks.notes));
      const a = await createAutomation({
        name: 'Chain',
        trigger: { type: 'recordCreated', tableId: tasks.table.id },
        actions: [
          {
            type: 'updateRecord',
            tableId: tasks.table.id,
            recordId: '{{trigger.record.id}}',
            fields: { [tasks.notes]: 'done' },
          },
        ],
      });
      await addRecord(tasks, { [tasks.name]: 'x' });
      await pump();
      const [failed] = (await runsOf(a.id)) as unknown as Run[];
      if (!failed) throw new Error('no run');
      const again = await retry(creator, a.id, failed.id);
      expect(again.body).toMatchObject({
        status: 'failed',
        mode: 'retry',
        retryOf: failed.id,
        triggeredBy: creator.id,
      });
      expect(await automationRow(a.id)).toMatchObject({ lastRunStatus: 'failed' });
      const third = await retry(owner, a.id, again.body.id);
      expect(third.body).toMatchObject({ status: 'succeeded', retryOf: again.body.id });
      await off(a.id);
    });
  });

  describe('in the worker', () => {
    let worker: RunningWorker | undefined;
    afterAll(() => worker?.stop(2_000));

    it('relays a record event to automations.run and runs it', async () => {
      const tasks = await makeTable('Worker tasks');
      const log = await makeTable('Worker log');
      await loadColumns();
      const a = await createAutomation({
        name: 'Live',
        trigger: { type: 'recordCreated', tableId: tasks.table.id },
        actions: [{ type: 'createRecord', tableId: log.table.id, fields: { [log.name]: 'live' } }],
      });
      const queues = builtinQueues({ db: t.appDb, logger, revisionDays: 365 });
      const relay = queues['outbox.relay'];
      const run = queues['automations.run'];
      if (!relay || !run) throw new Error('no automation queues');
      worker = await startWorker(
        { db: t.appDb, logger, revisionDays: 365 },
        {
          connectionString: t.appUrl,
          instanceName: 'automations',
          queues: { 'outbox.relay': relay, 'automations.run': run },
          pollingIntervalSeconds: 0.5,
          cronMonitorIntervalSeconds: 1,
          cronWorkerIntervalSeconds: 1,
          maxConnections: 3,
        }
      );
      await addRecord(tasks, { [tasks.name]: 'go' });
      const deadline = Date.now() + 30_000;
      for (;;) {
        await worker.boss.send('outbox.relay', null);
        const runs = await runsOf(a.id);
        if (runs.length) {
          expect(runs[0]?.status).toBe('succeeded');
          break;
        }
        if (Date.now() > deadline) throw new Error('no run');
        await new Promise((r) => setTimeout(r, 300));
      }
      expect((await recordsOf(log)).map((r) => cell(r, log.name))).toEqual(['live']);
      await off(a.id);
    });
  });

  it('prunes runs past 30 days', async () => {
    const [someRun] = await t.db.select().from(automationRuns).limit(1);
    if (!someRun) throw new Error('no runs');
    await t.db
      .update(automationRuns)
      .set({ createdAt: new Date(Date.now() - 31 * 86_400_000) })
      .where(eq(automationRuns.id, someRun.id));
    expect(await pruneAutomationRuns(t.appDb)).toBe(1);
    expect(
      await t.db.select().from(automationRuns).where(eq(automationRuns.id, someRun.id))
    ).toEqual([]);
  });
});
