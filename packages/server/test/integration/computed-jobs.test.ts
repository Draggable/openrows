import type { FieldMeta, LinkOptions, RecordData, TableMeta } from '@openrows/shared';
import { and, gt, inArray, isNotNull } from 'drizzle-orm';
import fc from 'fast-check';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_SYNC_LIMIT,
  refreshTable,
  setRecomputeSyncLimit,
} from '../../src/data/computed/engine.js';
import { fields, outbox, type users } from '../../src/db/index.js';
import { refreshVolatileFormulas } from '../../src/jobs/computed.js';
import { withTenant } from '../../src/jobs/tenant.js';
import { createLogger } from '../../src/lib/logger.js';
import { drainComputed } from '../helpers/computed.js';
import { useTestDb } from '../helpers/db.js';
import { authedClient, createWorkspace } from '../helpers/factories.js';

/**
 * The worker's computed-field jobs: recomputes past the sync limit left to the worker
 * (fields flagged `recomputing` until it's done), the scheduled NOW()/TODAY() refresh, two-hop
 * invalidation through link names, and formula result types re-derived on type changes.
 */
describe('computed fields in the worker', () => {
  const t = useTestDb();
  const logger = createLogger({ level: 'silent' });
  let owner: typeof users.$inferSelect;
  let workspaceId: string;
  let api: Awaited<ReturnType<typeof authedClient>>;

  const json = (method: string, path: string, body?: unknown) =>
    api.request(path, {
      method,
      headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  async function ok<T>(res: Response, status = 200): Promise<T> {
    if (res.status !== status) throw new Error(`${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }
  const newBase = async () =>
    ok<{ id: string }>(
      await json('POST', `/api/workspaces/${workspaceId}/bases`, { name: 'Base' }),
      201
    );
  const newTable = async (baseId: string, name: string) =>
    ok<TableMeta>(await json('POST', `/api/bases/${baseId}/tables`, { name }), 201);
  const getTable = async (id: string) => ok<TableMeta>(await json('GET', `/api/tables/${id}`));
  const primary = (table: TableMeta) => {
    const f = table.fields.find((x) => x.isPrimary);
    if (!f) throw new Error('no primary');
    return f.id;
  };
  const field = async (tableId: string, name: string, type: string, options: unknown = {}) =>
    ok<FieldMeta>(
      await json('POST', `/api/tables/${tableId}/fields`, { name, type, options }),
      201
    );
  const records = (tableId: string) => `/api/tables/${tableId}/records`;
  const create = async (tableId: string, cells: Record<string, unknown>[]) =>
    (
      await ok<{ records: RecordData[] }>(
        await json('POST', records(tableId), { records: cells.map((fields) => ({ fields })) }),
        201
      )
    ).records;
  const update = (tableId: string, patches: { id: string; fields: Record<string, unknown> }[]) =>
    Promise.resolve(json('PATCH', records(tableId), { records: patches })).then((res) => ok(res));
  const get = (tableId: string, id: string) =>
    Promise.resolve(api.request(`${records(tableId)}/${id}`)).then((res) => ok<RecordData>(res));
  const all = async (tableId: string) =>
    (
      await ok<{ records: RecordData[] }>(
        await json('POST', `${records(tableId)}/query`, { limit: 1000, count: false })
      )
    ).records;
  const inverseOf = (link: FieldMeta) => (link.options as LinkOptions).inverseLinkFieldId as string;

  const drain = () => drainComputed(t.appDb, t.db);

  const flagged = async (ids: string[]) =>
    (
      await t.db
        .select({ id: fields.id })
        .from(fields)
        .where(and(inArray(fields.id, ids), isNotNull(fields.recomputeRequestedAt)))
    ).map((r) => r.id);

  const lastOutboxId = async () => {
    const rows = await t.db.select({ id: outbox.id }).from(outbox);
    return rows.reduce((max, r) => Math.max(max, Number(r.id)), 0);
  };
  const eventsSince = (id: number) =>
    t.db.select().from(outbox).where(gt(outbox.id, id)).orderBy(outbox.id);

  beforeAll(async () => {
    const created = await createWorkspace(t.db);
    owner = created.owner;
    workspaceId = created.workspace.id;
    api = await authedClient(t, owner);
    await drain();
  });

  afterEach(() => setRecomputeSyncLimit(DEFAULT_SYNC_LIMIT));

  it('refreshes a lookup of a link when a linked-linked primary value changes (two hops)', async () => {
    const base = await newBase();
    const clients = await newTable(base.id, 'Clients');
    const projects = await newTable(base.id, 'Projects');
    const tasks = await newTable(base.id, 'Tasks');
    const client = await field(projects.id, 'Client', 'link', { linkedTableId: clients.id });
    const project = await field(tasks.id, 'Project', 'link', { linkedTableId: projects.id });
    const clientNames = await field(tasks.id, 'Client names', 'lookup', {
      recordLinkFieldId: project.id,
      fieldIdInLinkedTable: client.id,
    });
    const clientText = await field(tasks.id, 'Clients text', 'rollup', {
      recordLinkFieldId: project.id,
      fieldIdInLinkedTable: client.id,
      function: 'ARRAYJOIN',
    });
    const [acme] = await create(clients.id, [{ [primary(clients)]: 'Acme' }]);
    if (!acme) throw new Error('no client');
    const [alpha] = await create(projects.id, [
      { [primary(projects)]: 'Alpha', [client.id]: [acme.id] },
    ]);
    if (!alpha) throw new Error('no project');
    const [task] = await create(tasks.id, [{ [primary(tasks)]: 'T', [project.id]: [alpha.id] }]);
    if (!task) throw new Error('no task');
    expect(JSON.stringify(task.fields[clientNames.id])).toContain('Acme');

    await update(clients.id, [{ id: acme.id, fields: { [primary(clients)]: 'Acme Corp' } }]);
    const after = await get(tasks.id, task.id);
    expect(JSON.stringify(after.fields[clientNames.id])).toContain('Acme Corp');
    expect(String(after.fields[clientText.id])).toContain('Acme Corp');
  });

  it('refreshes NOW() and TODAY() formulas without any record write (fake clock)', async () => {
    const base = await newBase();
    const events = await newTable(base.id, 'Events');
    const report = await newTable(base.id, 'Report');
    const now = await field(events.id, 'Now', 'formula', { formula: 'NOW()' });
    const today = await field(events.id, 'Today', 'formula', { formula: 'TODAY()' });
    const zoned = await field(events.id, 'Local day', 'formula', {
      formula: 'DATETIME_FORMAT(SET_TIMEZONE(NOW(), "Asia/Kolkata"), "YYYY-MM-DD HH:mm")',
    });
    const upper = await field(events.id, 'Upper', 'formula', {
      formula: `UPPER({${primary(events)}})`,
    });
    const link = await field(report.id, 'Events', 'link', { linkedTableId: events.id });
    const seen = await field(report.id, 'Seen', 'lookup', {
      recordLinkFieldId: link.id,
      fieldIdInLinkedTable: today.id,
    });
    const [event] = await create(events.id, [{ [primary(events)]: 'launch' }]);
    if (!event) throw new Error('no event');
    const [row] = await create(report.id, [{ [link.id]: [event.id] }]);
    if (!row) throw new Error('no report row');
    const real = new Date().toISOString().slice(0, 10);
    expect(String(event.fields[today.id])).toContain(real);

    const before = await lastOutboxId();
    const clock = Date.UTC(2031, 0, 2, 3, 4, 5);
    const result = await refreshVolatileFormulas({ db: t.appDb, logger }, { now: clock });
    expect(result.bases).toBeGreaterThanOrEqual(1);
    const e = await get(events.id, event.id);
    expect(String(e.fields[now.id])).toContain('2031-01-02T03:04:05');
    expect(String(e.fields[today.id])).toContain('2031-01-02');
    expect(e.fields[zoned.id]).toBe('2031-01-02 08:34');
    expect(e.fields[upper.id]).toBe('LAUNCH');
    // What reads a clock formula follows, in other tables too (lookups store display text).
    const r = await get(report.id, row.id);
    expect(r.fields[seen.id]).toEqual(['Jan 2, 2031']);
    // No record write: one `field.recomputed` per changed table, no per-record events.
    const emitted = await eventsSince(before);
    expect(emitted.map((x) => x.kind).sort()).toEqual(['field.recomputed', 'field.recomputed']);
    expect(emitted.find((x) => x.tableId === events.id)?.payload).toEqual({
      fieldIds: expect.arrayContaining([now.id, today.id, zoned.id]),
    });

    // The half-hour runs refresh only the zoned formulas.
    const later = Date.UTC(2031, 0, 2, 18, 30, 0);
    await refreshVolatileFormulas({ db: t.appDb, logger }, { now: later, zonedOnly: true });
    const z = await get(events.id, event.id);
    expect(z.fields[zoned.id]).toBe('2031-01-03 00:00');
    expect(String(z.fields[now.id])).toContain('2031-01-02T03:04:05');
  });

  it('leaves recomputes past the sync limit to the worker, flagged until done', async () => {
    const base = await newBase();
    const projects = await newTable(base.id, 'Projects');
    const tasks = await newTable(base.id, 'Tasks');
    const hours = await field(tasks.id, 'Hours', 'number');
    const link = await field(tasks.id, 'Project', 'link', { linkedTableId: projects.id });
    const ps = await create(
      projects.id,
      Array.from({ length: 12 }, (_, i) => ({ [primary(projects)]: `P${i}` }))
    );
    const ts = await create(
      tasks.id,
      ps.map((p) => ({ [hours.id]: 1, [link.id]: [p.id] }))
    );
    setRecomputeSyncLimit(5);
    const before = await lastOutboxId();
    // A new rollup over 12 projects: more than 5, so the worker computes it.
    const sum = await field(projects.id, 'Sum', 'rollup', {
      recordLinkFieldId: inverseOf(link),
      fieldIdInLinkedTable: hours.id,
      function: 'SUM',
    });
    const double = await field(projects.id, 'Double', 'formula', { formula: `{${sum.id}} * 2` });
    expect((await getTable(projects.id)).fields.find((f) => f.id === sum.id)?.recomputing).toBe(
      true
    );
    expect(await flagged([sum.id, double.id])).toEqual(expect.arrayContaining([sum.id]));
    const kinds = (await eventsSince(before)).map((e) => e.kind);
    expect(kinds).toContain('field.recomputing');
    expect((await all(projects.id)).every((p) => p.fields[sum.id] == null)).toBe(true);

    expect(await drain()).toBeGreaterThanOrEqual(1);
    expect(await flagged([sum.id, double.id])).toEqual([]);
    const table = await getTable(projects.id);
    expect(table.fields.some((f) => f.recomputing)).toBe(false);
    for (const p of await all(projects.id)) {
      expect(p.fields[sum.id]).toBe(1);
      expect(p.fields[double.id]).toBe(2);
    }
    expect((await eventsSince(before)).map((e) => e.kind)).toContain('field.recomputed');

    // A write making 12 records stale returns at once; the worker catches up.
    await update(
      tasks.id,
      ts.map((x) => ({ id: x.id, fields: { [hours.id]: 3 } }))
    );
    expect(await flagged([sum.id])).toEqual([sum.id]);
    await drain();
    for (const p of await all(projects.id)) {
      expect(p.fields[sum.id]).toBe(3);
      expect(p.fields[double.id]).toBe(6);
    }
    // Small writes still recompute in the request.
    const first = ts[0];
    if (!first) throw new Error('no task');
    await update(tasks.id, [{ id: first.id, fields: { [hours.id]: 5 } }]);
    const p0 = (await all(projects.id)).find((p) => p.fields[sum.id] === 5);
    expect(p0?.fields[double.id]).toBe(10);

    // A flagged field recomputed whole in a request (reconfigured under the limit) is unflagged.
    await update(
      tasks.id,
      ts.map((x) => ({ id: x.id, fields: { [hours.id]: 4 } }))
    );
    expect(await flagged([sum.id])).toEqual([sum.id]);
    setRecomputeSyncLimit(1000);
    await ok(
      await json('PATCH', `/api/fields/${sum.id}`, {
        options: {
          recordLinkFieldId: inverseOf(link),
          fieldIdInLinkedTable: hours.id,
          function: 'MAX',
        },
      })
    );
    expect(await flagged([sum.id])).toEqual([]);
    expect((await all(projects.id)).map((p) => p.fields[sum.id])).toEqual(Array(12).fill(4));
  });

  it("re-derives a formula's result type when a referenced field's type changes", async () => {
    const base = await newBase();
    const table = await newTable(base.id, 'Things');
    const num = await field(table.id, 'Num', 'number');
    const f1 = await field(table.id, 'F1', 'formula', { formula: `{${num.id}}` });
    const f2 = await field(table.id, 'F2', 'formula', { formula: `{${f1.id}}` });
    const resultType = async (id: string) => {
      const f = (await getTable(table.id)).fields.find((x) => x.id === id);
      return (f?.options as { resultType?: string } | undefined)?.resultType;
    };
    expect(await resultType(f1.id)).toBe('number');
    expect(await resultType(f2.id)).toBe('number');
    const before = await lastOutboxId();
    await ok(await json('PATCH', `/api/fields/${num.id}`, { type: 'singleLineText' }));
    expect(await resultType(f1.id)).toBe('text');
    expect(await resultType(f2.id)).toBe('text');
    const updated = (await eventsSince(before)).filter((e) => e.kind === 'field.updated');
    const ids = updated.map((e) => (e.payload as { field: { id: string } }).field.id);
    expect(ids).toEqual(expect.arrayContaining([f1.id, f2.id, num.id]));
  });

  /**
   * Clients ← Projects ← Tasks, with a low sync limit so some recomputes go to the worker:
   * projects sum their tasks' hours, clients sum the projects' sums, tasks look up their
   * project's client link (client names, two hops) and projects look up those lookups.
   */
  it('keeps every lookup and rollup of a 3-table chain consistent after jobs drain (property)', async () => {
    const base = await newBase();
    const clients = await newTable(base.id, 'Clients');
    const projects = await newTable(base.id, 'Projects');
    const tasks = await newTable(base.id, 'Tasks');
    const hours = await field(tasks.id, 'Hours', 'number');
    const project = await field(tasks.id, 'Project', 'link', { linkedTableId: projects.id });
    const client = await field(projects.id, 'Client', 'link', { linkedTableId: clients.id });
    const projectTasks = inverseOf(project);
    const clientProjects = inverseOf(client);
    const total = await field(projects.id, 'Total', 'rollup', {
      recordLinkFieldId: projectTasks,
      fieldIdInLinkedTable: hours.id,
      function: 'SUM',
    });
    await field(projects.id, 'Task names', 'lookup', {
      recordLinkFieldId: projectTasks,
      fieldIdInLinkedTable: primary(tasks),
    });
    await field(clients.id, 'Hours', 'rollup', {
      recordLinkFieldId: clientProjects,
      fieldIdInLinkedTable: total.id,
      function: 'SUM',
    });
    const taskClients = await field(tasks.id, 'Client names', 'lookup', {
      recordLinkFieldId: project.id,
      fieldIdInLinkedTable: client.id,
    });
    await field(projects.id, 'Clients of tasks', 'lookup', {
      recordLinkFieldId: projectTasks,
      fieldIdInLinkedTable: taskClients.id,
    });
    await field(tasks.id, 'Label', 'formula', {
      formula: `{${primary(tasks)}} & ":" & {${project.id}}`,
    });
    const cs = await create(
      clients.id,
      ['C1', 'C2', 'C3'].map((n) => ({ [primary(clients)]: n }))
    );
    const ps = await create(
      projects.id,
      ['P1', 'P2', 'P3', 'P4'].map((n) => ({ [primary(projects)]: n }))
    );
    const ts = await create(
      tasks.id,
      ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'].map((n) => ({ [primary(tasks)]: n }))
    );
    const tableIds = [clients.id, projects.id, tasks.id];
    const pick = <T>(xs: T[], i: number) => xs[i % xs.length] as T;
    const subset = <T extends { id: string }>(xs: T[], mask: number) =>
      xs.filter((_, i) => mask & (1 << i)).map((x) => x.id);
    const name = fc.string({ maxLength: 4 });
    const op = fc.oneof(
      fc.record({ kind: fc.constant('hours' as const), i: fc.nat(), v: fc.integer({ max: 50 }) }),
      fc.record({ kind: fc.constant('allHours' as const), v: fc.integer({ max: 50 }) }),
      fc.record({ kind: fc.constant('taskName' as const), i: fc.nat(), v: name }),
      fc.record({ kind: fc.constant('projectName' as const), i: fc.nat(), v: name }),
      fc.record({ kind: fc.constant('clientName' as const), i: fc.nat(), v: name }),
      fc.record({ kind: fc.constant('taskProject' as const), i: fc.nat(), mask: fc.nat(15) }),
      fc.record({ kind: fc.constant('projectClient' as const), i: fc.nat(), mask: fc.nat(7) }),
      fc.record({ kind: fc.constant('clientProjects' as const), i: fc.nat(), mask: fc.nat(15) }),
      fc.record({ kind: fc.constant('drain' as const) })
    );
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }),
        fc.array(op, { minLength: 1, maxLength: 8 }),
        async (limit, ops) => {
          setRecomputeSyncLimit(limit);
          for (const o of ops) {
            if (o.kind === 'hours') {
              await update(tasks.id, [{ id: pick(ts, o.i).id, fields: { [hours.id]: o.v } }]);
            } else if (o.kind === 'allHours') {
              await update(
                tasks.id,
                ts.map((x) => ({ id: x.id, fields: { [hours.id]: o.v } }))
              );
            } else if (o.kind === 'taskName') {
              await update(tasks.id, [{ id: pick(ts, o.i).id, fields: { [primary(tasks)]: o.v } }]);
            } else if (o.kind === 'projectName') {
              await update(projects.id, [
                { id: pick(ps, o.i).id, fields: { [primary(projects)]: o.v } },
              ]);
            } else if (o.kind === 'clientName') {
              await update(clients.id, [
                { id: pick(cs, o.i).id, fields: { [primary(clients)]: o.v } },
              ]);
            } else if (o.kind === 'taskProject') {
              await update(tasks.id, [
                { id: pick(ts, o.i).id, fields: { [project.id]: subset(ps, o.mask).slice(0, 2) } },
              ]);
            } else if (o.kind === 'projectClient') {
              await update(projects.id, [
                { id: pick(ps, o.i).id, fields: { [client.id]: subset(cs, o.mask) } },
              ]);
            } else if (o.kind === 'clientProjects') {
              await update(clients.id, [
                { id: pick(cs, o.i).id, fields: { [clientProjects]: subset(ps, o.mask) } },
              ]);
            } else {
              await drain();
            }
          }
          await drain();
          // Consistent: nothing is left flagged, and recomputing every computed field of every
          // table from scratch changes no cell.
          const computedIds = (
            await t.db
              .select({ id: fields.id })
              .from(fields)
              .where(inArray(fields.tableId, tableIds))
          ).map((f) => f.id);
          expect(await flagged(computedIds)).toEqual([]);
          setRecomputeSyncLimit(1_000_000);
          for (const tableId of tableIds) {
            const changed = await withTenant(t.appDb, workspaceId, (tx) =>
              refreshTable(tx, base.id, tableId)
            );
            expect(changed, `table ${tableId}`).toBe(0);
          }
        }
      ),
      { numRuns: 20 }
    );
    // And the two-hop lookup reads the clients' current names (an empty one shows as a link
    // does: "Unnamed record").
    const clientNames = new Map(
      (await all(clients.id)).map((c) => [c.id, c.fields[primary(clients)] || 'Unnamed record'])
    );
    const projectClients = new Map(
      (await all(projects.id)).map((p) => [
        p.id,
        ((p.fields[client.id] ?? []) as { id: string }[]).map((x) => clientNames.get(x.id)),
      ])
    );
    for (const task of await all(tasks.id)) {
      const expected = ((task.fields[project.id] ?? []) as { id: string }[]).flatMap(
        (p) => projectClients.get(p.id) ?? []
      );
      expect(task.fields[taskClients.id] ?? []).toEqual(expected);
    }
  }, 300_000);
});
