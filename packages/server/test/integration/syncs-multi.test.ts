import {
  type Base,
  MAX_SYNC_SOURCES_PER_TABLE,
  MAX_SYNCS_PER_BASE,
  type RecordData as RecordT,
  type TableMeta,
  type TableSync,
} from '@openrows/shared';
import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { tableSyncs, workspaceMembers } from '../../src/db/index.js';
import { ossEntitlements } from '../../src/edition/oss.js';
import type { EntitlementsProvider } from '../../src/edition/types.js';
import { runSyncJob, type SyncRunDeps } from '../../src/syncs/run.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, createSession, createWorkspace } from '../helpers/factories.js';

/**
 * Synced tables with more than one source. Each source owns its records (by the "Sync source
 * ID" field, or for the table's first source also the keyed records synced before it had a
 * second): a run of one source upserts and deletes only its own, the same key from two sources
 * is two records, and a one-source table is unchanged until a second source is added.
 */
describe('synced tables with more than one source', () => {
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
  const meta = (tableId: string) => ok<TableMeta>(json('GET', `/api/tables/${tableId}`));
  const records = async (tableId: string) =>
    (await ok<{ records: RecordT[] }>(json('GET', `/api/tables/${tableId}/records?limit=1000`)))
      .records;
  const sources = async (tableId: string) =>
    (await ok<{ sources: TableSync[] }>(json('GET', `/api/tables/${tableId}/syncs`))).sources;
  /** "Sync now" on one source (unless a run is queued), run as the worker would. */
  async function syncNow(sync: TableSync, limits: Pick<SyncRunDeps, 'maxRecords'> = {}) {
    let current = (await sources(sync.tableId)).find((s) => s.id === sync.id);
    if (!current?.runs.some((r) => r.status === 'queued')) {
      current = await ok<TableSync>(
        json('POST', `/api/tables/${sync.tableId}/syncs/${sync.id}/run`)
      );
    }
    const queued = current.runs.find((r) => r.status === 'queued');
    if (!queued) throw new Error('no queued run');
    return runSyncJob(
      { db: t.appDb, ...limits },
      { workspaceId, syncId: sync.id, runId: queued.id }
    );
  }
  /** A source table of the CRM base with Name, Points and Status, and these records. */
  async function sourceTable(name: string, rows: { name: string; points?: number }[]) {
    const table = await ok<TableMeta>(json('POST', `/api/bases/${crm.id}/tables`, { name }), 201);
    await ok(
      json('POST', `/api/tables/${table.id}/fields`, { name: 'Points', type: 'number' }),
      201
    );
    const full = await meta(table.id);
    if (rows.length) {
      await ok(
        json('POST', `/api/tables/${table.id}/records`, {
          typecast: true,
          records: rows.map((r) => ({
            fields: {
              [fieldId(full, 'Name')]: r.name,
              [fieldId(full, 'Status')]: 'Todo',
              ...(r.points !== undefined ? { [fieldId(full, 'Points')]: r.points } : {}),
            },
          })),
        }),
        201
      );
    }
    return full;
  }
  const recordId = async (table: TableMeta, name: string) => {
    const r = (await records(table.id)).find((x) => x.fields[fieldId(table, 'Name')] === name);
    if (!r) throw new Error(`no record ${name}`);
    return r.id;
  };
  /** A synced table keyed by Name, made from `from`, with its first run done. */
  async function syncedFrom(from: TableMeta, name: string) {
    const sync = await ok<TableSync>(
      json('POST', `/api/bases/${reports.id}/syncs`, {
        name,
        source: { baseId: crm.id, tableId: from.id },
        keyFieldId: fieldId(from, 'Name'),
        schedule: 'manual',
      }),
      201
    );
    expect(await syncNow(sync)).toMatchObject({ status: 'succeeded' });
    return sync;
  }
  /** Adds `from` (keyed by Name) as a source of the synced table. */
  const addSource = (tableId: string, from: TableMeta, body: Record<string, unknown> = {}) =>
    json('POST', `/api/tables/${tableId}/syncs`, {
      source: { baseId: crm.id, tableId: from.id },
      keyFieldId: fieldId(from, 'Name'),
      schedule: 'manual',
      ...body,
    });
  /** The synced table's records as [Sync source ID or '', key, Points] rows, sorted. */
  async function owned(tableId: string) {
    const table = await meta(tableId);
    const ownerField = table.fields.find((f) => f.name === 'Sync source ID');
    return (await records(tableId))
      .map((r) => [
        ownerField ? ((r.fields[ownerField.id] as string | undefined) ?? '') : '',
        r.fields[fieldId(table, 'Sync source')] as string,
        (r.fields[fieldId(table, 'Points')] as number | undefined) ?? null,
      ])
      .sort((a, b) => `${a[0]}|${a[1]}`.localeCompare(`${b[0]}|${b[1]}`));
  }

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

  it('keeps a one-source table as it was until a source is added, then keeps sources apart', async () => {
    const people = await sourceTable('People', [
      { name: 'Ada', points: 1 },
      { name: 'Bob', points: 2 },
    ]);
    const contacts = await sourceTable('Contacts', [
      { name: 'Ada', points: 10 },
      { name: 'Cy', points: 30 },
    ]);
    const a = await syncedFrom(people, 'Everyone');
    const table = await meta(a.tableId);
    // One source: no "Sync source ID" field, and the API shape is today's.
    expect(a.ownerFieldId).toBeNull();
    expect(table.fields.map((f) => f.name)).toEqual([
      'Name',
      'Notes',
      'Status',
      'Points',
      'Sync source',
    ]);
    expect(await sources(a.tableId)).toEqual([
      await ok<TableSync>(json('GET', `/api/tables/${a.tableId}/sync`)),
    ]);
    const before = await records(a.tableId);
    // A rerun is a no-op.
    expect(await syncNow(a)).toMatchObject({ unchanged: 2, created: 0, updated: 0, deleted: 0 });
    expect((await records(a.tableId)).map((r) => [r.id, r.version])).toEqual(
      before.map((r) => [r.id, r.version])
    );

    // Opting in: Contacts as a second source, its Points into the table's Points (same type),
    // its Notes into a new field; Name fills the primary by default.
    const b = await ok<TableSync>(
      addSource(a.tableId, contacts, {
        fieldIds: [fieldId(contacts, 'Points'), fieldId(contacts, 'Notes')],
        targets: [
          { sourceFieldId: fieldId(contacts, 'Points'), fieldId: fieldId(table, 'Points') },
          { sourceFieldId: fieldId(contacts, 'Notes'), fieldId: null },
        ],
      }),
      201
    );
    const after = await meta(a.tableId);
    expect(after.fields.map((f) => [f.name, f.type, f.synced])).toEqual([
      ['Name', 'singleLineText', true],
      ['Notes', 'longText', true],
      ['Status', 'singleSelect', true],
      ['Points', 'number', true],
      ['Sync source', 'syncSource', true],
      ['Notes 2', 'longText', true],
      ['Sync source ID', 'syncSource', true],
    ]);
    const ownerFieldId = fieldId(after, 'Sync source ID');
    expect(b).toMatchObject({
      tableId: a.tableId,
      sourceFieldId: a.sourceFieldId,
      ownerFieldId,
      source: { label: 'CRM / Contacts' },
    });
    expect(b.fields).toEqual([
      { sourceFieldId: fieldId(contacts, 'Name'), column: null, fieldId: fieldId(after, 'Name') },
      {
        sourceFieldId: fieldId(contacts, 'Notes'),
        column: null,
        fieldId: fieldId(after, 'Notes 2'),
      },
      {
        sourceFieldId: fieldId(contacts, 'Points'),
        column: null,
        fieldId: fieldId(after, 'Points'),
      },
    ]);
    const both = await sources(a.tableId);
    expect(both.map((s) => [s.id, s.ownerFieldId])).toEqual([
      [a.id, ownerFieldId],
      [b.id, ownerFieldId],
    ]);
    // The table-wide GET still answers the first source.
    expect((await ok<TableSync>(json('GET', `/api/tables/${a.tableId}/sync`))).id).toBe(a.id);

    // The first source's records keep their keys and an empty "Sync source ID": still its own,
    // so its rerun is still a no-op.
    expect(await syncNow(a)).toMatchObject({ unchanged: 2, created: 0, updated: 0, deleted: 0 });
    expect((await records(a.tableId)).map((r) => [r.id, r.version])).toEqual(
      before.map((r) => [r.id, r.version])
    );

    // The second source's run: Ada again, as a record of its own.
    expect(await syncNow(b)).toMatchObject({ status: 'succeeded', created: 2, deleted: 0 });
    expect(await owned(a.tableId)).toEqual([
      ['', 'Ada', 1],
      ['', 'Bob', 2],
      [b.id, 'Ada', 10],
      [b.id, 'Cy', 30],
    ]);
    // Neither touches the other: reruns change nothing.
    const settled = (await records(a.tableId)).map((r) => [r.id, r.version]);
    expect(await syncNow(a)).toMatchObject({ unchanged: 2, created: 0, updated: 0, deleted: 0 });
    expect(await syncNow(b)).toMatchObject({ unchanged: 2, created: 0, updated: 0, deleted: 0 });
    expect((await records(a.tableId)).map((r) => [r.id, r.version])).toEqual(settled);

    // People drops Ada, which Contacts still has: only People's Ada goes. People's new record is
    // marked as its own; Contacts' edit reaches only Contacts' record.
    await ok(
      json('DELETE', `/api/tables/${people.id}/records/${await recordId(people, 'Ada')}`),
      204
    );
    await ok(
      json('POST', `/api/tables/${people.id}/records`, {
        fields: { [fieldId(people, 'Name')]: 'Cy', [fieldId(people, 'Points')]: 3 },
      }),
      201
    );
    await ok(
      json('PATCH', `/api/tables/${contacts.id}/records/${await recordId(contacts, 'Ada')}`, {
        fields: { [fieldId(contacts, 'Points')]: 11 },
      })
    );
    expect(await syncNow(a)).toMatchObject({ created: 1, updated: 0, deleted: 1, unchanged: 1 });
    expect(await syncNow(b)).toMatchObject({ created: 0, updated: 1, deleted: 0, unchanged: 1 });
    expect(await owned(a.tableId)).toEqual([
      ['', 'Bob', 2],
      [a.id, 'Cy', 3],
      [b.id, 'Ada', 11],
      [b.id, 'Cy', 30],
    ]);

    // Contacts drops everything: only its records go.
    for (const name of ['Ada', 'Cy']) {
      await ok(
        json('DELETE', `/api/tables/${contacts.id}/records/${await recordId(contacts, name)}`),
        204
      );
    }
    expect(await syncNow(b)).toMatchObject({ deleted: 2, created: 0 });
    expect(await owned(a.tableId)).toEqual([
      ['', 'Bob', 2],
      [a.id, 'Cy', 3],
    ]);
    // Records and synced cells stay the sources' only.
    const [rec] = await records(a.tableId);
    if (!rec) throw new Error('no record');
    expect(
      (
        await json('PATCH', `/api/tables/${a.tableId}/records/${rec.id}`, {
          fields: { [ownerFieldId]: b.id },
        })
      ).status
    ).toBe(403);
  });

  it('maps onto existing fields only when the types fit, and only onto synced fields', async () => {
    const left = await sourceTable('Left', [{ name: 'L1', points: 1 }]);
    const right = await sourceTable('Right', [{ name: 'R1', points: 2 }]);
    const sync = await syncedFrom(left, 'Mapped');
    // A field the person added: editable, and no source's target.
    await ok(
      json('POST', `/api/tables/${sync.tableId}/fields`, {
        name: 'Remark',
        type: 'singleLineText',
      }),
      201
    );
    const table = await meta(sync.tableId);
    const target = (from: string, to: string) => ({
      fieldIds: [fieldId(right, from)],
      targets: [{ sourceFieldId: fieldId(right, from), fieldId: fieldId(table, to) }],
    });

    // A number can't fill a single select.
    const mismatch = await problem(addSource(sync.tableId, right, target('Points', 'Status')), 422);
    expect(mismatch.errors?.[0]).toMatchObject({
      path: 'targets.0.fieldId',
      message: expect.stringMatching(/"Points" \(Number\) can't fill "Status" \(Single select\)/),
    });
    // Not a field the person added, nor the engine's own.
    expect(
      (await problem(addSource(sync.tableId, right, target('Points', 'Remark')), 422)).errors?.[0]
        ?.path
    ).toBe('targets.0.fieldId');
    expect(
      (await problem(addSource(sync.tableId, right, target('Notes', 'Sync source')), 422))
        .errors?.[0]?.path
    ).toBe('targets.0.fieldId');
    // Only the fields the source copies, each once.
    expect(
      (
        await problem(
          addSource(sync.tableId, right, {
            fieldIds: [fieldId(right, 'Points')],
            targets: [{ sourceFieldId: fieldId(right, 'Notes'), fieldId: null }],
          }),
          422
        )
      ).errors?.[0]?.path
    ).toBe('targets.0');
    // Nothing was added by the refusals.
    expect((await sources(sync.tableId)).length).toBe(1);
    expect((await meta(sync.tableId)).fields.length).toBe(table.fields.length);

    // A number fills a number field, or a text field (as its text): both fine.
    const added = await ok<TableSync>(
      addSource(sync.tableId, right, {
        fieldIds: [fieldId(right, 'Points'), fieldId(right, 'Status')],
        targets: [
          { sourceFieldId: fieldId(right, 'Name'), fieldId: fieldId(table, 'Notes') },
          { sourceFieldId: fieldId(right, 'Points'), fieldId: fieldId(table, 'Points') },
          { sourceFieldId: fieldId(right, 'Status'), fieldId: fieldId(table, 'Status') },
        ],
      }),
      201
    );
    expect(added.fields.map((f) => f.fieldId)).toEqual([
      fieldId(table, 'Notes'),
      fieldId(table, 'Status'),
      fieldId(table, 'Points'),
    ]);
    expect(await syncNow(added)).toMatchObject({ status: 'succeeded', created: 1 });
    const after = await meta(sync.tableId);
    const r1 = (await records(sync.tableId)).find(
      (r) => r.fields[fieldId(after, 'Sync source')] === 'R1'
    );
    expect(r1?.fields).toMatchObject({
      [fieldId(after, 'Notes')]: 'R1',
      [fieldId(after, 'Points')]: 2,
    });
    // Its primary is empty: Right's Name went to Notes.
    expect(r1?.fields[fieldId(after, 'Name')] ?? null).toBeNull();
    // Only creators and up add sources.
    const editor = await createSession(t.db, await addMember(t.db, workspaceId, 'editor'));
    expect(
      (
        await json(
          'POST',
          `/api/tables/${sync.tableId}/syncs`,
          { source: { baseId: crm.id, tableId: right.id } },
          editor
        )
      ).status
    ).toBe(403);
  });

  it("runs each source as its own creator, with that creator's live access", async () => {
    const mine = await sourceTable('Mine', [{ name: 'M1' }]);
    const theirs = await sourceTable('Theirs', [{ name: 'T1' }]);
    const sync = await syncedFrom(mine, 'Shared');
    const creator = await addMember(t.db, workspaceId, 'creator');
    const session = await createSession(t.db, creator);
    const second = await ok<TableSync>(
      json(
        'POST',
        `/api/tables/${sync.tableId}/syncs`,
        {
          source: { baseId: crm.id, tableId: theirs.id },
          keyFieldId: fieldId(theirs, 'Name'),
          schedule: 'manual',
        },
        session
      ),
      201
    );
    expect(second.createdBy).toBe(creator.id);
    expect(second.createdBy).not.toBe(sync.createdBy);
    expect(await syncNow(second)).toMatchObject({ status: 'succeeded', created: 1 });

    // The second source's creator leaves the workspace: that source pauses, keeping its
    // records; the first runs on as its own creator.
    await t.db
      .delete(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, creator.id))
      );
    expect(await syncNow(second)).toEqual({ status: 'paused', reason: 'access_lost' });
    await ok(
      json('POST', `/api/tables/${mine.id}/records`, { fields: { [fieldId(mine, 'Name')]: 'M2' } }),
      201
    );
    expect(await syncNow(sync)).toMatchObject({ status: 'succeeded', created: 1 });
    const now = await sources(sync.tableId);
    expect(now.map((s) => [s.status, s.pauseReason])).toEqual([
      ['active', null],
      ['paused', 'access_lost'],
    ]);
    expect((await owned(sync.tableId)).map((r) => r[1]).sort()).toEqual(['M1', 'M2', 'T1']);
    // Paused, one source refuses "Sync now"; the table-wide one runs the active ones.
    expect((await json('POST', `/api/tables/${sync.tableId}/syncs/${second.id}/run`)).status).toBe(
      409
    );
    expect(
      (await ok<TableSync>(json('POST', `/api/tables/${sync.tableId}/sync/run`))).runs[0]
    ).toMatchObject({ status: 'queued' });
    // Resuming makes whoever resumed it the source's reader.
    const resumed = await ok<TableSync>(
      json('PATCH', `/api/tables/${sync.tableId}/syncs/${second.id}`, { paused: false })
    );
    expect(resumed).toMatchObject({ status: 'active', createdBy: sync.createdBy });
    // A source of another table is a 404 here.
    const other = await syncedFrom(theirs, 'Other');
    expect(
      (await json('PATCH', `/api/tables/${sync.tableId}/syncs/${other.id}`, { schedule: 'daily' }))
        .status
    ).toBe(404);
    expect((await json('DELETE', `/api/tables/${sync.tableId}/syncs/${other.id}`)).status).toBe(
      404
    );
  });

  it('removes one source keeping its records, then the last one stops syncing', async () => {
    const first = await sourceTable('First', [
      { name: 'Ada', points: 1 },
      { name: 'Bob', points: 2 },
    ]);
    const second = await sourceTable('Second', [
      { name: 'Ada', points: 10 },
      { name: 'Eve', points: 50 },
    ]);
    const a = await syncedFrom(first, 'Removal');
    const b = await ok<TableSync>(
      addSource(a.tableId, second, {
        fieldIds: [fieldId(second, 'Points'), fieldId(second, 'Notes')],
        targets: [{ sourceFieldId: fieldId(second, 'Notes'), fieldId: null }],
      }),
      201
    );
    expect(await syncNow(b)).toMatchObject({ created: 2 });
    let table = await meta(a.tableId);
    // Second's Points went to a new field (no target given): "Points 2".
    expect(table.fields.find((f) => f.name === 'Points 2')?.synced).toBe(true);

    // The first source goes: its records stay (with their empty "Sync source ID"), owned by no
    // source; fields only it filled become ordinary.
    await ok(json('DELETE', `/api/tables/${a.tableId}/syncs/${a.id}`), 204);
    expect((await sources(a.tableId)).map((s) => s.id)).toEqual([b.id]);
    table = await meta(a.tableId);
    expect(table.synced).toBe(true);
    const syncedNames = table.fields.filter((f) => f.synced).map((f) => f.name);
    expect(syncedNames).toEqual(['Name', 'Sync source', 'Notes 2', 'Points 2', 'Sync source ID']);
    expect(table.fields.find((f) => f.name === 'Points')?.synced).toBeUndefined();
    const kept = await records(a.tableId);
    expect(kept).toHaveLength(4);
    // The table-wide routes now answer the remaining source.
    expect((await ok<TableSync>(json('GET', `/api/tables/${a.tableId}/sync`))).id).toBe(b.id);

    // The remaining source runs on: it drops Ada (which the removed source's record also has as
    // its key) and gets Fay; the removed source's records are left alone.
    await ok(
      json('DELETE', `/api/tables/${second.id}/records/${await recordId(second, 'Ada')}`),
      204
    );
    await ok(
      json('POST', `/api/tables/${second.id}/records`, {
        fields: { [fieldId(second, 'Name')]: 'Fay' },
      }),
      201
    );
    expect(await syncNow(b)).toMatchObject({ created: 1, deleted: 1, updated: 0, unchanged: 1 });
    const keys = async () => {
      const m = await meta(a.tableId);
      return (await records(a.tableId))
        .map((r) => [
          (r.fields[fieldId(m, 'Sync source ID')] as string | undefined) ?? '',
          r.fields[fieldId(m, 'Sync source')],
        ])
        .sort((x, y) => `${x[0]}|${x[1]}`.localeCompare(`${y[0]}|${y[1]}`));
    };
    expect(await keys()).toEqual([
      ['', 'Ada'],
      ['', 'Bob'],
      [b.id, 'Eve'],
      [b.id, 'Fay'],
    ]);
    const versions = kept
      .filter((r) => !r.fields[fieldId(table, 'Sync source ID')])
      .map((r) => [r.id, r.version]);
    expect(
      (await records(a.tableId))
        .filter((r) => versions.some(([id]) => id === r.id))
        .map((r) => [r.id, r.version])
    ).toEqual(versions);
    // While the table syncs, its records stay read-only, the removed source's too; a field no
    // source fills any more is editable.
    const ada = (await records(a.tableId)).find(
      (r) =>
        r.fields[fieldId(table, 'Sync source')] === 'Ada' &&
        !r.fields[fieldId(table, 'Sync source ID')]
    );
    if (!ada) throw new Error('no record');
    expect((await json('DELETE', `/api/tables/${a.tableId}/records/${ada.id}`)).status).toBe(403);
    await ok(
      json('PATCH', `/api/tables/${a.tableId}/records/${ada.id}`, {
        fields: { [fieldId(table, 'Points')]: 7 },
      })
    );

    // The last source goes: today's "Stop syncing".
    await ok(json('DELETE', `/api/tables/${a.tableId}/syncs/${b.id}`), 204);
    const plain = await meta(a.tableId);
    expect(plain.synced).toBeUndefined();
    expect(plain.fields.filter((f) => f.synced)).toEqual([]);
    expect((await json('GET', `/api/tables/${a.tableId}/sync`)).status).toBe(404);
    expect((await json('GET', `/api/tables/${a.tableId}/syncs`)).status).toBe(404);
    expect(await records(a.tableId)).toHaveLength(4);
    await ok(json('DELETE', `/api/tables/${a.tableId}/records/${ada.id}`), 204);
    await ok(json('DELETE', `/api/fields/${fieldId(plain, 'Sync source ID')}`), 204);
  });

  it('fails a run, deleting nothing, when a source is added to the table during it', async () => {
    const items = await sourceTable('Items', [{ name: 'I1' }, { name: 'I2' }, { name: 'I3' }]);
    const extra = await sourceTable('Extra', [{ name: 'I2' }]);
    const sync = await syncedFrom(items, 'Racing');
    // I1 leaves the source, I4 and I5 join it.
    await ok(json('DELETE', `/api/tables/${items.id}/records/${await recordId(items, 'I1')}`), 204);
    await ok(
      json('POST', `/api/tables/${items.id}/records`, {
        records: ['I4', 'I5'].map((n) => ({ fields: { [fieldId(items, 'Name')]: n } })),
      }),
      201
    );
    // In the run's first write: a source is added (it waits for the batch), then the batch
    // goes on. The next write sees the table's sources changed.
    let adding: Promise<Response> | undefined;
    const entitlements: EntitlementsProvider = {
      ...ossEntitlements,
      forWorkspace: async (id, tx) => {
        if (!adding) {
          adding = Promise.resolve(addSource(sync.tableId, extra));
          for (let waited = 0; ; waited += 20) {
            const { rows } = await t.db.execute<{ n: number }>(
              sql`SELECT count(*)::int AS n FROM pg_stat_activity
                  WHERE datname = current_database() AND wait_event_type = 'Lock'`
            );
            if ((rows[0]?.n ?? 0) > 0) break;
            if (waited > 10_000) throw new Error('the add never waited for the batch');
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
        return ossEntitlements.forWorkspace(id, tx);
      },
    };
    const queued = (
      await ok<TableSync>(json('POST', `/api/tables/${sync.tableId}/syncs/${sync.id}/run`))
    ).runs[0];
    if (!queued) throw new Error('no run');
    const outcome = await runSyncJob(
      { db: t.appDb, entitlements, batchSize: 1 },
      { workspaceId, syncId: sync.id, runId: queued.id }
    );
    expect(outcome).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/sources changed during the run/),
    });
    const added = await ok<TableSync>(adding ?? Promise.reject(new Error('no add')), 201);
    // Nothing was deleted: I1 is still there.
    expect((await owned(sync.tableId)).map((r) => r[1])).toContain('I1');
    // The next runs converge, each on its own records.
    expect(await syncNow(sync)).toMatchObject({ status: 'succeeded', deleted: 1 });
    expect(await syncNow(added)).toMatchObject({ status: 'succeeded', created: 1 });
    const rows = await owned(sync.tableId);
    expect(rows.filter((r) => r[0] !== added.id).map((r) => r[1])).toEqual([
      'I2',
      'I3',
      'I4',
      'I5',
    ]);
    expect(rows.filter((r) => r[0] === added.id).map((r) => r[1])).toEqual(['I2']);
  });

  it('keeps a source added while another one is being removed', async () => {
    const left = await sourceTable('Left side', [{ name: 'L1', points: 1 }]);
    const a = await syncedFrom(left, 'Raced removal');
    const [row] = await t.db.select().from(tableSyncs).where(eq(tableSyncs.id, a.id));
    if (!row) throw new Error('no sync row');
    const { id: _id, createdAt: _c, updatedAt: _u, ...copy } = row;
    const addedId = uuidv7();
    // An add in progress (it holds the table's sources, then inserts its own and commits)
    // while the only other source is removed: the removal waits, then must see the new source,
    // so the table goes on syncing from it, with the fields it fills still synced.
    let removing: Promise<Response> | undefined;
    await t.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM table_syncs WHERE id = ${a.id} FOR UPDATE`);
      removing = Promise.resolve(json('DELETE', `/api/tables/${a.tableId}/syncs/${a.id}`));
      for (let waited = 0; ; waited += 20) {
        const { rows } = await t.db.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'`
        );
        if ((rows[0]?.n ?? 0) > 0) break;
        if (waited > 10_000) throw new Error('the removal never waited for the add');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await tx.insert(tableSyncs).values({ ...copy, id: addedId });
    });
    await ok(removing ?? Promise.reject(new Error('no removal')), 204);
    expect((await sources(a.tableId)).map((s) => s.id)).toEqual([addedId]);
    const table = await meta(a.tableId);
    expect(table.synced).toBe(true);
    expect(table.fields.find((f) => f.name === 'Points')?.synced).toBe(true);
  });

  it('pauses only the source past the record cap, and caps sources per table and base', async () => {
    const small = await sourceTable('Small', [{ name: 'S1' }]);
    const big = await sourceTable('Big', [{ name: 'B1' }, { name: 'B2' }, { name: 'B3' }]);
    const a = await syncedFrom(small, 'Capped');
    const b = await ok<TableSync>(addSource(a.tableId, big), 201);
    // Past the cap (lowered here): that source pauses before writing; the other runs on.
    expect(await syncNow(b, { maxRecords: 2 })).toEqual({
      status: 'paused',
      reason: 'too_many_records',
    });
    expect(await syncNow(a, { maxRecords: 2 })).toMatchObject({ status: 'succeeded' });
    expect((await sources(a.tableId)).map((s) => [s.status, s.pauseReason])).toEqual([
      ['active', null],
      ['paused', 'too_many_records'],
    ]);
    expect(await records(a.tableId)).toHaveLength(1);

    // Sources per table: MAX_SYNC_SOURCES_PER_TABLE.
    const only = { fieldIds: [fieldId(small, 'Name')] };
    for (let n = 2; n < MAX_SYNC_SOURCES_PER_TABLE; n++) {
      await ok(addSource(a.tableId, small, only), 201);
    }
    expect(await sources(a.tableId)).toHaveLength(MAX_SYNC_SOURCES_PER_TABLE);
    const full = await problem(addSource(a.tableId, small, only), 409);
    expect(full.detail).toBe(
      `A table can sync from at most ${MAX_SYNC_SOURCES_PER_TABLE} sources.`
    );

    // Sources per base: each source counts, the extra ones too.
    const another = await syncedFrom(small, 'Another');
    const stored = await t.db.select().from(tableSyncs).where(eq(tableSyncs.baseId, reports.id));
    const template = stored.find((s) => s.id === another.id);
    if (!template) throw new Error('no sync row');
    const filler = MAX_SYNCS_PER_BASE - stored.length;
    expect(filler).toBeGreaterThan(0);
    const { id: _id, createdAt: _c, updatedAt: _u, ...copy } = template;
    // Rows only (they are never run), on a table of their own so the table cap stays out of it.
    const holder = await syncedFrom(big, 'Holder');
    await t.db
      .insert(tableSyncs)
      .values(Array.from({ length: filler - 1 }, () => ({ ...copy, tableId: holder.tableId })));
    const atCap = await problem(addSource(another.tableId, small, only), 409);
    expect(atCap.detail).toBe(`A base can have at most ${MAX_SYNCS_PER_BASE} sync sources.`);
    const create = await problem(
      json('POST', `/api/bases/${reports.id}/syncs`, {
        source: { baseId: crm.id, tableId: small.id },
      }),
      409
    );
    expect(create.detail).toBe(`A base can have at most ${MAX_SYNCS_PER_BASE} sync sources.`);
  });
});
