import type { ImportJob, RecordData, RestoreJob, TableMeta } from '@openrows/shared';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectAttachmentGarbage } from '../../src/attachments/gc.js';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { qualified } from '../../src/data/columns.js';
import {
  attachments,
  baseSnapshots,
  fields,
  jobs,
  storageGarbage,
  tables,
  type users,
} from '../../src/db/index.js';
import { runImportJob } from '../../src/import-export/import.js';
import { JOB_QUEUES } from '../../src/jobs/queues.js';
import { type RunningWorker, startWorker } from '../../src/jobs/runtime.js';
import { sweepJobs } from '../../src/jobs/status.js';
import { createLogger } from '../../src/lib/logger.js';
import { takeSnapshot } from '../../src/snapshots/writer.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, createSession, createWorkspace } from '../helpers/factories.js';
import { MemoryObjectStore } from '../helpers/object-store.js';

/**
 * Jobs moved to the worker: CSV imports resume after a crash (between batches, and with
 * the worker killed for real), fail with a visible error on the last attempt or when their
 * pg-boss job is gone, one runs per table, and only who started a job reads it; restores run as
 * jobs; the attachment GC never deletes a live, trashed or still-named file.
 */
const t = useTestDb();
const logger = createLogger({ level: 'silent' });
const store = new MemoryObjectStore();
let app: ReturnType<typeof testApp>;
let owner: typeof users.$inferSelect;
let workspaceId: string;
let cookie: string;

const running: RunningWorker[] = [];
afterAll(async () => {
  await Promise.all(running.map((w) => w.stop(1_000).catch(() => {})));
});

beforeAll(async () => {
  app = testApp({ db: t.appDb, objectStore: store });
  const ws = await createWorkspace(t.db);
  owner = ws.owner;
  workspaceId = ws.workspace.id;
  cookie = await createSession(t.db, owner);
});

