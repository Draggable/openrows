import type { FieldMeta, TableMeta, ViewMeta } from '@openrows/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { users } from '../../src/db/index.js';
import { useTestDb } from '../helpers/db.js';
import { authedClient, createWorkspace } from '../helpers/factories.js';

/**
 * Gallery, timeline (Gantt) and list views: each layout checked on write against the
 * table's fields (422 with paths), merged into the saved config and pruned on read when a field
 * goes away or no longer fits.
 */
describe('gallery, timeline and list views', () => {
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

  type Fixture = {
    table: TableMeta;
    start: FieldMeta;
    end: FieldMeta;
    stage: FieldMeta;
    photos: FieldMeta;
    notes: FieldMeta;
    dependsOn: FieldMeta;
    other: FieldMeta;
  };

  async function fixture(): Promise<Fixture> {
    const base = await ok<{ id: string }>(
      await json('POST', `/api/workspaces/${workspaceId}/bases`, { name: 'Base' }),
      201
    );
    const table = await ok<TableMeta>(
      await json('POST', `/api/bases/${base.id}/tables`, { name: 'Tasks' }),
      201
    );
    const elsewhere = await ok<TableMeta>(
      await json('POST', `/api/bases/${base.id}/tables`, { name: 'People' }),
      201
    );
    const field = async (body: unknown) =>
      ok<FieldMeta>(await json('POST', `/api/tables/${table.id}/fields`, body), 201);
    return {
      table,
      start: await field({ name: 'Start', type: 'date' }),
      end: await field({ name: 'End', type: 'dateTime', options: { timeZone: 'Europe/Paris' } }),
      stage: await field({
        name: 'Stage',
        type: 'singleSelect',
        options: { choices: [{ id: 'a', name: 'A', color: 'blue' }] },
      }),
      photos: await field({ name: 'Photos', type: 'attachment' }),
      notes: await field({ name: 'Details', type: 'longText' }),
      dependsOn: await field({
        name: 'Depends on',
        type: 'link',
        options: { linkedTableId: table.id },
      }),
      other: await field({ name: 'Owner', type: 'link', options: { linkedTableId: elsewhere.id } }),
    };
  }

  const newView = async (tableId: string, type: string) =>
    ok<ViewMeta>(await json('POST', `/api/tables/${tableId}/views`, { name: type, type }), 201);

  const paths = async (res: Response) => {
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors?: { path: string }[] };
    return (body.errors ?? []).map((e) => e.path).sort();
  };

  beforeAll(async () => {
    const tenant = await createWorkspace(t.db);
    owner = tenant.owner;
    workspaceId = tenant.workspace.id;
    api = await authedClient(t, owner);
  });

  it('saves a gallery layout, refuses a cover that is not an attachment, prunes on read', async () => {
    const f = await fixture();
    const view = await newView(f.table.id, 'gallery');
    expect(view.type).toBe('gallery');
    const saved = await ok<ViewMeta>(
      await json('PATCH', `/api/views/${view.id}`, {
        gallery: {
          coverFieldId: f.photos.id,
          cardFields: [f.notes.id, f.stage.id],
          cardSize: 'large',
          coverFit: 'fit',
        },
      })
    );
    expect(saved.config.gallery).toEqual({
      coverFieldId: f.photos.id,
      cardFields: [f.notes.id, f.stage.id],
      cardSize: 'large',
      coverFit: 'fit',
    });
    // Keys left out stay.
    const resized = await ok<ViewMeta>(
      await json('PATCH', `/api/views/${view.id}`, { gallery: { cardSize: 'small' } })
    );
    expect(resized.config.gallery?.coverFieldId).toBe(f.photos.id);
    expect(resized.config.gallery?.cardSize).toBe('small');

    expect(
      await paths(
        await json('PATCH', `/api/views/${view.id}`, {
          gallery: { coverFieldId: f.notes.id, cardFields: [crypto.randomUUID()] },
        })
      )
    ).toEqual(['gallery.cardFields.0', 'gallery.coverFieldId']);
    expect(
      (await json('PATCH', `/api/views/${view.id}`, { gallery: { cardSize: 'huge' } })).status
    ).toBe(422);

    await ok(await json('DELETE', `/api/fields/${f.notes.id}`), 204);
    const [read] = (
      await ok<{ views: ViewMeta[] }>(await json('GET', `/api/tables/${f.table.id}/views`))
    ).views.filter((v) => v.id === view.id);
    expect(read?.config.gallery?.cardFields).toEqual([f.stage.id]);
  });

  it('saves a timeline with dependencies, refuses fields that do not fit, prunes on read', async () => {
    const f = await fixture();
    const view = await newView(f.table.id, 'timeline');
    const layout = {
      startFieldId: f.start.id,
      endFieldId: f.end.id,
      scale: 'month',
      groupFieldId: f.stage.id,
      colorFieldId: f.stage.id,
      dependencyFieldId: f.dependsOn.id,
    };
    const saved = await ok<ViewMeta>(
      await json('PATCH', `/api/views/${view.id}`, { timeline: layout })
    );
    expect(saved.config.timeline).toEqual(layout);

    expect(
      await paths(
        await json('PATCH', `/api/views/${view.id}`, {
          timeline: {
            startFieldId: f.notes.id,
            endFieldId: crypto.randomUUID(),
            groupFieldId: f.start.id,
            colorFieldId: f.photos.id,
            // A link to another table can't be a dependency.
            dependencyFieldId: f.other.id,
          },
        })
      )
    ).toEqual([
      'timeline.colorFieldId',
      'timeline.dependencyFieldId',
      'timeline.endFieldId',
      'timeline.groupFieldId',
      'timeline.startFieldId',
    ]);
    expect(
      (await json('PATCH', `/api/views/${view.id}`, { timeline: { scale: 'year' } })).status
    ).toBe(422);

    // The start field converted to text: the timeline no longer has a start.
    await ok(
      await json('PATCH', `/api/fields/${f.start.id}`, { type: 'singleLineText', options: {} })
    );
    await ok(await json('DELETE', `/api/fields/${f.dependsOn.id}`), 204);
    const read = (
      await ok<{ views: ViewMeta[] }>(await json('GET', `/api/tables/${f.table.id}/views`))
    ).views.find((v) => v.id === view.id);
    expect(read?.config.timeline).toEqual({
      ...layout,
      startFieldId: null,
      dependencyFieldId: null,
    });
  });

  it('saves a list nested by a self link and refuses a link to another table', async () => {
    const f = await fixture();
    const view = await newView(f.table.id, 'list');
    expect(view.type).toBe('list');
    const saved = await ok<ViewMeta>(
      await json('PATCH', `/api/views/${view.id}`, {
        list: { parentFieldId: f.dependsOn.id, rowFields: [f.stage.id, f.start.id] },
      })
    );
    expect(saved.config.list).toEqual({
      parentFieldId: f.dependsOn.id,
      rowFields: [f.stage.id, f.start.id],
    });
    expect(
      await paths(
        await json('PATCH', `/api/views/${view.id}`, { list: { parentFieldId: f.other.id } })
      )
    ).toEqual(['list.parentFieldId']);
    expect(
      await paths(
        await json('PATCH', `/api/views/${view.id}`, { list: { parentFieldId: f.notes.id } })
      )
    ).toEqual(['list.parentFieldId']);
    expect((await json('PATCH', `/api/views/${view.id}`, { list: { depth: 3 } })).status).toBe(422);

    // The copy keeps the layout.
    const copy = await ok<ViewMeta>(await json('POST', `/api/views/${view.id}/duplicate`, {}), 201);
    expect(copy.type).toBe('list');
    expect(copy.config.list?.parentFieldId).toBe(f.dependsOn.id);
  });
});
