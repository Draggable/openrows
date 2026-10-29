import type {
  Base,
  DuplicateJob,
  FieldMeta,
  LinkOptions,
  RecordData,
  TableMeta,
} from '@openrows/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import {
  attachments,
  automations,
  fields,
  jobs,
  shares,
  storageGarbage,
  tables,
  type users,
  views,
  workspaceMembers,
} from '../../src/db/index.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import {
  addMember,
  createReadyAttachment,
  createSession,
  createUser,
  createWorkspace,
} from '../helpers/factories.js';
import { MemoryObjectStore } from '../helpers/object-store.js';
import { planEdition } from '../helpers/plans.js';

type Described = Record<
  string,
  { fields: unknown[]; records: Record<string, Record<string, unknown>> }
>;

/**
 * Duplicating a base: the copy equals the original (schema, records, links, formulas,
 * lookups and rollups, files, views) under new ids, works on its own, never takes share links,
 * secrets or other people's personal views, can go to another workspace of the person's (files
 * copied to that workspace's keys), and is refused across tenants, below creator and past the
 * target's plan.
 */
describe('duplicate a base', () => {
  const t = useTestDb();
  const store = new MemoryObjectStore();
  const plans = planEdition();
  let app: ReturnType<typeof testApp>['app'];
  let runJob: ReturnType<typeof testApp>['runJob'];
  let owner: typeof users.$inferSelect;
  let workspaceId: string;
  let token: string;

  beforeAll(async () => {
    ({ app, runJob } = testApp({ db: t.appDb, objectStore: store, edition: plans.edition }));
    const ws = await createWorkspace(t.db);
    owner = ws.owner;
    workspaceId = ws.workspace.id;
    token = await createSession(t.db, owner);
  });

  const json = (method: string, path: string, body?: unknown, as = token) =>
    app.request(path, {
      method,
      headers: {
        origin: 'http://localhost:5173',
        'content-type': 'application/json',
        cookie: `${SESSION_COOKIE}=${as}`,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
    const r = await res;
    if (r.status !== status) throw new Error(`${r.status}: ${await r.text()}`);
    return (status === 204 ? null : await r.json()) as T;
  }
  const start = (baseId: string, body: Record<string, unknown> = {}, as = token) =>
    json('POST', `/api/bases/${baseId}/duplicate`, body, as);
  /** Starts a duplicate, runs it as the worker would and answers the finished job. */
  async function duplicate(baseId: string, body: Record<string, unknown> = {}, as = token) {
    const job = await ok<DuplicateJob>(start(baseId, body, as), 201);
    expect(job).toMatchObject({ status: 'running', baseId, base: null });
    await runJob(job.id);
    return ok<DuplicateJob>(
      json('GET', `/api/bases/${baseId}/duplicates/${job.id}`, undefined, as)
    );
  }
  async function copied(baseId: string, body: Record<string, unknown> = {}) {
    const done = await duplicate(baseId, body);
    if (done.status !== 'done' || !done.base) throw new Error(`duplicate: ${done.error}`);
    return { job: done, base: done.base };
  }
  const newBase = (name = 'Roadmap', ws = workspaceId) =>
    ok<Base>(json('POST', `/api/workspaces/${ws}/bases`, { name }), 201);
  const newTable = (baseId: string, name: string) =>
    ok<TableMeta>(json('POST', `/api/bases/${baseId}/tables`, { name }), 201);
  const field = (tableId: string, name: string, type: string, options?: unknown) =>
    ok<FieldMeta>(json('POST', `/api/tables/${tableId}/fields`, { name, type, options }), 201);
  const create = async (tableId: string, cells: Record<string, unknown>[]) =>
    (
      await ok<{ records: RecordData[] }>(
        json('POST', `/api/tables/${tableId}/records`, {
          records: cells.map((f) => ({ fields: f })),
        }),
        201
      )
    ).records;
  const tablesOf = async (baseId: string) =>
    (await ok<{ tables: TableMeta[] }>(json('GET', `/api/bases/${baseId}/tables`))).tables;
  const getTable = (id: string) => ok<TableMeta>(json('GET', `/api/tables/${id}`));
  const allRecords = async (tableId: string) =>
    (await ok<{ records: RecordData[] }>(json('GET', `/api/tables/${tableId}/records?limit=1000`)))
      .records;
  const primary = (m: TableMeta) => m.fields.find((f) => f.isPrimary)?.id ?? '';

  /** The base as names, ids turned into names (or 'unknown-id' for an id outside the base). */
  async function describeBase(baseId: string): Promise<Described> {
    const out: Described = {};
    const names = new Map<string, string>();
    const metas = await Promise.all((await tablesOf(baseId)).map((x) => getTable(x.id)));
    for (const m of metas) {
      names.set(m.id, `table:${m.name}`);
      for (const f of m.fields) names.set(f.id, `field:${m.name}.${f.name}`);
    }
    const recordNames = new Map<string, string>();
    const data = new Map<string, RecordData[]>();
    for (const m of metas) {
      const rows = await allRecords(m.id);
      data.set(m.id, rows);
      for (const r of rows) recordNames.set(r.id, String(r.fields[primary(m)]));
    }
    const rename = (v: unknown) =>
      JSON.parse(
        JSON.stringify(v ?? null).replace(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
          (id) => names.get(id) ?? recordNames.get(id) ?? 'unknown-id'
        )
      );
    for (const m of metas) {
      const byId = new Map(m.fields.map((f) => [f.id, f]));
      out[m.name] = {
        fields: m.fields.map((f) => ({
          name: f.name,
          type: f.type,
          isPrimary: f.isPrimary,
          options: rename(f.options),
        })),
        records: Object.fromEntries(
          (data.get(m.id) ?? []).map((r) => [
            String(r.fields[primary(m)]),
            Object.fromEntries(
              Object.entries(r.fields).map(([id, v]) => {
                const f = byId.get(id);
                if (f?.type === 'attachment') {
                  return [f.name, ((v ?? []) as { filename: string }[]).map((a) => a.filename)];
                }
                return [f?.name ?? id, rename(v)];
              })
            ),
          ])
        ),
      };
    }
    return out;
  }

  /** Projects ← Tasks: links, a self link, lookup, rollup, count, formula, a file, views. */
  async function roadmap(ws = workspaceId) {
    const base = await newBase('Roadmap', ws);
    const projects = await newTable(base.id, 'Projects');
    const tasks = await newTable(base.id, 'Tasks');
    const hours = await field(tasks.id, 'Hours', 'number', { precision: 1 });
    const files = await field(tasks.id, 'Files', 'attachment');
    const project = await field(tasks.id, 'Project', 'link', { linkedTableId: projects.id });
    await field(tasks.id, 'Parent', 'link', { linkedTableId: tasks.id });
    await field(tasks.id, 'Double', 'formula', { formula: '{Hours} * 2' });
    const inverse = (project.options as LinkOptions).inverseLinkFieldId as string;
    await field(projects.id, 'Total hours', 'rollup', {
      recordLinkFieldId: inverse,
      fieldIdInLinkedTable: hours.id,
      function: 'SUM',
    });
    await field(projects.id, 'Task count', 'count', { recordLinkFieldId: inverse });
    await field(projects.id, 'Task names', 'lookup', {
      recordLinkFieldId: inverse,
      fieldIdInLinkedTable: primary(tasks),
    });
    const [alpha, beta] = await create(projects.id, [
      { [primary(projects)]: 'Alpha' },
      { [primary(projects)]: 'Beta' },
    ]);
    const file = await createReadyAttachment(
      t.db,
      { workspaceId: ws, baseId: base.id, tableId: tasks.id, fieldId: files.id },
      { filename: 'plan.txt', type: 'text/plain', size: 4 }
    );
    const [row] = await t.db
      .select({ key: attachments.storageKey })
      .from(attachments)
      .where(eq(attachments.id, file.id));
    await store.put(row?.key ?? '', new TextEncoder().encode('plan'));
    const [design] = await create(tasks.id, [
      {
        [primary(tasks)]: 'Design',
        [hours.id]: 2.5,
        [project.id]: [alpha?.id],
        [files.id]: [{ id: file.id, filename: file.filename, size: file.size, type: file.type }],
      },
      { [primary(tasks)]: 'Build', [hours.id]: 8, [project.id]: [alpha?.id] },
      { [primary(tasks)]: 'Ship', [hours.id]: 1, [project.id]: [beta?.id] },
    ]);
    if (!design) throw new Error('roadmap: no Design task');
    // The grid's config names a field and a record (a sort, a link filter's record).
    await t.db
      .update(views)
      .set({ config: { sorts: [{ fieldId: hours.id, direction: 'desc' }], note: design.id } })
      .where(eq(views.tableId, tasks.id));
    return { base, projects, tasks, hours, files, project, file, design, storageKey: row?.key };
  }

  it('copies schema, records, links, formulas and files under new ids, independent of the source', async () => {
    const w = await roadmap();
    const before = await describeBase(w.base.id);
    expect(before['Projects']?.records['Alpha']?.['Total hours']).toBe(10.5);

    const { job, base } = await copied(w.base.id, { withRecords: true });
    expect(base).toMatchObject({ name: 'Roadmap copy', workspaceId, role: 'owner' });
    expect(job.progress).toEqual({ records: 5, totalRecords: 5 });
    expect(job.withRecords).toBe(true);
    // Every reference names the copy's own tables, fields and records: no 'unknown-id'.
    const after = await describeBase(base.id);
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain('unknown-id');

    // New ids everywhere; the copy's field options point into the copy only.
    const sourceTables = await t.db.select().from(tables).where(eq(tables.baseId, w.base.id));
    const copyTables = await t.db.select().from(tables).where(eq(tables.baseId, base.id));
    const copyFields = await t.db
      .select()
      .from(fields)
      .where(
        inArray(
          fields.tableId,
          copyTables.map((x) => x.id)
        )
      );
    const sourceIds = new Set(sourceTables.map((x) => x.id));
    const sourceFields = await t.db
      .select({ id: fields.id })
      .from(fields)
      .where(
        inArray(
          fields.tableId,
          sourceTables.map((x) => x.id)
        )
      );
    for (const f of sourceFields) sourceIds.add(f.id);
    for (const f of copyFields) {
      expect(sourceIds.has(f.id)).toBe(false);
      for (const id of JSON.stringify(f.config).match(/[0-9a-f-]{36}/g) ?? []) {
        expect(sourceIds.has(id), `${f.name} names a source id`).toBe(false);
      }
    }

    // The file: a new row on the same object (one workspace), counted again.
    const [file] = await t.db.select().from(attachments).where(eq(attachments.baseId, base.id));
    expect(file?.id).not.toBe(w.file.id);
    expect(file?.storageKey).toBe(w.storageKey);

    // The view config names the copy's field and record.
    const copyTasks = copyTables.find((x) => x.name === 'Tasks');
    const [view] = await t.db
      .select()
      .from(views)
      .where(eq(views.tableId, copyTasks?.id ?? ''));
    const config = view?.config as { sorts: { fieldId: string }[]; note: string };
    const hoursCopy = copyFields.find((f) => f.name === 'Hours' && f.tableId === copyTasks?.id);
    expect(config.sorts[0]?.fieldId).toBe(hoursCopy?.id);
    const copyRecords = await allRecords(copyTasks?.id ?? '');
    expect(copyRecords.map((r) => r.id)).toContain(config.note);

    // Edits on either side stay there: the source's rollup and formula don't move.
    const copyMeta = await getTable(copyTasks?.id ?? '');
    const copyDesign = copyRecords.find((r) => r.fields[primary(copyMeta)] === 'Design');
    await ok(
      json('PATCH', `/api/tables/${copyTasks?.id}/records/${copyDesign?.id}`, {
        fields: { [hoursCopy?.id ?? '']: 40 },
      })
    );
    expect((await describeBase(w.base.id))['Projects']?.records['Alpha']?.['Total hours']).toBe(
      10.5
    );
    expect((await describeBase(base.id))['Projects']?.records['Alpha']?.['Total hours']).toBe(48);
    await ok(json('DELETE', `/api/bases/${w.base.id}`), 204);
    expect((await describeBase(base.id))['Tasks']?.records['Design']?.['Double']).toBe(80);
  });

  it('copies only the structure without records, and leaves share links, secrets and others’ personal views behind', async () => {
    const w = await roadmap();
    const other = await addMember(t.db, workspaceId, 'creator', await createUser(t.db));
    await t.db.insert(views).values([
      {
        workspaceId,
        tableId: w.tasks.id,
        name: 'Theirs',
        personal: true,
        createdBy: other.id,
      },
      { workspaceId, tableId: w.tasks.id, name: 'Mine', personal: true, createdBy: owner.id },
    ]);
    const [grid] = await t.db.select().from(views).where(eq(views.tableId, w.tasks.id));
    await ok(json('POST', `/api/views/${grid?.id}/shares`, {}), 201);
    await t.db.insert(automations).values({
      workspaceId,
      baseId: w.base.id,
      name: 'Notify',
      enabled: true,
      trigger: { type: 'recordCreated', tableId: w.tasks.id },
      actions: [{ type: 'updateRecord', tableId: w.tasks.id, fields: { [w.hours.id]: '1' } }],
      triggerType: 'recordCreated',
      tableId: w.tasks.id,
      createdBy: other.id,
      secretsEncrypted: Buffer.from('secret'),
      hookTokenHash: `hash-${w.base.id}`,
      hookSample: { private: true },
    });

    const { job, base } = await copied(w.base.id, { name: 'Template' });
    expect(base.name).toBe('Template');
    expect(job.progress).toEqual({ records: 0, totalRecords: 0 });
    const after = await describeBase(base.id);
    const before = await describeBase(w.base.id);
    for (const name of ['Projects', 'Tasks']) {
      expect(after[name]?.fields).toEqual(before[name]?.fields);
      expect(after[name]?.records).toEqual({});
    }
    // No record files came along.
    expect(await t.db.select().from(attachments).where(eq(attachments.baseId, base.id))).toEqual(
      []
    );

    const copyTables = await t.db.select().from(tables).where(eq(tables.baseId, base.id));
    const copyTasks = copyTables.find((x) => x.name === 'Tasks');
    const copyViews = await t.db
      .select()
      .from(views)
      .where(eq(views.tableId, copyTasks?.id ?? ''));
    expect(copyViews.map((v) => v.name).sort()).toEqual(['Grid view', 'Mine']);
    expect(
      await t.db
        .select()
        .from(shares)
        .where(
          inArray(
            shares.viewId,
            copyViews.map((v) => v.id)
          )
        )
    ).toEqual([]);

    const [automation] = await t.db
      .select()
      .from(automations)
      .where(eq(automations.baseId, base.id));
    const hoursCopy = (await getTable(copyTasks?.id ?? '')).fields.find((f) => f.name === 'Hours');
    expect(automation).toMatchObject({
      name: 'Notify',
      enabled: false,
      tableId: copyTasks?.id,
      trigger: { type: 'recordCreated', tableId: copyTasks?.id },
      actions: [
        { type: 'updateRecord', tableId: copyTasks?.id, fields: { [hoursCopy?.id ?? '']: '1' } },
      ],
      createdBy: owner.id,
      secretsEncrypted: null,
      hookTokenHash: null,
      hookSample: null,
    });
  });

  it('copies into another workspace of the person, files under that workspace’s keys', async () => {
    const w = await roadmap();
    const other = await createWorkspace(t.db, { owner });
    const { job, base } = await copied(w.base.id, {
      withRecords: true,
      workspaceId: other.workspace.id,
    });
    expect(job.workspaceId).toBe(other.workspace.id);
    expect(base.workspaceId).toBe(other.workspace.id);
    expect(await describeBase(base.id)).toEqual(await describeBase(w.base.id));
    const [file] = await t.db.select().from(attachments).where(eq(attachments.baseId, base.id));
    expect(file?.workspaceId).toBe(other.workspace.id);
    expect(file?.storageKey.startsWith(`ws/${other.workspace.id}/b/${base.id}/`)).toBe(true);
    expect(new TextDecoder().decode(await store.get(file?.storageKey ?? ''))).toBe('plan');
    // The source's object is still there for the source.
    expect(await store.head(w.storageKey ?? '')).not.toBeNull();
  });

  it('refuses a workspace the person has no role in (404), below creator (403) and below creator on the source', async () => {
    const w = await roadmap();
    const stranger = await createWorkspace(t.db);
    const res = await start(w.base.id, { workspaceId: stranger.workspace.id });
    expect(res.status).toBe(404);
    const missing = await start(w.base.id, { workspaceId: '01900000-0000-7000-8000-00000000ffff' });
    expect(missing.status).toBe(404);
    // An editor of the other workspace can't add bases there.
    await addMember(t.db, stranger.workspace.id, 'editor', owner);
    expect((await start(w.base.id, { workspaceId: stranger.workspace.id })).status).toBe(403);
    // An editor of the source can't duplicate it; another tenant's base is a 404.
    const editor = await addMember(t.db, workspaceId, 'editor', await createUser(t.db));
    const editorToken = await createSession(t.db, editor);
    expect((await start(w.base.id, {}, editorToken)).status).toBe(403);
    const outsider = await createWorkspace(t.db);
    const outsiderToken = await createSession(t.db, outsider.owner);
    expect((await start(w.base.id, {}, outsiderToken)).status).toBe(404);
    // Nothing was started, and no base appeared in the stranger's workspace.
    const rows = await t.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.baseId, w.base.id), eq(jobs.kind, 'duplicate')));
    expect(rows).toEqual([]);
  });

  it('fails the job when the person lost access to the target before it ran', async () => {
    const w = await roadmap();
    const other = await createWorkspace(t.db);
    await addMember(t.db, other.workspace.id, 'creator', owner);
    const job = await ok<DuplicateJob>(
      start(w.base.id, { workspaceId: other.workspace.id, withRecords: true }),
      201
    );
    await t.db
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, other.workspace.id),
          eq(workspaceMembers.userId, owner.id)
        )
      );
    await runJob(job.id);
    const done = await ok<DuplicateJob>(
      json('GET', `/api/bases/${w.base.id}/duplicates/${job.id}`)
    );
    expect(done).toMatchObject({ status: 'failed', base: null });
    expect(done.error).toMatch(/lost access/);
  });

  it('checks the target plan up front and when it runs (#129)', async () => {
    const w = await roadmap();
    const small = await createWorkspace(t.db, { owner });
    plans.set(small.workspace.id, { limits: { recordsPerBase: 2 } });
    const res = await start(w.base.id, { workspaceId: small.workspace.id, withRecords: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      limit: 'recordsPerBase',
      used: 5,
      max: 2,
    });
    // Without records it fits.
    await copied(w.base.id, { workspaceId: small.workspace.id });

    const files = await createWorkspace(t.db, { owner });
    plans.set(files.workspace.id, { limits: { attachmentBytesPerWorkspace: 2 } });
    expect(
      (await start(w.base.id, { workspaceId: files.workspace.id, withRecords: true })).status
    ).toBe(403);

    // A plan that shrank after the start: the job fails, and its copied files become garbage.
    const later = await createWorkspace(t.db, { owner });
    const job = await ok<DuplicateJob>(
      start(w.base.id, { workspaceId: later.workspace.id, withRecords: true }),
      201
    );
    plans.set(later.workspace.id, { limits: { recordsPerBase: 1 } });
    await runJob(job.id);
    const done = await ok<DuplicateJob>(
      json('GET', `/api/bases/${w.base.id}/duplicates/${job.id}`)
    );
    expect(done.status).toBe('failed');
    const garbage = await t.db
      .select()
      .from(storageGarbage)
      .where(eq(storageGarbage.workspaceId, later.workspace.id));
    expect(garbage.map((g) => g.storageKey)).toHaveLength(1);
    expect(
      await t.db.select().from(tables).where(eq(tables.workspaceId, later.workspace.id))
    ).toEqual([]);
  });

  it('shows a duplicate only to who started it, and caps the running ones', async () => {
    const w = await roadmap();
    const job = await ok<DuplicateJob>(start(w.base.id), 201);
    const creator = await addMember(t.db, workspaceId, 'creator', await createUser(t.db));
    const creatorToken = await createSession(t.db, creator);
    expect(
      (await json('GET', `/api/bases/${w.base.id}/duplicates/${job.id}`, undefined, creatorToken))
        .status
    ).toBe(404);
    // Through another base: 404 too.
    const sibling = await newBase('Sibling');
    expect((await json('GET', `/api/bases/${sibling.id}/duplicates/${job.id}`)).status).toBe(404);
    await ok(start(w.base.id), 201);
    await ok(start(w.base.id), 201);
    const fourth = await start(w.base.id);
    expect(fourth.status).toBe(409);
    // A second run of a finished job changes nothing.
    await runJob(job.id);
    await runJob(job.id);
    const copies = await t.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, job.id), eq(jobs.status, 'done')));
    expect(copies).toHaveLength(1);
  });
});
