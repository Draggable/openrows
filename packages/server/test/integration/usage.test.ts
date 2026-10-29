import type { ImportJob, RecordData, TableMeta, WorkspaceUsage } from '@openrows/shared';
import { eq, sql } from 'drizzle-orm';
import { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { qualified } from '../../src/data/columns.js';
import { baseMembers, tableRecordCounts, tables, type users } from '../../src/db/index.js';
import {
  CountingUsageMeter,
  type Entitlements,
  noBilling,
  readWorkspacePlan,
  resolveEdition,
  setWorkspacePlan,
} from '../../src/edition/index.js';
import { createLogger } from '../../src/lib/logger.js';
import { reconcileRecordCounts } from '../../src/usage/counters.js';
import { monthOf } from '../../src/usage/service.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import {
  addMember,
  createReadyAttachment,
  createSession,
  createToken,
  createUser,
  createWorkspace,
} from '../helpers/factories.js';
import { MemoryObjectStore } from '../helpers/object-store.js';

/**
 * Plans and usage counters: the record counters stay equal to the live records under
 * concurrent creates and deletes, CSV imports, the trash, snapshot restores and table copies;
 * the worker's reconcile repairs drift; GET /api/workspaces/:id/usage reports attachment bytes,
 * this month's automation runs and API calls and the billable editors, with the edition's plan.
 */
