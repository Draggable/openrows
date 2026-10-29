import type { TableMeta, ViewMeta } from '@openrows/shared';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { outbox, type users } from '../../src/db/index.js';
import { useTestDb } from '../helpers/db.js';
import { authedClient, createWorkspace } from '../helpers/factories.js';

/** Views of a table: list, create, rename, reorder, duplicate, delete, outbox events. */
describe('views', () => {
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

  async function newTable(): Promise<TableMeta> {
    const base = await ok<{ id: string }>(
      await json('POST', `/api/workspaces/${workspaceId}/bases`, { name: 'Base' }),
      201
    );
    return ok<TableMeta>(
      await json('POST', `/api/bases/${base.id}/tables`, { name: 'Tasks' }),
      201
    );
  }
  const list = async (tableId: string) =>
    (await ok<{ views: ViewMeta[] }>(await json('GET', `/api/tables/${tableId}/views`))).views;

  beforeAll(async () => {
    const created = await createWorkspace(t.db);
    owner = created.owner;
    workspaceId = created.workspace.id;
    api = await authedClient(t, owner);
  });

  it('lists the default grid view of a new table', async () => {
    const table = await newTable();
    const views = await list(table.id);
    expect(views).toMatchObject([{ name: 'Grid view', type: 'grid', tableId: table.id }]);
  });

  it('creates views at the end, refuses duplicate names, renames and reorders', async () => {
    const table = await newTable();
    const a = await ok<ViewMeta>(
      await json('POST', `/api/tables/${table.id}/views`, { name: 'Open tasks' }),
      201
    );
    expect(a).toMatchObject({ name: 'Open tasks', type: 'grid', config: {} });
    expect((await list(table.id)).map((v) => v.name)).toEqual(['Grid view', 'Open tasks']);

    const clash = await json('POST', `/api/tables/${table.id}/views`, { name: 'open TASKS' });
    expect(clash.status).toBe(409);

    const renamed = await ok<ViewMeta>(await json('PATCH', `/api/views/${a.id}`, { name: 'Mine' }));
    expect(renamed.name).toBe('Mine');
    expect((await json('PATCH', `/api/views/${a.id}`, { name: 'grid VIEW' })).status).toBe(409);

    await ok(await json('PATCH', `/api/views/${a.id}`, { position: -1 }));
    expect((await list(table.id)).map((v) => v.name)).toEqual(['Mine', 'Grid view']);
    expect(await ok<ViewMeta>(await json('GET', `/api/views/${a.id}`))).toMatchObject({
      name: 'Mine',
      position: -1,
    });
  });

  it('duplicates a view with its config under a free name', async () => {
    const table = await newTable();
    const [grid] = await list(table.id);
    if (!grid) throw new Error('no view');
    const config = { sorts: [{ fieldId: table.fields[0]?.id, direction: 'desc' }] };
    await t.db.execute(
      `UPDATE views SET config = '${JSON.stringify(config)}'::jsonb WHERE id = '${grid.id}'`
    );
    const copy = await ok<ViewMeta>(await json('POST', `/api/views/${grid.id}/duplicate`, {}), 201);
    expect(copy).toMatchObject({ name: 'Grid view copy', type: 'grid', config });
    const again = await ok<ViewMeta>(
      await json('POST', `/api/views/${grid.id}/duplicate`, {}),
      201
    );
    expect(again.name).toBe('Grid view copy 2');
  });

  it('saves the grid layout in the config, merged, beside the saved query', async () => {
    const table = await newTable();
    const [grid] = await list(table.id);
    const [name, notes] = table.fields;
    if (!grid || !name || !notes) throw new Error('no view');
    const sorts = [{ fieldId: name.id, direction: 'desc' }];
    await t.db.execute(
      `UPDATE views SET config = '${JSON.stringify({ sorts })}'::jsonb WHERE id = '${grid.id}'`
    );
    const order = [notes.id, name.id];
    await ok(await json('PATCH', `/api/views/${grid.id}`, { grid: { fieldOrder: order } }));
    const saved = await ok<ViewMeta>(
      await json('PATCH', `/api/views/${grid.id}`, {
        grid: {
          columnWidths: { [notes.id]: 320 },
          frozenCount: 1,
          rowHeight: 'tall',
          hiddenFields: [notes.id],
        },
      })
    );
    expect(saved.config).toEqual({
      sorts,
      grid: {
        fieldOrder: order,
        columnWidths: { [notes.id]: 320 },
        frozenCount: 1,
        rowHeight: 'tall',
        hiddenFields: [notes.id],
      },
    });
    const bad = await json('PATCH', `/api/views/${grid.id}`, {
      grid: { columnWidths: { [notes.id]: 5 } },
    });
    expect(bad.status).toBe(422);

    // The saved sort still applies to the view query with a layout beside it.
    await ok(
      await json('POST', `/api/tables/${table.id}/records`, {
        records: [{ fields: { [name.id]: 'a' } }, { fields: { [name.id]: 'b' } }],
      }),
      201
    );
    const result = await ok<{ records: { fields: Record<string, unknown> }[] }>(
      await json('POST', `/api/tables/${table.id}/records/query`, { viewId: grid.id })
    );
    expect(result.records.map((r) => r.fields[name.id])).toEqual(['b', 'a']);
  });

  it('checks the grid layout field ids on write and prunes stale ones on read (#21)', async () => {
    const table = await newTable();
    const other = await newTable();
    const [grid] = await list(table.id);
    const [name, notes, status] = table.fields;
    const foreign = other.fields[1];
    if (!grid || !name || !notes || !status || !foreign) throw new Error('no view');

    const refused = await json('PATCH', `/api/views/${grid.id}`, {
      grid: {
        fieldOrder: [notes.id, foreign.id],
        columnWidths: { '00000000-0000-4000-8000-000000000009': 200 },
        hiddenFields: [name.id],
      },
    });
    expect(refused.status).toBe(422);
    const problem = (await refused.json()) as { errors: { path: string }[] };
    expect(problem.errors.map((e) => e.path)).toEqual([
      'grid.fieldOrder.1',
      'grid.columnWidths.00000000-0000-4000-8000-000000000009',
      'grid.hiddenFields.0',
    ]);
    // Unknown keys are refused, in the layout and beside it.
    for (const body of [{ grid: { colour: 'red' } }, { config: {} }]) {
      expect((await json('PATCH', `/api/views/${grid.id}`, body)).status).toBe(422);
    }
    expect((await ok<ViewMeta>(await json('GET', `/api/views/${grid.id}`))).config).toEqual({});

    const layout = {
      fieldOrder: [status.id, notes.id, name.id],
      columnWidths: { [notes.id]: 300, [status.id]: 120 },
      hiddenFields: [notes.id, status.id],
    };
    await ok(
      await json('PATCH', `/api/views/${grid.id}`, {
        grid: layout,
        query: { sorts: [{ fieldId: notes.id, direction: 'asc' }] },
      })
    );
    // A deleted field disappears from the config the API returns, everywhere...
    await ok(await json('DELETE', `/api/fields/${notes.id}`), 204);
    const pruned = {
      sorts: [],
      grid: {
        fieldOrder: [status.id, name.id],
        columnWidths: { [status.id]: 120 },
        hiddenFields: [status.id],
      },
    };
    expect((await ok<ViewMeta>(await json('GET', `/api/views/${grid.id}`))).config).toEqual(pruned);
    expect((await list(table.id))[0]?.config).toEqual(pruned);
    // ...a client that hasn't seen the delete yet can still save it...
    await ok(
      await json('PATCH', `/api/views/${grid.id}`, {
        grid: { hiddenFields: [notes.id, status.id] },
      })
    );
    // ...and restoring the field brings its settings back.
    await ok(await json('POST', `/api/tables/${table.id}/fields/${notes.id}/restore`), 200);
    const restored = await ok<ViewMeta>(await json('GET', `/api/views/${grid.id}`));
    expect(restored.config).toEqual({
      sorts: [{ fieldId: notes.id, direction: 'asc' }],
      grid: layout,
    });

    // Keys this version doesn't know (older or hand-edited configs) aren't returned.
    await t.db.execute(
      `UPDATE views SET config = config || '{"visibleFields": [], "sorts": "bad"}'::jsonb WHERE id = '${grid.id}'`
    );
    expect((await ok<ViewMeta>(await json('GET', `/api/views/${grid.id}`))).config).toEqual({
      grid: layout,
    });
  });

  it('saves the filter, sorts and groups (#28), checked, and the view query applies them', async () => {
    const table = await newTable();
    const [grid] = await list(table.id);
    const [name, notes] = table.fields;
    if (!grid || !name || !notes) throw new Error('no view');
    await ok(
      await json('POST', `/api/tables/${table.id}/records`, {
        records: ['apple', 'banana', 'cherry', 'avocado'].map((n, i) => ({
          fields: { [name.id]: n, [notes.id]: i % 2 === 0 ? 'x' : null },
        })),
      }),
      201
    );
    await ok(await json('PATCH', `/api/views/${grid.id}`, { grid: { rowHeight: 'tall' } }));
    const filter = {
      conjunction: 'and',
      conditions: [
        { fieldId: name.id, operator: 'contains', value: 'a' },
        {
          conjunction: 'or',
          conditions: [
            { fieldId: notes.id, operator: 'isNotEmpty' },
            { fieldId: name.id, operator: 'is', value: 'banana' },
          ],
        },
      ],
    };
    const sorts = [{ fieldId: name.id, direction: 'desc' }];
    const saved = await ok<ViewMeta>(
      await json('PATCH', `/api/views/${grid.id}`, { query: { filter, sorts } })
    );
    expect(saved.config).toEqual({ grid: { rowHeight: 'tall' }, filter, sorts });
    // Keys left out stay; a key sent replaces the saved one.
    const grouped = await ok<ViewMeta>(
      await json('PATCH', `/api/views/${grid.id}`, {
        query: { groupBy: [{ fieldId: notes.id, direction: 'asc' }] },
      })
    );
    expect(grouped.config).toMatchObject({ filter, sorts, groupBy: [{ fieldId: notes.id }] });

    const names = async () =>
      (
        await ok<{ records: { fields: Record<string, unknown> }[] }>(
          await json('POST', `/api/tables/${table.id}/records/query`, { viewId: grid.id })
        )
      ).records.map((r) => r.fields[name.id]);
    // Grouped by notes (empty first), then name descending.
    expect(await names()).toEqual(['banana', 'apple']);

    // A query the table can't run is refused: unknown field, operator the type lacks.
    const unknown = await json('PATCH', `/api/views/${grid.id}`, {
      query: { sorts: [{ fieldId: '00000000-0000-4000-8000-000000000009', direction: 'asc' }] },
    });
    expect(unknown.status).toBe(422);
    const operator = await json('PATCH', `/api/views/${grid.id}`, {
      query: { filter: { conditions: [{ fieldId: name.id, operator: '>', value: 1 }] } },
    });
    expect(operator.status).toBe(422);
    expect((await json('PATCH', `/api/views/${grid.id}`, { query: { sql: 'x' } })).status).toBe(
      422
    );

    // Deleting a field drops its conditions and group level from the saved query on read.
    await ok(await json('DELETE', `/api/fields/${notes.id}`), 204);
    expect(await names()).toEqual(['banana']);
    await ok(
      await json('PATCH', `/api/views/${grid.id}`, {
        query: { filter: { conjunction: 'and', conditions: [] } },
      })
    );
    expect(await names()).toEqual(['cherry', 'banana', 'avocado', 'apple']);
  });

  it('deletes a view but keeps the last one, and writes outbox events', async () => {
    const table = await newTable();
    const extra = await ok<ViewMeta>(
      await json('POST', `/api/tables/${table.id}/views`, { name: 'Extra' }),
      201
    );
    await ok(await json('DELETE', `/api/views/${extra.id}`), 204);
    expect((await json('GET', `/api/views/${extra.id}`)).status).toBe(404);
    const [last] = await list(table.id);
    if (!last) throw new Error('no view');
    expect((await json('DELETE', `/api/views/${last.id}`)).status).toBe(409);

    const events = await t.db
      .select({ kind: outbox.kind })
      .from(outbox)
      .where(and(eq(outbox.tableId, table.id)));
    expect(events.map((e) => e.kind).filter((k) => k.startsWith('view.'))).toEqual([
      'view.created',
      'view.deleted',
    ]);
  });

  it('refuses a malformed view id and an unknown type', async () => {
    expect((await json('GET', '/api/views/not-a-uuid')).status).toBe(404);
    const table = await newTable();
    const bad = await json('POST', `/api/tables/${table.id}/views`, { name: 'X', type: 'pie' });
    expect(bad.status).toBe(422);
  });
});
