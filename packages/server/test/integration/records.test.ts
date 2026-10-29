import type { FieldMeta, RecordData, TableMeta } from '@openrows/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { inScope } from '../../src/authz/scope.js';
import { qualified } from '../../src/data/columns.js';
import { outbox, type Transaction, tables, type users } from '../../src/db/index.js';
import { unlimitedEntitlements } from '../../src/edition/oss.js';
import { createRecords, updateRecords } from '../../src/records/service.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, authedClient, createWorkspace } from '../helpers/factories.js';

/**
 * The RecordService (ADR-003) through the API as openrows_app: per-cell patches with
 * versions, `ifVersion`, registry validation, soft delete and restore, bulk writes in one
 * transaction, ids constrained to the route's table, and outbox events in the same transaction.
 */
describe('records', () => {
  const t = useTestDb();
  let owner: typeof users.$inferSelect;
  let workspaceId: string;
  let api: Awaited<ReturnType<typeof authedClient>>;

  const json = (method: string, path: string, body?: unknown, client = api) =>
    client.request(path, {
      method,
      headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  async function ok<T>(res: Response, status = 200): Promise<T> {
    if (res.status !== status) throw new Error(`${res.status}: ${await res.text()}`);
    return (status === 204 ? undefined : await res.json()) as T;
  }

  async function newTable(name = 'Tasks', wsId = workspaceId, client = api) {
    const base = await ok<{ id: string }>(
      await json('POST', `/api/workspaces/${wsId}/bases`, { name: 'Base' }, client),
      201
    );
    return ok<TableMeta>(await json('POST', `/api/bases/${base.id}/tables`, { name }, client), 201);
  }
  const newField = async (tableId: string, body: Record<string, unknown>) =>
    ok<FieldMeta>(await json('POST', `/api/tables/${tableId}/fields`, body), 201);
  const fieldId = (table: TableMeta, name: string) => {
    const f = table.fields.find((x) => x.name === name);
    if (!f) throw new Error(`no field ${name}`);
    return f.id;
  };
  const records = (tableId: string) => `/api/tables/${tableId}/records`;
  const create = async (tableId: string, fields: Record<string, unknown> = {}) =>
    ok<RecordData>(await json('POST', records(tableId), { fields }), 201);
  const events = async (tableId: string) =>
    t.db.select().from(outbox).where(eq(outbox.tableId, tableId)).orderBy(asc(outbox.id));
  const recordEvents = async (tableId: string) =>
    (await events(tableId)).filter((e) => e.kind.startsWith('record.'));
  const rawRows = async (tableId: string) => {
    const [row] = await t.db.select().from(tables).where(eq(tables.id, tableId));
    if (!row) throw new Error('no table');
    return (await t.db.execute(sql`SELECT * FROM ${qualified(row)} ORDER BY id`)).rows;
  };

  beforeAll(async () => {
    const created = await createWorkspace(t.db);
    owner = created.owner;
    workspaceId = created.workspace.id;
    api = await authedClient(t, owner);
  });

  it('creates a record with coerced values, system fields and an outbox event', async () => {
    const table = await newTable();
    const number = await newField(table.id, { name: 'Estimate', type: 'number' });
    const auto = await newField(table.id, { name: 'No', type: 'autoNumber' });
    const created = await newField(table.id, { name: 'Created', type: 'createdTime' });
    const by = await newField(table.id, { name: 'Creator', type: 'createdBy' });
    const done = await newField(table.id, { name: 'Done', type: 'checkbox' });

    const record = await create(table.id, {
      [fieldId(table, 'Name')]: 'Write tests',
      [fieldId(table, 'Status')]: 'In progress',
      [number.id]: '42',
    });
    expect(record.version).toBe(1);
    expect(record.createdBy).toBe(owner.id);
    expect(record.updatedBy).toBe(owner.id);
    const status = table.fields.find((f) => f.name === 'Status')?.options as {
      choices: { id: string; name: string }[];
    };
    expect(record.fields).toMatchObject({
      [fieldId(table, 'Name')]: 'Write tests',
      [fieldId(table, 'Notes')]: null,
      [fieldId(table, 'Status')]: status.choices.find((c) => c.name === 'In progress')?.id,
      [number.id]: 42,
      [auto.id]: 1,
      [by.id]: owner.id,
      [done.id]: false,
    });
    expect(record.fields[created.id]).toBe(record.createdAt);

    const second = await create(table.id);
    expect(second.fields[auto.id]).toBe(2);

    const [event] = await recordEvents(table.id);
    expect(event).toMatchObject({
      kind: 'record.created',
      actorId: owner.id,
      workspaceId,
      baseId: table.baseId,
    });
    expect(event?.payload).toMatchObject({
      recordId: record.id,
      version: 1,
      fieldIds: [fieldId(table, 'Name'), fieldId(table, 'Status'), number.id],
    });
  });

  it('rejects unknown, trashed, computed and unreadable cells with 422 and writes nothing', async () => {
    const table = await newTable();
    const number = await newField(table.id, { name: 'Estimate', type: 'number' });
    const auto = await newField(table.id, { name: 'No', type: 'autoNumber' });
    const old = await newField(table.id, { name: 'Old', type: 'singleLineText' });
    await ok(await json('DELETE', `/api/fields/${old.id}`), 204);

    for (const fields of [
      { [number.id]: 'not a number' },
      { [auto.id]: 5 },
      { [old.id]: 'x' },
      { '0190a8b2-0000-7000-8000-000000000001': 'x' },
      { [fieldId(table, 'Status')]: 'No such choice' },
    ]) {
      const res = await json('POST', records(table.id), { fields });
      expect(res.status, JSON.stringify(fields)).toBe(422);
      const body = (await res.json()) as { code: string; errors: { path: string }[] };
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.errors[0]?.path).toBe(`records.0.fields.${Object.keys(fields)[0]}`);
    }
    expect(await rawRows(table.id)).toEqual([]);
    expect(await recordEvents(table.id)).toEqual([]);
  });

  it('patches only the given cells, bumps the version and honours ifVersion', async () => {
    const table = await newTable();
    const name = fieldId(table, 'Name');
    const notes = fieldId(table, 'Notes');
    const record = await create(table.id, { [name]: 'A', [notes]: 'keep me' });

    const patched = await ok<RecordData>(
      await json('PATCH', `${records(table.id)}/${record.id}`, { fields: { [name]: 'B' } })
    );
    expect(patched.version).toBe(2);
    expect(patched.fields).toMatchObject({ [name]: 'B', [notes]: 'keep me' });
    expect(new Date(patched.updatedAt) >= new Date(record.updatedAt)).toBe(true);

    const stale = await json('PATCH', `${records(table.id)}/${record.id}`, {
      fields: { [name]: 'C' },
      ifVersion: 1,
    });
    expect(stale.status).toBe(409);
    const conflict = (await stale.json()) as { code: string; records: RecordData[] };
    expect(conflict.code).toBe('CONFLICT');
    expect(conflict.records[0]).toMatchObject({ id: record.id, version: 2 });

    const fresh = await ok<RecordData>(
      await json('PATCH', `${records(table.id)}/${record.id}`, {
        fields: { [name]: null },
        ifVersion: 2,
        clientOpId: 'op-1',
      })
    );
    expect(fresh).toMatchObject({ version: 3, fields: { [name]: null, [notes]: 'keep me' } });
    const noop = await ok<RecordData>(
      await json('PATCH', `${records(table.id)}/${record.id}`, { fields: {} })
    );
    expect(noop.version).toBe(3);

    const updates = (await recordEvents(table.id)).filter((e) => e.kind === 'record.updated');
    expect(updates.map((e) => e.payload)).toEqual([
      // `before`: the written cells as they were, for webhooks (clients never get it).
      {
        recordId: record.id,
        version: 2,
        fieldIds: [name],
        cells: { [name]: 'B' },
        before: { [name]: 'A' },
      },
      {
        recordId: record.id,
        version: 3,
        fieldIds: [name],
        cells: { [name]: null },
        before: { [name]: 'B' },
      },
    ]);
    expect(updates[1]?.clientOpId).toBe('op-1');
  });

  it('loses nothing when 50 single-cell updates to different fields of a record race', async () => {
    const table = await newTable();
    const created: FieldMeta[] = [];
    for (let i = 0; i < 50; i++) {
      created.push(await newField(table.id, { name: `N${i}`, type: 'number' }));
    }
    const record = await create(table.id);

    const results = await Promise.all(
      created.map((f, i) =>
        json('PATCH', `${records(table.id)}/${record.id}`, { fields: { [f.id]: i + 1 } })
      )
    );
    expect(results.map((r) => r.status)).toEqual(results.map(() => 200));

    const final = await ok<RecordData>(await json('GET', `${records(table.id)}/${record.id}`));
    expect(final.version).toBe(51);
    for (const [i, f] of created.entries()) expect(final.fields[f.id], f.name).toBe(i + 1);
    const versions = (await recordEvents(table.id))
      .filter((e) => e.kind === 'record.updated')
      .map((e) => (e.payload as { version: number }).version)
      .sort((a, b) => a - b);
    expect(versions).toEqual(Array.from({ length: 50 }, (_, i) => i + 2));
  });

  it('creates, updates and deletes 1,000 records per call, in one transaction', async () => {
    const table = await newTable();
    const name = fieldId(table, 'Name');
    const batch = await ok<{ records: RecordData[] }>(
      await json('POST', records(table.id), {
        records: Array.from({ length: 1000 }, (_, i) => ({ fields: { [name]: `R${i}` } })),
      }),
      201
    );
    expect(batch.records).toHaveLength(1000);
    expect(batch.records[999]?.fields[name]).toBe('R999');

    const tooMany = await json('POST', records(table.id), {
      records: Array.from({ length: 1001 }, () => ({})),
    });
    expect(tooMany.status).toBe(422);

    const updated = await ok<{ records: RecordData[] }>(
      await json('PATCH', records(table.id), {
        records: batch.records.map((r, i) => ({ id: r.id, fields: { [name]: `U${i}` } })),
      })
    );
    expect(updated.records.every((r, i) => r.version === 2 && r.fields[name] === `U${i}`)).toBe(
      true
    );

    // One bad cell rolls the whole batch back, outbox included.
    const before = (await recordEvents(table.id)).length;
    const bad = await json('PATCH', records(table.id), {
      records: [
        { id: batch.records[0]?.id, fields: { [name]: 'changed' } },
        { id: batch.records[1]?.id, fields: { [fieldId(table, 'Status')]: 'Nope' } },
      ],
    });
    expect(bad.status).toBe(422);
    const conflict = await json('PATCH', records(table.id), {
      records: [
        { id: batch.records[0]?.id, fields: { [name]: 'changed' } },
        { id: batch.records[1]?.id, fields: { [name]: 'changed' }, ifVersion: 1 },
      ],
    });
    expect(conflict.status).toBe(409);
    expect((await recordEvents(table.id)).length).toBe(before);
    const first = await ok<RecordData>(
      await json('GET', `${records(table.id)}/${batch.records[0]?.id}`)
    );
    expect(first).toMatchObject({ version: 2, fields: { [name]: 'U0' } });

    const ids = batch.records.map((r) => r.id);
    await ok(await json('POST', `${records(table.id)}/delete`, { recordIds: ids }));
    const page = await ok<{ records: RecordData[] }>(await json('GET', records(table.id)));
    expect(page.records).toEqual([]);
    const kinds = (await recordEvents(table.id)).map((e) => e.kind);
    expect(kinds.filter((k) => k === 'record.created')).toHaveLength(1000);
    expect(kinds.filter((k) => k === 'record.updated')).toHaveLength(1000);
    expect(kinds.filter((k) => k === 'record.deleted')).toHaveLength(1000);
  });

  it('writes outbox rows atomically: a failing transaction leaves neither records nor events', async () => {
    const table = await newTable();
    const [row] = await t.db.select().from(tables).where(eq(tables.id, table.id));
    if (!row) throw new Error('no table');
    const scope = { userId: owner.id, workspaceId };
    const ctx = (tx: Transaction) => ({
      tx,
      workspaceId,
      userId: owner.id,
      role: 'owner' as const,
      entitlements: unlimitedEntitlements(),
      table: row,
    });
    await expect(
      inScope(t.appDb, scope, async (tx) => {
        const [record] = await createRecords(ctx(tx), [{ [fieldId(table, 'Name')]: 'A' }]);
        if (!record) throw new Error('no record');
        await updateRecords(ctx(tx), [
          { id: record.id, fields: { [fieldId(table, 'Name')]: 'B' } },
        ]);
        expect((await recordEvents(table.id)).length).toBe(0); // not visible before commit
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(await rawRows(table.id)).toEqual([]);
    expect(await recordEvents(table.id)).toEqual([]);
  });

  it('soft-deletes and restores records', async () => {
    const table = await newTable();
    const record = await create(table.id, { [fieldId(table, 'Name')]: 'A' });
    await ok(await json('DELETE', `${records(table.id)}/${record.id}`), 204);
    expect((await json('GET', `${records(table.id)}/${record.id}`)).status).toBe(404);
    expect((await json('DELETE', `${records(table.id)}/${record.id}`)).status).toBe(404);
    expect((await json('PATCH', `${records(table.id)}/${record.id}`, { fields: {} })).status).toBe(
      404
    );
    const [row] = await rawRows(table.id);
    expect(row).toMatchObject({ version: 2, deleted_at: expect.any(String) });

    const restored = await ok<{ records: RecordData[] }>(
      await json('POST', `${records(table.id)}/restore`, { recordIds: [record.id] })
    );
    expect(restored.records[0]).toMatchObject({ id: record.id, version: 3 });
    expect(
      (await json('POST', `${records(table.id)}/restore`, { recordIds: [record.id] })).status
    ).toBe(404);
    expect((await recordEvents(table.id)).map((e) => e.kind)).toEqual([
      'record.created',
      'record.deleted',
      'record.restored',
    ]);
  });

  it('lists live records oldest first with keyset paging', async () => {
    const table = await newTable();
    const name = fieldId(table, 'Name');
    await ok(
      await json('POST', records(table.id), {
        records: Array.from({ length: 5 }, (_, i) => ({ fields: { [name]: `R${i}` } })),
      }),
      201
    );
    const first = await ok<{ records: RecordData[]; nextCursor: string | null }>(
      await json('GET', `${records(table.id)}?limit=3`)
    );
    expect(first.records.map((r) => r.fields[name])).toEqual(['R0', 'R1', 'R2']);
    const second = await ok<{ records: RecordData[]; nextCursor: string | null }>(
      await json('GET', `${records(table.id)}?limit=3&cursor=${first.nextCursor}`)
    );
    expect(second.records.map((r) => r.fields[name])).toEqual(['R3', 'R4']);
    expect(second.nextCursor).toBeNull();
    expect((await json('GET', `${records(table.id)}?limit=5000`)).status).toBe(422);
    expect((await json('GET', `${records(table.id)}/not-a-uuid`)).status).toBe(404);
  });

  it("can't reach records of another table or workspace by id, in bulk or not", async () => {
    const mine = await newTable('Mine');
    const sibling = await newTable('Sibling');
    const other = await createWorkspace(t.db);
    const otherApi = await authedClient(t, other.owner);
    const foreign = await newTable('Foreign', other.workspace.id, otherApi);
    const name = fieldId(mine, 'Name');
    const own = await create(mine.id, { [name]: 'mine' });
    const siblingRecord = await create(sibling.id, { [fieldId(sibling, 'Name')]: 'sibling' });
    const foreignRecord = await ok<RecordData>(
      await json(
        'POST',
        records(foreign.id),
        { fields: { [fieldId(foreign, 'Name')]: 'foreign' } },
        otherApi
      ),
      201
    );
    const before = {
      sibling: await rawRows(sibling.id),
      foreign: await rawRows(foreign.id),
      mine: await rawRows(mine.id),
    };

    for (const id of [siblingRecord.id, foreignRecord.id]) {
      const bulk = await json('PATCH', records(mine.id), {
        records: [
          { id: own.id, fields: { [name]: 'changed' } },
          { id, fields: { [name]: 'changed' } },
        ],
      });
      expect(bulk.status).toBe(404);
      expect(((await bulk.json()) as { recordIds: string[] }).recordIds).toEqual([id]);
      expect(
        (await json('POST', `${records(mine.id)}/delete`, { recordIds: [own.id, id] })).status
      ).toBe(404);
      expect((await json('GET', `${records(mine.id)}/${id}`)).status).toBe(404);
      expect((await json('DELETE', `${records(mine.id)}/${id}`)).status).toBe(404);
    }
    // The other tenant's table itself is invisible.
    expect((await json('GET', records(foreign.id))).status).toBe(404);
    expect(
      (
        await json('PATCH', records(foreign.id), {
          records: [{ id: foreignRecord.id, fields: {} }],
        })
      ).status
    ).toBe(404);

    expect({
      sibling: await rawRows(sibling.id),
      foreign: await rawRows(foreign.id),
      mine: await rawRows(mine.id),
    }).toEqual(before);
  });

  it('lets editors write records and read-only members only read them', async () => {
    const table = await newTable();
    const editor = await authedClient(t, await addMember(t.db, workspaceId, 'editor'));
    const reader = await authedClient(t, await addMember(t.db, workspaceId, 'read_only'));
    const created = await ok<RecordData>(
      await json('POST', records(table.id), { fields: {} }, editor),
      201
    );
    expect(created.createdBy).not.toBe(owner.id);
    expect((await json('POST', records(table.id), { fields: {} }, reader)).status).toBe(403);
    expect(
      (await json('GET', `${records(table.id)}/${created.id}`, undefined, reader)).status
    ).toBe(200);
    const rows = await t.db
      .select()
      .from(outbox)
      .where(and(eq(outbox.tableId, table.id), eq(outbox.kind, 'record.created')));
    expect(rows).toHaveLength(1);
  });

  it('restores exact prior values from an inverse bulk patch (grid undo, #29)', async () => {
    const table = await newTable('Undo');
    const specs: Record<string, unknown>[] = [
      { name: 'Long', type: 'longText' },
      { name: 'Price', type: 'currency', options: { precision: 2 } },
      { name: 'Check', type: 'checkbox' },
      { name: 'Due', type: 'date' },
      { name: 'At', type: 'dateTime', options: { timeZone: 'Europe/Paris' } },
      {
        name: 'Tags',
        type: 'multipleSelect',
        options: {
          choices: ['a', 'b', 'c'].map((n) => ({ id: n, name: n, color: 'blue' })),
        },
      },
      { name: 'Stars', type: 'rating' },
      { name: 'Site', type: 'url' },
    ];
    const extra: FieldMeta[] = [];
    for (const spec of specs) extra.push(await newField(table.id, spec));
    const ids = extra.map((f) => f.id);
    const [notes, price, done, due, at, tags, stars, site] = ids as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const name = fieldId(table, 'Name');
    const editable = [name, ...extra.map((f) => f.id)];
    const pick = (r: RecordData) => Object.fromEntries(editable.map((id) => [id, r.fields[id]]));

    const original = await ok<{ records: RecordData[] }>(
      await json('POST', records(table.id), {
        records: [
          {
            fields: {
              [name]: 'One',
              [notes]: 'line 1\nline 2',
              [price]: 12.5,
              [done]: true,
              [due]: '2026-03-04',
              [at]: '2026-03-04T10:30:00+01:00',
              [tags]: ['b', 'a'],
              [stars]: 3,
              [site]: 'https://example.com/a',
            },
          },
          { fields: { [name]: 'Two' } },
        ],
      }),
      201
    );
    const before = original.records.map(pick);

    // A paste overwrites every editable cell of both records.
    const pasted = {
      [name]: 'Pasted',
      [notes]: null,
      [price]: '99.999',
      [done]: false,
      [due]: '2027-01-01',
      [at]: null,
      [tags]: ['c'],
      [stars]: 5,
      [site]: null,
    };
    await ok(
      await json('PATCH', records(table.id), {
        records: original.records.map((r) => ({ id: r.id, fields: pasted })),
      })
    );

    // Undo: the inverse patch holds each written cell's prior value.
    await ok(
      await json('PATCH', records(table.id), {
        records: original.records.map((r, i) => ({ id: r.id, fields: before[i] })),
      })
    );
    const after = await Promise.all(
      original.records.map(async (r) =>
        ok<RecordData>(await json('GET', `${records(table.id)}/${r.id}`))
      )
    );
    expect(after.map(pick)).toEqual(before);
  });
});
