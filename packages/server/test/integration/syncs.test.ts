import type { Base, RecordData as RecordT, TableMeta, TableSync } from '@openrows/shared';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { tableSyncs, workspaceMembers } from '../../src/db/index.js';
import { ossEntitlements } from '../../src/edition/oss.js';
import type { EntitlementsProvider } from '../../src/edition/types.js';
import { runSyncJob, type SyncRunDeps, syncRunLockName } from '../../src/syncs/run.js';
import { scheduleDueSyncs } from '../../src/syncs/service.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, createSession, createWorkspace } from '../helpers/factories.js';

/**
 * Synced tables: a table synced one way from another table or view the creator can read.
 * Runs are idempotent (a second run over an unchanged source writes nothing), synced cells and
 * records can't be edited by hand (local fields can), and lost access or a deleted source pauses
 * the sync without touching its records.
 */
describe('synced tables', () => {
  const t = useTestDb();
  let app: ReturnType<typeof testApp>['app'];
  let owner: string;
  let editor: string;
  let workspaceId: string;
  let source: Base;
  let target: Base;
  let tasks: TableMeta;
  let otherOwner: string;
  let otherWorkspaceId: string;
  let ownerId: string;

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
  const fieldId = (table: TableMeta, name: string) => {
    const f = table.fields.find((x) => x.name === name);
    if (!f) throw new Error(`no field ${name}`);
    return f.id;
  };
  const records = async (tableId: string) =>
    (await ok<{ records: RecordT[] }>(json('GET', `/api/tables/${tableId}/records?limit=1000`)))
      .records;
  /** Runs the sync's queued run the way the worker does. */
  async function run(sync: TableSync) {
    const current = await ok<TableSync>(json('GET', `/api/tables/${sync.tableId}/sync`));
    const queued = current.runs.find((r) => r.status === 'queued');
    if (!queued) throw new Error('no queued run');
    return runSyncJob(
      { db: t.appDb },
      { workspaceId: workspaceOf(sync), syncId: sync.id, runId: queued.id }
    );
  }
  const homes = new Map<string, string>();
  const workspaceOf = (sync: TableSync) => homes.get(sync.id) ?? workspaceId;
  async function syncNow(sync: TableSync) {
    await ok<TableSync>(json('POST', `/api/tables/${sync.tableId}/sync/run`));
    return run(sync);
  }
  /** "Sync now", run with the engine's limits changed (a lower cap, smaller batches). */
  async function syncNowWith(
    sync: TableSync,
    limits: Pick<SyncRunDeps, 'maxRecords' | 'batchSize'>
  ) {
    const current = await ok<TableSync>(json('POST', `/api/tables/${sync.tableId}/sync/run`));
    const queued = current.runs.find((r) => r.status === 'queued');
    if (!queued) throw new Error('no queued run');
    return runSyncJob(
      { db: t.appDb, ...limits },
      { workspaceId: workspaceOf(sync), syncId: sync.id, runId: queued.id }
    );
  }
  /** The table's live records, counted. */
  const total = async (tableId: string) =>
    (
      await ok<{ total: number }>(
        json('POST', `/api/tables/${tableId}/records/query`, { limit: 1, count: true })
      )
    ).total;
  const names = async (table: TableMeta) =>
    (await records(table.id)).map((r) => r.fields[fieldId(table, 'Name')]).sort();

  beforeAll(async () => {
    ({ app } = testApp({ db: t.appDb }));
    const ws = await createWorkspace(t.db);
    workspaceId = ws.workspace.id;
    ownerId = ws.owner.id;
    owner = await createSession(t.db, ws.owner);
    editor = await createSession(t.db, await addMember(t.db, workspaceId, 'editor'));
    source = await ok<Base>(
      json('POST', `/api/workspaces/${workspaceId}/bases`, { name: 'CRM' }),
      201
    );
    target = await ok<Base>(
      json('POST', `/api/workspaces/${workspaceId}/bases`, { name: 'Reports' }),
      201
    );
    tasks = await ok<TableMeta>(
      json('POST', `/api/bases/${source.id}/tables`, { name: 'Tasks' }),
      201
    );
    await ok(
      json('POST', `/api/tables/${tasks.id}/fields`, { name: 'Points', type: 'number' }),
      201
    );
    tasks = await ok<TableMeta>(json('GET', `/api/tables/${tasks.id}`));
    await ok(
      json('POST', `/api/tables/${tasks.id}/records`, {
        typecast: true,
        records: [
          {
            fields: {
              [fieldId(tasks, 'Name')]: 'Write spec',
              [fieldId(tasks, 'Status')]: 'Todo',
              [fieldId(tasks, 'Points')]: 3,
            },
          },
          {
            fields: {
              [fieldId(tasks, 'Name')]: 'Ship it',
              [fieldId(tasks, 'Status')]: 'Done',
              [fieldId(tasks, 'Points')]: 5,
            },
          },
        ],
      }),
      201
    );
    const other = await createWorkspace(t.db);
    otherWorkspaceId = other.workspace.id;
    otherOwner = await createSession(t.db, other.owner);
  });

  it('copies a table, re-runs idempotently and follows the source', async () => {
    const sync = await ok<TableSync>(
      json('POST', `/api/bases/${target.id}/syncs`, {
        source: { baseId: source.id, tableId: tasks.id },
        schedule: 'manual',
      }),
      201
    );
    expect(sync).toMatchObject({ schedule: 'manual', status: 'active', canManage: true });
    expect(sync.source.label).toBe('CRM / Tasks');
    expect(sync.runs).toHaveLength(1);
    expect(sync.runs[0]).toMatchObject({ trigger: 'create', status: 'queued' });
    const table = await ok<TableMeta>(json('GET', `/api/tables/${sync.tableId}`));
    expect(table.synced).toBe(true);
    expect(table.name).toBe('Tasks');
    expect(table.fields.map((f) => [f.name, f.type, f.synced])).toEqual([
      ['Name', 'singleLineText', true],
      ['Notes', 'longText', true],
      ['Status', 'singleSelect', true],
      ['Points', 'number', true],
      ['Sync source', 'syncSource', true],
    ]);

    expect(await run(sync)).toMatchObject({ status: 'succeeded', created: 2, updated: 0 });
    const first = await records(sync.tableId);
    expect(first.map((r) => r.fields[fieldId(table, 'Name')]).sort()).toEqual([
      'Ship it',
      'Write spec',
    ]);
    const statusOptions = table.fields.find((f) => f.name === 'Status')?.options as {
      choices: { id: string; name: string }[];
    };
    const done = statusOptions.choices.find((c) => c.name === 'Done')?.id;
    expect(first.find((r) => r.fields[fieldId(table, 'Name')] === 'Ship it')?.fields).toMatchObject(
      {
        [fieldId(table, 'Status')]: done,
        [fieldId(table, 'Points')]: 5,
      }
    );
    const sourceIds = (await records(tasks.id)).map((r) => r.id).sort();
    expect(first.map((r) => r.fields[fieldId(table, 'Sync source')]).sort()).toEqual(sourceIds);

    // Again, unchanged: nothing is written, no version moves.
    expect(await syncNow(sync)).toMatchObject({
      status: 'succeeded',
      created: 0,
      updated: 0,
      deleted: 0,
      unchanged: 2,
    });
    const second = await records(sync.tableId);
    expect(second.map((r) => [r.id, r.version])).toEqual(first.map((r) => [r.id, r.version]));

    // The source changes: an edit, a new record with a new option, a deletion.
    const src = await records(tasks.id);
    const spec = src.find((r) => r.fields[fieldId(tasks, 'Name')] === 'Write spec');
    const ship = src.find((r) => r.fields[fieldId(tasks, 'Name')] === 'Ship it');
    if (!spec || !ship) throw new Error('source records');
    await ok(
      json('PATCH', `/api/tables/${tasks.id}/records/${spec.id}`, {
        fields: { [fieldId(tasks, 'Points')]: 8 },
      })
    );
    await ok(json('DELETE', `/api/tables/${tasks.id}/records/${ship.id}`), 204);
    await ok(
      json('POST', `/api/tables/${tasks.id}/records`, {
        typecast: true,
        fields: { [fieldId(tasks, 'Name')]: 'Review', [fieldId(tasks, 'Status')]: 'Blocked' },
      }),
      201
    );
    expect(await syncNow(sync)).toMatchObject({
      status: 'succeeded',
      created: 1,
      updated: 1,
      deleted: 1,
      unchanged: 0,
    });
    const after = await ok<TableMeta>(json('GET', `/api/tables/${sync.tableId}`));
    const blocked = (
      (after.fields.find((f) => f.name === 'Status')?.options ?? { choices: [] }) as {
        choices: { id: string; name: string }[];
      }
    ).choices.find((c) => c.name === 'Blocked');
    expect(blocked).toBeDefined();
    const third = await records(sync.tableId);
    expect(
      third
        .map((r) => [r.fields[fieldId(after, 'Name')], r.fields[fieldId(after, 'Points')] ?? null])
        .sort()
    ).toEqual([
      ['Review', null],
      ['Write spec', 8],
    ]);
    expect(await syncNow(sync)).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 2 });
  });

  it('refuses edits of synced cells and records, but local fields stay editable', async () => {
    const sync = await ok<TableSync>(
      json('POST', `/api/bases/${target.id}/syncs`, {
        name: 'Tasks mirror',
        source: { baseId: source.id, tableId: tasks.id },
        schedule: 'manual',
      }),
      201
    );
    await run(sync);
    let table = await ok<TableMeta>(json('GET', `/api/tables/${sync.tableId}`));
    const [one] = await records(sync.tableId);
    if (!one) throw new Error('no synced record');
    const patch = await json('PATCH', `/api/tables/${sync.tableId}/records/${one.id}`, {
      fields: { [fieldId(table, 'Name')]: 'Hacked' },
    });
    expect(patch.status).toBe(403);
    expect(((await patch.json()) as { code: string }).code).toBe('EDIT_RESTRICTED');
    const add = await json('POST', `/api/tables/${sync.tableId}/records`, { fields: {} });
    expect(add.status).toBe(403);
    expect((await json('DELETE', `/api/tables/${sync.tableId}/records/${one.id}`)).status).toBe(
      403
    );
    const keyEdit = await json('PATCH', `/api/tables/${sync.tableId}/records/${one.id}`, {
      fields: { [fieldId(table, 'Sync source')]: 'x' },
    });
    expect([403, 422]).toContain(keyEdit.status);
    // Synced fields keep the source's type; the sync source field stays.
    const convert = await json('PATCH', `/api/fields/${fieldId(table, 'Points')}`, {
      type: 'singleLineText',
    });
    expect(convert.status).toBe(409);
    expect((await json('DELETE', `/api/fields/${fieldId(table, 'Sync source')}`)).status).toBe(409);
    // Renaming a synced field is fine.
    await ok(json('PATCH', `/api/fields/${fieldId(table, 'Notes')}`, { name: 'Details' }));
    // Nobody adds a sync source field by hand.
    const manual = await json('POST', `/api/tables/${tasks.id}/fields`, {
      name: 'Origin',
      type: 'syncSource',
    });
    expect(manual.status).toBe(422);

    // A local field: editable, and kept across runs.
    await ok(
      json('POST', `/api/tables/${sync.tableId}/fields`, {
        name: 'Comment',
        type: 'singleLineText',
      }),
      201
    );
    table = await ok<TableMeta>(json('GET', `/api/tables/${sync.tableId}`));
    await ok(
      json(
        'PATCH',
        `/api/tables/${sync.tableId}/records/${one.id}`,
        { fields: { [fieldId(table, 'Comment')]: 'mine' } },
        editor
      )
    );
    expect(await syncNow(sync)).toMatchObject({ status: 'succeeded', updated: 0, deleted: 0 });
    const kept = (await records(sync.tableId)).find((r) => r.id === one.id);
    expect(kept?.fields[fieldId(table, 'Comment')]).toBe('mine');

    // Editors sync now, but can't change or remove the sync.
    expect(
      (await json('POST', `/api/tables/${sync.tableId}/sync/run`, undefined, editor)).status
    ).toBe(200);
    expect(
      (await json('PATCH', `/api/tables/${sync.tableId}/sync`, { schedule: 'daily' }, editor))
        .status
    ).toBe(403);
    // Sync now twice: one queued run.
    const twice = await ok<TableSync>(json('POST', `/api/tables/${sync.tableId}/sync/run`));
    expect(twice.runs.filter((r) => r.status === 'queued')).toHaveLength(1);
    await run(sync);

    // Stop syncing: an ordinary table again.
    await ok(json('DELETE', `/api/tables/${sync.tableId}/sync`), 204);
    const plain = await ok<TableMeta>(json('GET', `/api/tables/${sync.tableId}`));
    expect(plain.synced).toBeUndefined();
    await ok(
      json('PATCH', `/api/tables/${sync.tableId}/records/${one.id}`, {
        fields: { [fieldId(plain, 'Name')]: 'Mine now' },
      })
    );
    expect((await json('GET', `/api/tables/${sync.tableId}/sync`)).status).toBe(404);
    // Its "Sync source" field stays as read-only text: copied by a duplicate, and deletable now.
    const copy = await ok<TableMeta>(
      json('POST', `/api/tables/${sync.tableId}/duplicate`, { includeRecords: true }),
      201
    );
    expect(copy.synced).toBeUndefined();
    expect(copy.fields.find((f) => f.type === 'syncSource')?.synced).toBeUndefined();
    const copied = await records(copy.id);
    expect(copied.map((r) => r.fields[fieldId(copy, 'Sync source')]).sort()).toEqual(
      (await records(sync.tableId)).map((r) => r.fields[fieldId(plain, 'Sync source')]).sort()
    );
    await ok(json('DELETE', `/api/fields/${fieldId(plain, 'Sync source')}`), 204);
  });

  it("syncs a view's records only, keyed by a field", async () => {
    const view = await ok<{ id: string }>(
      json('POST', `/api/tables/${tasks.id}/views`, { name: 'Open' }),
      201
    );
    await ok(
      json('PATCH', `/api/views/${view.id}`, {
        query: {
          filter: {
            conjunction: 'and',
            conditions: [{ fieldId: fieldId(tasks, 'Name'), operator: 'is', value: 'Review' }],
          },
        },
      })
    );
    const sync = await ok<TableSync>(
      json('POST', `/api/bases/${target.id}/syncs`, {
        name: 'Open tasks',
        source: { baseId: source.id, tableId: tasks.id, viewId: view.id },
        fieldIds: [fieldId(tasks, 'Points')],
        keyFieldId: fieldId(tasks, 'Name'),
      }),
      201
    );
    expect(sync.source.label).toBe('CRM / Tasks / Open');
    expect(sync.schedule).toBe('hourly');
    expect(sync.nextRunAt).not.toBeNull();
    await run(sync);
    const table = await ok<TableMeta>(json('GET', `/api/tables/${sync.tableId}`));
    expect(table.fields.map((f) => f.name)).toEqual(['Name', 'Points', 'Sync source']);
    const rows = await records(sync.tableId);
    expect(rows.map((r) => r.fields[fieldId(table, 'Sync source')])).toEqual(['Review']);
    // A view of another table, or a field that isn't the source's: refused.
    const bad = await json('POST', `/api/bases/${target.id}/syncs`, {
      source: { baseId: source.id, tableId: tasks.id },
      fieldIds: [fieldId(table, 'Points')],
    });
    expect(bad.status).toBe(422);
  });

  it('crosses workspaces only for members of both, and pauses when access goes', async () => {
    // The other workspace's owner can't read this workspace's table.
    const theirs = await ok<Base>(
      json('POST', `/api/workspaces/${otherWorkspaceId}/bases`, { name: 'Theirs' }, otherOwner),
      201
    );
    const refused = await json(
      'POST',
      `/api/bases/${theirs.id}/syncs`,
      { source: { baseId: source.id, tableId: tasks.id } },
      otherOwner
    );
    expect(refused.status).toBe(404);
    // A member of both can.
    const both = await addMember(t.db, otherWorkspaceId, 'creator');
    await t.db.insert(workspaceMembers).values({ workspaceId, userId: both.id, role: 'read_only' });
    const bothSession = await createSession(t.db, both);
    const sync = await ok<TableSync>(
      json(
        'POST',
        `/api/bases/${theirs.id}/syncs`,
        { source: { baseId: source.id, tableId: tasks.id }, schedule: '5m' },
        bothSession
      ),
      201
    );
    homes.set(sync.id, otherWorkspaceId);
    expect(sync.source.workspaceId).toBe(workspaceId);
    const queued = sync.runs[0];
    if (!queued) throw new Error('no run');
    expect(
      await runSyncJob(
        { db: t.appDb },
        { workspaceId: otherWorkspaceId, syncId: sync.id, runId: queued.id }
      )
    ).toMatchObject({ status: 'succeeded', created: 2 });
    const before = await ok<{ records: RecordT[] }>(
      json('GET', `/api/tables/${sync.tableId}/records`, undefined, bothSession)
    );

    // Access to the source goes: the next run pauses and writes nothing.
    await t.db.delete(workspaceMembers).where(eq(workspaceMembers.userId, both.id));
    await t.db
      .insert(workspaceMembers)
      .values({ workspaceId: otherWorkspaceId, userId: both.id, role: 'creator' });
    await ok(
      json('PATCH', `/api/tables/${tasks.id}/records/${(await records(tasks.id))[0]?.id}`, {
        fields: { [fieldId(tasks, 'Points')]: 99 },
      })
    );
    await t.db
      .update(tableSyncs)
      .set({ nextRunAt: new Date(Date.now() - 1000) })
      .where(eq(tableSyncs.id, sync.id));
    const sent: unknown[] = [];
    const jobs = {
      send: async (_tx: unknown, queue: string, data: unknown) => {
        sent.push({ queue, data });
        return 'job';
      },
      stop: async () => {},
    };
    expect((await scheduleDueSyncs(t.appDb, jobs)).queued).toBeGreaterThanOrEqual(1);
    const job = sent.find((s) => (s as { data: { syncId: string } }).data.syncId === sync.id) as
      | { data: { runId: string } }
      | undefined;
    if (!job) throw new Error('the scheduler queued nothing');
    expect(
      await runSyncJob(
        { db: t.appDb },
        { workspaceId: otherWorkspaceId, syncId: sync.id, runId: job.data.runId }
      )
    ).toEqual({ status: 'paused', reason: 'access_lost' });
    const status = await ok<TableSync>(
      json('GET', `/api/tables/${sync.tableId}/sync`, undefined, bothSession)
    );
    expect(status).toMatchObject({ status: 'paused', pauseReason: 'access_lost' });
    expect(status.runs[0]).toMatchObject({ status: 'paused' });
    const afterRecords = await ok<{ records: RecordT[] }>(
      json('GET', `/api/tables/${sync.tableId}/records`, undefined, bothSession)
    );
    expect(afterRecords.records).toEqual(before.records);
    // Paused: sync now is refused, and the scheduler leaves it alone.
    expect(
      (await json('POST', `/api/tables/${sync.tableId}/sync/run`, undefined, bothSession)).status
    ).toBe(409);
    sent.length = 0;
    await t.db
      .update(tableSyncs)
      .set({ nextRunAt: new Date(Date.now() - 1000) })
      .where(eq(tableSyncs.id, sync.id));
    await scheduleDueSyncs(t.appDb, jobs);
    expect(sent.filter((s) => (s as { data: { syncId: string } }).data.syncId === sync.id)).toEqual(
      []
    );
  });

  it('syncs a table past 10,000 records, re-runs as a no-op and pauses past the cap', {
    timeout: 180_000,
  }, async () => {
    const many = await ok<TableMeta>(
      json('POST', `/api/bases/${source.id}/tables`, { name: 'Many' }),
      201
    );
    const name = fieldId(many, 'Name');
    for (let i = 0; i < 10_001; i += 1000) {
      const count = Math.min(1000, 10_001 - i);
      await ok(
        json('POST', `/api/tables/${many.id}/records`, {
          records: Array.from({ length: count }, (_, j) => ({
            fields: { [name]: `Item ${i + j}` },
          })),
        }),
        201
      );
    }
    const sync = await ok<TableSync>(
      json('POST', `/api/bases/${target.id}/syncs`, {
        source: { baseId: source.id, tableId: many.id },
        schedule: 'manual',
      }),
      201
    );
    expect(await run(sync)).toEqual({
      status: 'succeeded',
      created: 10_001,
      updated: 0,
      deleted: 0,
      unchanged: 0,
      skipped: 0,
    });
    expect(await total(sync.tableId)).toBe(10_001);
    const first = await records(sync.tableId);

    // Again, unchanged: nothing is written, no version moves.
    expect(await syncNow(sync)).toMatchObject({
      status: 'succeeded',
      created: 0,
      updated: 0,
      deleted: 0,
      unchanged: 10_001,
    });
    expect((await records(sync.tableId)).map((r) => [r.id, r.version])).toEqual(
      first.map((r) => [r.id, r.version])
    );

    // One edit and one deletion in the source: only those are written.
    const [edited, removed] = await records(many.id);
    if (!edited || !removed) throw new Error('source records');
    await ok(
      json('PATCH', `/api/tables/${many.id}/records/${edited.id}`, {
        fields: { [name]: 'Edited' },
      })
    );
    await ok(json('DELETE', `/api/tables/${many.id}/records/${removed.id}`), 204);
    expect(await syncNow(sync)).toMatchObject({
      status: 'succeeded',
      created: 0,
      updated: 1,
      deleted: 1,
      unchanged: 9_999,
    });
    expect(await total(sync.tableId)).toBe(10_000);

    // Past the cap (lowered here): the sync pauses and keeps its records.
    expect(await syncNowWith(sync, { maxRecords: 9_999 })).toEqual({
      status: 'paused',
      reason: 'too_many_records',
    });
    expect(await total(sync.tableId)).toBe(10_000);
    const paused = await ok<TableSync>(json('GET', `/api/tables/${sync.tableId}/sync`));
    expect(paused).toMatchObject({ status: 'paused', pauseReason: 'too_many_records' });
  });

  it("deletes nothing when a run fails midway on the creator's permissions, then converges", async () => {
    const items = await ok<TableMeta>(
      json('POST', `/api/bases/${source.id}/tables`, { name: 'Items' }),
      201
    );
    const name = fieldId(items, 'Name');
    await ok(
      json('POST', `/api/tables/${items.id}/records`, {
        records: [1, 2, 3, 4].map((n) => ({ fields: { [name]: `Item ${n}` } })),
      }),
      201
    );
    const sync = await ok<TableSync>(
      json('POST', `/api/bases/${target.id}/syncs`, {
        source: { baseId: source.id, tableId: items.id },
        schedule: 'manual',
      }),
      201
    );
    expect(await run(sync)).toMatchObject({ status: 'succeeded', created: 4 });
    const synced = await ok<TableMeta>(json('GET', `/api/tables/${sync.tableId}`));

    // The source changes: an edit early in its order, a deletion, two new records at its end.
    const src = await records(items.id);
    const byName = (n: string) => src.find((r) => r.fields[name] === n)?.id;
    await ok(
      json('PATCH', `/api/tables/${items.id}/records/${byName('Item 1')}`, {
        fields: { [name]: 'Item 1 (edited)' },
      })
    );
    await ok(json('DELETE', `/api/tables/${items.id}/records/${byName('Item 2')}`), 204);
    await ok(
      json('POST', `/api/tables/${items.id}/records`, {
        records: [5, 6].map((n) => ({ fields: { [name]: `Item ${n}` } })),
      }),
      201
    );
    // Nobody may add records to the synced table, its sync's creator included: in batches of 2,
    // the first (the edit) is written, the second (a new record) fails the run.
    await ok(
      json('PATCH', `/api/tables/${sync.tableId}`, {
        permissions: { addRecords: { level: 'nobody' } },
      })
    );
    const failed = await syncNowWith(sync, { batchSize: 2 });
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed.status === 'failed' && failed.error).toMatch(/permission to add records/);
    // The record that left the source is still there: deletes only follow a whole read.
    expect(await names(synced)).toEqual(['Item 1 (edited)', 'Item 2', 'Item 3', 'Item 4']);
    const status = await ok<TableSync>(json('GET', `/api/tables/${sync.tableId}/sync`));
    expect(status).toMatchObject({ status: 'active', lastSyncedAt: expect.any(String) });
    expect(status.runs[0]).toMatchObject({ status: 'failed' });

    // Allowed again, the next run converges, and the one after writes nothing.
    await ok(
      json('PATCH', `/api/tables/${sync.tableId}`, {
        permissions: { addRecords: { level: 'editors' } },
      })
    );
    expect(await syncNowWith(sync, { batchSize: 2 })).toMatchObject({
      status: 'succeeded',
      created: 2,
      updated: 0,
      deleted: 1,
      unchanged: 3,
    });
    expect(await names(synced)).toEqual([
      'Item 1 (edited)',
      'Item 3',
      'Item 4',
      'Item 5',
      'Item 6',
    ]);
    expect(await syncNow(sync)).toMatchObject({ status: 'succeeded', unchanged: 5, updated: 0 });
  });

  it('runs a sync once at a time: an attempt waits while another holds it', async () => {
    const sync = await ok<TableSync>(
      json('POST', `/api/bases/${target.id}/syncs`, {
        name: 'One at a time',
        source: { baseId: source.id, tableId: tasks.id },
        schedule: 'manual',
      }),
      201
    );
    const holder = new pg.Client({ connectionString: t.url });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        syncRunLockName(sync.id),
      ]);
      const queued = sync.runs[0];
      if (!queued) throw new Error('no run');
      expect(
        await runSyncJob({ db: t.appDb }, { workspaceId, syncId: sync.id, runId: queued.id })
      ).toEqual({ status: 'busy' });
      // Left as it was, for the attempt that holds it.
      const waiting = await ok<TableSync>(json('GET', `/api/tables/${sync.tableId}/sync`));
      expect(waiting.runs[0]).toMatchObject({ id: queued.id, status: 'queued' });
      expect(await total(sync.tableId)).toBe(0);
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
    expect(await run(sync)).toMatchObject({ status: 'succeeded' });
  });

  it('runs on one connection with no transaction open between batches; a lost one frees the sync', async () => {
    const items = await ok<TableMeta>(
      json('POST', `/api/bases/${source.id}/tables`, { name: 'Batched' }),
      201
    );
    const name = fieldId(items, 'Name');
    await ok(
      json('POST', `/api/tables/${items.id}/records`, {
        records: [1, 2, 3, 4, 5].map((n) => ({ fields: { [name]: `Row ${n}` } })),
      }),
      201
    );
    const sync = await ok<TableSync>(
      json('POST', `/api/bases/${target.id}/syncs`, {
        source: { baseId: source.id, tableId: items.id },
        schedule: 'manual',
      }),
      201
    );
    const queued = sync.runs[0];
    if (!queued) throw new Error('no run');
    // Seen from outside, in this file's database only (the other test files share the server):
    // the backends holding this sync's run lock (a bigint key: classid is its high half, objid its
    // low half), and the client backends with a transaction open, the observer's own left out.
    const lockName = syncRunLockName(sync.id);
    const observe = async () => {
      const [row] = (
        await t.db.execute<{ holders: number[]; open: number[] }>(sql`
          SELECT
            (SELECT coalesce(array_agg(l.pid ORDER BY l.pid), '{}')
               FROM pg_locks l
              WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
                AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
                AND ((l.classid::int8 << 32) | l.objid::int8) = hashtextextended(${lockName}, 0)
            ) AS holders,
            (SELECT coalesce(array_agg(a.pid ORDER BY a.pid), '{}')
               FROM pg_stat_activity a
              WHERE a.datname = current_database() AND a.backend_type = 'client backend'
                AND a.xact_start IS NOT NULL AND a.pid <> pg_backend_pid()
            ) AS open`)
      ).rows;
      if (!row) throw new Error('nothing observed');
      return row;
    };
    // In each batch: the backends holding the sync's lock, whether the batch's own backend is the
    // only one and the only one with a transaction open, and when the batch's transaction began.
    const seen: { holders: number; ownTransactionOnly: boolean }[] = [];
    const began: string[] = [];
    let kill = false;
    const entitlements: EntitlementsProvider = {
      ...ossEntitlements,
      forWorkspace: async (id, tx) => {
        const [own] = (
          await tx.execute<{ pid: number; began: string }>(
            sql`SELECT pg_backend_pid() AS pid, now()::text AS began`
          )
        ).rows;
        const { holders, open } = await observe();
        seen.push({
          holders: holders.length,
          ownTransactionOnly: holders[0] === own?.pid && open.length === 1 && open[0] === own?.pid,
        });
        if (own) began.push(own.began);
        if (kill && own) {
          // The run's connection is lost midway, as when its worker dies.
          await t.db.execute(sql`SELECT pg_terminate_backend(${own.pid}, 5000)`);
        }
        return ossEntitlements.forWorkspace(id, tx);
      },
    };
    const job = { workspaceId, syncId: sync.id, runId: queued.id };
    kill = true;
    await expect(runSyncJob({ db: t.appDb, entitlements, batchSize: 2 }, job)).rejects.toThrow();
    expect(seen).toEqual([{ holders: 1, ownTransactionOnly: true }]);
    // Postgres let go of the lost connection's lock: the job's retry runs, it isn't deferred.
    expect((await observe()).holders).toEqual([]);
    kill = false;
    seen.length = 0;
    began.length = 0;
    expect(await runSyncJob({ db: t.appDb, entitlements, batchSize: 2 }, job)).toMatchObject({
      status: 'succeeded',
      created: 5,
    });
    // Three batches of 2 and the run's end, each a transaction of its own on the connection
    // holding the lock: no other transaction (and no other connection) is held across them.
    expect(seen).toEqual(Array(4).fill({ holders: 1, ownTransactionOnly: true }));
    // Each one a new transaction, not savepoints of one held across the run.
    expect(new Set(began).size).toBe(4);
    expect((await observe()).holders).toEqual([]);
  });

  it('pauses when the source table is deleted', async () => {
    const scratch = await ok<TableMeta>(
      json('POST', `/api/bases/${source.id}/tables`, { name: 'Scratch' }),
      201
    );
    const sync = await ok<TableSync>(
      json('POST', `/api/bases/${target.id}/syncs`, {
        source: { baseId: source.id, tableId: scratch.id },
        schedule: 'manual',
      }),
      201
    );
    await run(sync);
    await ok(json('DELETE', `/api/tables/${scratch.id}`), 204);
    expect(await syncNow(sync)).toEqual({ status: 'paused', reason: 'source_deleted' });
    // Resuming runs again (and pauses again while the source is gone).
    const resumed = await ok<TableSync>(
      json('PATCH', `/api/tables/${sync.tableId}/sync`, { paused: false })
    );
    expect(resumed.status).toBe('active');
    expect(resumed.createdBy).toBe(ownerId);
    expect(await run(sync)).toEqual({ status: 'paused', reason: 'source_deleted' });
  });
});