const request = (method: string, path: string, body?: unknown, as = cookie) =>
  app.app.request(path, {
    method,
    headers: {
      origin: app.config.appUrl,
      cookie: `${SESSION_COOKIE}=${as}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  if (r.status !== status) throw new Error(`${r.status}: ${await r.text()}`);
  return (status === 204 ? null : await r.json()) as T;
}

async function newTable() {
  const base = await ok<{ id: string }>(
    request('POST', `/api/workspaces/${workspaceId}/bases`, { name: 'Base' }),
    201
  );
  const table = await ok<TableMeta>(
    request('POST', `/api/bases/${base.id}/tables`, { name: 'Tasks' }),
    201
  );
  return { baseId: base.id, table };
}

const csvOf = (n: number) =>
  `Name\n${Array.from({ length: n }, (_, i) => `Row ${i + 1}`).join('\n')}\n`;

async function startImport(tableId: string, csv: string, as = cookie) {
  const name = (await ok<TableMeta>(request('GET', `/api/tables/${tableId}`, undefined, as)))
    .fields[0];
  return ok<ImportJob>(
    request(
      'POST',
      `/api/tables/${tableId}/imports`,
      { csv, columns: [{ index: 0, fieldId: name?.id }] },
      as
    ),
    201
  );
}
const importState = (tableId: string, id: string, as = cookie) =>
  ok<ImportJob>(request('GET', `/api/tables/${tableId}/imports/${id}`, undefined, as));

async function names(tableId: string): Promise<string[]> {
  const [row] = await t.db.select().from(tables).where(eq(tables.id, tableId));
  const [primary] = await t.db
    .select()
    .from(fields)
    .where(sql`${fields.tableId} = ${tableId} AND ${fields.isPrimary}`);
  if (!row || !primary) throw new Error('no table');
  const { rows } = await t.db.execute<{ name: string }>(
    sql`SELECT ${sql.identifier(primary.dbColumn)} AS name FROM ${qualified(row)}
         WHERE deleted_at IS NULL ORDER BY id`
  );
  return rows.map((r) => r.name);
}

async function until<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 250));
  }
}

class Crash extends Error {}

describe('CSV import in the worker', () => {
  it('resumes after the last committed batch when the worker dies between batches', async () => {
    const { table } = await newTable();
    const job = await startImport(table.id, csvOf(2_500));
    expect(job).toMatchObject({ status: 'running', totalRows: 2_500, processedRows: 0 });

    // The first attempt dies after its first batch (the crash a retry follows).
    const data = { workspaceId, jobId: job.id };
    await expect(
      runImportJob({ db: t.appDb, logger }, data, {
        afterBatch: () => {
          throw new Crash('worker killed');
        },
      })
    ).rejects.toBeInstanceOf(Crash);
    expect(await importState(table.id, job.id)).toMatchObject({
      status: 'running',
      processedRows: 1_000,
    });
    expect(await names(table.id)).toHaveLength(1_000);

    // The retry carries on from row 1,001: every row once, in order.
    await runImportJob({ db: t.appDb, logger }, data);
    expect(await importState(table.id, job.id)).toMatchObject({
      status: 'done',
      processedRows: 2_500,
    });
    const imported = await names(table.id);
    expect(imported).toHaveLength(2_500);
    expect(imported[0]).toBe('Row 1');
    expect(imported[1_000]).toBe('Row 1001');
    expect(new Set(imported).size).toBe(2_500);
    // The CSV text is gone with the job's end; running it again changes nothing.
    const [row] = await t.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row?.payload).toBeNull();
    await runImportJob({ db: t.appDb, logger }, data);
    expect(await names(table.id)).toHaveLength(2_500);
  });

  it('resumes on another worker when the one running it is killed (heartbeat lost)', {
    timeout: 120_000,
  }, async () => {
    const { table } = await newTable();
    const job = await startImport(table.id, csvOf(3_000));
    // Short heartbeats and retry delays so the test doesn't wait minutes.
    const spec = {
      ...JOB_QUEUES['imports.run'],
      heartbeatSeconds: 10,
      retryDelay: 1,
      retryBackoff: false,
    };
    const opts = {
      connectionString: t.appUrl,
      pollingIntervalSeconds: 0.5,
      superviseIntervalSeconds: 1,
      maxConnections: 3,
    };
    let firstBatch: () => void = () => {};
    const committed = new Promise<void>((resolve) => {
      firstBatch = resolve;
    });
    // Worker A hangs forever after its first batch, then is killed: no more heartbeats.
    const a = await startWorker(
      { db: t.appDb, logger, revisionDays: 365 },
      {
        ...opts,
        instanceName: 'a',
        queues: {
          'imports.run': {
            spec,
            handler: (data) =>
              runImportJob({ db: t.appDb, logger }, data, {
                afterBatch: () => {
                  firstBatch();
                  return new Promise(() => {});
                },
              }),
          },
        },
      }
    );
    await committed;
    await a.boss.stop({ graceful: false, close: true });
    expect(await importState(table.id, job.id)).toMatchObject({
      status: 'running',
      processedRows: 1_000,
    });

    // Worker B fails the silent job, retries it and finishes the import.
    const b = await startWorker(
      { db: t.appDb, logger, revisionDays: 365 },
      {
        ...opts,
        instanceName: 'b',
        queues: {
          'imports.run': {
            spec,
            handler: (data) => runImportJob({ db: t.appDb, logger }, data),
          },
        },
      }
    );
    running.push(b);
    const done = await until(async () => {
      const state = await importState(table.id, job.id);
      return state.status === 'done' && state;
    });
    expect(done.processedRows).toBe(3_000);
    const imported = await names(table.id);
    expect(imported).toHaveLength(3_000);
    expect(new Set(imported).size).toBe(3_000);
  });

  it('fails with a visible error on the last attempt, or once its pg-boss job is gone', async () => {
    const { table } = await newTable();
    const first = await startImport(table.id, csvOf(10));
    await runImportJob(
      { db: t.appDb, logger },
      { workspaceId, jobId: first.id },
      {
        lastAttempt: true,
        afterBatch: () => {
          throw new Error('disk on fire');
        },
      }
    );
    const failed = await importState(table.id, first.id);
    expect(failed).toMatchObject({ status: 'failed', processedRows: 10 });
    expect(failed.error).toBe('The import stopped because of a server error.');
    expect(failed.finishedAt).not.toBeNull();

    // A worker killed on the last attempt: pg-boss ends the job; the sweep fails the import.
    const second = await startImport(table.id, csvOf(10));
    await t.db.execute(sql`UPDATE pgboss.job SET state = 'failed' WHERE id = ${second.id}`);
    await t.db
      .update(jobs)
      .set({ createdAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(jobs.id, second.id));
    expect((await sweepJobs(t.appDb)).failed).toBe(1);
    expect(await importState(table.id, second.id)).toMatchObject({
      status: 'failed',
      error: 'The import stopped because of a server error.',
    });
  });

  it('runs one import per table at a time, and only its starter reads it', async () => {
    const { table } = await newTable();
    const job = await startImport(table.id, csvOf(5));
    const again = await request('POST', `/api/tables/${table.id}/imports`, {
      csv: csvOf(5),
      columns: [{ index: 0, fieldId: table.fields[0]?.id }],
    });
    expect(again.status).toBe(409);
    // Another editor of the workspace doesn't see it.
    const editor = await addMember(t.db, workspaceId, 'editor');
    const editorCookie = await createSession(t.db, editor);
    const theirs = await request(
      'GET',
      `/api/tables/${table.id}/imports/${job.id}`,
      undefined,
      editorCookie
    );
    expect(theirs.status).toBe(404);
    await app.runJob(job.id);
    expect((await importState(table.id, job.id)).status).toBe('done');
    // Done: the next import may start.
    await startImport(table.id, csvOf(5));
  });

  it('runs with the live role: an import whose starter lost access fails', async () => {
    const editor = await addMember(t.db, workspaceId, 'editor');
    const editorCookie = await createSession(t.db, editor);
    const { table } = await newTable();
    const job = await startImport(table.id, csvOf(5), editorCookie);
    await t.db.execute(
      sql`UPDATE workspace_members SET role = 'commenter' WHERE user_id = ${editor.id}`
    );
    await app.runJob(job.id);
    // The commenter can't read imports any more; the row says why it stopped.
    const [row] = await t.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row).toMatchObject({
      status: 'failed',
      error: 'You can no longer add records to this table.',
    });
    expect(await names(table.id)).toHaveLength(0);
  });
});

describe('snapshot restore in the worker', () => {
  it('restores as a job that only its starter reads; a failed restore leaves nothing', async () => {
    const { baseId, table } = await newTable();
    await ok(
      request('POST', `/api/tables/${table.id}/records`, {
        fields: { [table.fields[0]?.id ?? '']: 'A' },
      }),
      201
    );
    const snap = await takeSnapshot(t.appDb, store, {
      workspaceId,
      baseId,
      userId: owner.id,
      kind: 'manual',
    });
    const job = await ok<RestoreJob>(
      request('POST', `/api/bases/${baseId}/snapshots/${snap.id}/restore`, { name: 'Again' }),
      201
    );
    expect(job).toMatchObject({ status: 'running', base: null, snapshotId: snap.id });
    const other = await addMember(t.db, workspaceId, 'creator');
    const otherCookie = await createSession(t.db, other);
    const path = `/api/bases/${baseId}/snapshot-restores/${job.id}`;
    expect((await request('GET', path, undefined, otherCookie)).status).toBe(404);

    // The snapshot's object vanished: the restore fails and creates no base.
    const object = store.objects.get(snap.storageKey);
    store.objects.delete(snap.storageKey);
    await app.runJob(job.id, { lastAttempt: true });
    const failed = await ok<RestoreJob>(request('GET', path));
    expect(failed).toMatchObject({ status: 'failed', base: null });
    expect(failed.error).toBeTruthy();
    const { rows } = await t.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM bases WHERE name = 'Again'`
    );
    expect(rows[0]?.n).toBe(0);

    if (object) store.objects.set(snap.storageKey, object);
    const retry = await ok<RestoreJob>(
      request('POST', `/api/bases/${baseId}/snapshots/${snap.id}/restore`, { name: 'Again' }),
      201
    );
    await app.runJob(retry.id);
    const done = await ok<RestoreJob>(
      request('GET', `/api/bases/${baseId}/snapshot-restores/${retry.id}`)
    );
    expect(done.status).toBe('done');
    expect(done.base?.name).toBe('Again');
    // Running the finished job again restores nothing more.
    await app.runJob(retry.id);
    const { rows: again } = await t.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM bases WHERE name = 'Again'`
    );
    expect(again[0]?.n).toBe(1);
  });
});

describe('attachment garbage collection', () => {
  const DAY = 24 * 60 * 60 * 1000;

  /**
   * A base with an attachment field, records and files, in a workspace of its own (snapshots
   * hold a workspace's garbage).
   */
  async function world() {
    const ws = await createWorkspace(t.db);
    owner = ws.owner;
    workspaceId = ws.workspace.id;
    cookie = await createSession(t.db, owner);
    const { baseId, table } = await newTable();
    const field = await ok<{ id: string }>(
      request('POST', `/api/tables/${table.id}/fields`, { name: 'Files', type: 'attachment' }),
      201
    );
    const [fieldRow] = await t.db.select().from(fields).where(eq(fields.id, field.id));
    const [tableRow] = await t.db.select().from(tables).where(eq(tables.id, table.id));
    if (!fieldRow || !tableRow) throw new Error('no field');
    const file = async (
      name: string,
      opts: { status?: 'ready' | 'pending'; ageDays?: number } = {}
    ) => {
      const key = `ws/${workspaceId}/b/${baseId}/t/${table.id}/${name}-${crypto.randomUUID()}`;
      const at = new Date(Date.now() - (opts.ageDays ?? 2) * DAY);
      const [row] = await t.db
        .insert(attachments)
        .values({
          workspaceId,
          baseId,
          tableId: table.id,
          fieldId: field.id,
          storageKey: key,
          filename: `${name}.txt`,
          contentType: 'text/plain',
          size: 3,
          status: opts.status ?? 'ready',
          createdBy: owner.id,
          createdAt: at,
          confirmedAt: opts.status === 'pending' ? null : at,
        })
        .returning();
      if (!row) throw new Error('no attachment');
      await store.put(key, new Uint8Array([1, 2, 3]));
      return row;
    };
    const record = async (files: { id: string; filename: string }[]) => {
      const created = await ok<RecordData>(
        request('POST', `/api/tables/${table.id}/records`, {
          fields: {
            [field.id]: files.map((f) => ({
              id: f.id,
              filename: f.filename,
              size: 3,
              type: 'text/plain',
            })),
          },
        }),
        201
      );
      return created;
    };
    return { baseId, table, tableRow, fieldRow, file, record };
  }

  const rowExists = async (id: string) =>
    (await t.db.select().from(attachments).where(eq(attachments.id, id))).length === 1;
  const gc = (dryRun = false) =>
    collectAttachmentGarbage({ db: t.appDb, store, logger }, { dryRun });
  /** Ages every garbage key past the snapshot margin. */
  const ageGarbage = () =>
    t.db.update(storageGarbage).set({ createdAt: new Date(Date.now() - 2 * DAY) });

  it('never deletes a live, trashed or revision-held file; deletes orphans after a dry run', async () => {
    const w = await world();
    const live = await w.file('live');
    const trashed = await w.file('trashed');
    const purged = await w.file('purged');
    const cleared = await w.file('cleared');
    const unused = await w.file('unused');
    const fresh = await w.file('fresh', { ageDays: 0 });
    const pending = await w.file('pending', { status: 'pending' });
    await w.record([live]);
    const inTrash = await w.record([trashed]);
    const toPurge = await w.record([purged]);
    const toClear = await w.record([cleared]);
    // A record in the trash, one purged (row and revisions gone), one cell cleared (its
    // revision still names the file: restoring it brings it back).
    await ok(
      request('POST', `/api/tables/${w.table.id}/records/delete`, {
        recordIds: [inTrash.id, toPurge.id],
      })
    );
    await ok(
      request('POST', `/api/tables/${w.table.id}/trash/records/purge`, { recordIds: [toPurge.id] })
    );
    await ok(
      request('PATCH', `/api/tables/${w.table.id}/records/${toClear.id}`, {
        fields: { [w.fieldRow.id]: [] },
      })
    );

    // The dry run counts and deletes nothing.
    const dry = await gc(true);
    expect(dry).toMatchObject({ dryRun: true, errors: 0 });
    expect(dry.orphanedRows).toBeGreaterThanOrEqual(3);
    for (const f of [live, trashed, purged, cleared, unused, fresh, pending]) {
      expect(await rowExists(f.id), f.filename).toBe(true);
      expect(store.objects.has(f.storageKey), f.filename).toBe(true);
    }

    const first = await gc();
    expect(first.errors).toBe(0);
    for (const f of [live, trashed, cleared, fresh]) {
      expect(await rowExists(f.id), f.filename).toBe(true);
    }
    for (const f of [purged, unused, pending])
      expect(await rowExists(f.id), f.filename).toBe(false);
    // Pending uploads were never in a snapshot: their object goes at once. Ready files wait
    // out the snapshot margin.
    expect(store.objects.has(pending.storageKey)).toBe(false);
    expect(store.objects.has(purged.storageKey)).toBe(true);
    await ageGarbage();
    await gc();
    expect(store.objects.has(purged.storageKey)).toBe(false);
    expect(store.objects.has(unused.storageKey)).toBe(false);
    for (const f of [live, trashed, cleared, fresh]) {
      expect(store.objects.has(f.storageKey), f.filename).toBe(true);
    }
    expect(
      await t.db.select().from(storageGarbage).where(eq(storageGarbage.workspaceId, workspaceId))
    ).toEqual([]);
  });

  it('keeps an object another row still names, or a snapshot from before may hold', async () => {
    const w = await world();
    const shared = await w.file('shared');
    const held = await w.file('held');
    // A restored base's row sharing the file's key (same workspace), in a live cell.
    const [copy] = await t.db
      .insert(attachments)
      .values({ ...shared, id: uuidv7() })
      .returning();
    if (!copy) throw new Error('no copy');
    await w.record([copy]);
    const heldRecord = await w.record([held]);
    // `shared`'s own row is orphaned and goes; its object stays while `copy` names the key.
    await gc();
    expect(await rowExists(shared.id)).toBe(false);
    await ageGarbage();
    await gc();
    expect(store.objects.has(shared.storageKey)).toBe(true);

    // A snapshot taken while `held` was in a cell: after the record's purge, its object stays
    // until the snapshot is gone.
    const snap = await takeSnapshot(t.appDb, store, {
      workspaceId,
      baseId: w.baseId,
      userId: owner.id,
      kind: 'manual',
    });
    // Purged: the record and its revisions.
    await t.db.execute(sql`DELETE FROM ${qualified(w.tableRow)} WHERE id = ${heldRecord.id}`);
    await t.db.execute(sql`DELETE FROM record_revisions WHERE record_id = ${heldRecord.id}`);
    await gc();
    expect(await rowExists(held.id)).toBe(false);
    // Aged together: the snapshot is still older than the garbage.
    await ageGarbage();
    await t.db
      .update(baseSnapshots)
      .set({ createdAt: new Date(Date.now() - 3 * DAY) })
      .where(eq(baseSnapshots.id, snap.id));
    await gc();
    expect(store.objects.has(held.storageKey)).toBe(true);
    await ok(request('DELETE', `/api/bases/${w.baseId}/snapshots/${snap.id}`), 204);
    await gc();
    expect(store.objects.has(held.storageKey)).toBe(false);
  });

  it("deletes a purged base's files and snapshots once nothing holds them", async () => {
    const w = await world();
    const file = await w.file('in-base');
    await w.record([file]);
    const snap = await takeSnapshot(t.appDb, store, {
      workspaceId,
      baseId: w.baseId,
      userId: owner.id,
      kind: 'manual',
    });
    await ok(request('DELETE', `/api/bases/${w.baseId}`), 204);
    // In the trash: nothing goes.
    await gc();
    await ageGarbage();
    await gc();
    expect(await rowExists(file.id)).toBe(true);
    expect(store.objects.has(file.storageKey)).toBe(true);
    await ok(request('DELETE', `/api/workspaces/${workspaceId}/trash/bases/${w.baseId}`), 204);
    await ageGarbage();
    await gc();
    expect(store.objects.has(file.storageKey)).toBe(false);
    expect(store.objects.has(snap.storageKey)).toBe(false);
  });
});
