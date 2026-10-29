import { randomBytes } from 'node:crypto';
import type {
  Base,
  FieldMeta,
  LinkOptions,
  RecordData,
  RestoreJob,
  SnapshotList,
  TableMeta,
} from '@openrows/shared';
import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { S3ObjectStore } from '../../src/attachments/storage.js';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { qualified } from '../../src/data/columns.js';
import {
  attachments,
  baseMembers,
  baseSnapshots,
  fields,
  tables,
  type users,
  views,
  workspaces,
} from '../../src/db/index.js';
import { createLogger } from '../../src/lib/logger.js';
import { pruneSnapshots, runAutoSnapshots } from '../../src/snapshots/jobs.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import {
  createReadyAttachment,
  createSession,
  createUser,
  createWorkspace,
} from '../helpers/factories.js';
import { useTestS3 } from '../helpers/s3.js';

/**
 * Base snapshots: snapshot → restore to a new base round-trips the schema, records, links,
 * attachments (shared object keys) and views, with formulas, lookups and rollups recomputed;
 * snapshots of another base or tenant are 404; the worker's automatic snapshots and retention
 * prune; a 100k-row base in bounded memory; streamed multipart uploads on a real S3 server.
 */
describe('base snapshots', () => {
  const t = useTestDb();
  const s3 = useTestS3({ metadata: true });
  let store: S3ObjectStore;
  let app: ReturnType<typeof testApp>['app'];
  let runJob: ReturnType<typeof testApp>['runJob'];
  let owner: typeof users.$inferSelect;
  let workspaceId: string;
  let token: string;
  const logger = createLogger({ level: 'silent' });

  beforeAll(async () => {
    store = new S3ObjectStore(s3());
    ({ app, runJob } = testApp({ db: t.appDb, objectStore: store }));
    const ws = await createWorkspace(t.db);
    owner = ws.owner;
    workspaceId = ws.workspace.id;
    token = await createSession(t.db, owner);
  });

  const json = async (method: string, path: string, body?: unknown, as = token) =>
    app.request(path, {
      method,
      headers: {
        origin: 'http://localhost:5173',
        'content-type': 'application/json',
        cookie: `${SESSION_COOKIE}=${as}`,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  /** Starts a restore, runs it as the worker would and answers the new base. */
  async function restore(baseId: string, snapshotId: string, body: Record<string, unknown> = {}) {
    const job = await ok<RestoreJob>(
      json('POST', `/api/bases/${baseId}/snapshots/${snapshotId}/restore`, body),
      201
    );
    expect(job).toMatchObject({ status: 'running', snapshotId, base: null });
    await runJob(job.id);
    const done = await ok<RestoreJob>(
      json('GET', `/api/bases/${baseId}/snapshot-restores/${job.id}`)
    );
    expect(done.status).toBe('done');
    if (!done.base) throw new Error('restore: no base');
    return done.base;
  }
  async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
    const r = await res;
    if (r.status !== status) throw new Error(`${r.status}: ${await r.text()}`);
    return (status === 204 ? null : await r.json()) as T;
  }
  const newBase = (name = 'Roadmap') =>
    ok<Base>(json('POST', `/api/workspaces/${workspaceId}/bases`, { name }), 201);
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
  const snapshot = (baseId: string) =>
    ok<{ id: string; records: number; tables: number; kind: string }>(
      json('POST', `/api/bases/${baseId}/snapshots`),
      201
    );

  /**
   * The base as names: per table its fields (type, options with ids turned into names) and its
   * records keyed by primary value, each cell with links as names and files as filenames.
   */
  async function describeBase(baseId: string) {
    const out: Record<string, unknown> = {};
    const names = new Map<string, string>();
    const metas = await Promise.all((await tablesOf(baseId)).map((x) => getTable(x.id)));
    for (const m of metas) {
      names.set(m.id, `table:${m.name}`);
      for (const f of m.fields) names.set(f.id, `field:${m.name}.${f.name}`);
    }
    const recordNames = new Map<string, string>();
    const data = new Map<string, RecordData[]>();
    for (const m of metas) {
      const primary = m.fields.find((f) => f.isPrimary)?.id ?? '';
      const rows = await allRecords(m.id);
      data.set(m.id, rows);
      for (const r of rows) recordNames.set(r.id, String(r.fields[primary]));
    }
    const rename = (v: unknown) =>
      JSON.parse(
        JSON.stringify(v ?? null).replace(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
          (id) => names.get(id) ?? recordNames.get(id) ?? 'unknown-id'
        )
      );
    for (const m of metas) {
      const byName = new Map(m.fields.map((f) => [f.id, f]));
      const primary = m.fields.find((f) => f.isPrimary)?.id ?? '';
      out[m.name] = {
        fields: m.fields.map((f) => ({
          name: f.name,
          type: f.type,
          isPrimary: f.isPrimary,
          options: rename(f.options),
        })),
        records: Object.fromEntries(
          (data.get(m.id) ?? []).map((r) => [
            String(r.fields[primary]),
            Object.fromEntries(
              Object.entries(r.fields).map(([id, v]) => {
                const f = byName.get(id);
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

  /** Projects ← Tasks (link, self link, lookup, rollup, count, formula, files, a view). */
  async function roadmap() {
    const base = await newBase();
    const projects = await newTable(base.id, 'Projects');
    const tasks = await newTable(base.id, 'Tasks');
    const primary = (m: TableMeta) => m.fields.find((f) => f.isPrimary)?.id ?? '';
    const hours = await field(tasks.id, 'Hours', 'number', { precision: 1 });
    const due = await field(tasks.id, 'Due', 'date');
    const files = await field(tasks.id, 'Files', 'attachment');
    const project = await field(tasks.id, 'Project', 'link', { linkedTableId: projects.id });
    const parent = await field(tasks.id, 'Parent', 'link', { linkedTableId: tasks.id });
    const double = await field(tasks.id, 'Double', 'formula', { formula: '{Hours} * 2' });
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
      { workspaceId, baseId: base.id, tableId: tasks.id, fieldId: files.id },
      { filename: 'plan.txt', type: 'text/plain', size: 4 }
    );
    const [key] = await t.db
      .select({ key: attachments.storageKey })
      .from(attachments)
      .where(eq(attachments.id, file.id));
    await store.put(key?.key ?? '', new TextEncoder().encode('plan'), 'text/plain');
    const [design, build] = await create(tasks.id, [
      {
        [primary(tasks)]: 'Design',
        [hours.id]: 2.5,
        [due.id]: '2026-11-02',
        [project.id]: [alpha?.id],
        [files.id]: [{ id: file.id, filename: file.filename, size: file.size, type: file.type }],
      },
      { [primary(tasks)]: 'Build', [hours.id]: 8, [project.id]: [alpha?.id] },
    ]);
    const [, gone] = await create(tasks.id, [
      {
        [primary(tasks)]: 'Ship',
        [hours.id]: 1,
        [project.id]: [beta?.id],
        [parent.id]: [build?.id],
      },
      { [primary(tasks)]: 'Gone', [hours.id]: 100, [project.id]: [beta?.id] },
    ]);
    // A task in the trash isn't in the snapshot (nor in Beta's rollup).
    await ok(json('DELETE', `/api/tables/${tasks.id}/records/${gone?.id}`), 204);
    // A view whose config names a field and a record.
    await t.db
      .update(views)
      .set({ config: { sorts: [{ fieldId: hours.id, direction: 'desc' }], note: design?.id } })
      .where(eq(views.tableId, tasks.id));
    if (!design) throw new Error('roadmap: no Design task');
    return { base, projects, tasks, hours, double, files, file, design };
  }

  it('restores a snapshot to a new base equal to the original (schema, records, links, formulas)', async () => {
    const w = await roadmap();
    const before = await describeBase(w.base.id);
    const snap = await snapshot(w.base.id);
    expect(snap).toMatchObject({ kind: 'manual', tables: 2, records: 5 });

    // Changes after the snapshot aren't in it.
    await ok(
      json('PATCH', `/api/tables/${w.tasks.id}/records/${w.design.id}`, {
        fields: { [w.hours.id]: 40 },
      })
    );

    const list = await ok<SnapshotList>(json('GET', `/api/bases/${w.base.id}/snapshots`));
    expect(list.retentionDays).toBe(30);
    expect(list.snapshots.map((s) => s.id)).toEqual([snap.id]);

    const restored = await restore(w.base.id, snap.id, {});
    expect(restored.name).toBe('Roadmap (restored)');
    expect(restored.id).not.toBe(w.base.id);
    expect(await describeBase(restored.id)).toEqual(before);
    // The rollup and formula were recomputed from the restored values.
    const after = await describeBase(restored.id);
    expect(
      (after['Projects'] as { records: Record<string, Record<string, unknown>> }).records[
        'Alpha'
      ]?.['Total hours']
    ).toBe(10.5);
    expect(
      (after['Tasks'] as { records: Record<string, Record<string, unknown>> }).records['Design']?.[
        'Double'
      ]
    ).toBe(5);

    // Every id is new; the file is a new row on the same object, downloadable in the new base.
    const newTables = await t.db.select().from(tables).where(eq(tables.baseId, restored.id));
    expect(newTables.map((x) => x.id)).not.toContain(w.tasks.id);
    const newTasks = newTables.find((x) => x.name === 'Tasks');
    const [file] = await t.db.select().from(attachments).where(eq(attachments.baseId, restored.id));
    expect(file?.id).not.toBe(w.file.id);
    expect(file?.storageKey).toContain(`/t/${w.tasks.id}/${w.file.id}`);
    const download = await json('GET', `/api/tables/${newTasks?.id}/attachments/${file?.id}`);
    expect(download.status).toBe(302);
    // View configs name the new field and record.
    const [view] = await t.db
      .select()
      .from(views)
      .where(eq(views.tableId, newTasks?.id ?? ''));
    const [hoursCopy] = await t.db
      .select()
      .from(fields)
      .where(and(eq(fields.tableId, newTasks?.id ?? ''), eq(fields.name, 'Hours')));
    const config = view?.config as { sorts: { fieldId: string }[]; note: string };
    expect(config.sorts[0]?.fieldId).toBe(hoursCopy?.id);
    expect(config.note).not.toBe(w.design.id);
    const { rows } = await t.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ${qualified(newTasks ?? { id: '', dbSchema: '', dbTable: '' })} WHERE id = ${config.note}`
    );
    expect(rows[0]?.n).toBe(1);

    // A name of one's own, and the original base is untouched.
    const named = await restore(w.base.id, snap.id, { name: 'Copy' });
    expect(named.name).toBe('Copy');
    const original = await describeBase(w.base.id);
    expect(
      (original['Tasks'] as { records: Record<string, Record<string, unknown>> }).records[
        'Design'
      ]?.['Hours']
    ).toBe(40);

    // Deleting a snapshot removes its object.
    const [row] = await t.db.select().from(baseSnapshots).where(eq(baseSnapshots.id, snap.id));
    expect(await store.head(row?.storageKey ?? '')).not.toBeNull();
    await ok(json('DELETE', `/api/bases/${w.base.id}/snapshots/${snap.id}`), 204);
    expect(await store.head(row?.storageKey ?? '')).toBeNull();
  });

  it("answers 404 for another base's or another tenant's snapshot", async () => {
    const w = await roadmap();
    const snap = await snapshot(w.base.id);
    const sibling = await newBase('Sibling');
    // Through a base it doesn't belong to.
    expect(
      (await json('POST', `/api/bases/${sibling.id}/snapshots/${snap.id}/restore`, {})).status
    ).toBe(404);
    expect((await json('DELETE', `/api/bases/${sibling.id}/snapshots/${snap.id}`)).status).toBe(
      404
    );
    // Another tenant: neither the list nor the snapshot exist for them.
    const other = await createWorkspace(t.db);
    const otherToken = await createSession(t.db, other.owner);
    const theirs = await ok<Base>(
      json('POST', `/api/workspaces/${other.workspace.id}/bases`, { name: 'Theirs' }, otherToken),
      201
    );
    expect(
      (await json('GET', `/api/bases/${w.base.id}/snapshots`, undefined, otherToken)).status
    ).toBe(404);
    expect(
      (await json('POST', `/api/bases/${w.base.id}/snapshots/${snap.id}/restore`, {}, otherToken))
        .status
    ).toBe(404);
    expect(
      (await json('POST', `/api/bases/${theirs.id}/snapshots/${snap.id}/restore`, {}, otherToken))
        .status
    ).toBe(404);
    // A base-only creator may snapshot the base but not add bases to the workspace.
    const guest = await createUser(t.db);
    await t.db
      .insert(baseMembers)
      .values({ workspaceId, baseId: w.base.id, userId: guest.id, role: 'creator' });
    const guestToken = await createSession(t.db, guest);
    expect(
      (await json('GET', `/api/bases/${w.base.id}/snapshots`, undefined, guestToken)).status
    ).toBe(200);
    expect(
      (await json('POST', `/api/bases/${w.base.id}/snapshots/${snap.id}/restore`, {}, guestToken))
        .status
    ).toBe(403);
  });

  it('takes daily automatic snapshots of changed bases and prunes past retention', async () => {
    const w = await roadmap();
    const autos = async () =>
      t.db
        .select()
        .from(baseSnapshots)
        .where(and(eq(baseSnapshots.baseId, w.base.id), eq(baseSnapshots.kind, 'auto')));
    expect(await runAutoSnapshots(t.appDb, store, logger, 1000)).toBeGreaterThanOrEqual(1);
    expect(await autos()).toHaveLength(1);
    // Not again within a day.
    await runAutoSnapshots(t.appDb, store, logger, 1000);
    expect(await autos()).toHaveLength(1);

    // Owners set the retention; past it, the row and the object go.
    await ok(
      json('PATCH', `/api/workspaces/${workspaceId}/snapshot-settings`, { retentionDays: 7 })
    );
    const [ws] = await t.db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws?.snapshotRetentionDays).toBe(7);
    expect(
      (
        await json('PATCH', `/api/workspaces/${workspaceId}/snapshot-settings`, {
          retentionDays: 0,
        })
      ).status
    ).toBe(422);
    const [auto] = await autos();
    await t.db
      .update(baseSnapshots)
      .set({ createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
      .where(eq(baseSnapshots.id, auto?.id ?? ''));
    expect(await pruneSnapshots(t.appDb, store, logger)).toBeGreaterThanOrEqual(1);
    expect(await autos()).toHaveLength(0);
    expect(await store.head(auto?.storageKey ?? '')).toBeNull();
    await ok(
      json('PATCH', `/api/workspaces/${workspaceId}/snapshot-settings`, { retentionDays: 30 })
    );
  });

  it('streams uploads past one part as a multipart upload', async () => {
    const big = randomBytes(17 * 1024 * 1024);
    async function* chunks() {
      for (let i = 0; i < big.byteLength; i += 1024 * 1024) yield big.subarray(i, i + 1024 * 1024);
    }
    const size = await store.putStream('snapshots/test/big.bin', chunks(), 'application/gzip');
    expect(size).toBe(big.byteLength);
    expect((await store.head('snapshots/test/big.bin'))?.size).toBe(big.byteLength);
    const back: Uint8Array[] = [];
    for await (const chunk of await store.getStream('snapshots/test/big.bin')) back.push(chunk);
    expect(Buffer.concat(back).equals(big)).toBe(true);
    await store.delete('snapshots/test/big.bin');
  });

  it('snapshots and restores a 100k-row base in bounded memory', { timeout: 240_000 }, async () => {
    const base = await newBase('Big');
    const table = await newTable(base.id, 'Rows');
    const name = table.fields.find((f) => f.isPrimary);
    const hours = await field(table.id, 'Hours', 'number');
    const [row] = await t.db.select().from(tables).where(eq(tables.id, table.id));
    const [nameRow] = await t.db
      .select()
      .from(fields)
      .where(eq(fields.id, name?.id ?? ''));
    const [hoursRow] = await t.db.select().from(fields).where(eq(fields.id, hours.id));
    if (!row || !nameRow || !hoursRow) throw new Error('no table');
    await t.db.execute(sql`
      INSERT INTO ${qualified(row)} (id, ${sql.identifier(nameRow.dbColumn)}, ${sql.identifier(hoursRow.dbColumn)})
      SELECT (lpad(to_hex(n), 8, '0') || '-0000-7000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
             'Row ' || n || ' ' || md5(n::text), n
        FROM generate_series(1, 100000) AS n`);

    let peak = 0;
    const start = process.memoryUsage().heapUsed;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().heapUsed - start);
    }, 20);
    try {
      const snap = await snapshot(base.id);
      expect(snap.records).toBe(100_000);
      const restored = await restore(base.id, snap.id, {});
      const [copy] = await t.db.select().from(tables).where(eq(tables.baseId, restored.id));
      const [hoursCopy] = await t.db
        .select()
        .from(fields)
        .where(and(eq(fields.tableId, copy?.id ?? ''), eq(fields.name, 'Hours')));
      const { rows } = await t.db.execute<{ n: number; total: string }>(sql`
        SELECT count(*)::int AS n, sum(${sql.identifier(hoursCopy?.dbColumn ?? '')})::text AS total
          FROM ${qualified(copy ?? row)}`);
      expect(rows[0]).toEqual({ n: 100_000, total: String((100_000 * 100_001) / 2) });
    } finally {
      clearInterval(timer);
    }
    // Pages of 1,000 rows and one upload part at a time: a generous bound against regressions
    // that would hold the whole base or snapshot.
    expect(peak).toBeLessThan(150 * 1024 * 1024);
  });
});
