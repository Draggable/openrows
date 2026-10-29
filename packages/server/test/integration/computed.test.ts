import {
  type FieldMeta,
  getFieldType,
  type LinkOptions,
  type RecordData,
  type TableMeta,
} from '@openrows/shared';
import { and, eq } from 'drizzle-orm';
import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import { outbox, type users } from '../../src/db/index.js';
import { drainComputed } from '../helpers/computed.js';
import { useTestDb } from '../helpers/db.js';
import { authedClient, createWorkspace } from '../helpers/factories.js';

/**
 * Lookup, rollup and count fields: the dependency graph from the fields' options, cycle
 * detection, recompute on every record write (both link sides, deletes and restores) and on
 * schema changes, values in columns for sort/filter/aggregates, and a 10k-record benchmark.
 */
describe('lookup, rollup and count fields', () => {
  const t = useTestDb();
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
  const addField = (tableId: string, name: string, type: string, options: unknown = {}) =>
    json('POST', `/api/tables/${tableId}/fields`, { name, type, options });
  const field = async (tableId: string, name: string, type: string, options: unknown = {}) =>
    ok<FieldMeta>(await addField(tableId, name, type, options), 201);
  const records = (tableId: string) => `/api/tables/${tableId}/records`;
  const create = async (tableId: string, cells: Record<string, unknown>[]) =>
    (
      await ok<{ records: RecordData[] }>(
        await json('POST', records(tableId), { records: cells.map((fields) => ({ fields })) }),
        201
      )
    ).records;
  const update = async (
    tableId: string,
    patches: { id: string; fields: Record<string, unknown> }[]
  ) =>
    (
      await ok<{ records: RecordData[] }>(
        await json('PATCH', records(tableId), { records: patches })
      )
    ).records;
  const all = async (tableId: string) => {
    const out: RecordData[] = [];
    let cursor: string | undefined;
    do {
      const page = await ok<{ records: RecordData[]; nextCursor: string | null }>(
        await json('POST', `${records(tableId)}/query`, {
          limit: 1000,
          count: false,
          ...(cursor ? { cursor } : {}),
        })
      );
      out.push(...page.records);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return out;
  };
  const linkIds = (cell: unknown) => ((cell ?? []) as { id: string }[]).map((x) => x.id);

  /**
   * Clients ← Projects ← Tasks: Tasks.Project links Projects (inverse Projects.Tasks), and
   * Projects.Client links Clients (inverse Clients.Projects). Projects count, sum, max and look
   * up their tasks; Clients sum the projects' sums (a rollup of a rollup), look up the projects'
   * lookups and count projects.
   */
  async function world() {
    const base = await newBase();
    const clients = await newTable(base.id, 'Clients');
    const projects = await newTable(base.id, 'Projects');
    const tasks = await newTable(base.id, 'Tasks');
    const hours = await field(tasks.id, 'Hours', 'number');
    const project = await field(tasks.id, 'Project', 'link', { linkedTableId: projects.id });
    const client = await field(projects.id, 'Client', 'link', { linkedTableId: clients.id });
    const projectTasks = (project.options as LinkOptions).inverseLinkFieldId as string;
    const clientProjects = (client.options as LinkOptions).inverseLinkFieldId as string;
    const via = (link: string, source?: string) => ({
      recordLinkFieldId: link,
      ...(source ? { fieldIdInLinkedTable: source } : {}),
    });
    const taskCount = await field(projects.id, 'Task count', 'count', via(projectTasks));
    const totalHours = await field(projects.id, 'Total hours', 'rollup', {
      ...via(projectTasks, hours.id),
      function: 'SUM',
    });
    const maxHours = await field(projects.id, 'Max hours', 'rollup', {
      ...via(projectTasks, hours.id),
      function: 'MAX',
    });
    const taskNames = await field(
      projects.id,
      'Task names',
      'lookup',
      via(projectTasks, primary(tasks))
    );
    const clientHours = await field(clients.id, 'Hours', 'rollup', {
      ...via(clientProjects, totalHours.id),
      function: 'SUM',
    });
    const clientTasks = await field(
      clients.id,
      'Tasks',
      'lookup',
      via(clientProjects, taskNames.id)
    );
    const projectCount = await field(clients.id, 'Projects n', 'count', via(clientProjects));
    return {
      base,
      clients,
      projects,
      tasks,
      f: {
        hours: hours.id,
        project: project.id,
        client: client.id,
        projectTasks,
        clientProjects,
        taskCount: taskCount.id,
        totalHours: totalHours.id,
        maxHours: maxHours.id,
        taskNames: taskNames.id,
        clientHours: clientHours.id,
        clientTasks: clientTasks.id,
        projectCount: projectCount.id,
        taskName: primary(tasks),
        projectName: primary(projects),
        clientName: primary(clients),
      },
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  /**
   * The computed values every record should have, recomputed from the stored links and hours as
   * the API returns them, compared with what the engine stored.
   */
  async function expectConsistent(w: World) {
    const [cs, ps, ts] = await Promise.all([
      all(w.clients.id),
      all(w.projects.id),
      all(w.tasks.id),
    ]);
    const taskById = new Map(ts.map((r) => [r.id, r]));
    const projectById = new Map(ps.map((r) => [r.id, r]));
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    for (const p of ps) {
      const linked = linkIds(p.fields[w.f.projectTasks]).flatMap((id) => taskById.get(id) ?? []);
      const hours = linked.flatMap((x) =>
        typeof x.fields[w.f.hours] === 'number' ? [x.fields[w.f.hours] as number] : []
      );
      const names = linked.flatMap((x) => (x.fields[w.f.taskName] ? [x.fields[w.f.taskName]] : []));
      expect(p.fields[w.f.taskCount], 'count').toBe(linked.length);
      expect(p.fields[w.f.totalHours], 'sum').toBe(sum(hours));
      expect(p.fields[w.f.maxHours] ?? null, 'max').toBe(hours.length ? Math.max(...hours) : null);
      expect(p.fields[w.f.taskNames] ?? null, 'lookup').toEqual(names.length ? names : null);
    }
    for (const c of cs) {
      const linked = linkIds(c.fields[w.f.clientProjects]).flatMap(
        (id) => projectById.get(id) ?? []
      );
      expect(c.fields[w.f.projectCount], 'client count').toBe(linked.length);
      expect(c.fields[w.f.clientHours], 'client sum').toBe(
        sum(linked.map((x) => (x.fields[w.f.totalHours] as number | null) ?? 0))
      );
      const items = linked.flatMap((x) => (x.fields[w.f.taskNames] as string[] | null) ?? []);
      expect(c.fields[w.f.clientTasks] ?? null, 'client lookup').toEqual(
        items.length ? items : null
      );
    }
  }

  beforeAll(async () => {
    const created = await createWorkspace(t.db);
    owner = created.owner;
    workspaceId = created.workspace.id;
    api = await authedClient(t, owner);
  });

  it('computes counts, rollups and lookups across three tables and keeps them current', async () => {
    const w = await world();
    const [acme, globex] = await create(w.clients.id, [
      { [w.f.clientName]: 'Acme' },
      { [w.f.clientName]: 'Globex' },
    ]);
    if (!acme || !globex) throw new Error('no clients');
    const [alpha, beta] = await create(w.projects.id, [
      { [w.f.projectName]: 'Alpha', [w.f.client]: [acme.id] },
      { [w.f.projectName]: 'Beta' },
    ]);
    if (!alpha || !beta) throw new Error('no projects');
    expect(alpha.fields[w.f.taskCount]).toBe(0);
    expect(alpha.fields[w.f.totalHours]).toBe(0);
    expect(alpha.fields[w.f.maxHours]).toBeNull();

    const created = await create(w.tasks.id, [
      { [w.f.taskName]: 'Design', [w.f.hours]: 3, [w.f.project]: [alpha.id] },
      { [w.f.taskName]: 'Build', [w.f.hours]: 5, [w.f.project]: [alpha.id] },
      { [w.f.taskName]: 'Ship', [w.f.hours]: 2, [w.f.project]: [beta.id] },
    ]);
    const [design, build, ship] = created;
    if (!design || !build || !ship) throw new Error('no tasks');
    const a = await ok<RecordData>(await json('GET', `${records(w.projects.id)}/${alpha.id}`));
    expect(a.fields[w.f.taskCount]).toBe(2);
    expect(a.fields[w.f.totalHours]).toBe(8);
    expect(a.fields[w.f.maxHours]).toBe(5);
    expect(a.fields[w.f.taskNames]).toEqual(['Design', 'Build']);
    const acmeNow = await ok<RecordData>(await json('GET', `${records(w.clients.id)}/${acme.id}`));
    expect(acmeNow.fields[w.f.clientHours]).toBe(8);
    expect(acmeNow.fields[w.f.clientTasks]).toEqual(['Design', 'Build']);

    // Writes on the other side of the link, renames, deletes and restores.
    await update(w.projects.id, [{ id: beta.id, fields: { [w.f.client]: [acme.id] } }]);
    await update(w.tasks.id, [
      { id: build.id, fields: { [w.f.hours]: 7, [w.f.taskName]: 'Code' } },
    ]);
    await expectConsistent(w);
    await ok(await json('POST', `${records(w.tasks.id)}/delete`, { recordIds: [design.id] }));
    await expectConsistent(w);
    const after = await ok<RecordData>(await json('GET', `${records(w.clients.id)}/${acme.id}`));
    expect(after.fields[w.f.clientHours]).toBe(9);
    await ok(await json('POST', `${records(w.tasks.id)}/restore`, { recordIds: [design.id] }));
    await ok(await json('POST', `${records(w.projects.id)}/delete`, { recordIds: [beta.id] }));
    await expectConsistent(w);

    // Computed cells can't be written, and recomputed records get events.
    const refused = await json('PATCH', records(w.projects.id), {
      records: [{ id: alpha.id, fields: { [w.f.taskCount]: 9 } }],
    });
    expect(refused.status).toBe(422);
    const computedEvents = (
      await t.db
        .select()
        .from(outbox)
        .where(and(eq(outbox.tableId, w.clients.id), eq(outbox.kind, 'record.updated')))
    ).filter((e) => (e.payload as { computed?: boolean }).computed);
    expect(computedEvents.length).toBeGreaterThan(0);
    const first = computedEvents[0]?.payload as { fieldIds?: string[] } | undefined;
    expect(first?.fieldIds?.length).toBeGreaterThan(0);
  });

  it('keeps every computed value consistent under random edits (property)', async () => {
    const w = await world();
    const clients = await create(
      w.clients.id,
      ['C1', 'C2', 'C3'].map((n) => ({ [w.f.clientName]: n }))
    );
    const projects = await create(
      w.projects.id,
      ['P1', 'P2', 'P3', 'P4'].map((n) => ({ [w.f.projectName]: n }))
    );
    const tasks = await create(
      w.tasks.id,
      ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'].map((n) => ({ [w.f.taskName]: n }))
    );
    const pick = <T>(xs: T[], i: number) => xs[i % xs.length] as T;
    const subset = <T extends { id: string }>(xs: T[], mask: number) =>
      xs.filter((_, i) => mask & (1 << i)).map((x) => x.id);
    const op = fc.oneof(
      fc.record({
        kind: fc.constant('hours' as const),
        i: fc.nat(),
        v: fc.option(fc.integer({ min: -50, max: 50 })),
      }),
      fc.record({ kind: fc.constant('taskLinks' as const), i: fc.nat(), mask: fc.nat(15) }),
      fc.record({ kind: fc.constant('projectTasks' as const), i: fc.nat(), mask: fc.nat(63) }),
      fc.record({ kind: fc.constant('projectClient' as const), i: fc.nat(), mask: fc.nat(7) }),
      fc.record({ kind: fc.constant('clientProjects' as const), i: fc.nat(), mask: fc.nat(15) }),
      fc.record({
        kind: fc.constant('rename' as const),
        i: fc.nat(),
        v: fc.string({ maxLength: 4 }),
      }),
      fc.record({ kind: fc.constant('toggleTask' as const), i: fc.nat() }),
      fc.record({ kind: fc.constant('toggleProject' as const), i: fc.nat() })
    );
    const deleted = new Set<string>();
    const toggle = async (tableId: string, id: string) => {
      const path = deleted.has(id) ? 'restore' : 'delete';
      await ok(await json('POST', `${records(tableId)}/${path}`, { recordIds: [id] }));
      if (deleted.has(id)) deleted.delete(id);
      else deleted.add(id);
    };
    const live = <T extends { id: string }>(xs: T[]) => xs.filter((x) => !deleted.has(x.id));
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 6 }), async (ops) => {
        for (const o of ops) {
          const lt = live(tasks);
          const lp = live(projects);
          if (o.kind === 'hours' && lt.length) {
            await update(w.tasks.id, [{ id: pick(lt, o.i).id, fields: { [w.f.hours]: o.v } }]);
          } else if (o.kind === 'rename' && lt.length) {
            await update(w.tasks.id, [{ id: pick(lt, o.i).id, fields: { [w.f.taskName]: o.v } }]);
          } else if (o.kind === 'taskLinks' && lt.length) {
            const ids = subset(live(projects), o.mask).slice(0, 2);
            await update(w.tasks.id, [{ id: pick(lt, o.i).id, fields: { [w.f.project]: ids } }]);
          } else if (o.kind === 'projectTasks' && lp.length) {
            const ids = subset(lt, o.mask);
            await update(w.projects.id, [
              { id: pick(lp, o.i).id, fields: { [w.f.projectTasks]: ids } },
            ]);
          } else if (o.kind === 'projectClient' && lp.length) {
            await update(w.projects.id, [
              { id: pick(lp, o.i).id, fields: { [w.f.client]: subset(clients, o.mask) } },
            ]);
          } else if (o.kind === 'clientProjects') {
            await update(w.clients.id, [
              { id: pick(clients, o.i).id, fields: { [w.f.clientProjects]: subset(lp, o.mask) } },
            ]);
          } else if (o.kind === 'toggleTask') {
            await toggle(w.tasks.id, pick(tasks, o.i).id);
          } else if (o.kind === 'toggleProject') {
            await toggle(w.projects.id, pick(projects, o.i).id);
          }
        }
        await expectConsistent(w);
      }),
      { numRuns: 25 }
    );
  }, 240_000);

  it('validates options, refuses cycles and refuses deleting what a computed field reads', async () => {
    const w = await world();
    const bad = async (tableId: string, type: string, options: unknown) => {
      const res = await addField(tableId, `Bad ${Math.random()}`, type, options);
      expect(res.status, JSON.stringify(options)).toBe(422);
      return (await res.json()) as { errors?: { path: string; message: string }[] };
    };
    await bad(w.projects.id, 'count', {});
    await bad(w.projects.id, 'count', { recordLinkFieldId: w.f.hours });
    await bad(w.projects.id, 'count', { recordLinkFieldId: w.f.project });
    await bad(w.projects.id, 'lookup', { recordLinkFieldId: w.f.projectTasks });
    await bad(w.projects.id, 'lookup', {
      recordLinkFieldId: w.f.projectTasks,
      fieldIdInLinkedTable: w.f.clientName,
    });
    await bad(w.projects.id, 'rollup', {
      recordLinkFieldId: w.f.projectTasks,
      fieldIdInLinkedTable: w.f.hours,
      function: 'NOPE',
    });

    // Tasks look up their project's task names (a new field can't close a loop: nothing reads
    // it yet). Repointing the projects' lookup at the tasks' lookup would loop.
    const back = await field(w.tasks.id, 'Siblings', 'lookup', {
      recordLinkFieldId: w.f.project,
      fieldIdInLinkedTable: w.f.taskNames,
    });
    const repoint = await json('PATCH', `/api/fields/${w.f.taskNames}`, {
      options: { recordLinkFieldId: w.f.projectTasks, fieldIdInLinkedTable: back.id },
    });
    expect(repoint.status).toBe(422);
    const problem = (await repoint.json()) as { errors?: { message: string }[] };
    expect(problem.errors?.[0]?.message).toMatch(/circular/);
    // And a rollup can't read itself.
    const self = await json('PATCH', `/api/fields/${w.f.totalHours}`, {
      options: { recordLinkFieldId: w.f.projectTasks, fieldIdInLinkedTable: w.f.totalHours },
    });
    expect(self.status).toBe(422);

    // Fields a computed field reads can't be deleted or unlinked (409), the computed ones can.
    expect((await json('DELETE', `/api/fields/${w.f.hours}`)).status).toBe(409);
    expect((await json('DELETE', `/api/fields/${w.f.project}`)).status).toBe(409);
    expect(
      (await json('PATCH', `/api/fields/${w.f.projectTasks}`, { type: 'singleLineText' })).status
    ).toBe(409);
    expect((await json('DELETE', `/api/fields/${back.id}`)).status).toBe(204);
  });

  it('recomputes when a computed field is reconfigured and sorts, filters and sums the columns', async () => {
    const w = await world();
    const [alpha, beta, gamma] = await create(
      w.projects.id,
      ['Alpha', 'Beta', 'Gamma'].map((n) => ({ [w.f.projectName]: n }))
    );
    if (!alpha || !beta || !gamma) throw new Error('no projects');
    await create(w.tasks.id, [
      { [w.f.taskName]: 'a', [w.f.hours]: 4, [w.f.project]: [alpha.id] },
      { [w.f.taskName]: 'b', [w.f.hours]: 1, [w.f.project]: [alpha.id] },
      { [w.f.taskName]: 'c', [w.f.hours]: 2, [w.f.project]: [beta.id] },
    ]);
    const query = async (body: unknown) =>
      ok<{ records: RecordData[]; aggregates?: Record<string, Record<string, unknown>> }>(
        await json('POST', `${records(w.projects.id)}/query`, body)
      );
    const sorted = await query({
      query: { sorts: [{ fieldId: w.f.totalHours, direction: 'desc' }] },
    });
    expect(sorted.records.map((r) => r.id)).toEqual([alpha.id, beta.id, gamma.id]);
    const big = await query({
      query: { filter: { conditions: [{ fieldId: w.f.totalHours, operator: '>', value: 2 }] } },
    });
    expect(big.records.map((r) => r.id)).toEqual([alpha.id]);
    const named = await query({
      query: {
        filter: { conditions: [{ fieldId: w.f.taskNames, operator: 'contains', value: 'C' }] },
      },
    });
    expect(named.records.map((r) => r.id)).toEqual([beta.id]);
    const counted = await query({
      query: { filter: { conditions: [{ fieldId: w.f.taskCount, operator: '=', value: 0 }] } },
      aggregates: [{ fieldId: w.f.totalHours, fn: 'sum' }],
    });
    expect(counted.records.map((r) => r.id)).toEqual([gamma.id]);
    expect(Number(counted.aggregates?.[w.f.totalHours]?.['sum'])).toBe(0);
    const byName = await query({
      query: { sorts: [{ fieldId: w.f.taskNames, direction: 'asc' }] },
    });
    expect(byName.records.map((r) => r.id)).toEqual([gamma.id, alpha.id, beta.id]);

    // Every filter operator of the three types.
    const A = alpha.id;
    const B = beta.id;
    const G = gamma.id;
    const cases: [string, string, unknown, string[]][] = [
      [w.f.taskCount, '=', 1, [B]],
      [w.f.taskCount, '!=', 1, [A, G]],
      [w.f.taskCount, '<', 1, [G]],
      [w.f.taskCount, '<=', 1, [B, G]],
      [w.f.taskCount, '>', 1, [A]],
      [w.f.taskCount, '>=', 1, [A, B]],
      [w.f.taskCount, 'isEmpty', undefined, []],
      [w.f.taskCount, 'isNotEmpty', undefined, [A, B, G]],
      [w.f.totalHours, '=', 5, [A]],
      [w.f.totalHours, '!=', 5, [B, G]],
      [w.f.totalHours, '<', 2, [G]],
      [w.f.totalHours, '<=', 2, [B, G]],
      [w.f.totalHours, '>', 2, [A]],
      [w.f.totalHours, '>=', 2, [A, B]],
      [w.f.totalHours, 'isEmpty', undefined, []],
      [w.f.totalHours, 'isNotEmpty', undefined, [A, B, G]],
      [w.f.totalHours, 'contains', '5', [A]],
      [w.f.totalHours, 'doesNotContain', '5', [B, G]],
      [w.f.taskNames, 'contains', 'A', [A]],
      [w.f.taskNames, 'doesNotContain', 'a', [B, G]],
      [w.f.taskNames, 'isEmpty', undefined, [G]],
      [w.f.taskNames, 'isNotEmpty', undefined, [A, B]],
    ];
    for (const [fieldId, operator, value, expected] of cases) {
      const res = await query({
        query: {
          filter: {
            conditions: [{ fieldId, operator, ...(value !== undefined ? { value } : {}) }],
          },
        },
      });
      expect(
        res.records.map((r) => r.id),
        `${fieldId} ${operator}`
      ).toEqual(expected);
    }
    const covered = new Set(cases.map(([id, op]) => `${id} ${op}`));
    for (const [id, type] of [
      [w.f.taskCount, 'count'],
      [w.f.totalHours, 'rollup'],
      [w.f.taskNames, 'lookup'],
    ] as const) {
      for (const op of getFieldType(type).filterOperators) expect(covered).toContain(`${id} ${op}`);
    }

    // SUM → ARRAYJOIN, then AVG: every record recomputes, and so does the clients' rollup of it.
    const joined = await json('PATCH', `/api/fields/${w.f.totalHours}`, {
      options: {
        recordLinkFieldId: w.f.projectTasks,
        fieldIdInLinkedTable: w.f.hours,
        function: 'ARRAYJOIN',
        separator: ' + ',
      },
    });
    expect(joined.status).toBe(200);
    const a = await ok<RecordData>(await json('GET', `${records(w.projects.id)}/${alpha.id}`));
    expect(a.fields[w.f.totalHours]).toBe('4 + 1');
    await ok(
      await json('PATCH', `/api/fields/${w.f.totalHours}`, {
        options: {
          recordLinkFieldId: w.f.projectTasks,
          fieldIdInLinkedTable: w.f.hours,
          function: 'AVG',
        },
      })
    );
    const avg = await ok<RecordData>(await json('GET', `${records(w.projects.id)}/${alpha.id}`));
    expect(avg.fields[w.f.totalHours]).toBe(2.5);

    // Converting the source to text: the lookup and rollups follow.
    await ok(await json('PATCH', `/api/fields/${w.f.hours}`, { type: 'singleLineText' }));
    const text = await ok<RecordData>(await json('GET', `${records(w.projects.id)}/${alpha.id}`));
    expect(text.fields[w.f.totalHours]).toBeNull();
    expect(text.fields[w.f.maxHours]).toBeNull();
  });

  it('recomputes after a 10k-record bulk update in under 10 s', async () => {
    const base = await newBase();
    const projects = await newTable(base.id, 'Projects');
    const tasks = await newTable(base.id, 'Tasks');
    const hours = await field(tasks.id, 'Hours', 'number');
    const link = await field(tasks.id, 'Project', 'link', { linkedTableId: projects.id });
    const inverse = (link.options as LinkOptions).inverseLinkFieldId as string;
    const N = 10_000;
    const projectIds: string[] = [];
    for (let i = 0; i < N; i += 1000) {
      const batch = await create(
        projects.id,
        Array.from({ length: 1000 }, (_, j) => ({ [primary(projects)]: `P${i + j}` }))
      );
      projectIds.push(...batch.map((r) => r.id));
    }
    const taskIds: string[] = [];
    for (let i = 0; i < N; i += 1000) {
      const batch = await create(
        tasks.id,
        Array.from({ length: 1000 }, (_, j) => ({
          [hours.id]: 1,
          [link.id]: [projectIds[i + j]],
        }))
      );
      taskIds.push(...batch.map((r) => r.id));
    }
    const via = { recordLinkFieldId: inverse, fieldIdInLinkedTable: hours.id };
    const started = Date.now();
    const sum = await field(projects.id, 'Sum', 'rollup', { ...via, function: 'SUM' });
    await field(projects.id, 'Hours', 'lookup', via);
    await field(projects.id, 'N', 'count', { recordLinkFieldId: inverse });
    // 10k records each: past the sync limit, so the worker computes them.
    expect((await getTable(projects.id)).fields.filter((f) => f.recomputing)).toHaveLength(3);
    await drainComputed(t.appDb, t.db);
    const created = Date.now() - started;

    const t0 = Date.now();
    for (let i = 0; i < N; i += 1000) {
      await update(
        tasks.id,
        taskIds.slice(i, i + 1000).map((id) => ({ id, fields: { [hours.id]: 2 } }))
      );
    }
    const elapsed = Date.now() - t0;
    console.info(
      `computed: 3 fields over 10k records in ${created} ms; 10k-record update ${elapsed} ms`
    );
    expect(elapsed).toBeLessThan(10_000);
    expect(created).toBeLessThan(10_000);
    const table = await getTable(projects.id);
    expect(table.fields.some((f) => f.id === sum.id)).toBe(true);
    const res = await ok<{
      records: RecordData[];
      aggregates?: Record<string, Record<string, unknown>>;
    }>(
      await json('POST', `${records(projects.id)}/query`, {
        limit: 1,
        aggregates: [{ fieldId: sum.id, fn: 'sum' }],
      })
    );
    expect(Number(res.aggregates?.[sum.id]?.['sum'])).toBe(2 * N);
  }, 180_000);
});
