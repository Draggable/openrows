import {
  type FieldMeta,
  type LinkOptions,
  type RecordData,
  type Revision,
  RevisionListSchema,
  type TableMeta,
} from '@openrows/shared';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { recordRevisions } from '../../src/db/index.js';
import type { FieldVisibility } from '../../src/realtime/projection.js';
import { pruneRevisions } from '../../src/revisions/repo.js';
import { useTestDb } from '../helpers/db.js';
import {
  addMember,
  authedClient,
  createBase,
  createReadyAttachment,
  createWorkspace,
} from '../helpers/factories.js';

const ORIGIN = 'http://localhost:5173';
const send = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { origin: ORIGIN, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const body = r.status === 204 ? null : await r.json();
  expect(r.status, JSON.stringify(body)).toBe(status);
  return body as T;
}

type Client = Awaited<ReturnType<typeof authedClient>>;

describe('record revisions (#94)', () => {
  const t = useTestDb();

  async function world(opts: { visibility?: FieldVisibility } = {}) {
    const { workspace, owner } = await createWorkspace(t.db, { name: 'Acme' });
    const editor = await addMember(t.db, workspace.id, 'editor');
    const reader = await addMember(t.db, workspace.id, 'read_only');
    const base = await createBase(t.db, workspace.id);
    const other = await createWorkspace(t.db);
    const c = {
      owner: await authedClient(t, owner, opts),
      editor: await authedClient(t, editor, opts),
      reader: await authedClient(t, reader, opts),
      stranger: await authedClient(t, other.owner, opts),
    };
    const newTable = async (name: string) =>
      json<TableMeta>(c.owner.request(`/api/bases/${base.id}/tables`, send({ name })), 201);
    const addField = (tableId: string, name: string, type: string, options?: unknown) =>
      json<FieldMeta>(
        c.owner.request(`/api/tables/${tableId}/fields`, send({ name, type, options })),
        201
      );
    const tasks = await newTable('Tasks');
    const projects = await newTable('Projects');
    const name = tasks.fields.find((f) => f.isPrimary) as FieldMeta;
    const projectName = projects.fields.find((f) => f.isPrimary) as FieldMeta;
    const status = await addField(tasks.id, 'Stage', 'singleLineText');
    const hours = await addField(tasks.id, 'Hours', 'number');
    const double = await addField(tasks.id, 'Double', 'formula', { formula: '{Hours} * 2' });
    const files = await addField(tasks.id, 'Files', 'attachment');
    const link = await addField(tasks.id, 'Project', 'link', { linkedTableId: projects.id });
    const inverseId = (link.options as LinkOptions).inverseLinkFieldId as string;
    const recordsUrl = (tableId: string) => `/api/tables/${tableId}/records`;
    const create = (as: Client, tableId: string, fields: Record<string, unknown>) =>
      json<RecordData>(as.request(recordsUrl(tableId), send({ fields })), 201);
    const alpha = await create(c.owner, projects.id, { [projectName.id]: 'Alpha' });
    const beta = await create(c.owner, projects.id, { [projectName.id]: 'Beta' });
    const record = await create(c.owner, tasks.id, { [name.id]: 'Write docs' });
    const file = (filename: string) =>
      createReadyAttachment(
        t.db,
        { workspaceId: workspace.id, baseId: base.id, tableId: tasks.id, fieldId: files.id },
        { filename, type: 'text/plain', size: 3 }
      );
    return {
      workspace,
      owner,
      editor,
      base,
      c,
      tasks,
      projects,
      fields: {
        name: name.id,
        status: status.id,
        hours: hours.id,
        double: double.id,
        files: files.id,
        link: link.id,
        inverseId,
      },
      alpha,
      beta,
      record,
      file,
      create,
      patch: (as: Client, id: string, fields: Record<string, unknown>, status = 200) =>
        json<RecordData>(
          as.request(`${recordsUrl(tasks.id)}/${id}`, send({ fields }, 'PATCH')),
          status
        ),
      get: (id: string) => json<RecordData>(c.owner.request(`${recordsUrl(tasks.id)}/${id}`)),
      revisions: async (as: Client = c.owner, id = record.id, query = '') =>
        RevisionListSchema.parse(
          await json(as.request(`${recordsUrl(tasks.id)}/${id}/revisions${query}`))
        ),
      restore: (
        as: Client,
        revisionId: string,
        body: Record<string, unknown> = {},
        status = 200,
        id = record.id
      ) =>
        json<RecordData>(
          as.request(`${recordsUrl(tasks.id)}/${id}/revisions/${revisionId}/restore`, send(body)),
          status
        ),
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  /** Moves every revision of the world's record a few minutes back, past coalescing. */
  const age = (w: World) =>
    t.db.execute(sql`UPDATE record_revisions
      SET created_at = created_at - interval '5 minutes', updated_at = updated_at - interval '5 minutes'
      WHERE record_id = ${w.record.id}`);

  const updates = (list: { revisions: Revision[] }) =>
    list.revisions.filter((r) => r.kind === 'updated');

  it('records who changed which cells, before and after, never computed fields', async () => {
    const w = await world();
    await w.patch(w.c.editor, w.record.id, {
      [w.fields.status]: 'Open',
      [w.fields.hours]: 3,
    });
    const list = await w.revisions();
    expect(list.revisions.map((r) => r.kind)).toEqual(['updated', 'created']);
    const [update] = list.revisions;
    expect(update).toMatchObject({
      actorId: w.editor.id,
      recordId: w.record.id,
      restoredFrom: null,
    });
    expect(update?.changes).toEqual([
      { fieldId: w.fields.status, type: 'singleLineText', before: null, after: 'Open' },
      { fieldId: w.fields.hours, type: 'number', before: null, after: 3 },
    ]);
    // The formula recomputed (Double = 6) but isn't part of anyone's change.
    expect((await w.get(w.record.id)).fields[w.fields.double]).toBe(6);
    expect(JSON.stringify(list)).not.toContain(w.fields.double);
    // Writing the same value again is no change.
    await w.patch(w.c.owner, w.record.id, { [w.fields.status]: 'Open' });
    expect(updates(await w.revisions())).toHaveLength(1);
  });

  it('coalesces rapid edits of the same cell by the same person within 60 s', async () => {
    const w = await world();
    const status = w.fields.status;
    await w.patch(w.c.owner, w.record.id, { [status]: 'A' });
    await w.patch(w.c.owner, w.record.id, { [status]: 'AB' });
    await w.patch(w.c.owner, w.record.id, { [status]: 'ABC' });
    let list = updates(await w.revisions());
    expect(list).toHaveLength(1);
    expect(list[0]?.changes).toEqual([
      { fieldId: status, type: 'singleLineText', before: null, after: 'ABC' },
    ]);
    // Another cell, another person, or later than 60 s: a new revision.
    await w.patch(w.c.owner, w.record.id, { [w.fields.hours]: 1 });
    await w.patch(w.c.editor, w.record.id, { [w.fields.hours]: 2 });
    expect(updates(await w.revisions())).toHaveLength(3);
    await age(w);
    await w.patch(w.c.editor, w.record.id, { [w.fields.hours]: 4 });
    list = updates(await w.revisions());
    expect(list).toHaveLength(4);
    expect(list[0]?.changes[0]).toMatchObject({ before: 2, after: 4 });
    // Typing back to where the coalesced edit started removes it.
    await w.patch(w.c.editor, w.record.id, { [w.fields.hours]: 2 });
    expect(updates(await w.revisions())).toHaveLength(3);
  });

  it('records deletes and restores, and reads only live records', async () => {
    const w = await world();
    const url = `/api/tables/${w.tasks.id}/records`;
    await json(w.c.owner.request(`${url}/delete`, send({ recordIds: [w.record.id] })));
    await json(w.c.owner.request(`${url}/${w.record.id}/revisions`), 404);
    await json(w.c.owner.request(`${url}/restore`, send({ recordIds: [w.record.id] })));
    expect((await w.revisions()).revisions.map((r) => r.kind)).toEqual([
      'restored',
      'deleted',
      'created',
    ]);
    // Another table's record id, a made-up one, and another tenant: 404.
    await json(
      w.c.owner.request(`/api/tables/${w.projects.id}/records/${w.record.id}/revisions`),
      404
    );
    await json(w.c.stranger.request(`${url}/${w.record.id}/revisions`), 404);
  });

  it('pages newest first with an opaque cursor', async () => {
    const w = await world();
    for (const n of [1, 2, 3, 4]) {
      await w.patch(n % 2 ? w.c.owner : w.c.editor, w.record.id, { [w.fields.hours]: n });
    }
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const query: string = `?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const page = await w.revisions(w.c.reader, w.record.id, query);
      expect(page.revisions.length).toBeLessThanOrEqual(2);
      for (const r of page.revisions)
        if (r.kind === 'updated') seen.push(r.changes[0]?.after as number);
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([4, 3, 2, 1]);
    const bad = await w.c.owner.request(
      `/api/tables/${w.tasks.id}/records/${w.record.id}/revisions?cursor=nope`
    );
    expect(bad.status).toBe(422);
    const tooMany = await w.c.owner.request(
      `/api/tables/${w.tasks.id}/records/${w.record.id}/revisions?limit=1000`
    );
    expect(tooMany.status).toBe(422);
  });

  it('restores one cell, including links and attachments, as a new revision', async () => {
    const w = await world();
    const { status, link, files } = w.fields;
    const one = await w.file('one.txt');
    const two = await w.file('two.txt');
    await w.patch(w.c.owner, w.record.id, {
      [status]: 'Open',
      [link]: [w.alpha.id],
      [files]: [one],
    });
    await age(w);
    const point = updates(await w.revisions())[0] as Revision;
    await w.patch(w.c.editor, w.record.id, {
      [status]: 'Done',
      [link]: [w.beta.id],
      [files]: [one, two],
    });
    await age(w);

    // One cell back: only it changes.
    let record = await w.restore(w.c.editor, point.id, { fieldId: link });
    expect(record.fields[link]).toEqual([{ id: w.alpha.id, name: 'Alpha' }]);
    expect(record.fields[status]).toBe('Done');
    // The other side of the link follows (the junction was written).
    const alpha = await json<RecordData>(
      w.c.owner.request(`/api/tables/${w.projects.id}/records/${w.alpha.id}`)
    );
    expect(alpha.fields[w.fields.inverseId]).toEqual([{ id: w.record.id, name: 'Write docs' }]);

    record = await w.restore(w.c.editor, point.id, { fieldId: files });
    expect((record.fields[files] as { id: string }[]).map((f) => f.id)).toEqual([one.id]);

    const list = updates(await w.revisions());
    expect(list[0]).toMatchObject({ actorId: w.editor.id, restoredFrom: point.id });
    expect(list[0]?.changes.map((c) => c.fieldId)).toEqual([files]);
    expect(list[1]).toMatchObject({ restoredFrom: point.id });
    expect(list[1]?.changes.map((c) => c.fieldId)).toEqual([link]);
  });

  it('restores the whole record to a point, and back again', async () => {
    const w = await world();
    const { status, hours, link, files } = w.fields;
    const one = await w.file('one.txt');
    await w.patch(w.c.owner, w.record.id, { [status]: 'Open', [link]: [w.alpha.id] });
    await age(w);
    const point = updates(await w.revisions())[0] as Revision;
    const at = await w.get(w.record.id);
    // Later changes: the same cells, and cells the point never touched.
    await w.patch(w.c.owner, w.record.id, { [status]: 'Done', [link]: [w.beta.id] });
    await age(w);
    await w.patch(w.c.editor, w.record.id, { [hours]: 8, [files]: [one] });
    await age(w);
    const before = await w.get(w.record.id);

    const restored = await w.restore(w.c.editor, point.id);
    for (const f of [status, hours, link, files, w.fields.double]) {
      expect(restored.fields[f], f).toEqual(at.fields[f]);
    }
    const [undo] = updates(await w.revisions());
    expect(undo?.restoredFrom).toBe(point.id);
    // Restoring to just before the restore brings the later state back.
    const later = updates(await w.revisions())[1] as Revision;
    const again = await w.restore(w.c.owner, later.id);
    for (const f of [status, hours, link, files]) {
      expect(again.fields[f], f).toEqual(before.fields[f]);
    }
    // A point the record already matches changes nothing.
    const count = (await w.revisions()).revisions.length;
    await w.restore(w.c.owner, later.id);
    expect((await w.revisions()).revisions.length).toBe(count);
  });

  it('skips what it can no longer restore: deleted linked records and fields', async () => {
    const w = await world();
    const { status, hours, link } = w.fields;
    await w.patch(w.c.owner, w.record.id, {
      [status]: 'Open',
      [hours]: 2,
      [link]: [w.alpha.id, w.beta.id],
    });
    await age(w);
    const point = updates(await w.revisions())[0] as Revision;
    await w.patch(w.c.owner, w.record.id, { [status]: 'Done', [hours]: 5, [link]: [] });
    await json(
      w.c.owner.request(
        `/api/tables/${w.projects.id}/records/delete`,
        send({ recordIds: [w.beta.id] })
      )
    );
    // Double reads Hours: it goes first.
    await json(w.c.owner.request(`/api/fields/${w.fields.double}`, send(undefined, 'DELETE')), 204);
    await json(w.c.owner.request(`/api/fields/${hours}`, send(undefined, 'DELETE')), 204);
    const record = await w.restore(w.c.owner, point.id);
    expect(record.fields[status]).toBe('Open');
    expect(record.fields[link]).toEqual([{ id: w.alpha.id, name: 'Alpha' }]);
    // The deleted field's history is gone from the list, and a one-cell restore refuses it.
    const list = await w.revisions();
    expect(JSON.stringify(list)).not.toContain(hours);
    await w.restore(w.c.owner, point.id, { fieldId: hours }, 422);
  });

  it('is an authorized write: roles and edit permissions apply', async () => {
    const w = await world();
    const { status } = w.fields;
    await w.patch(w.c.owner, w.record.id, { [status]: 'Open' });
    await age(w);
    const point = updates(await w.revisions())[0] as Revision;
    await w.patch(w.c.owner, w.record.id, { [status]: 'Done' });
    // Read-only members read the history but can't restore.
    expect(updates(await w.revisions(w.c.reader))).toHaveLength(2);
    await w.restore(w.c.reader, point.id, {}, 403);
    // A field only creators may edit: the editor's restore is refused, nothing changes.
    await json(
      w.c.owner.request(
        `/api/fields/${status}`,
        send({ permissions: { edit: { level: 'creators' } } }, 'PATCH')
      )
    );
    const refused = await w.c.editor.request(
      `/api/tables/${w.tasks.id}/records/${w.record.id}/revisions/${point.id}/restore`,
      send({ fieldId: status })
    );
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code?: string }).code).toBe('EDIT_RESTRICTED');
    await w.restore(w.c.editor, point.id, {}, 403);
    expect((await w.get(w.record.id)).fields[status]).toBe('Done');
    // A revision id of another record is a 404.
    const other = await w.create(w.c.owner, w.tasks.id, { [w.fields.name]: 'Other' });
    await w.restore(w.c.owner, point.id, {}, 404, other.id);
  });

  it('leaves out fields hidden from the reader, in the list and in restores', async () => {
    let hiddenId = '';
    let hiddenFor = '';
    const visibility: FieldVisibility = {
      hiddenFields: (viewer) => new Set(viewer.userId === hiddenFor ? [hiddenId] : []),
    };
    const w = await world({ visibility });
    hiddenId = w.fields.hours;
    hiddenFor = w.editor.id;
    const { status, hours } = w.fields;
    await w.patch(w.c.owner, w.record.id, { [status]: 'Open', [hours]: 1 });
    await age(w);
    const point = updates(await w.revisions())[0] as Revision;
    await w.patch(w.c.owner, w.record.id, { [hours]: 7 });
    await age(w);
    await w.patch(w.c.owner, w.record.id, { [status]: 'Done' });

    // The owner sees all three updates; the editor never sees Hours, and the Hours-only one
    // isn't listed at all.
    expect(updates(await w.revisions())).toHaveLength(3);
    const seen = updates(await w.revisions(w.c.editor));
    expect(seen).toHaveLength(2);
    expect(JSON.stringify(seen)).not.toContain(hours);
    expect(seen.flatMap((r) => r.changes.map((c) => c.fieldId))).toEqual([status, status]);
    // The editor's restore brings back what they can see only; the hidden cell is refused alone.
    const record = await w.restore(w.c.editor, point.id);
    expect(record.fields[status]).toBe('Open');
    expect((await w.get(w.record.id)).fields[hours]).toBe(7);
    await w.restore(w.c.editor, point.id, { fieldId: hours }, 422);
  });

  it('prunes revisions past the retention, per workspace', async () => {
    const w = await world();
    const other = await world();
    await t.db.execute(sql`UPDATE record_revisions
      SET created_at = now() - interval '40 days', updated_at = now() - interval '40 days'`);
    const count = async (workspaceId: string) =>
      (
        await t.db
          .select({ id: recordRevisions.id })
          .from(recordRevisions)
          .where(eq(recordRevisions.workspaceId, workspaceId))
      ).length;
    const kept = await count(other.workspace.id);
    expect(kept).toBeGreaterThan(0);
    // The app role runs the prune (SECURITY DEFINER), across workspaces.
    const pruned = await pruneRevisions(t.appDb, 30, { [other.workspace.id]: 60 });
    expect(pruned).toBeGreaterThan(0);
    expect(await count(w.workspace.id)).toBe(0);
    expect(await count(other.workspace.id)).toBe(kept);
    await expect(pruneRevisions(t.appDb, 0)).rejects.toThrow();
  });
});
