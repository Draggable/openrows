import type { Base, RecordData as RecordT, TableMeta, TableSync } from '@openrows/shared';
import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { tableSyncRecords, tableSyncs, tables, workspaceMembers } from '../../src/db/index.js';
import { runSyncJob, type SyncRunDeps } from '../../src/syncs/run.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, createSession, createWorkspace } from '../helpers/factories.js';

/**
 * Two-way syncs with a table or view of OpenRows. One-way syncs stay as they were until a
 * creator opts a source in; then edits of its written-back fields and deletes of its records on
 * the synced table go back to the source as the sync's creator (their live rights, or a pause),
 * each side is compared with the values last applied to tell which one changed, the record
 * updated last wins a field both changed (the source on a tie), deletes follow the rules of the
 * guide (a view's filter never deletes a source record), and two-way syncs never loop.
 */
describe('two-way synced tables', () => {
  const t = useTestDb();
  let app: ReturnType<typeof testApp>['app'];
  let owner: string;
  let workspaceId: string;
  let crm: Base;
  let reports: Base;

  const json = (method: string, path: string, body?: unknown, as = owner) =>
    app.request(path, {
      method,
      headers: {
        origin: 'http://localhost:5173',
        'content-type': 'application/json',
        cookie: `${SESSION_COOKIE}=${as}`,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  async function ok<T>(res: Response | Promise<Response>, expected = 200): Promise<T> {
    const r = await res;
    if (r.status !== expected) throw new Error(`${r.status}: ${await r.text()}`);
    return (expected === 204 ? null : await r.json()) as T;
  }
  async function problem(res: Response | Promise<Response>, expected: number) {
    const r = await res;
    const text = await r.text();
    if (r.status !== expected) throw new Error(`${r.status}: ${text}`);
    return JSON.parse(text) as { detail?: string; errors?: { path: string; message: string }[] };
  }
  const fieldId = (table: TableMeta, name: string) => {
    const f = table.fields.find((x) => x.name === name);
    if (!f) throw new Error(`no field ${name}`);
    return f.id;
  };
  const meta = (tableId: string, as = owner) =>
    ok<TableMeta>(json('GET', `/api/tables/${tableId}`, undefined, as));
  const records = async (tableId: string, as = owner) =>
    (
      await ok<{ records: RecordT[] }>(
        json('GET', `/api/tables/${tableId}/records?limit=1000`, undefined, as)
      )
    ).records;
  const sources = async (tableId: string, as = owner) =>
    (await ok<{ sources: TableSync[] }>(json('GET', `/api/tables/${tableId}/syncs`, undefined, as)))
      .sources;
  const homes = new Map<string, string>();
  /** "Sync now" on one source (unless a run is queued), run as the worker would. */
  async function syncNow(
    sync: TableSync,
    opts: Pick<SyncRunDeps, 'batchSize'> & { as?: string } = {}
  ) {
    const as = opts.as ?? owner;
    let current = (await sources(sync.tableId, as)).find((s) => s.id === sync.id);
    if (!current?.runs.some((r) => r.status === 'queued')) {
      current = await ok<TableSync>(
        json('POST', `/api/tables/${sync.tableId}/syncs/${sync.id}/run`, undefined, as)
      );
    }
    const queued = current.runs.find((r) => r.status === 'queued');
    if (!queued) throw new Error('no queued run');
    return runSyncJob(
      { db: t.appDb, ...(opts.batchSize ? { batchSize: opts.batchSize } : {}) },
      { workspaceId: homes.get(sync.id) ?? workspaceId, syncId: sync.id, runId: queued.id }
    );
  }
  const quiet = {
    status: 'succeeded',
    created: 0,
    updated: 0,
    deleted: 0,
    writtenBack: 0,
    removedFromSource: 0,
  };
  /** A table of `base` with Name, Notes, Status, Points and a Ticket number, and these rows. */
  async function sourceTable(
    base: Base,
    name: string,
    rows: { name: string; points?: number }[],
    as = owner
  ) {
    const table = await ok<TableMeta>(
      json('POST', `/api/bases/${base.id}/tables`, { name }, as),
      201
    );
    for (const field of [
      { name: 'Points', type: 'number' },
      { name: 'Ticket', type: 'autoNumber' },
    ]) {
      await ok(json('POST', `/api/tables/${table.id}/fields`, field, as), 201);
    }
    const full = await meta(table.id, as);
    if (rows.length) {
      await ok(
        json(
          'POST',
          `/api/tables/${table.id}/records`,
          {
            typecast: true,
            records: rows.map((r) => ({
              fields: {
                [fieldId(full, 'Name')]: r.name,
                [fieldId(full, 'Status')]: 'Todo',
                ...(r.points !== undefined ? { [fieldId(full, 'Points')]: r.points } : {}),
              },
            })),
          },
          as
        ),
        201
      );
    }
    return full;
  }
  /** A synced table of Reports made from `from` (one-way unless `twoWay`), its first run done. */
  async function syncedFrom(
    from: TableMeta,
    body: Record<string, unknown> = {},
    opts: { base?: Base; sourceBase?: Base; as?: string; home?: string } = {}
  ) {
    const sync = await ok<TableSync>(
      json(
        'POST',
        `/api/bases/${(opts.base ?? reports).id}/syncs`,
        {
          source: { baseId: (opts.sourceBase ?? crm).id, tableId: from.id },
          schedule: 'manual',
          ...body,
        },
        opts.as ?? owner
      ),
      201
    );
    if (opts.home) homes.set(sync.id, opts.home);
    expect(await syncNow(sync, { as: opts.as ?? owner })).toMatchObject({ status: 'succeeded' });
    return sync;
  }
  /** A record of `table` by its Name. */
  async function byName(table: TableMeta, name: string, as = owner) {
    const r = (await records(table.id, as)).find((x) => x.fields[fieldId(table, 'Name')] === name);
    if (!r) throw new Error(`no record ${name}`);
    return r;
  }
  const patch = (table: TableMeta, record: RecordT, fields: Record<string, unknown>, as = owner) =>
    json(
      'PATCH',
      `/api/tables/${table.id}/records/${record.id}`,
      {
        typecast: true,
        fields: Object.fromEntries(
          Object.entries(fields).map(([name, value]) => [fieldId(table, name), value])
        ),
      },
      as
    );
  const remove = (table: TableMeta, record: RecordT, as = owner) =>
    json('DELETE', `/api/tables/${table.id}/records/${record.id}`, undefined, as);
  /** Name → [Points, Notes, Status] of a table's records. */
  async function cells(table: TableMeta, as = owner) {
    const status = (await meta(table.id, as)).fields.find((f) => f.name === 'Status');
    const options = (status?.options ?? {}) as { choices?: { id: string; name: string }[] };
    const choices = options.choices;
    const choice = (id: unknown) => choices?.find((c) => c.id === id)?.name ?? id ?? null;
    const out: Record<string, [unknown, unknown, unknown]> = {};
    for (const r of await records(table.id, as)) {
      out[r.fields[fieldId(table, 'Name')] as string] = [
        r.fields[fieldId(table, 'Points')] ?? null,
        r.fields[fieldId(table, 'Notes')] ?? null,
        choice(r.fields[fieldId(table, 'Status')]),
      ];
    }
    return out;
  }
  /** One record's [Points, Notes, Status], by its Name. */
  const cell = async (table: TableMeta, name: string, as = owner) =>
    new Map(Object.entries(await cells(table, as))).get(name);
  const versions = async (tableId: string) =>
    (await records(tableId)).map((r) => [r.id, r.version]).sort();
  /** Sets a record's modified time (both sides' LWW clock) as the owner connection. */
  async function setUpdatedAt(tableId: string, recordId: string, at: string) {
    const [row] = await t.db.select().from(tables).where(eq(tables.id, tableId));
    if (!row) throw new Error('no table');
    await t.db.execute(
      sql`UPDATE ${sql.identifier(row.dbSchema)}.${sql.identifier(row.dbTable)} SET updated_at = ${at}::timestamptz WHERE id = ${recordId}::uuid`
    );
  }
  const applied = async (syncId: string) =>
    (
      await t.db
        .select({ n: sql<number>`count(*)::int` })
        .from(tableSyncRecords)
        .where(eq(tableSyncRecords.syncId, syncId))
    )[0]?.n ?? 0;

  beforeAll(async () => {
    ({ app } = testApp({ db: t.appDb }));
    const ws = await createWorkspace(t.db);
    workspaceId = ws.workspace.id;
    owner = await createSession(t.db, ws.owner);
    crm = await ok<Base>(
      json('POST', `/api/workspaces/${workspaceId}/bases`, { name: 'CRM' }),
      201
    );
    reports = await ok<Base>(
      json('POST', `/api/workspaces/${workspaceId}/bases`, { name: 'Reports' }),
      201
    );
  });

  it('keeps one-way table and view syncs as they were until two-way is turned on', async () => {
    const people = await sourceTable(crm, 'People', [
      { name: 'Ada', points: 1 },
      { name: 'Bob', points: 2 },
    ]);
    const view = await ok<{ id: string }>(
      json('POST', `/api/tables/${people.id}/views`, { name: 'Some' }),
      201
    );
    const a = await syncedFrom(people);
    const b = await syncedFrom(people, {
      source: { baseId: crm.id, tableId: people.id, viewId: view.id },
    });
    for (const sync of [a, b]) {
      const [s] = await sources(sync.tableId);
      expect(s).toMatchObject({ twoWay: false, writeBackFieldIds: [] });
      const synced = await meta(sync.tableId);
      const before = await versions(sync.tableId);
      // An unchanged rerun writes nothing, and keeps no last applied values.
      expect(await syncNow(sync)).toMatchObject({ ...quiet, unchanged: 2 });
      expect(await versions(sync.tableId)).toEqual(before);
      expect(await applied(sync.id)).toBe(0);
      // Synced fields and records stay read-only.
      const ada = await byName(synced, 'Ada');
      expect((await patch(synced, ada, { Points: 5 })).status).toBe(403);
      expect((await remove(synced, ada)).status).toBe(403);
    }

    // Opting in: the run it queues sets the baseline and opens the written-back fields.
    const on = await ok<TableSync>(
      json('PATCH', `/api/tables/${a.tableId}/sync`, { twoWay: true })
    );
    expect(on).toMatchObject({ twoWay: true, writeBackFieldIds: [] });
    expect(on.runs[0]).toMatchObject({ status: 'queued' });
    const synced = await meta(a.tableId);
    expect((await patch(synced, await byName(synced, 'Ada'), { Points: 5 })).status).toBe(403);
    expect(await syncNow(a)).toMatchObject({ ...quiet, unchanged: 2 });
    expect(await applied(a.id)).toBe(2);
    const [s] = await sources(a.tableId);
    expect(new Set(s?.writeBackFieldIds)).toEqual(
      new Set(['Name', 'Notes', 'Status', 'Points'].map((n) => fieldId(synced, n)))
    );
    // The copy of an auto number is text: never written back, so never editable.
    expect((await patch(synced, await byName(synced, 'Ada'), { Ticket: 'x' })).status).toBe(403);
    await ok(patch(synced, await byName(synced, 'Ada'), { Points: 5 }));
    expect(await syncNow(a)).toMatchObject({ ...quiet, writtenBack: 1 });
    expect((await byName(people, 'Ada')).fields[fieldId(people, 'Points')]).toBe(5);
    // The view sync, still one-way, takes it like any source change.
    expect(await syncNow(b)).toMatchObject({ ...quiet, updated: 1 });

    // Off again: one-way, read-only, no last applied values.
    const off = await ok<TableSync>(
      json('PATCH', `/api/tables/${a.tableId}/sync`, { twoWay: false })
    );
    expect(off).toMatchObject({ twoWay: false, writeBackFieldIds: [] });
    expect(await applied(a.id)).toBe(0);
    expect((await patch(synced, await byName(synced, 'Ada'), { Points: 6 })).status).toBe(403);
  });

  it("writes each side's changes to the other, the last update winning a field both changed", async () => {
    const tasks = await sourceTable(crm, 'Tasks', [
      { name: 'A', points: 1 },
      { name: 'B', points: 2 },
      { name: 'C', points: 3 },
    ]);
    const sync = await syncedFrom(tasks, { twoWay: true, keyFieldId: fieldId(tasks, 'Name') });
    expect(sync).toMatchObject({ twoWay: true });
    const synced = await meta(sync.tableId);
    expect(await applied(sync.id)).toBe(3);
    // The key is never written back; a field added here stays here.
    expect((await patch(synced, await byName(synced, 'A'), { Name: 'A2' })).status).toBe(403);
    await ok(
      json('POST', `/api/tables/${synced.id}/fields`, { name: 'Mine', type: 'number' }),
      201
    );
    const mine = await meta(synced.id);

    // Only this table changed: back to the source (a choice by its name too).
    await ok(patch(mine, await byName(mine, 'A'), { Points: 10, Status: 'Done', Mine: 7 }));
    // (A record written back isn't counted unchanged.)
    expect(await syncNow(sync)).toMatchObject({ ...quiet, writtenBack: 1, unchanged: 2 });
    expect(await cell(tasks, 'A')).toEqual([10, null, 'Done']);
    expect((await byName(tasks, 'A')).fields).not.toHaveProperty(fieldId(mine, 'Mine'));
    // Only the source changed: the synced record follows.
    await ok(patch(tasks, await byName(tasks, 'B'), { Notes: 'from the source' }));
    expect(await syncNow(sync)).toMatchObject({ ...quiet, updated: 1 });
    expect(await cell(synced, 'B')).toEqual([2, 'from the source', 'Todo']);

    // Both changed Points: the record updated last wins, this table's here…
    await ok(patch(tasks, await byName(tasks, 'C'), { Points: 30 }));
    await ok(patch(synced, await byName(synced, 'C'), { Points: 31 }));
    expect(await syncNow(sync)).toMatchObject({ ...quiet, writtenBack: 1 });
    expect([(await cell(tasks, 'C'))?.[0], (await cell(synced, 'C'))?.[0]]).toEqual([31, 31]);
    // …the source's here…
    await ok(patch(synced, await byName(synced, 'C'), { Points: 32 }));
    await ok(patch(tasks, await byName(tasks, 'C'), { Points: 33 }));
    expect(await syncNow(sync)).toMatchObject({ ...quiet, updated: 1 });
    expect([(await cell(tasks, 'C'))?.[0], (await cell(synced, 'C'))?.[0]]).toEqual([33, 33]);
    // …and the source's on a tie.
    await ok(patch(synced, await byName(synced, 'C'), { Points: 34 }));
    await ok(patch(tasks, await byName(tasks, 'C'), { Points: 35 }));
    const tie = '2026-11-01T12:00:00Z';
    await setUpdatedAt(synced.id, (await byName(synced, 'C')).id, tie);
    await setUpdatedAt(tasks.id, (await byName(tasks, 'C')).id, tie);
    expect(await syncNow(sync)).toMatchObject({ ...quiet, updated: 1 });
    expect([(await cell(tasks, 'C'))?.[0], (await cell(synced, 'C'))?.[0]]).toEqual([35, 35]);

    // Different fields of one record: each goes its own way, whichever record is newer.
    await ok(patch(synced, await byName(synced, 'A'), { Notes: 'from here' }));
    await ok(patch(tasks, await byName(tasks, 'A'), { Points: 11 }));
    expect(await syncNow(sync)).toMatchObject({ ...quiet, updated: 1, writtenBack: 1 });
    expect(await cell(tasks, 'A')).toEqual([11, 'from here', 'Done']);
    expect(await cell(synced, 'A')).toEqual([11, 'from here', 'Done']);

    // Converged: reruns write nothing on either side.
    const before = [await versions(tasks.id), await versions(synced.id)];
    expect(await syncNow(sync)).toMatchObject({ ...quiet, unchanged: 3 });
    expect(await syncNow(sync)).toMatchObject({ ...quiet, unchanged: 3 });
    expect([await versions(tasks.id), await versions(synced.id)]).toEqual(before);
  });

  it('deletes both ways, and never undoes a delete with an edit', async () => {
    const tasks = await sourceTable(crm, 'Chores', [
      { name: 'D', points: 1 },
      { name: 'E', points: 2 },
      { name: 'F', points: 3 },
    ]);
    const sync = await syncedFrom(tasks, { twoWay: true });
    const synced = await meta(sync.tableId);
    // Source deleted, synced record edited: the synced record goes, nothing is written back.
    await ok(patch(synced, await byName(synced, 'D'), { Points: 100 }));
    await ok(remove(tasks, await byName(tasks, 'D')), 204);
    // Synced record deleted, source edited: the source record goes, the synced one stays gone.
    await ok(patch(tasks, await byName(tasks, 'E'), { Points: 200 }));
    await ok(remove(synced, await byName(synced, 'E')), 204);
    expect(await syncNow(sync)).toMatchObject({
      ...quiet,
      deleted: 1,
      removedFromSource: 1,
      unchanged: 1,
    });
    expect(Object.keys(await cells(tasks))).toEqual(['F']);
    expect(Object.keys(await cells(synced))).toEqual(['F']);
    expect(await applied(sync.id)).toBe(1);
    expect(await syncNow(sync)).toMatchObject({ ...quiet, unchanged: 1 });
    // Restored from the trash before the next run: the delete is cancelled.
    const f = await byName(synced, 'F');
    await ok(remove(synced, f), 204);
    await ok(json('POST', `/api/tables/${synced.id}/records/restore`, { recordIds: [f.id] }));
    expect(await syncNow(sync)).toMatchObject({ ...quiet, unchanged: 1 });
    expect(Object.keys(await cells(tasks))).toEqual(['F']);
  });

  it('removes a record that leaves the view here only, and deletes through to the source', async () => {
    const tasks = await sourceTable(crm, 'Leads', [
      { name: 'G', points: 1 },
      { name: 'H', points: 2 },
    ]);
    const view = await ok<{ id: string }>(
      json('POST', `/api/tables/${tasks.id}/views`, { name: 'Scored' }),
      201
    );
    await ok(
      json('PATCH', `/api/views/${view.id}`, {
        query: {
          filter: {
            conjunction: 'and',
            conditions: [{ fieldId: fieldId(tasks, 'Points'), operator: '>', value: 0 }],
          },
        },
      })
    );
    const sync = await syncedFrom(tasks, {
      source: { baseId: crm.id, tableId: tasks.id, viewId: view.id },
      twoWay: true,
    });
    const synced = await meta(sync.tableId);
    // G leaves the view (edited here: written back, then filtered out at the next run).
    await ok(patch(synced, await byName(synced, 'G'), { Points: 0 }));
    expect(await syncNow(sync)).toMatchObject({ ...quiet, writtenBack: 1 });
    expect(await syncNow(sync)).toMatchObject({ ...quiet, deleted: 1, unchanged: 1 });
    expect(Object.keys(await cells(tasks)).sort()).toEqual(['G', 'H']);
    expect(Object.keys(await cells(synced))).toEqual(['H']);
    // Back in the view: synced again, not taken for a delete.
    await ok(patch(tasks, await byName(tasks, 'G'), { Points: 5 }));
    expect(await syncNow(sync)).toMatchObject({ ...quiet, created: 1, unchanged: 1 });
    // A record deleted here is deleted in the source table.
    await ok(remove(synced, await byName(synced, 'H')), 204);
    expect(await syncNow(sync)).toMatchObject({ ...quiet, removedFromSource: 1, unchanged: 1 });
    expect(Object.keys(await cells(tasks))).toEqual(['G']);
  });

  it('refuses two-way without edit rights on the source, and pauses when they go', async () => {
    // A creator here, an editor in another workspace's base holding the source.
    const other = await createWorkspace(t.db);
    const otherOwner = await createSession(t.db, other.owner);
    const theirs = await ok<Base>(
      json('POST', `/api/workspaces/${other.workspace.id}/bases`, { name: 'Partners' }, otherOwner),
      201
    );
    const deals = await sourceTable(
      theirs,
      'Deals',
      [
        { name: 'P', points: 1 },
        { name: 'Q', points: 2 },
        { name: 'R', points: 3 },
      ],
      otherOwner
    );
    const member = await addMember(t.db, workspaceId, 'creator');
    await addMember(t.db, other.workspace.id, 'read_only', member);
    const session = await createSession(t.db, member);
    const body = (twoWay: boolean) => ({
      source: { baseId: theirs.id, tableId: deals.id },
      schedule: 'manual',
      twoWay,
    });
    // Reading isn't enough to sync both ways; one way is fine.
    const refused = await problem(
      json('POST', `/api/bases/${reports.id}/syncs`, body(true), session),
      422
    );
    expect(refused.errors?.[0]).toMatchObject({ path: 'twoWay' });
    expect(refused.detail).toMatch(/edit the source's records/);
    const oneWay = await ok<TableSync>(
      json('POST', `/api/bases/${reports.id}/syncs`, body(false), session),
      201
    );
    await problem(
      json('PATCH', `/api/tables/${oneWay.tableId}/sync`, { twoWay: true }, session),
      422
    );
    // Nor is editing when the source table keeps record edits to its creators.
    const editorOf = async (role: 'editor' | 'read_only') =>
      t.db
        .update(workspaceMembers)
        .set({ role })
        .where(
          and(
            eq(workspaceMembers.workspaceId, other.workspace.id),
            eq(workspaceMembers.userId, member.id)
          )
        );
    await editorOf('editor');
    await ok(
      json(
        'PATCH',
        `/api/tables/${deals.id}`,
        { permissions: { editRecords: { level: 'creators' } } },
        otherOwner
      )
    );
    await problem(
      json('PATCH', `/api/tables/${oneWay.tableId}/sync`, { twoWay: true }, session),
      422
    );
    await ok(
      json(
        'PATCH',
        `/api/tables/${deals.id}`,
        { permissions: { editRecords: { level: 'editors' } } },
        otherOwner
      )
    );
    // An editor of the source may: the sync writes back as them.
    const sync = await ok<TableSync>(
      json('PATCH', `/api/tables/${oneWay.tableId}/sync`, { twoWay: true }, session)
    );
    expect(sync).toMatchObject({ twoWay: true, createdBy: member.id });
    // The sync's first run (queued when it was made) is two-way already.
    expect(await syncNow(sync, { as: session })).toMatchObject({ ...quiet, created: 3 });
    const synced = await meta(sync.tableId, session);
    await ok(patch(synced, await byName(synced, 'P', session), { Points: 10 }, session));
    expect(await syncNow(sync, { as: session })).toMatchObject({ ...quiet, writtenBack: 1 });
    expect((await byName(deals, 'P', otherOwner)).fields[fieldId(deals, 'Points')]).toBe(10);

    // Read-only there again: the next run pauses before writing anything.
    await editorOf('read_only');
    await ok(patch(synced, await byName(synced, 'Q', session), { Points: 20 }, session));
    expect(await syncNow(sync, { as: session })).toEqual({
      status: 'paused',
      reason: 'write_access_lost',
    });
    const paused = (await sources(sync.tableId, session))[0];
    expect(paused).toMatchObject({ status: 'paused', pauseReason: 'write_access_lost' });
    expect(paused?.runs[0]?.error).toMatch(/can no longer edit/);
    expect((await byName(deals, 'Q', otherOwner)).fields[fieldId(deals, 'Points')]).toBe(2);
    expect((await byName(synced, 'Q', session)).fields[fieldId(synced, 'Points')]).toBe(20);
    // Resuming two-way checks the same rules for whoever resumes it.
    await problem(
      json('PATCH', `/api/tables/${sync.tableId}/sync`, { paused: false }, session),
      422
    );

    // Editing is back, deleting isn't: Q's edit goes back, the delete here pauses the run at its
    // end, and none of that run's deletes happens on either side; the synced R stays deleted.
    await editorOf('editor');
    await ok(
      json(
        'PATCH',
        `/api/tables/${deals.id}`,
        { permissions: { deleteRecords: { level: 'creators' } } },
        otherOwner
      )
    );
    await ok(json('PATCH', `/api/tables/${sync.tableId}/sync`, { paused: false }, session));
    await ok(remove(synced, await byName(synced, 'R', session), session), 204);
    expect(await syncNow(sync, { as: session })).toEqual({
      status: 'paused',
      reason: 'write_access_lost',
    });
    expect(await cells(deals, otherOwner)).toEqual({
      P: [10, null, 'Todo'],
      Q: [20, null, 'Todo'],
      R: [3, null, 'Todo'],
    });
    expect(Object.keys(await cells(synced, session)).sort()).toEqual(['P', 'Q']);
    // Allowed again: the run deletes R in the source, then writes nothing.
    await ok(
      json(
        'PATCH',
        `/api/tables/${deals.id}`,
        { permissions: { deleteRecords: { level: 'editors' } } },
        otherOwner
      )
    );
    await ok(json('PATCH', `/api/tables/${sync.tableId}/sync`, { paused: false }, session));
    expect(await syncNow(sync, { as: session })).toMatchObject({
      ...quiet,
      removedFromSource: 1,
      unchanged: 2,
    });
    expect(await cells(deals, otherOwner)).toEqual({
      P: [10, null, 'Todo'],
      Q: [20, null, 'Todo'],
    });
    expect(await syncNow(sync, { as: session })).toMatchObject({ ...quiet, unchanged: 2 });
  });

  it('pauses mid-run on a field the creator may not edit, then converges', async () => {
    const tasks = await sourceTable(crm, 'Orders', [
      { name: 'S', points: 1 },
      { name: 'T', points: 2 },
      { name: 'U', points: 3 },
    ]);
    const sync = await syncedFrom(tasks, { twoWay: true });
    const synced = await meta(sync.tableId);
    const member = await addMember(t.db, workspaceId, 'editor');
    await t.db.update(tableSyncs).set({ createdBy: member.id }).where(eq(tableSyncs.id, sync.id));
    await ok(
      json('PATCH', `/api/fields/${fieldId(tasks, 'Notes')}`, {
        permissions: { edit: { level: 'creators' } },
      })
    );
    // In batches of one: S's Points go back, T's Notes can't, U's delete waits for the end.
    await ok(patch(synced, await byName(synced, 'S'), { Points: 10 }));
    await ok(patch(synced, await byName(synced, 'T'), { Notes: 'no' }));
    await ok(remove(synced, await byName(synced, 'U')), 204);
    expect(await syncNow(sync, { batchSize: 1 })).toEqual({
      status: 'paused',
      reason: 'write_access_lost',
    });
    expect(await cells(tasks)).toEqual({
      S: [10, null, 'Todo'],
      T: [2, null, 'Todo'],
      U: [3, null, 'Todo'],
    });
    await ok(
      json('PATCH', `/api/fields/${fieldId(tasks, 'Notes')}`, {
        permissions: { edit: { level: 'editors' } },
      })
    );
    // Resumed by the owner (who becomes its creator), it converges and then stays quiet.
    await ok(json('PATCH', `/api/tables/${sync.tableId}/sync`, { paused: false }));
    expect(await syncNow(sync, { batchSize: 1 })).toMatchObject({
      ...quiet,
      writtenBack: 1,
      removedFromSource: 1,
      unchanged: 1,
    });
    expect(await cells(tasks)).toEqual({ S: [10, null, 'Todo'], T: [2, 'no', 'Todo'] });
    expect(await syncNow(sync)).toMatchObject({ ...quiet, unchanged: 2 });
  });

  it('refuses sources that can only sync one way, and loops', async () => {
    const plain = await sourceTable(crm, 'Plain', [{ name: 'V', points: 1 }]);
    const csv = await problem(
      json('POST', `/api/bases/${reports.id}/syncs`, {
        source: { kind: 'csv', url: 'https://example.com/a.csv' },
        columns: [{ name: 'id' }],
        twoWay: true,
      }),
      422
    );
    expect(csv.detail).toMatch(/Only a table or view/);
    // A synced table is never a source.
    const first = await syncedFrom(plain, { twoWay: true });
    expect(
      (
        await json('POST', `/api/bases/${reports.id}/syncs`, {
          source: { baseId: reports.id, tableId: first.tableId },
          twoWay: true,
        })
      ).status
    ).toBe(422);
    // One two-way sync per pair of tables: not a second one into the same table.
    const again = await problem(
      json('POST', `/api/tables/${first.tableId}/syncs`, {
        source: { baseId: crm.id, tableId: plain.id },
        schedule: 'manual',
        twoWay: true,
      }),
      422
    );
    expect(again.detail).toMatch(/already joined by a two-way sync/);
    // A table with itself, and a chain closing on itself (rows set up directly: the API never
    // makes a synced table a source).
    const other = await sourceTable(crm, 'Other', [{ name: 'W' }]);
    const loose = await syncedFrom(other);
    const self = await syncedFrom(other);
    await t.db
      .update(tableSyncs)
      .set({ sourceTableId: self.tableId, sourceBaseId: reports.id })
      .where(eq(tableSyncs.id, self.id));
    expect(
      (await problem(json('PATCH', `/api/tables/${self.tableId}/sync`, { twoWay: true }), 422))
        .detail
    ).toMatch(/with itself/);
    // Two tables synced both ways with Plain may not also sync both ways with each other.
    const fanOut = await syncedFrom(plain, { twoWay: true });
    await t.db
      .update(tableSyncs)
      .set({ tableId: fanOut.tableId, sourceTableId: first.tableId, sourceBaseId: reports.id })
      .where(eq(tableSyncs.id, loose.id));
    expect(
      (
        await problem(
          json('PATCH', `/api/tables/${fanOut.tableId}/syncs/${loose.id}`, { twoWay: true }),
          422
        )
      ).detail
    ).toMatch(/already joined/);
  });

  it("doesn't bounce a write-back between two tables synced both ways with one source", async () => {
    const shared = await sourceTable(crm, 'Shared', [
      { name: 'X', points: 1 },
      { name: 'Y', points: 2 },
    ]);
    const left = await syncedFrom(shared, { twoWay: true });
    const right = await syncedFrom(shared, { twoWay: true });
    const leftTable = await meta(left.tableId);
    const rightTable = await meta(right.tableId);
    await ok(patch(leftTable, await byName(leftTable, 'X'), { Points: 10 }));
    expect(await syncNow(left)).toMatchObject({ ...quiet, writtenBack: 1, unchanged: 1 });
    const sourceVersions = await versions(shared.id);
    // The write-back is a source change for the other table, and nothing more for anyone.
    expect(await syncNow(right)).toMatchObject({ ...quiet, updated: 1, unchanged: 1 });
    expect(await syncNow(left)).toMatchObject({ ...quiet, unchanged: 2 });
    expect(await syncNow(right)).toMatchObject({ ...quiet, unchanged: 2 });
    expect(await versions(shared.id)).toEqual(sourceVersions);
    expect((await cell(rightTable, 'X'))?.[0]).toBe(10);
  });

  it("writes back only a two-way source's own records on a table with several sources", async () => {
    const north = await sourceTable(crm, 'North', [{ name: 'K', points: 1 }]);
    const south = await sourceTable(crm, 'South', [{ name: 'K', points: 5 }]);
    const first = await syncedFrom(north, { keyFieldId: fieldId(north, 'Name') });
    const table = await meta(first.tableId);
    const second = await ok<TableSync>(
      json('POST', `/api/tables/${first.tableId}/syncs`, {
        source: { baseId: crm.id, tableId: south.id },
        keyFieldId: fieldId(south, 'Name'),
        schedule: 'manual',
        twoWay: true,
        targets: [{ sourceFieldId: fieldId(south, 'Points'), fieldId: fieldId(table, 'Points') }],
      }),
      201
    );
    expect(await syncNow(second)).toMatchObject({ ...quiet, created: 1 });
    const all = await meta(first.tableId);
    const ownerField = fieldId(all, 'Sync source ID');
    const rows = await records(all.id);
    const mine = rows.find((r) => r.fields[ownerField] === second.id);
    const theirs = rows.find((r) => r.id !== mine?.id);
    if (!mine || !theirs) throw new Error('records missing');
    // The one-way source's record stays read-only, the two-way one's opens.
    expect((await patch(all, theirs, { Points: 2 })).status).toBe(403);
    expect((await remove(all, theirs)).status).toBe(403);
    await ok(patch(all, mine, { Points: 6 }));
    expect(await syncNow(second)).toMatchObject({ ...quiet, writtenBack: 1 });
    expect(await syncNow(first)).toMatchObject({ ...quiet, unchanged: 1 });
    expect((await cell(south, 'K'))?.[0]).toBe(6);
    expect((await cell(north, 'K'))?.[0]).toBe(1);
  });
});
