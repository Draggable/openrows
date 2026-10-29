import type { FieldMeta, TableMeta, ViewMeta } from '@openrows/shared';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { outbox, type users, viewRecordPositions } from '../../src/db/index.js';
import { useTestDb } from '../helpers/db.js';
import { authedClient, createWorkspace } from '../helpers/factories.js';

/**
 * Kanban views: the `kanban` layout checked on write and pruned on read, stack queries
 * (`within`), the manual card order per view, and moving a card between stacks as a normal
 * record update.
 */
describe('kanban views', () => {
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
    return (status === 204 ? undefined : await res.json()) as T;
  }

  type Board = {
    table: TableMeta;
    view: ViewMeta;
    name: FieldMeta;
    status: FieldMeta;
    people: FieldMeta;
    owner: FieldMeta;
    files: FieldMeta;
  };

  async function newBoard(): Promise<Board> {
    const base = await ok<{ id: string }>(
      await json('POST', `/api/workspaces/${workspaceId}/bases`, { name: 'Base' }),
      201
    );
    const table = await ok<TableMeta>(
      await json('POST', `/api/bases/${base.id}/tables`, { name: 'Tasks' }),
      201
    );
    const field = async (body: unknown) =>
      ok<FieldMeta>(await json('POST', `/api/tables/${table.id}/fields`, body), 201);
    const name = table.fields.find((f) => f.isPrimary);
    if (!name) throw new Error('no primary field');
    const status = await field({
      name: 'Stage',
      type: 'singleSelect',
      options: {
        choices: [
          { id: 'todo', name: 'To do', color: 'blue' },
          { id: 'doing', name: 'Doing', color: 'amber' },
          { id: 'done', name: 'Done', color: 'green' },
        ],
      },
    });
    const people = await field({ name: 'People', type: 'user', options: { multiple: true } });
    const ownerField = await field({ name: 'Owner', type: 'user' });
    const files = await field({ name: 'Files', type: 'attachment' });
    const view = await ok<ViewMeta>(
      await json('POST', `/api/tables/${table.id}/views`, { name: 'Board', type: 'kanban' }),
      201
    );
    return { table, view, name, status, people, owner: ownerField, files };
  }

  async function addRecords(b: Board, rows: [string, string | null][]): Promise<string[]> {
    const created = await ok<{ records: { id: string }[] }>(
      await json('POST', `/api/tables/${b.table.id}/records`, {
        records: rows.map(([n, s]) => ({ fields: { [b.name.id]: n, [b.status.id]: s } })),
      }),
      201
    );
    return created.records.map((r) => r.id);
  }

  /** The names of a stack's cards, in the view's order. */
  async function stack(b: Board, choice: string | null): Promise<string[]> {
    const within = [
      choice === null
        ? { fieldId: b.status.id, operator: 'isEmpty' }
        : { fieldId: b.status.id, operator: 'is', value: choice },
    ];
    const result = await ok<{ records: { fields: Record<string, unknown> }[] }>(
      await json('POST', `/api/tables/${b.table.id}/records/query`, {
        viewId: b.view.id,
        query: { within },
      })
    );
    return result.records.map((r) => String(r.fields[b.name.id]));
  }

  const move = (b: Board, recordId: string, afterId: string | null) =>
    json('POST', `/api/views/${b.view.id}/order`, { recordId, afterId });

  beforeAll(async () => {
    const created = await createWorkspace(t.db);
    owner = created.owner;
    workspaceId = created.workspace.id;
    api = await authedClient(t, owner);
  });

  it('saves a kanban layout and refuses one that names the wrong fields', async () => {
    const b = await newBoard();
    expect(b.view).toMatchObject({ type: 'kanban', config: {} });
    const saved = await ok<ViewMeta>(
      await json('PATCH', `/api/views/${b.view.id}`, {
        kanban: {
          stackFieldId: b.status.id,
          cardFields: [b.owner.id, b.files.id],
          coverFieldId: b.files.id,
          collapseEmpty: true,
        },
      })
    );
    expect(saved.config.kanban).toEqual({
      stackFieldId: b.status.id,
      cardFields: [b.owner.id, b.files.id],
      coverFieldId: b.files.id,
      collapseEmpty: true,
    });
    // Keys left out stay.
    const merged = await ok<ViewMeta>(
      await json('PATCH', `/api/views/${b.view.id}`, { kanban: { stackFieldId: b.owner.id } })
    );
    expect(merged.config.kanban).toMatchObject({
      stackFieldId: b.owner.id,
      coverFieldId: b.files.id,
    });

    const refused = async (kanban: unknown, path: string) => {
      const res = await json('PATCH', `/api/views/${b.view.id}`, { kanban });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { errors?: { path: string }[] };
      expect(body.errors?.map((e) => e.path)).toContain(path);
    };
    await refused({ stackFieldId: b.name.id }, 'kanban.stackFieldId');
    await refused({ stackFieldId: b.people.id }, 'kanban.stackFieldId');
    await refused({ coverFieldId: b.status.id }, 'kanban.coverFieldId');
    await refused(
      { cardFields: [b.status.id, '01900000-0000-7000-8000-000000000000'] },
      'kanban.cardFields.1'
    );
    expect(
      (await json('PATCH', `/api/views/${b.view.id}`, { kanban: { stackBy: b.status.id } })).status
    ).toBe(422);

    // Another table's field is refused too.
    const other = await newBoard();
    await refused({ stackFieldId: other.status.id }, 'kanban.stackFieldId');
  });

  it('prunes a stack field converted to a type that can no longer stack', async () => {
    const b = await newBoard();
    await ok(
      await json('PATCH', `/api/views/${b.view.id}`, {
        kanban: { stackFieldId: b.owner.id, cardFields: [b.files.id] },
      })
    );
    await ok(
      await json('PATCH', `/api/fields/${b.owner.id}`, {
        options: { multiple: true },
      })
    );
    const read = await ok<ViewMeta>(await json('GET', `/api/views/${b.view.id}`));
    expect(read.config.kanban).toEqual({ stackFieldId: null, cardFields: [b.files.id] });
  });

  it('keeps a manual card order per view that survives a reload', async () => {
    const b = await newBoard();
    const [a, c, d, e] = await addRecords(b, [
      ['a', 'todo'],
      ['c', 'todo'],
      ['d', 'todo'],
      ['e', 'done'],
    ]);
    if (!a || !c || !d || !e) throw new Error('no records');
    expect(await stack(b, 'todo')).toEqual(['a', 'c', 'd']);

    await ok(await move(b, d, null), 204);
    expect(await stack(b, 'todo')).toEqual(['d', 'a', 'c']);
    await ok(await move(b, a, c), 204);
    expect(await stack(b, 'todo')).toEqual(['d', 'c', 'a']);
    await ok(await move(b, d, c), 204);
    expect(await stack(b, 'todo')).toEqual(['c', 'd', 'a']);
    expect(await stack(b, 'done')).toEqual(['e']);

    // Another view of the table has its own order (and grid views ignore it).
    const grid = (
      await ok<{ views: ViewMeta[] }>(await json('GET', `/api/tables/${b.table.id}/views`))
    ).views.find((v) => v.type === 'grid');
    const gridOrder = await ok<{ records: { fields: Record<string, unknown> }[] }>(
      await json('POST', `/api/tables/${b.table.id}/records/query`, { viewId: grid?.id })
    );
    expect(gridOrder.records.map((r) => r.fields[b.name.id])).toEqual(['a', 'c', 'd', 'e']);

    // A duplicate keeps the order.
    const copy = await ok<ViewMeta>(
      await json('POST', `/api/views/${b.view.id}/duplicate`, {}),
      201
    );
    const copied = await ok<{ records: { fields: Record<string, unknown> }[] }>(
      await json('POST', `/api/tables/${b.table.id}/records/query`, {
        viewId: copy.id,
        query: { within: [{ fieldId: b.status.id, operator: 'is', value: 'todo' }] },
      })
    );
    expect(copied.records.map((r) => r.fields[b.name.id])).toEqual(['c', 'd', 'a']);

    // Sorts win over the manual order, as in Airtable.
    await ok(
      await json('PATCH', `/api/views/${b.view.id}`, {
        query: { sorts: [{ fieldId: b.name.id, direction: 'asc' }] },
      })
    );
    expect(await stack(b, 'todo')).toEqual(['a', 'c', 'd']);

    const events = await t.db
      .select()
      .from(outbox)
      .where(and(eq(outbox.workspaceId, workspaceId), eq(outbox.kind, 'view.recordMoved')));
    expect(events.length).toBeGreaterThanOrEqual(3);
  });

  it('renumbers when repeated moves use up the gap between two cards', async () => {
    const b = await newBoard();
    const ids = await addRecords(
      b,
      Array.from({ length: 6 }, (_, i) => [`r${i}`, 'todo'] as [string, string])
    );
    const [first, second, ...rest] = ids;
    if (!first || !second) throw new Error('no records');
    await ok(await move(b, first, null), 204);
    await ok(await move(b, second, first), 204);
    // Keep inserting right after `first`: each move halves the gap, until it's renumbered.
    for (let i = 0; i < 70; i++) {
      const id = rest[i % rest.length] as string;
      await ok(await move(b, id, first), 204);
    }
    const order = await stack(b, 'todo');
    expect(order[0]).toBe('r0');
    expect(new Set(order).size).toBe(6);
    expect(order.at(-1)).toBe('r1');
    const last = rest[69 % rest.length] as string;
    const names = await stack(b, 'todo');
    expect(names[1]).toBe(`r${ids.indexOf(last)}`);
    const positions = await t.db
      .select()
      .from(viewRecordPositions)
      .where(eq(viewRecordPositions.viewId, b.view.id));
    expect(new Set(positions.map((p) => p.position)).size).toBe(positions.length);
  });

  it('moves a card between stacks through the RecordService', async () => {
    const b = await newBoard();
    const [x, y] = await addRecords(b, [
      ['x', 'todo'],
      ['y', 'doing'],
    ]);
    if (!x || !y) throw new Error('no records');
    // Drop x into "Doing" above y: a record update, then its place.
    await ok(
      await json('PATCH', `/api/tables/${b.table.id}/records`, {
        records: [{ id: x, fields: { [b.status.id]: 'doing' } }],
      })
    );
    await ok(await move(b, x, null), 204);
    expect(await stack(b, 'todo')).toEqual([]);
    expect(await stack(b, 'doing')).toEqual(['x', 'y']);
    const updates = await t.db
      .select()
      .from(outbox)
      .where(and(eq(outbox.workspaceId, workspaceId), eq(outbox.kind, 'record.updated')));
    expect(updates.some((e) => JSON.stringify(e.payload).includes(x))).toBe(true);

    // An unknown choice is refused by the record's validation.
    const bad = await json('PATCH', `/api/tables/${b.table.id}/records`, {
      records: [{ id: x, fields: { [b.status.id]: 'nope' } }],
    });
    expect(bad.status).toBe(422);
  });

  it('refuses moves of records that are not live records of the table', async () => {
    const b = await newBoard();
    const [x] = await addRecords(b, [['x', null]]);
    if (!x) throw new Error('no record');
    expect(await stack(b, null)).toEqual(['x']);
    const missing = '01900000-0000-7000-8000-000000000000';
    expect((await move(b, missing, null)).status).toBe(404);
    expect((await move(b, x, missing)).status).toBe(404);
    expect((await move(b, x, x)).status).toBe(422);
    const other = await newBoard();
    const [z] = await addRecords(other, [['z', null]]);
    if (!z) throw new Error('no record');
    expect((await move(b, z, null)).status).toBe(404);
    await ok(await json('POST', `/api/tables/${b.table.id}/records/delete`, { recordIds: [x] }));
    expect((await move(b, x, null)).status).toBe(404);
  });
});