describe('usage counters', () => {
  const t = useTestDb();
  const logger = createLogger({ level: 'silent' });
  let app: ReturnType<typeof testApp>;
  let owner: typeof users.$inferSelect;
  let workspaceId: string;
  let cookie: string;

  beforeAll(async () => {
    app = testApp({ db: t.appDb, objectStore: new MemoryObjectStore() });
    const ws = await createWorkspace(t.db);
    owner = ws.owner;
    workspaceId = ws.workspace.id;
    cookie = await createSession(t.db, owner);
  });

  const request = (
    method: string,
    path: string,
    body?: unknown,
    as = cookie,
    a = app.app
  ): Promise<Response> =>
    Promise.resolve(
      a.request(path, {
        method,
        headers: {
          origin: app.config.appUrl,
          cookie: `${SESSION_COOKIE}=${as}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    );
  async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
    const r = await res;
    if (r.status !== status) throw new Error(`${r.status}: ${await r.text()}`);
    return (status === 204 ? null : await r.json()) as T;
  }
  const newBase = (name = 'Base') =>
    ok<{ id: string }>(request('POST', `/api/workspaces/${workspaceId}/bases`, { name }), 201);
  const newTable = (baseId: string, name = 'Tasks') =>
    ok<TableMeta>(request('POST', `/api/bases/${baseId}/tables`, { name }), 201);
  const create = async (tableId: string, n: number) =>
    (
      await ok<{ records: RecordData[] }>(
        request('POST', `/api/tables/${tableId}/records`, {
          records: Array.from({ length: n }, () => ({ fields: {} })),
        }),
        201
      )
    ).records.map((r) => r.id);
  const remove = (tableId: string, ids: string[]) =>
    request('POST', `/api/tables/${tableId}/records/delete`, { recordIds: ids });
  const restore = (tableId: string, ids: string[]) =>
    request('POST', `/api/tables/${tableId}/records/restore`, { recordIds: ids });
  const usage = (as = cookie, a = app.app) =>
    ok<WorkspaceUsage>(request('GET', `/api/workspaces/${workspaceId}/usage`, undefined, as, a));

  /** The table's counter, and what its physical table really holds. */
  async function counted(tableId: string) {
    const [row] = await t.db
      .select({ records: tableRecordCounts.records })
      .from(tableRecordCounts)
      .where(eq(tableRecordCounts.tableId, tableId));
    const [table] = await t.db.select().from(tables).where(eq(tables.id, tableId));
    if (!table) throw new Error('no table');
    const { rows } = await t.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ${qualified(table)} WHERE deleted_at IS NULL`
    );
    return { counter: row?.records ?? 0, actual: rows[0]?.n ?? -1 };
  }
  const baseRecords = async (baseId: string) =>
    (await usage()).bases.find((b) => b.baseId === baseId)?.records;

  it('counts creates, trash, restore and permanent deletes through the RecordService', async () => {
    const base = await newBase('Counted');
    const table = await newTable(base.id);
    const ids = await create(table.id, 5);
    expect(await counted(table.id)).toEqual({ counter: 5, actual: 5 });
    expect(await baseRecords(base.id)).toBe(5);

    await ok(remove(table.id, ids.slice(0, 2)));
    expect(await counted(table.id)).toEqual({ counter: 3, actual: 3 });
    // Deleting a record already in the trash: 404, nothing counted twice.
    expect((await remove(table.id, ids.slice(0, 1))).status).toBe(404);
    await ok(restore(table.id, ids.slice(0, 1)));
    expect(await counted(table.id)).toEqual({ counter: 4, actual: 4 });
    // Deleting from the trash permanently: those were no longer counted.
    await ok(
      request('POST', `/api/tables/${table.id}/trash/records/purge`, { recordIds: [ids[1]] })
    );
    expect(await counted(table.id)).toEqual({ counter: 4, actual: 4 });

    // A table in the trash doesn't count toward its base; restored, it does again.
    const other = await newTable(base.id, 'Other');
    await create(other.id, 3);
    expect(await baseRecords(base.id)).toBe(7);
    await ok(request('DELETE', `/api/tables/${other.id}`), 204);
    expect(await baseRecords(base.id)).toBe(4);
    await ok(request('POST', `/api/bases/${base.id}/trash/tables/${other.id}/restore`), 200);
    expect(await baseRecords(base.id)).toBe(7);
    // A base in the trash isn't listed.
    await ok(request('DELETE', `/api/bases/${base.id}`), 204);
    expect((await usage()).bases.some((b) => b.baseId === base.id)).toBe(false);
  });

  it('stays exact under concurrent creates and overlapping deletes and restores', async () => {
    const base = await newBase('Concurrent');
    const table = await newTable(base.id);
    const seed = await create(table.id, 40);
    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) writes.push(create(table.id, 3));
    // Every seed record deleted twice at once: one delete wins, the other answers 404.
    for (let i = 0; i < 20; i++) {
      writes.push(remove(table.id, [seed[i] as string]));
      writes.push(remove(table.id, [seed[i] as string]));
    }
    // Restores racing deletes of other records, and a reconcile in the middle of it all.
    for (let i = 20; i < 30; i++) writes.push(remove(table.id, [seed[i] as string]));
    writes.push(reconcileRecordCounts(t.appDb, logger));
    await Promise.all(writes);
    await Promise.all(
      seed
        .slice(20, 30)
        .map((id) => restore(table.id, [id]).then((r) => expect(r.status).toBe(200)))
    );
    const c = await counted(table.id);
    expect(c.actual).toBe(40 + 30 - 20);
    expect(c.counter).toBe(c.actual);
  });

  it('counts CSV imports (the worker writes through the RecordService)', async () => {
    const base = await newBase('Imported');
    const table = await newTable(base.id);
    const csv = ['Name', ...Array.from({ length: 120 }, (_, i) => `row ${i}`)].join('\n');
    const name = table.fields.find((f) => f.name === 'Name');
    const job = await ok<ImportJob>(
      request('POST', `/api/tables/${table.id}/imports`, {
        csv,
        columns: [{ index: 0, fieldId: name?.id }],
      }),
      201
    );
    await app.runJob(job.id);
    expect(await counted(table.id)).toEqual({ counter: 120, actual: 120 });
  });

  it('recounts a table duplicated with its records and a base restored from a snapshot', async () => {
    const base = await newBase('Copied');
    const table = await newTable(base.id);
    const ids = await create(table.id, 6);
    await ok(remove(table.id, ids.slice(0, 2)));
    const copy = await ok<TableMeta>(
      request('POST', `/api/tables/${table.id}/duplicate`, { includeRecords: true }),
      201
    );
    expect(await counted(copy.id)).toEqual({ counter: 4, actual: 4 });

    const snap = await ok<{ id: string }>(request('POST', `/api/bases/${base.id}/snapshots`), 201);
    const job = await ok<{ id: string }>(
      request('POST', `/api/bases/${base.id}/snapshots/${snap.id}/restore`, {}),
      201
    );
    await app.runJob(job.id);
    const done = await ok<{ base: { id: string } | null }>(
      request('GET', `/api/bases/${base.id}/snapshot-restores/${job.id}`)
    );
    const restored = done.base?.id ?? '';
    const restoredTables = await t.db.select().from(tables).where(eq(tables.baseId, restored));
    expect(restoredTables).toHaveLength(2);
    for (const rt of restoredTables)
      expect(await counted(rt.id)).toEqual({ counter: 4, actual: 4 });
    expect(await baseRecords(restored)).toBe(8);
  });

  it("the worker's reconcile repairs a counter that drifted, and only reports drift", async () => {
    const base = await newBase('Drifted');
    const table = await newTable(base.id);
    await create(table.id, 3);
    await t.db
      .update(tableRecordCounts)
      .set({ records: 99 })
      .where(eq(tableRecordCounts.tableId, table.id));
    const missing = await newTable(base.id, 'No counter');
    await create(missing.id, 2);
    await t.db.delete(tableRecordCounts).where(eq(tableRecordCounts.tableId, missing.id));

    const first = await reconcileRecordCounts(t.appDb, logger, 2);
    expect(first.drifted).toBe(2);
    expect(await counted(table.id)).toEqual({ counter: 3, actual: 3 });
    expect(await counted(missing.id)).toEqual({ counter: 2, actual: 2 });
    expect((await reconcileRecordCounts(t.appDb, logger)).drifted).toBe(0);
  });

  it('reports attachment bytes, automation runs, API calls and billable editors', async () => {
    const { workspace, owner: wsOwner } = await createWorkspace(t.db, { name: 'Metered' });
    const as = await createSession(t.db, wsOwner);
    const get = () =>
      ok<WorkspaceUsage>(request('GET', `/api/workspaces/${workspace.id}/usage`, undefined, as));
    const base = await ok<{ id: string }>(
      request('POST', `/api/workspaces/${workspace.id}/bases`, { name: 'B' }, as),
      201
    );
    const table = await ok<TableMeta>(
      request('POST', `/api/bases/${base.id}/tables`, { name: 'Projects' }, as),
      201
    );
    const files = table.fields.find((f) => f.type === 'attachment');
    const at = { workspaceId: workspace.id, baseId: base.id, tableId: table.id };
    const fieldId =
      files?.id ??
      (
        await ok<{ id: string }>(
          request(
            'POST',
            `/api/tables/${table.id}/fields`,
            { name: 'Files', type: 'attachment' },
            as
          ),
          201
        )
      ).id;
    await createReadyAttachment(
      t.db,
      { ...at, fieldId },
      { filename: 'a.pdf', type: 'application/pdf', size: 1500 }
    );
    const { start } = monthOf(new Date());
    await t.db.execute(
      sql`INSERT INTO automation_run_counts (workspace_id, month, runs) VALUES
            (${workspace.id}, ${start}::date, 7), (${workspace.id}, '2020-01-01', 1000)`
    );
    // Billable: the owner, an editor, a creator and a base-only editor; not a commenter, a
    // read-only member or a base-only commenter; someone with both roles once.
    await addMember(t.db, workspace.id, 'editor');
    await addMember(t.db, workspace.id, 'creator');
    await addMember(t.db, workspace.id, 'commenter');
    const reader = await addMember(t.db, workspace.id, 'read_only');
    const baseEditor = await createUser(t.db);
    const baseCommenter = await createUser(t.db);
    await t.db.insert(baseMembers).values([
      { workspaceId: workspace.id, baseId: base.id, userId: baseEditor.id, role: 'editor' },
      { workspaceId: workspace.id, baseId: base.id, userId: baseCommenter.id, role: 'commenter' },
      { workspaceId: workspace.id, baseId: base.id, userId: reader.id, role: 'editor' },
      { workspaceId: workspace.id, baseId: base.id, userId: wsOwner.id, role: 'editor' },
    ]);

    // API calls: admitted REST API v1 requests on a base of the workspace, by token or session.
    const { token } = await createToken(t.db, wsOwner, { workspaceIds: [workspace.id] });
    for (let i = 0; i < 3; i++) {
      const res = await app.app.request(`/api/v1/${base.id}/Projects`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
    }
    // A base the caller doesn't reach counts nowhere.
    const stranger = await createUser(t.db);
    const strangerToken = await createToken(t.db, stranger, { workspaceIds: [workspace.id] });
    expect(
      (
        await app.app.request(`/api/v1/${base.id}/Projects`, {
          headers: { authorization: `Bearer ${strangerToken.token}` },
        })
      ).status
    ).toBe(404);
    // The app's own routes aren't API calls.
    await ok(request('GET', `/api/tables/${table.id}/records`, undefined, as));

    const u = await get();
    expect(u.plan).toEqual({ id: 'self-hosted', name: 'Self-hosted' });
    expect(u.period.start).toBe(start);
    expect(u.bases).toEqual([{ baseId: base.id, name: 'B', records: 0, limit: null }]);
    expect(u.attachmentBytes).toEqual({ used: 1500, limit: null });
    expect(u.automationRuns).toEqual({ used: 7, limit: null });
    expect(u.apiCalls).toEqual({ used: 3, limit: null });
    expect(u.editors).toEqual({ used: 5, limit: null });
    expect(u.revisionHistoryDays).toBeNull();
    expect(Object.values(u.features).every(Boolean)).toBe(true);

    // Members of any role read it; a base-only collaborator has no workspace role: 404.
    expect(
      (
        await request(
          'GET',
          `/api/workspaces/${workspace.id}/usage`,
          undefined,
          await createSession(t.db, reader)
        )
      ).status
    ).toBe(200);
    expect(
      (
        await request(
          'GET',
          `/api/workspaces/${workspace.id}/usage`,
          undefined,
          await createSession(t.db, baseEditor)
        )
      ).status
    ).toBe(404);
  });
});

describe('workspace plans', () => {
  const t = useTestDb();

  it('only workspace_plan_set changes plan and plan_overrides; the app role cannot UPDATE them', async () => {
    const { workspace } = await createWorkspace(t.db);
    const scoped = (q: ReturnType<typeof sql>) =>
      t.appDb.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.workspace_id', ${workspace.id}, true)`);
        return tx.execute(q);
      });
    const denied = { cause: { message: expect.stringMatching(/permission denied/) } };
    await expect(scoped(sql`UPDATE workspaces SET plan = 'business'`)).rejects.toMatchObject(
      denied
    );
    await expect(
      scoped(sql`UPDATE workspaces SET plan_overrides = '{"limits":{}}'::jsonb`)
    ).rejects.toMatchObject(denied);
    // Renaming still works.
    await scoped(sql`UPDATE workspaces SET name = 'Renamed', updated_at = now()`);

    expect(
      await setWorkspacePlan(t.appDb, workspace.id, {
        plan: 'pro',
        overrides: { limits: { recordsPerBase: 75_000 }, features: { sso: true } },
      })
    ).toBe(true);
    const stored = await t.appDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.workspace_id', ${workspace.id}, true)`);
      return readWorkspacePlan(tx, workspace.id);
    });
    expect(stored).toEqual({
      plan: 'pro',
      overrides: { limits: { recordsPerBase: 75_000 }, features: { sso: true } },
    });
    expect(
      await setWorkspacePlan(
        t.appDb,
        '0190f0a0-0000-7000-8000-00000000dead',
        stored ?? { plan: null, overrides: {} }
      )
    ).toBe(false);
    await expect(
      setWorkspacePlan(t.appDb, workspace.id, { plan: 'Not A Plan', overrides: {} })
    ).rejects.toThrow();
  });

  it("the usage route answers with the edition's entitlements for the stored plan", async () => {
    const { workspace, owner } = await createWorkspace(t.db);
    await setWorkspacePlan(t.appDb, workspace.id, {
      plan: 'pro',
      overrides: { limits: { apiCallsPerMonth: 5 } },
    });
    // A stand-in for the hosted plan catalog: the core can't import it.
    const seen: string[] = [];
    const edition = resolveEdition('cloud', {
      entitlements: {
        id: 'test-plans',
        async forWorkspace(id, tx): Promise<Entitlements> {
          const stored = await readWorkspacePlan(tx, id);
          seen.push(stored?.plan ?? 'none');
          const limits: Record<string, number | null> = {
            recordsPerBase: 50_000,
            ...stored?.overrides.limits,
          };
          return {
            plan: stored?.plan ?? 'free',
            planName: 'Pro',
            has: (f) => f !== 'sso',
            limit: (l) => limits[l] ?? null,
          };
        },
      },
      billing: noBilling,
      usage: new CountingUsageMeter(),
    });
    const { app, config } = testApp({ db: t.appDb, edition });
    const as = await createSession(t.db, owner);
    const res = await app.request(`/api/workspaces/${workspace.id}/usage`, {
      headers: { origin: config.appUrl, cookie: `${SESSION_COOKIE}=${as}` },
    });
    expect(res.status).toBe(200);
    const u = (await res.json()) as WorkspaceUsage;
    expect(seen).toEqual(['pro']);
    expect(u.plan).toEqual({ id: 'pro', name: 'Pro' });
    expect(u.apiCalls.limit).toBe(5);
    expect(u.features.sso).toBe(false);
    expect(u.features.editPermissions).toBe(true);
  });

  it('workspace_plan_set notifies the workspace_plan channel', async () => {
    const { workspace } = await createWorkspace(t.db);
    const client = new Client({ connectionString: t.appUrl });
    await client.connect();
    try {
      const got = new Promise<string>((resolve) =>
        client.on('notification', (msg) => resolve(msg.payload ?? ''))
      );
      await client.query('LISTEN workspace_plan');
      await setWorkspacePlan(t.appDb, workspace.id, { plan: 'business', overrides: {} });
      expect(await got).toBe(workspace.id);
    } finally {
      await client.end();
    }
  });
});
