import type { FieldMeta, TableMeta, ViewMeta, ViewSection } from '@openrows/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { users } from '../../src/db/index.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, authedClient, createWorkspace } from '../helpers/factories.js';

/**
 * View polish: personal views (listed only to their creator, names scoped to who sees
 * them, never a link's view limit), the lock rules beyond the matrix, row colouring checked on
 * write, pruned on read and answered by the records query, and sidebar sections.
 */
describe('personal and locked views, row colours and view sections', () => {
  const t = useTestDb();
  let owner: typeof users.$inferSelect;
  let workspaceId: string;
  let api: Awaited<ReturnType<typeof authedClient>>;
  let editorApi: Awaited<ReturnType<typeof authedClient>>;

  const send =
    (client: () => Awaited<ReturnType<typeof authedClient>>) =>
    (method: string, path: string, body?: unknown) =>
      client().request(path, {
        method,
        headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
  const json = send(() => api);
  const asEditor = send(() => editorApi);

  async function ok<T>(res: Response, status = 200): Promise<T> {
    if (res.status !== status) throw new Error(`${res.status}: ${await res.text()}`);
    return (status === 204 ? undefined : await res.json()) as T;
  }

  async function fixture() {
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
    const stage = await field({
      name: 'Stage',
      type: 'singleSelect',
      options: {
        choices: [
          { id: 'todo', name: 'To do', color: 'blue' },
          { id: 'done', name: 'Done', color: 'green' },
        ],
      },
    });
    const points = await field({ name: 'Points', type: 'number' });
    const { views } = await ok<{ views: ViewMeta[] }>(
      await json('GET', `/api/tables/${table.id}/views`)
    );
    const grid = views[0];
    if (!grid) throw new Error('no default view');
    return { base, table, stage, points, grid };
  }

  beforeAll(async () => {
    const tenant = await createWorkspace(t.db);
    owner = tenant.owner;
    workspaceId = tenant.workspace.id;
    api = await authedClient(t, owner);
    editorApi = await authedClient(t, await addMember(t.db, workspaceId, 'editor'));
  });

  it('keeps personal views to their creator, with names scoped to who sees them', async () => {
    const f = await fixture();
    const mine = await ok<ViewMeta>(
      await asEditor('POST', `/api/tables/${f.table.id}/views`, { name: 'Mine', personal: true }),
      201
    );
    expect(mine).toMatchObject({ personal: true, locked: false, sectionId: null });
    const listed = async (send: typeof json) =>
      (
        await ok<{ views: ViewMeta[] }>(await send('GET', `/api/tables/${f.table.id}/views`))
      ).views.map((v) => v.name);
    expect(await listed(asEditor)).toEqual(['Grid view', 'Mine']);
    expect(await listed(json)).toEqual(['Grid view']);
    // The owner can't tell the name is taken, and gets no 404-revealing conflict.
    await ok(await json('POST', `/api/tables/${f.table.id}/views`, { name: 'Mine' }), 201);
    expect((await json('GET', `/api/views/${mine.id}`)).status).toBe(404);

    // Only the creator makes it collaborative; then everyone sees it.
    const shared = await ok<ViewMeta>(
      await asEditor('PATCH', `/api/views/${mine.id}`, { personal: false, name: 'Ours' })
    );
    expect(shared.personal).toBe(false);
    expect(await listed(json)).toContain('Ours');
    expect((await json('PATCH', `/api/views/${mine.id}`, { personal: true })).status).toBe(403);
  });

  it('keeps one collaborative view per table', async () => {
    const f = await fixture();
    expect((await json('PATCH', `/api/views/${f.grid.id}`, { personal: true })).status).toBe(409);
    await ok(
      await asEditor('POST', `/api/tables/${f.table.id}/views`, { name: 'P', personal: true }),
      201
    );
    expect((await json('DELETE', `/api/views/${f.grid.id}`)).status).toBe(409);
  });

  it("refuses a personal view as a link field's record selection limit", async () => {
    const f = await fixture();
    const mine = await ok<ViewMeta>(
      await json('POST', `/api/tables/${f.table.id}/views`, { name: 'Mine', personal: true }),
      201
    );
    const res = await json('POST', `/api/tables/${f.table.id}/fields`, {
      name: 'Related',
      type: 'link',
      options: { linkedTableId: f.table.id, viewIdForRecordSelection: mine.id },
    });
    expect(res.status).toBe(422);
  });

  it('lets an editor reorder but not reconfigure a locked view', async () => {
    const f = await fixture();
    await ok(await json('PATCH', `/api/views/${f.grid.id}`, { locked: true }));
    const refused = await asEditor('PATCH', `/api/views/${f.grid.id}`, {
      query: { sorts: [{ fieldId: f.points.id, direction: 'desc' }] },
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { detail: string }).detail).toMatch(/locked/);
    const moved = await ok<ViewMeta>(
      await asEditor('PATCH', `/api/views/${f.grid.id}`, { position: 5 })
    );
    expect(moved).toMatchObject({ position: 5, locked: true });
    // The owner changes it, and the copy an editor makes is unlocked.
    await ok(await json('PATCH', `/api/views/${f.grid.id}`, { grid: { rowHeight: 'tall' } }));
    const copy = await ok<ViewMeta>(
      await asEditor('POST', `/api/views/${f.grid.id}/duplicate`, {}),
      201
    );
    expect(copy).toMatchObject({ locked: false, config: { grid: { rowHeight: 'tall' } } });
  });

  it('saves row colours by select or conditions, checked on write and pruned on read', async () => {
    const f = await fixture();
    const bySelect = await ok<ViewMeta>(
      await json('PATCH', `/api/views/${f.grid.id}`, {
        rowColor: { mode: 'select', fieldId: f.stage.id },
      })
    );
    expect(bySelect.config.rowColor).toEqual({ mode: 'select', fieldId: f.stage.id });

    const notSelect = await json('PATCH', `/api/views/${f.grid.id}`, {
      rowColor: { mode: 'select', fieldId: f.points.id },
    });
    expect(notSelect.status).toBe(422);
    const badFilter = await json('PATCH', `/api/views/${f.grid.id}`, {
      rowColor: {
        mode: 'conditions',
        conditions: [
          {
            color: 'red',
            filter: { conditions: [{ fieldId: f.stage.id, operator: 'contains', value: 'x' }] },
          },
        ],
      },
    });
    expect(badFilter.status).toBe(422);
    const errors = ((await badFilter.json()) as { errors: { path: string }[] }).errors;
    expect(errors[0]?.path).toMatch(/^rowColor\.conditions\.0\.filter/);

    const conditions = [
      {
        color: 'red',
        filter: {
          conjunction: 'and',
          conditions: [{ fieldId: f.points.id, operator: '>', value: 5 }],
        },
      },
      {
        color: 'amber',
        filter: {
          conjunction: 'and',
          conditions: [{ fieldId: f.stage.id, operator: 'is', value: 'todo' }],
        },
      },
    ];
    const byConditions = await ok<ViewMeta>(
      await json('PATCH', `/api/views/${f.grid.id}`, {
        rowColor: { mode: 'conditions', conditions },
      })
    );
    expect(byConditions.config.rowColor).toEqual({ mode: 'conditions', conditions });

    // The records query answers the colour of the first matching condition.
    const created = await ok<{ records: { id: string }[] }>(
      await json('POST', `/api/tables/${f.table.id}/records`, {
        records: [
          { fields: { [f.points.id]: 8, [f.stage.id]: 'todo' } },
          { fields: { [f.points.id]: 1, [f.stage.id]: 'todo' } },
          { fields: { [f.points.id]: 1, [f.stage.id]: 'done' } },
        ],
      }),
      201
    );
    const [high, todo, done] = created.records.map((r) => r.id);
    const result = await ok<{ rowColors: Record<string, string> }>(
      await json('POST', `/api/tables/${f.table.id}/records/query`, {
        viewId: f.grid.id,
        rowColors: conditions,
      })
    );
    expect(result.rowColors).toEqual({ [high as string]: 'red', [todo as string]: 'amber' });
    expect(done && result.rowColors[done]).toBeUndefined();

    // Deleting the points field drops the condition that used it.
    await ok(await json('DELETE', `/api/fields/${f.points.id}`), 204);
    const pruned = await ok<ViewMeta>(await json('GET', `/api/views/${f.grid.id}`));
    expect(pruned.config.rowColor).toEqual({ mode: 'conditions', conditions: [conditions[1]] });
    // Off again.
    const off = await ok<ViewMeta>(
      await json('PATCH', `/api/views/${f.grid.id}`, { rowColor: null })
    );
    expect(off.config.rowColor).toBeNull();
  });

  it('groups views into sections; deleting a section keeps its views', async () => {
    const f = await fixture();
    const other = await ok<TableMeta>(
      await json('POST', `/api/bases/${f.base.id}/tables`, { name: 'Other' }),
      201
    );
    const section = await ok<ViewSection>(
      await asEditor('POST', `/api/tables/${f.table.id}/view-sections`, { name: 'Planning' }),
      201
    );
    const elsewhere = await ok<ViewSection>(
      await json('POST', `/api/tables/${other.id}/view-sections`, { name: 'Other' }),
      201
    );
    const moved = await ok<ViewMeta>(
      await asEditor('PATCH', `/api/views/${f.grid.id}`, { sectionId: section.id })
    );
    expect(moved.sectionId).toBe(section.id);
    expect(
      (await json('PATCH', `/api/views/${f.grid.id}`, { sectionId: elsewhere.id })).status
    ).toBe(422);
    // A section is only reachable through its own table.
    expect(
      (await json('PATCH', `/api/tables/${other.id}/view-sections/${section.id}`, { name: 'x' }))
        .status
    ).toBe(404);
    const renamed = await ok<ViewSection>(
      await json('PATCH', `/api/tables/${f.table.id}/view-sections/${section.id}`, {
        name: 'Roadmap',
        position: 0.5,
      })
    );
    expect(renamed).toMatchObject({ name: 'Roadmap', position: 0.5 });
    const list = await ok<{ views: ViewMeta[]; sections: ViewSection[] }>(
      await json('GET', `/api/tables/${f.table.id}/views`)
    );
    expect(list.sections.map((s) => s.name)).toEqual(['Roadmap']);

    await ok(await json('DELETE', `/api/tables/${f.table.id}/view-sections/${section.id}`), 204);
    const after = await ok<ViewMeta>(await json('GET', `/api/views/${f.grid.id}`));
    expect(after.sectionId).toBeNull();
  });
});
