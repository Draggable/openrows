import type {
  BaseTrash,
  FieldMeta,
  LinkOptions,
  RecordData,
  RecordTrash,
  TableMeta,
  ViewMeta,
  WorkspaceTrash,
} from '@openrows/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { qualified } from '../../src/data/columns.js';
import {
  bases,
  fields,
  outbox,
  recordRevisions,
  tables,
  type users,
  views,
} from '../../src/db/index.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, authedClient, createWorkspace } from '../helpers/factories.js';

/**
 * The trash: delete → trash → restore → delete permanently, for records, fields (a link
 * pair too), views, tables (with links into another table) and bases, through the API as the
 * app's role, with who deleted what, outbox events and the DDL behind "delete permanently".
 */
describe('trash', () => {
  const t = useTestDb();
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
    return (status === 204 ? null : await res.json()) as T;
  }

  const newBase = async () =>
    ok<{ id: string }>(
      await json('POST', `/api/workspaces/${workspaceId}/bases`, { name: 'Base' }),
      201
    );
  const newTable = async (baseId: string, name: string) =>
    ok<TableMeta>(await json('POST', `/api/bases/${baseId}/tables`, { name }), 201);
  const getTable = async (id: string) => ok<TableMeta>(await json('GET', `/api/tables/${id}`));
  const fieldOf = (table: TableMeta, name: string) => {
    const f = table.fields.find((x) => x.name === name);
    if (!f) throw new Error(`no field ${name}`);
    return f;
  };
  const records = (tableId: string) => `/api/tables/${tableId}/records`;
  const create = async (tableId: string, cells: Record<string, unknown>[]) =>
    (
      await ok<{ records: RecordData[] }>(
        await json('POST', records(tableId), { records: cells.map((f) => ({ fields: f })) }),
        201
      )
    ).records;
  const get = (tableId: string, id: string) => json('GET', `${records(tableId)}/${id}`);
  const baseTrash = async (baseId: string) =>
    ok<BaseTrash>(await json('GET', `/api/bases/${baseId}/trash`));
  const ids = (cell: unknown) => ((cell ?? []) as { id: string }[]).map((x) => x.id);
  const kinds = async (tableId: string) =>
    (
      await t.db
        .select({ kind: outbox.kind })
        .from(outbox)
        .where(eq(outbox.tableId, tableId))
        .orderBy(asc(outbox.id))
    ).map((e) => e.kind);
  const exists = async (name: string) => {
    const { rows } = await t.db.execute<{ r: string | null }>(
      sql`SELECT to_regclass(${name})::text AS r`
    );
    return rows[0]?.r !== null && rows[0]?.r !== undefined;
  };

  /** Tasks → Projects (a link field "Projects" on Tasks, its inverse "Tasks" on Projects). */
  async function linked() {
    const base = await newBase();
    const projects = await newTable(base.id, 'Projects');
    const tasks = await newTable(base.id, 'Tasks');
    const link = await ok<FieldMeta>(
      await json('POST', `/api/tables/${tasks.id}/fields`, {
        name: 'Projects',
        type: 'link',
        options: { linkedTableId: projects.id },
      }),
      201
    );
    const inverseId = (link.options as LinkOptions).inverseLinkFieldId as string;
    const [alpha] = await create(projects.id, [{ [fieldOf(projects, 'Name').id]: 'Alpha' }]);
    if (!alpha) throw new Error('no project');
    const [task] = await create(tasks.id, [
      { [fieldOf(tasks, 'Name').id]: 'Design', [link.id]: [alpha.id] },
    ]);
    if (!task) throw new Error('no task');
    return { base, projects, tasks, link, inverseId, alpha, task };
  }

  beforeAll(async () => {
    const created = await createWorkspace(t.db);
    owner = created.owner;
    workspaceId = created.workspace.id;
    api = await authedClient(t, owner);
  });

  it('lists deleted records with their name and deleter, restores and purges them', async () => {
    const w = await linked();
    const name = fieldOf(w.tasks, 'Name').id;
    const [a, b, c] = await create(w.tasks.id, [
      { [name]: 'One' },
      { [name]: 'Two', [w.link.id]: [w.alpha.id] },
      { [name]: 'Three' },
    ]);
    if (!a || !b || !c) throw new Error('no records');
    await ok(await json('POST', `${records(w.tasks.id)}/delete`, { recordIds: [a.id, b.id] }));
    await ok(await json('POST', `${records(w.tasks.id)}/delete`, { recordIds: [c.id] }));

    const page = async (q = '') =>
      ok<RecordTrash>(await json('GET', `/api/tables/${w.tasks.id}/trash/records${q}`));
    const all = await page();
    expect(all.records.map((r) => r.id)).toEqual([c.id, b.id, a.id]);
    expect(all.records[0]).toMatchObject({ name: 'Three', deletedBy: owner.id });
    expect(Date.parse(all.records[0]?.purgeAfter ?? '')).toBeGreaterThan(Date.now() + 29 * 864e5);
    // Keyset pages.
    const first = await page('?limit=2');
    expect(first.records.map((r) => r.id)).toEqual([c.id, b.id]);
    const second = await page(`?limit=2&cursor=${first.nextCursor}`);
    expect(second).toEqual({ records: [all.records[2]], nextCursor: null });

    // Restore one; purge another (its links go with it), a live one is a 404.
    await ok(await json('POST', `${records(w.tasks.id)}/restore`, { recordIds: [a.id] }));
    expect((await get(w.tasks.id, a.id)).status).toBe(200);
    const purge = (recordIds: string[]) =>
      json('POST', `/api/tables/${w.tasks.id}/trash/records/purge`, { recordIds });
    expect((await purge([a.id])).status).toBe(404);
    expect(await ok(await purge([b.id]))).toEqual({ purged: 1 });
    const [tasks] = await t.db.select().from(tables).where(eq(tables.id, w.tasks.id));
    if (!tasks) throw new Error('no tasks table');
    const { rows } = await t.db.execute(sql`SELECT id FROM ${qualified(tasks)} WHERE id = ${b.id}`);
    expect(rows).toHaveLength(0);
    const revisions = await t.db
      .select()
      .from(recordRevisions)
      .where(eq(recordRevisions.recordId, b.id));
    expect(revisions).toHaveLength(0);
    const alpha = await ok<RecordData>(await get(w.projects.id, w.alpha.id));
    expect(ids(alpha.fields[w.inverseId])).toEqual([w.task.id]);
    expect((await page()).records.map((r) => r.id)).toEqual([c.id]);
  });

  it('restores and purges a field, with who deleted it', async () => {
    const w = await linked();
    const estimate = await ok<FieldMeta>(
      await json('POST', `/api/tables/${w.tasks.id}/fields`, { name: 'Estimate', type: 'number' }),
      201
    );
    await ok(
      await json('PATCH', `${records(w.tasks.id)}/${w.task.id}`, { fields: { [estimate.id]: 3 } })
    );
    await ok(await json('DELETE', `/api/fields/${estimate.id}`), 204);
    const trash = await baseTrash(w.base.id);
    expect(trash.fields).toEqual([
      expect.objectContaining({
        id: estimate.id,
        name: 'Estimate',
        tableId: w.tasks.id,
        tableName: 'Tasks',
        type: 'number',
        deletedBy: owner.id,
        inverse: null,
      }),
    ]);
    await ok(await json('POST', `/api/tables/${w.tasks.id}/fields/${estimate.id}/restore`));
    expect((await ok<RecordData>(await get(w.tasks.id, w.task.id))).fields[estimate.id]).toBe(3);
    const [row] = await t.db.select().from(fields).where(eq(fields.id, estimate.id));
    expect(row).toMatchObject({ deletedAt: null, deletedBy: null });

    await ok(await json('DELETE', `/api/fields/${estimate.id}`), 204);
    const purge = `/api/tables/${w.tasks.id}/trash/fields/${estimate.id}`;
    // Purging needs the field in the trash of this table.
    expect(
      (await json('DELETE', `/api/tables/${w.projects.id}/trash/fields/${estimate.id}`)).status
    ).toBe(404);
    await ok(await json('DELETE', purge), 204);
    expect(await t.db.select().from(fields).where(eq(fields.id, estimate.id))).toHaveLength(0);
    const { rows: columns } = await t.db.execute(sql`
      SELECT 1 FROM information_schema.columns
       WHERE column_name = ${`f_${estimate.id.replaceAll('-', '')}`}`);
    expect(columns).toHaveLength(0);
    expect((await json('DELETE', purge)).status).toBe(404);
  });

  it('purges a link pair with its junction', async () => {
    const w = await linked();
    const [table] = await t.db.select().from(tables).where(eq(tables.id, w.tasks.id));
    const junction = `${table?.dbSchema}.l_${w.link.id.replaceAll('-', '')}`;
    await ok(await json('DELETE', `/api/fields/${w.link.id}`), 204);
    expect(await exists(junction)).toBe(true);
    await ok(await json('DELETE', `/api/tables/${w.tasks.id}/trash/fields/${w.link.id}`), 204);
    expect(await exists(junction)).toBe(false);
    const left = await t.db.select().from(fields).where(eq(fields.type, 'link'));
    expect(left.map((f) => f.id)).not.toContain(w.inverseId);
    expect(left.map((f) => f.id)).not.toContain(w.link.id);
  });

  it('restores and purges a view; a personal view only for its owner', async () => {
    const w = await linked();
    const board = await ok<ViewMeta>(
      await json('POST', `/api/tables/${w.tasks.id}/views`, { name: 'Board' }),
      201
    );
    await ok(await json('DELETE', `/api/views/${board.id}`), 204);
    expect((await baseTrash(w.base.id)).views).toEqual([
      expect.objectContaining({ id: board.id, name: 'Board', tableName: 'Tasks', personal: false }),
    ]);
    // A view under its name blocks the restore.
    const clash = await ok<ViewMeta>(
      await json('POST', `/api/tables/${w.tasks.id}/views`, { name: 'Board' }),
      201
    );
    const restore = `/api/tables/${w.tasks.id}/trash/views/${board.id}/restore`;
    expect((await json('POST', restore)).status).toBe(409);
    await ok(await json('DELETE', `/api/views/${clash.id}`), 204);
    const restored = await ok<ViewMeta>(await json('POST', restore));
    expect(restored).toMatchObject({ id: board.id, name: 'Board' });
    expect(await kinds(w.tasks.id)).toContain('view.restored');

    // Someone else's personal view: not listed, not restorable, not purgeable.
    const editor = await addMember(t.db, workspaceId, 'editor');
    const theirs = await authedClient(t, editor);
    const mine = await ok<ViewMeta>(
      await json(
        'POST',
        `/api/tables/${w.tasks.id}/views`,
        { name: 'Mine', personal: true },
        theirs
      ),
      201
    );
    await ok(await json('DELETE', `/api/views/${mine.id}`, undefined, theirs), 204);
    expect((await baseTrash(w.base.id)).views.map((v) => v.id)).not.toContain(mine.id);
    const theirTrash = await ok<BaseTrash>(
      await json('GET', `/api/bases/${w.base.id}/trash`, undefined, theirs)
    );
    expect(theirTrash.views.map((v) => v.id)).toContain(mine.id);
    expect((await json('DELETE', `/api/tables/${w.tasks.id}/trash/views/${mine.id}`)).status).toBe(
      404
    );
    expect(
      (await json('POST', `/api/tables/${w.tasks.id}/trash/views/${mine.id}/restore`)).status
    ).toBe(404);
    await ok(
      await json(
        'POST',
        `/api/tables/${w.tasks.id}/trash/views/${mine.id}/restore`,
        undefined,
        theirs
      )
    );

    await ok(await json('DELETE', `/api/views/${board.id}`), 204);
    await ok(await json('DELETE', `/api/tables/${w.tasks.id}/trash/views/${board.id}`), 204);
    expect(await t.db.select().from(views).where(eq(views.id, board.id))).toHaveLength(0);
  });

  it('trashes the inverse links of a deleted table and restores them with it', async () => {
    const w = await linked();
    await ok(await json('DELETE', `/api/tables/${w.projects.id}`), 204);
    // The other side of the link went with the table; Tasks reads without it.
    const [inTasks] = await t.db.select().from(fields).where(eq(fields.id, w.link.id));
    expect(inTasks).toMatchObject({ trashedWith: w.projects.id, deletedBy: owner.id });
    expect((await getTable(w.tasks.id)).fields.map((f) => f.id)).not.toContain(w.link.id);
    expect((await ok<RecordData>(await get(w.tasks.id, w.task.id))).fields).not.toHaveProperty(
      w.link.id
    );
    expect(await kinds(w.tasks.id)).toContain('field.deleted');
    const trash = await baseTrash(w.base.id);
    expect(trash.tables).toEqual([
      expect.objectContaining({ id: w.projects.id, name: 'Projects', deletedBy: owner.id }),
    ]);
    // It isn't a field of its own in the trash (Projects' fields aren't listed either).
    expect(trash.fields).toEqual([]);
    // A field linking to the trashed table can't be restored or reached on its own.
    expect(
      (await json('POST', `/api/tables/${w.tasks.id}/fields/${w.link.id}/restore`)).status
    ).toBe(404);

    const restored = await ok<TableMeta>(
      await json('POST', `/api/bases/${w.base.id}/trash/tables/${w.projects.id}/restore`)
    );
    expect(restored.fields.map((f) => f.id)).toContain(w.inverseId);
    const task = await ok<RecordData>(await get(w.tasks.id, w.task.id));
    expect(task.fields[w.link.id]).toEqual([{ id: w.alpha.id, name: 'Alpha' }]);
    expect(await kinds(w.projects.id)).toContain('table.restored');
    expect((await kinds(w.tasks.id)).at(-1)).toBe('field.restored');
    expect((await baseTrash(w.base.id)).tables).toEqual([]);
  });

  it('restores two linked tables deleted one after the other, in either order', async () => {
    const w = await linked();
    await ok(await json('DELETE', `/api/tables/${w.projects.id}`), 204);
    await ok(await json('DELETE', `/api/tables/${w.tasks.id}`), 204);
    const restore = async (id: string) =>
      ok<TableMeta>(await json('POST', `/api/bases/${w.base.id}/trash/tables/${id}/restore`));
    // Projects first: its link waits for Tasks, which is still in the trash.
    const projects = await restore(w.projects.id);
    expect(projects.fields.map((f) => f.id)).not.toContain(w.inverseId);
    const tasks = await restore(w.tasks.id);
    expect(tasks.fields.map((f) => f.id)).toContain(w.link.id);
    expect((await getTable(w.projects.id)).fields.map((f) => f.id)).toContain(w.inverseId);
    const alpha = await ok<RecordData>(await get(w.projects.id, w.alpha.id));
    expect(ids(alpha.fields[w.inverseId])).toEqual([w.task.id]);
  });

  it('refuses to delete a table whose links other tables read (409)', async () => {
    const w = await linked();
    const lookup = await ok<FieldMeta>(
      await json('POST', `/api/tables/${w.tasks.id}/fields`, {
        name: 'Project name',
        type: 'lookup',
        options: {
          recordLinkFieldId: w.link.id,
          fieldIdInLinkedTable: fieldOf(w.projects, 'Name').id,
        },
      }),
      201
    );
    const res = await json('DELETE', `/api/tables/${w.projects.id}`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { fieldIds: string[] }).fieldIds).toEqual([lookup.id]);
  });

  it('purges a table with its record table, links and inverse fields', async () => {
    const w = await linked();
    const [projects] = await t.db.select().from(tables).where(eq(tables.id, w.projects.id));
    const physical = `${projects?.dbSchema}.${projects?.dbTable}`;
    const junction = `${projects?.dbSchema}.l_${w.link.id.replaceAll('-', '')}`;
    const purge = `/api/bases/${w.base.id}/trash/tables/${w.projects.id}`;
    // Only from the trash.
    expect((await json('DELETE', purge)).status).toBe(404);
    await ok(await json('DELETE', `/api/tables/${w.projects.id}`), 204);
    await ok(await json('DELETE', purge), 204);
    expect(await exists(physical)).toBe(false);
    expect(await exists(junction)).toBe(false);
    expect(await t.db.select().from(tables).where(eq(tables.id, w.projects.id))).toHaveLength(0);
    expect(await t.db.select().from(fields).where(eq(fields.id, w.link.id))).toHaveLength(0);
    expect((await ok<RecordData>(await get(w.tasks.id, w.task.id))).fields).not.toHaveProperty(
      w.link.id
    );
    expect((await baseTrash(w.base.id)).tables).toEqual([]);
  });

  it('restores and purges a base through its workspace', async () => {
    const w = await linked();
    await ok(await json('DELETE', `/api/bases/${w.base.id}`), 204);
    expect((await json('GET', `/api/bases/${w.base.id}`)).status).toBe(404);
    const trash = await ok<WorkspaceTrash>(
      await json('GET', `/api/workspaces/${workspaceId}/trash`)
    );
    expect(trash.bases).toEqual([
      expect.objectContaining({ id: w.base.id, name: 'Base', deletedBy: owner.id }),
    ]);
    const restored = await ok<{ id: string; role: string }>(
      await json('POST', `/api/workspaces/${workspaceId}/trash/bases/${w.base.id}/restore`)
    );
    expect(restored).toMatchObject({ id: w.base.id, role: 'owner' });
    expect((await ok<RecordData>(await get(w.tasks.id, w.task.id))).fields[w.link.id]).toEqual([
      { id: w.alpha.id, name: 'Alpha' },
    ]);
    const events = await t.db
      .select({ kind: outbox.kind })
      .from(outbox)
      .where(and(eq(outbox.baseId, w.base.id), eq(outbox.kind, 'base.restored')));
    expect(events).toHaveLength(1);

    const [row] = await t.db.select().from(bases).where(eq(bases.id, w.base.id));
    const purge = `/api/workspaces/${workspaceId}/trash/bases/${w.base.id}`;
    expect((await json('DELETE', purge)).status).toBe(404);
    await ok(await json('DELETE', `/api/bases/${w.base.id}`), 204);
    await ok(await json('DELETE', purge), 204);
    const { rows } = await t.db.execute(
      sql`SELECT 1 FROM pg_namespace WHERE nspname = ${row?.dbSchema ?? ''}`
    );
    expect(rows).toHaveLength(0);
    expect(await t.db.select().from(tables).where(eq(tables.baseId, w.base.id))).toHaveLength(0);
    expect(
      (await ok<WorkspaceTrash>(await json('GET', `/api/workspaces/${workspaceId}/trash`))).bases
    ).toEqual([]);
  });

  it('marks items past the retention as due for purging, still restorable', async () => {
    const w = await linked();
    await ok(await json('DELETE', `/api/tables/${w.projects.id}`), 204);
    await t.db
      .update(tables)
      .set({ deletedAt: sql`now() - interval '31 days'` })
      .where(eq(tables.id, w.projects.id));
    const [item] = (await baseTrash(w.base.id)).tables;
    expect(Date.parse(item?.purgeAfter ?? '')).toBeLessThan(Date.now());
    await ok(await json('POST', `/api/bases/${w.base.id}/trash/tables/${w.projects.id}/restore`));
  });
});
