import type { FieldMeta, LinkOptions, RecordData, TableMeta } from '@openrows/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { qualified } from '../../src/data/columns.js';
import { fields, outbox, tables, type users } from '../../src/db/index.js';
import { runImportJob } from '../../src/import-export/import.js';
import { createLogger } from '../../src/lib/logger.js';
import { useTestDb } from '../helpers/db.js';
import { authedClient, createWorkspace } from '../helpers/factories.js';

/**
 * Linked records (ADR-001): a junction per link field pair, an inverse field created in
 * the linked table, both sides changing together with outbox events for both, links that can't
 * leave the base, "limit to a view" enforced on writes, names matched by primary field.
 */
describe('linked records', () => {
  const t = useTestDb();
  const logger = createLogger({ level: 'silent' });
  let owner: typeof users.$inferSelect;
  let workspaceId: string;
  let api: Awaited<ReturnType<typeof authedClient>>;

  const json = (method: string, path: string, body?: unknown, client = api) =>
    client.request(path, {
      method,
      headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  async function ok<T>(res: Response, status = 200): Promise<T> {
    if (res.status !== status) throw new Error(`${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  async function newBase(client = api, ws = workspaceId) {
    return ok<{ id: string }>(
      await json('POST', `/api/workspaces/${ws}/bases`, { name: 'Base' }, client),
      201
    );
  }
  const newTable = async (baseId: string, name: string, client = api) =>
    ok<TableMeta>(await json('POST', `/api/bases/${baseId}/tables`, { name }, client), 201);
  const getTable = async (id: string) => ok<TableMeta>(await json('GET', `/api/tables/${id}`));
  const fieldOf = (table: TableMeta, name: string) => {
    const f = table.fields.find((x) => x.name === name);
    if (!f) throw new Error(`no field ${name}`);
    return f;
  };
  const records = (tableId: string) => `/api/tables/${tableId}/records`;
  const create = async (tableId: string, cells: Record<string, unknown>[], typecast = false) =>
    (
      await ok<{ records: RecordData[] }>(
        await json('POST', records(tableId), {
          records: cells.map((fields) => ({ fields })),
          ...(typecast ? { typecast } : {}),
        }),
        201
      )
    ).records;
  const patch = (tableId: string, id: string, cells: Record<string, unknown>, typecast = false) =>
    json('PATCH', records(tableId), {
      records: [{ id, fields: cells }],
      ...(typecast ? { typecast } : {}),
    });
  const get = async (tableId: string, id: string) =>
    ok<RecordData>(await json('GET', `${records(tableId)}/${id}`));
  const link = (tableId: string, name: string, options: Partial<LinkOptions>) =>
    json('POST', `/api/tables/${tableId}/fields`, { name, type: 'link', options });
  const ids = (cell: unknown) => ((cell ?? []) as { id: string }[]).map((x) => x.id);
  const names = (cell: unknown) => ((cell ?? []) as { name: string }[]).map((x) => x.name);
  const junctionExists = async (name: string, schema: string) => {
    const { rows } = await t.db.execute<{ r: string | null }>(
      sql`SELECT to_regclass(${`${schema}.${name}`})::text AS r`
    );
    return rows[0]?.r !== null;
  };
  const events = (tableId: string, kind: string) =>
    t.db
      .select()
      .from(outbox)
      .where(and(eq(outbox.tableId, tableId), eq(outbox.kind, kind)))
      .orderBy(asc(outbox.id));

  /** Tasks ↔ Projects in one base, with a link field Projects on Tasks. */
  async function world() {
    const base = await newBase();
    const projects = await newTable(base.id, 'Projects');
    const tasks = await newTable(base.id, 'Tasks');
    const field = await ok<FieldMeta>(
      await link(tasks.id, 'Projects', { linkedTableId: projects.id }),
      201
    );
    const projectName = fieldOf(projects, 'Name').id;
    const taskName = fieldOf(tasks, 'Name').id;
    const [alpha, beta, gamma] = await create(projects.id, [
      { [projectName]: 'Alpha' },
      { [projectName]: 'Beta' },
      { [projectName]: 'Gamma' },
    ]);
    if (!alpha || !beta || !gamma) throw new Error('no projects');
    const inverseId = (field.options as LinkOptions).inverseLinkFieldId as string;
    return { base, projects, tasks, field, inverseId, projectName, taskName, alpha, beta, gamma };
  }

  beforeAll(async () => {
    const created = await createWorkspace(t.db);
    owner = created.owner;
    workspaceId = created.workspace.id;
    api = await authedClient(t, owner);
  });

  it('creates the inverse field in the linked table and the junction, with events for both', async () => {
    const w = await world();
    const options = w.field.options as LinkOptions;
    expect(options).toMatchObject({
      linkedTableId: w.projects.id,
      prefersSingleRecordLink: false,
      viewIdForRecordSelection: null,
    });
    const projects = await getTable(w.projects.id);
    const inverse = fieldOf(projects, 'Tasks');
    expect(inverse.id).toBe(options.inverseLinkFieldId);
    expect(inverse.type).toBe('link');
    expect(inverse.options).toEqual({
      linkedTableId: w.tasks.id,
      inverseLinkFieldId: w.field.id,
      prefersSingleRecordLink: false,
      viewIdForRecordSelection: null,
    });
    const [table] = await t.db.select().from(tables).where(eq(tables.id, w.tasks.id));
    expect(await junctionExists(`l_${w.field.id.replaceAll('-', '')}`, table?.dbSchema ?? '')).toBe(
      true
    );
    expect((await events(w.tasks.id, 'field.created')).at(-1)?.payload).toMatchObject({
      field: { id: w.field.id },
    });
    expect((await events(w.projects.id, 'field.created')).at(-1)?.payload).toMatchObject({
      field: { id: inverse.id },
    });
    // A second link to the same table gets a free inverse name.
    await ok(await link(w.tasks.id, 'Also projects', { linkedTableId: w.projects.id }), 201);
    expect(fieldOf(await getTable(w.projects.id), 'Tasks 2').type).toBe('link');
  });

  it('keeps both sides consistent through adds, reorders and removals, with events for both', async () => {
    const w = await world();
    const [task] = await create(w.tasks.id, [
      { [w.taskName]: 'Write spec', [w.field.id]: [w.alpha.id, { id: w.beta.id }] },
    ]);
    if (!task) throw new Error('no task');
    expect(task.fields[w.field.id]).toEqual([
      { id: w.alpha.id, name: 'Alpha' },
      { id: w.beta.id, name: 'Beta' },
    ]);
    expect(ids((await get(w.projects.id, w.alpha.id)).fields[w.inverseId])).toEqual([task.id]);
    expect(names((await get(w.projects.id, w.beta.id)).fields[w.inverseId])).toEqual([
      'Write spec',
    ]);
    const updates = await events(w.projects.id, 'record.updated');
    expect(updates.map((e) => (e.payload as { recordId: string }).recordId).sort()).toEqual(
      [w.alpha.id, w.beta.id].sort()
    );
    expect(updates[0]?.payload).toMatchObject({
      fieldIds: [w.inverseId],
      cells: { [w.inverseId]: [{ id: task.id, name: 'Write spec' }] },
    });

    // Reorder and swap: Beta first, Alpha out, Gamma in.
    const changed = await ok<{ records: RecordData[] }>(
      await patch(w.tasks.id, task.id, { [w.field.id]: [w.gamma.id, w.beta.id] })
    );
    expect(names(changed.records[0]?.fields[w.field.id])).toEqual(['Gamma', 'Beta']);
    expect(changed.records[0]?.version).toBe(task.version + 1);
    expect((await get(w.projects.id, w.alpha.id)).fields[w.inverseId]).toBeNull();
    expect(ids((await get(w.projects.id, w.gamma.id)).fields[w.inverseId])).toEqual([task.id]);
    const later = (await events(w.projects.id, 'record.updated')).slice(updates.length);
    // Alpha (removed) and Gamma (added) changed; Beta only moved on the task's side.
    expect(later.map((e) => (e.payload as { recordId: string }).recordId).sort()).toEqual(
      [w.alpha.id, w.gamma.id].sort()
    );

    // From the other side: Gamma unlinks the task.
    const before = (await events(w.tasks.id, 'record.updated')).length;
    await ok(await patch(w.projects.id, w.gamma.id, { [w.inverseId]: [] }));
    expect(names((await get(w.tasks.id, task.id)).fields[w.field.id])).toEqual(['Beta']);
    const taskEvents = (await events(w.tasks.id, 'record.updated')).slice(before);
    expect(taskEvents.map((e) => e.payload)).toEqual([
      expect.objectContaining({
        recordId: task.id,
        fieldIds: [w.field.id],
        cells: { [w.field.id]: [{ id: w.beta.id, name: 'Beta' }] },
      }),
    ]);
  });

  it('hides links to deleted records on both sides and brings them back on restore', async () => {
    const w = await world();
    const [task] = await create(w.tasks.id, [{ [w.field.id]: [w.alpha.id, w.beta.id] }]);
    if (!task) throw new Error('no task');
    const before = (await events(w.tasks.id, 'record.updated')).length;
    await ok(await json('POST', `${records(w.projects.id)}/delete`, { recordIds: [w.alpha.id] }));
    expect(names((await get(w.tasks.id, task.id)).fields[w.field.id])).toEqual(['Beta']);
    const after = (await events(w.tasks.id, 'record.updated')).slice(before);
    expect(after.map((e) => e.payload)).toEqual([
      expect.objectContaining({ recordId: task.id, cells: { [w.field.id]: [expect.anything()] } }),
    ]);
    // Rewriting the cell keeps the hidden link, so a restore still brings it back.
    await ok(await patch(w.tasks.id, task.id, { [w.field.id]: [w.beta.id] }));
    await ok(await json('POST', `${records(w.projects.id)}/restore`, { recordIds: [w.alpha.id] }));
    expect(names((await get(w.tasks.id, task.id)).fields[w.field.id])).toEqual(['Alpha', 'Beta']);
    // Deleting the task removes it from the projects' inverse cells.
    await ok(await json('POST', `${records(w.tasks.id)}/delete`, { recordIds: [task.id] }));
    expect((await get(w.projects.id, w.beta.id)).fields[w.inverseId]).toBeNull();
  });

  it("can't link records of another table, base or workspace (404), nor link across bases", async () => {
    const w = await world();
    const [task] = await create(w.tasks.id, [{}]);
    if (!task) throw new Error('no task');
    const otherBase = await newBase();
    const elsewhere = await newTable(otherBase.id, 'Elsewhere');
    const [foreign] = await create(elsewhere.id, [{}]);
    const tenant = await createWorkspace(t.db);
    const stranger = await authedClient(t, tenant.owner);
    const strangerBase = await newBase(stranger, tenant.workspace.id);
    const strangerTable = await newTable(strangerBase.id, 'Secret', stranger);
    const [secret] = (
      await ok<{ records: RecordData[] }>(
        await json('POST', records(strangerTable.id), { records: [{ fields: {} }] }, stranger),
        201
      )
    ).records;

    for (const id of [foreign?.id, secret?.id, task.id]) {
      const res = await patch(w.tasks.id, task.id, { [w.field.id]: [id] });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { recordIds: string[] }).recordIds).toEqual([id]);
    }
    expect((await get(w.tasks.id, task.id)).fields[w.field.id]).toBeNull();

    // Link fields only point at tables of the same base.
    expect((await link(w.tasks.id, 'Out', { linkedTableId: elsewhere.id })).status).toBe(404);
    expect((await link(w.tasks.id, 'Out', { linkedTableId: strangerTable.id })).status).toBe(404);
    expect((await link(w.tasks.id, 'Out', {})).status).toBe(422);
    const [table] = await t.db.select().from(tables).where(eq(tables.id, w.tasks.id));
    expect(table).toBeDefined();
  });

  it('matches names by primary field, and typecast creates the missing records', async () => {
    const w = await world();
    const [task] = await create(w.tasks.id, [{ [w.field.id]: 'alpha' }]);
    expect(names(task?.fields[w.field.id])).toEqual(['Alpha']);
    const [pasted] = await create(w.tasks.id, [{ [w.field.id]: 'Beta, gamma' }]);
    expect(names(pasted?.fields[w.field.id])).toEqual(['Beta', 'Gamma']);

    const res = await json('POST', records(w.tasks.id), { fields: { [w.field.id]: 'Delta' } });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain(
      'No record named \\"Delta\\" in \\"Projects\\"'
    );

    const [typecast] = await create(w.tasks.id, [{ [w.field.id]: ['Delta', 'Alpha'] }], true);
    expect(names(typecast?.fields[w.field.id])).toEqual(['Delta', 'Alpha']);
    const created = await events(w.projects.id, 'record.created');
    expect(created.at(-1)?.payload).toMatchObject({
      record: { fields: { [w.projectName]: 'Delta' } },
    });
  });

  it('keeps one record when multiple links are turned off', async () => {
    const w = await world();
    const single = await ok<FieldMeta>(
      await link(w.tasks.id, 'Lead project', {
        linkedTableId: w.projects.id,
        prefersSingleRecordLink: true,
      }),
      201
    );
    const [task] = await create(w.tasks.id, [{ [single.id]: [w.alpha.id, w.beta.id] }]);
    expect(names(task?.fields[single.id])).toEqual(['Alpha']);
    // The option can change later; the linked table can't.
    const changed = await json('PATCH', `/api/fields/${single.id}`, {
      options: { prefersSingleRecordLink: false },
    });
    expect(((await ok<FieldMeta>(changed)).options as LinkOptions).linkedTableId).toBe(
      w.projects.id
    );
    const moved = await json('PATCH', `/api/fields/${single.id}`, {
      options: { linkedTableId: w.tasks.id },
    });
    expect(moved.status).toBe(422);
  });

  it('enforces "limit to a view" on writes (422), not only in the picker', async () => {
    const w = await world();
    const status = fieldOf(w.projects, 'Status');
    const done = (status.options as { choices: { id: string; name: string }[] }).choices.find(
      (c) => c.name === 'Done'
    );
    await ok(await patch(w.projects.id, w.beta.id, { [status.id]: done?.id }));
    const view = await ok<{ id: string }>(
      await json('POST', `/api/tables/${w.projects.id}/views`, { name: 'Done' }),
      201
    );
    await ok(
      await json('PATCH', `/api/views/${view.id}`, {
        query: {
          filter: {
            conjunction: 'and',
            conditions: [{ fieldId: status.id, operator: 'is', value: done?.id }],
          },
        },
      })
    );
    const limited = await ok<FieldMeta>(
      await link(w.tasks.id, 'Done project', {
        linkedTableId: w.projects.id,
        viewIdForRecordSelection: view.id,
      }),
      201
    );
    const refused = await json('POST', records(w.tasks.id), {
      fields: { [limited.id]: [w.alpha.id] },
    });
    expect(refused.status).toBe(422);
    const [task] = await create(w.tasks.id, [{ [limited.id]: [w.beta.id] }]);
    expect(names(task?.fields[limited.id])).toEqual(['Beta']);
    // The view must belong to the linked table.
    const bad = await link(w.tasks.id, 'Bad', {
      linkedTableId: w.tasks.id,
      viewIdForRecordSelection: view.id,
    });
    expect(bad.status).toBe(422);
  });

  it('filters, sorts and searches by the linked records’ primary field', async () => {
    const w = await world();
    const created = await create(w.tasks.id, [
      { [w.taskName]: 'one', [w.field.id]: [w.gamma.id] },
      { [w.taskName]: 'two', [w.field.id]: [w.alpha.id, w.gamma.id] },
      { [w.taskName]: 'three' },
    ]);
    const query = async (q: Record<string, unknown>) =>
      ok<{ records: RecordData[] }>(
        await json('POST', `${records(w.tasks.id)}/query`, { query: q })
      );
    const namesOf = (r: { records: RecordData[] }) =>
      r.records.map((x) => x.fields[w.taskName] as string);
    const cond = (operator: string, value?: string) => ({
      filter: { conjunction: 'and', conditions: [{ fieldId: w.field.id, operator, value }] },
    });
    expect(namesOf(await query(cond('contains', 'alp')))).toEqual(['two']);
    expect(namesOf(await query(cond('doesNotContain', 'alp')))).toEqual(['one', 'three']);
    expect(namesOf(await query(cond('isEmpty')))).toEqual(['three']);
    expect(namesOf(await query(cond('isNotEmpty')))).toEqual(['one', 'two']);
    expect(namesOf(await query({ sorts: [{ fieldId: w.field.id, direction: 'asc' }] }))).toEqual([
      'three',
      'two',
      'one',
    ]);
    expect(namesOf(await query({ search: 'gamm' }))).toEqual(['one', 'two']);
    expect(created).toHaveLength(3);
  });

  it('filters by specific linked records; ids of another base or tenant match nothing (#82)', async () => {
    const w = await world();
    await create(w.tasks.id, [
      { [w.taskName]: 'one', [w.field.id]: [w.gamma.id] },
      { [w.taskName]: 'two', [w.field.id]: [w.alpha.id, w.gamma.id] },
      { [w.taskName]: 'three' },
    ]);
    const run = (operator: string, value: unknown) =>
      json('POST', `${records(w.tasks.id)}/query`, {
        query: { filter: { conditions: [{ fieldId: w.field.id, operator, value }] } },
        count: true,
      });
    const namesOf = async (res: Response) =>
      (await ok<{ records: RecordData[] }>(res)).records.map((x) => x.fields[w.taskName]);
    expect(await namesOf(await run('hasAnyOf', [w.alpha.id]))).toEqual(['two']);
    expect(await namesOf(await run('hasAnyOf', [w.alpha.id.toUpperCase(), w.gamma.id]))).toEqual([
      'one',
      'two',
    ]);
    expect(await namesOf(await run('hasNoneOf', [w.alpha.id]))).toEqual(['one', 'three']);
    expect(await namesOf(await run('hasNoneOf', [w.beta.id]))).toEqual(['one', 'two', 'three']);
    // A blank value is ignored, as for any filter.
    expect(await namesOf(await run('hasAnyOf', []))).toEqual(['one', 'two', 'three']);
    // A deleted linked record no longer matches.
    await ok(await json('POST', `${records(w.projects.id)}/delete`, { recordIds: [w.alpha.id] }));
    expect(await namesOf(await run('hasAnyOf', [w.alpha.id]))).toEqual([]);

    // Ids of records of another base or tenant match nothing, and the answer is the same as
    // for an id that doesn't exist (nothing leaks).
    const otherBase = await newBase();
    const elsewhere = await newTable(otherBase.id, 'Elsewhere');
    const [foreign] = await create(elsewhere.id, [{}]);
    const tenant = await createWorkspace(t.db);
    const stranger = await authedClient(t, tenant.owner);
    const strangerBase = await newBase(stranger, tenant.workspace.id);
    const strangerTable = await newTable(strangerBase.id, 'Secret', stranger);
    const [secret] = (
      await ok<{ records: RecordData[] }>(
        await json('POST', records(strangerTable.id), { records: [{ fields: {} }] }, stranger),
        201
      )
    ).records;
    for (const id of [foreign?.id, secret?.id, '00000000-0000-4000-8000-000000000000']) {
      expect(await namesOf(await run('hasAnyOf', [id]))).toEqual([]);
      expect(await namesOf(await run('hasNoneOf', [id]))).toEqual(['one', 'two', 'three']);
    }
    // Not record ids, or too many: 422.
    expect((await run('hasAnyOf', ['Alpha'])).status).toBe(422);
    expect((await run('hasAnyOf', [{ id: w.gamma.id }])).status).toBe(422);
    const many = Array.from({ length: 101 }, () => crypto.randomUUID());
    expect((await run('hasAnyOf', many)).status).toBe(422);
  });

  it('groups by the whole list of linked records, ordered by their names (#82)', async () => {
    const w = await world();
    // Two projects named the same: their groups stay apart.
    const [alpha2] = await create(w.projects.id, [{ [w.projectName]: 'Alpha' }]);
    if (!alpha2) throw new Error('no project');
    await create(w.tasks.id, [
      { [w.taskName]: 'one', [w.field.id]: [w.gamma.id] },
      { [w.taskName]: 'two', [w.field.id]: [w.alpha.id, w.gamma.id] },
      { [w.taskName]: 'three' },
      { [w.taskName]: 'four', [w.field.id]: [w.gamma.id] },
      { [w.taskName]: 'five', [w.field.id]: [w.alpha.id] },
      { [w.taskName]: 'six', [w.field.id]: [alpha2.id] },
      { [w.taskName]: 'seven', [w.field.id]: [w.alpha.id] },
    ]);
    const res = await ok<{
      records: RecordData[];
      groups: { key: { id: string; name: string }[][]; count: number }[];
    }>(
      await json('POST', `${records(w.tasks.id)}/query`, {
        query: { groupBy: [{ fieldId: w.field.id, direction: 'asc' }] },
        groups: true,
      })
    );
    const [first, second] = [w.alpha.id, alpha2.id].sort();
    expect(res.groups).toEqual([
      { key: [null], count: 1 },
      { key: [[{ id: first, name: 'Alpha' }]], count: first === w.alpha.id ? 2 : 1 },
      { key: [[{ id: second, name: 'Alpha' }]], count: second === w.alpha.id ? 2 : 1 },
      {
        key: [
          [
            { id: w.alpha.id, name: 'Alpha' },
            { id: w.gamma.id, name: 'Gamma' },
          ],
        ],
        count: 1,
      },
      { key: [[{ id: w.gamma.id, name: 'Gamma' }]], count: 2 },
    ]);
    // Records follow the groups (equal names never interleave).
    const alphaFirst = first === w.alpha.id ? ['five', 'seven', 'six'] : ['six', 'five', 'seven'];
    expect(res.records.map((r) => r.fields[w.taskName])).toEqual([
      'three',
      ...alphaFirst,
      'two',
      'one',
      'four',
    ]);
    // Descending reverses the groups.
    const desc = await ok<{ groups: { count: number }[] }>(
      await json('POST', `${records(w.tasks.id)}/query`, {
        query: { groupBy: [{ fieldId: w.field.id, direction: 'desc' }] },
        groups: true,
      })
    );
    expect(desc.groups.map((g) => g.count)).toEqual([...res.groups.map((g) => g.count)].reverse());
  });

  it('self-links have no inverse field', async () => {
    const base = await newBase();
    const people = await newTable(base.id, 'People');
    const manager = await ok<FieldMeta>(
      await link(people.id, 'Manager', { linkedTableId: people.id }),
      201
    );
    expect((manager.options as LinkOptions).inverseLinkFieldId).toBeNull();
    expect((await getTable(people.id)).fields.filter((f) => f.type === 'link')).toHaveLength(1);
    const name = fieldOf(people, 'Name').id;
    const [boss] = await create(people.id, [{ [name]: 'Boss' }]);
    const [report] = await create(people.id, [{ [name]: 'Report', [manager.id]: [boss?.id] }]);
    expect(report?.fields[manager.id]).toEqual([{ id: boss?.id, name: 'Boss' }]);
    expect((await get(people.id, boss?.id ?? '')).fields[manager.id]).toBeNull();
  });

  it('deleting a link field trashes the pair, keeps the junction, and restores both (#95)', async () => {
    const w = await world();
    const [first] = await create(w.tasks.id, [{ [w.field.id]: [w.alpha.id] }]);
    const [table] = await t.db.select().from(tables).where(eq(tables.id, w.tasks.id));
    const junction = `l_${w.field.id.replaceAll('-', '')}`;
    // From the inverse side: both go, the junction stays.
    expect((await json('DELETE', `/api/fields/${w.inverseId}`)).status).toBe(204);
    const rows = await t.db
      .select()
      .from(fields)
      .where(inArray(fields.id, [w.field.id, w.inverseId]));
    expect(rows.every((r) => r.deletedAt !== null)).toBe(true);
    expect(rows.find((r) => r.id === w.field.id)?.trashedWith).toBe(w.inverseId);
    expect(await junctionExists(junction, table?.dbSchema ?? '')).toBe(true);
    expect((await events(w.tasks.id, 'field.deleted')).at(-1)?.payload).toEqual({
      fieldId: w.field.id,
    });
    // Records still read and write without the field.
    const [task] = await create(w.tasks.id, [{ [w.taskName]: 'after' }]);
    expect(task?.fields).not.toHaveProperty(w.field.id);
    // The pair is one item in the trash, under the side that was deleted.
    const trash = await ok<{ fields: { id: string; inverse: { id: string } | null }[] }>(
      await json('GET', `/api/bases/${w.base.id}/trash`)
    );
    expect(trash.fields.map((f) => [f.id, f.inverse?.id])).toEqual([[w.inverseId, w.field.id]]);
    // Restoring the other side alone isn't possible: it comes back with the inverse.
    expect(
      (await json('POST', `/api/tables/${w.tasks.id}/fields/${w.field.id}/restore`)).status
    ).toBe(404);
    await ok(await json('POST', `/api/tables/${w.projects.id}/fields/${w.inverseId}/restore`));
    expect((await get(w.tasks.id, first?.id ?? '')).fields[w.field.id]).toEqual([
      { id: w.alpha.id, name: 'Alpha' },
    ]);
    expect(ids((await get(w.projects.id, w.alpha.id)).fields[w.inverseId])).toEqual([first?.id]);
    expect((await events(w.tasks.id, 'field.restored')).at(-1)?.payload).toMatchObject({
      field: { id: w.field.id },
    });
  });

  it('converts text to a link by primary field, creating the records nothing matches', async () => {
    const w = await world();
    const text = await ok<FieldMeta>(
      await json('POST', `/api/tables/${w.tasks.id}/fields`, {
        name: 'Proj',
        type: 'singleLineText',
      }),
      201
    );
    const [a, b, c, d] = await create(w.tasks.id, [
      { [text.id]: 'alpha' },
      { [text.id]: 'Beta, Gamma' },
      { [text.id]: 'Zeta' },
      {},
    ]);
    const converted = await ok<FieldMeta>(
      await json('PATCH', `/api/fields/${text.id}`, {
        type: 'link',
        options: { linkedTableId: w.projects.id },
      })
    );
    const inverseId = (converted.options as LinkOptions).inverseLinkFieldId;
    expect(inverseId).toBeTruthy();
    expect(names((await get(w.tasks.id, a?.id ?? '')).fields[text.id])).toEqual(['Alpha']);
    expect(names((await get(w.tasks.id, b?.id ?? '')).fields[text.id])).toEqual(['Beta', 'Gamma']);
    expect(names((await get(w.tasks.id, c?.id ?? '')).fields[text.id])).toEqual(['Zeta']);
    expect((await get(w.tasks.id, d?.id ?? '')).fields[text.id]).toBeNull();
    // Zeta is a new project, linked back.
    const projects = await getTable(w.projects.id);
    expect(fieldOf(projects, 'Tasks 2').id).toBe(inverseId);
    const zeta = await ok<{ records: RecordData[] }>(
      await json('POST', `${records(w.projects.id)}/query`, { query: { search: 'Zeta' } })
    );
    expect(ids(zeta.records[0]?.fields[inverseId ?? ''])).toEqual([c?.id]);

    // And back to text: the names, the inverse field trashed, the junction dropped.
    const [table] = await t.db.select().from(tables).where(eq(tables.id, w.tasks.id));
    const back = await ok<FieldMeta>(
      await json('PATCH', `/api/fields/${text.id}`, { type: 'singleLineText' })
    );
    expect(back.type).toBe('singleLineText');
    expect((await get(w.tasks.id, b?.id ?? '')).fields[text.id]).toBe('Beta, Gamma');
    const [inverse] = await t.db
      .select()
      .from(fields)
      .where(eq(fields.id, inverseId ?? ''));
    expect(inverse?.deletedAt).not.toBeNull();
    expect(await junctionExists(`l_${text.id.replaceAll('-', '')}`, table?.dbSchema ?? '')).toBe(
      false
    );
    // To a link again, then to a multiple select: names become options.
    await ok(
      await json('PATCH', `/api/fields/${text.id}`, {
        type: 'link',
        options: { linkedTableId: w.projects.id },
      })
    );
    const select = await ok<FieldMeta>(
      await json('PATCH', `/api/fields/${text.id}`, { type: 'multipleSelect' })
    );
    const choices = (select.options as { choices: { id: string; name: string }[] }).choices;
    expect(choices.map((x) => x.name)).toEqual(['Alpha', 'Beta', 'Gamma', 'Zeta']);
    const cell = (await get(w.tasks.id, b?.id ?? '')).fields[text.id] as string[];
    expect(cell.map((id) => choices.find((x) => x.id === id)?.name)).toEqual(['Beta', 'Gamma']);
  });

  it('imports link cells by primary field and exports them as names', async () => {
    const w = await world();
    const runImport = async (csv: string, typecast: boolean) => {
      const job = await ok<{ id: string; status: string }>(
        await json('POST', `/api/tables/${w.tasks.id}/imports`, {
          csv,
          typecast,
          columns: [
            { index: 0, fieldId: w.taskName },
            { index: 1, fieldId: w.field.id },
          ],
        }),
        201
      );
      // As the worker would.
      await runImportJob({ db: t.appDb, logger }, { workspaceId, jobId: job.id });
      return ok<{ status: string; error: string | null }>(
        await json('GET', `/api/tables/${w.tasks.id}/imports/${job.id}`)
      );
    };
    expect((await runImport('Task,Projects\none,alpha\ntwo,"Beta, Nope"\n', false)).status).toBe(
      'done'
    );
    expect((await runImport('Task,Projects\nthree,"Gamma, Omega"\n', true)).status).toBe('done');
    const res = await json('POST', `${records(w.tasks.id)}/query`, {
      query: { sorts: [{ fieldId: w.taskName, direction: 'asc' }] },
    });
    const rows = (await ok<{ records: RecordData[] }>(res)).records.map((r) => [
      r.fields[w.taskName],
      names(r.fields[w.field.id]),
    ]);
    expect(rows).toEqual([
      ['one', ['Alpha']],
      ['three', ['Gamma', 'Omega']],
      ['two', ['Beta']],
    ]);
    const csv = await (await json('GET', `/api/tables/${w.tasks.id}/export.csv`)).text();
    expect(csv).toContain('three,,,"Gamma, Omega"');
  });

  const candidates = async (fieldId: string, query = '', client = api) =>
    client.request(`/api/fields/${fieldId}/link-candidates${query}`);

  it('the picker lists live records of the linked table by primary field, within the view', async () => {
    const w = await world();
    const all = await ok<{ tableId: string; records: { id: string; name: string }[] }>(
      await candidates(w.field.id)
    );
    expect(all).toEqual({
      tableId: w.projects.id,
      records: [
        { id: w.alpha.id, name: 'Alpha' },
        { id: w.beta.id, name: 'Beta' },
        { id: w.gamma.id, name: 'Gamma' },
      ],
      nextOffset: null,
    });
    const found = await ok<{ records: { name: string }[] }>(
      await candidates(w.field.id, '?search=MM&limit=5')
    );
    expect(found.records.map((r) => r.name)).toEqual(['Gamma']);
    await ok(await json('POST', `${records(w.projects.id)}/delete`, { recordIds: [w.beta.id] }));
    const live = await ok<{ records: { name: string }[] }>(await candidates(w.inverseId));
    expect(live.records).toEqual([]);
    expect(
      (await ok<{ records: { name: string }[] }>(await candidates(w.field.id))).records.map(
        (r) => r.name
      )
    ).toEqual(['Alpha', 'Gamma']);
    // Not a link field: 404. Another tenant: 404.
    expect((await candidates(w.taskName)).status).toBe(404);
    const tenant = await createWorkspace(t.db);
    const stranger = await authedClient(t, tenant.owner);
    expect((await candidates(w.field.id, '', stranger)).status).toBe(404);
    expect((await candidates(w.field.id, '?limit=1000')).status).toBe(422);
  });

  it('the picker pages, ignores the view limit for filters and names records by id (#82)', async () => {
    const w = await world();
    type Page = { records: { id: string; name: string }[]; nextOffset: number | null };
    const page1 = await ok<Page>(await candidates(w.field.id, '?limit=2'));
    expect(page1.records.map((r) => r.name)).toEqual(['Alpha', 'Beta']);
    expect(page1.nextOffset).toBe(2);
    const page2 = await ok<Page>(await candidates(w.field.id, '?limit=2&offset=2'));
    expect(page2).toMatchObject({ records: [{ name: 'Gamma' }], nextOffset: null });

    // A view of Projects showing only Beta limits linking, not a filter's picker.
    const view = await ok<{ id: string }>(
      await json('POST', `/api/tables/${w.projects.id}/views`, { name: 'Only Beta', type: 'grid' }),
      201
    );
    await ok(
      await json('PATCH', `/api/views/${view.id}`, {
        query: {
          filter: { conditions: [{ fieldId: w.projectName, operator: 'is', value: 'Beta' }] },
        },
      })
    );
    await ok(
      await json('PATCH', `/api/fields/${w.field.id}`, {
        options: { linkedTableId: w.projects.id, viewIdForRecordSelection: view.id },
      })
    );
    const limited = await ok<Page>(await candidates(w.field.id));
    expect(limited.records.map((r) => r.name)).toEqual(['Beta']);
    const forFilter = await ok<Page>(await candidates(w.field.id, '?purpose=filter'));
    expect(forFilter.records.map((r) => r.name)).toEqual(['Alpha', 'Beta', 'Gamma']);

    // Named records come back in the given order; ids of other tables or tenants don't.
    const tenant = await createWorkspace(t.db);
    const stranger = await authedClient(t, tenant.owner);
    const strangerBase = await newBase(stranger, tenant.workspace.id);
    const strangerTable = await newTable(strangerBase.id, 'Secret', stranger);
    const [secret] = (
      await ok<{ records: RecordData[] }>(
        await json('POST', records(strangerTable.id), { records: [{ fields: {} }] }, stranger),
        201
      )
    ).records;
    const [task] = await create(w.tasks.id, [{ [w.taskName]: 'a task' }]);
    const named = await ok<Page>(
      await candidates(
        w.field.id,
        `?ids=${[w.gamma.id, secret?.id, task?.id, w.alpha.id].join(',')}`
      )
    );
    expect(named).toEqual({
      tableId: w.projects.id,
      records: [
        { id: w.gamma.id, name: 'Gamma' },
        { id: w.alpha.id, name: 'Alpha' },
      ],
      nextOffset: null,
    });
    expect((await candidates(w.field.id, '?ids=nope')).status).toBe(422);
    expect((await candidates(w.field.id, '?offset=-1')).status).toBe(422);
    expect((await candidates(w.field.id, '?purpose=all')).status).toBe(422);
    const tooMany = Array.from({ length: 101 }, () => crypto.randomUUID()).join(',');
    expect((await candidates(w.field.id, `?ids=${tooMany}`)).status).toBe(422);
  });

  /**
   * Wall-clock times on the shared self-hosted runners swing with load (other jobs, the other test
   * files sharing the Postgres container), as in query-bench.test.ts: each search is paired with a
   * trivial picker request (one record by id) timed right before it, so both see the same load.
   * The p95 must stay under PICKER_P95_MS, or SLOWDOWN times the trivial request's p95 when the
   * machine is that much slower than usual.
   */
  const PICKER_P95_MS = 150;
  const SLOWDOWN = 10;
  const p95Of = (times: number[]) => {
    const sorted = times.slice(10).sort((a, b) => a - b);
    return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
  };

  it('the picker searches 100k linked records with p95 under 150 ms', async () => {
    const w = await world();
    const [projects] = await t.db.select().from(tables).where(eq(tables.id, w.projects.id));
    if (!projects) throw new Error('no projects table');
    const [primary] = await t.db.select().from(fields).where(eq(fields.id, w.projectName));
    await t.db.execute(sql`
      INSERT INTO ${qualified(projects)} (id, ${sql.identifier(primary?.dbColumn ?? '')})
      SELECT gen_random_uuid(), 'Project ' || lpad(n::text, 6, '0') || ' ' || md5(n::text)
        FROM generate_series(1, 100000) AS n`);
    await t.db.execute(sql`ANALYZE ${qualified(projects)}`);
    const searches = ['', 'Project 0999', '00042', 'abc', 'zzzz-nothing', 'ject 05', 'f00', '7'];
    const times: number[] = [];
    const baselines: number[] = [];
    for (let i = 0; i < 60; i++) {
      const search = searches[i % searches.length] ?? '';
      let started = performance.now();
      const trivial = await candidates(w.field.id, `?ids=${w.alpha.id}`);
      baselines.push(performance.now() - started);
      expect(trivial.status).toBe(200);
      started = performance.now();
      const res = await candidates(w.field.id, `?search=${encodeURIComponent(search)}&limit=50`);
      times.push(performance.now() - started);
      expect(res.status).toBe(200);
    }
    const p95 = p95Of(times);
    const baseline = p95Of(baselines);
    const budget = Math.max(PICKER_P95_MS, baseline * SLOWDOWN);
    console.info('link picker search over 100k records (p95 ms):', { p95, baseline, budget });
    expect(p95).toBeLessThan(budget);
  }, 120_000);
});
