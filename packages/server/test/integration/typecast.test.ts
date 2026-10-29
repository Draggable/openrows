import type { Choice, FieldMeta, RecordData, TableMeta } from '@openrows/shared';
import { MAX_CHOICES, MAX_TYPECAST_CHOICES, newChoiceId, nextChoiceColor } from '@openrows/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { qualified } from '../../src/data/columns.js';
import { fields, outbox, tables, type users } from '../../src/db/index.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, authedClient, createWorkspace } from '../helpers/factories.js';

/**
 * Select typecast: `typecast: true` on record writes creates the select options the cells
 * name, once under concurrency, within the caps, only with schema rights; a type change into a
 * select keeps every distinct value as an option. Import typecast is in imports.test.ts.
 */
describe('select typecast', () => {
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
    return (await res.json()) as T;
  }

  async function newTable(name = 'Tasks') {
    const base = await ok<{ id: string }>(
      await json('POST', `/api/workspaces/${workspaceId}/bases`, { name: 'Base' }),
      201
    );
    return ok<TableMeta>(await json('POST', `/api/bases/${base.id}/tables`, { name }), 201);
  }
  const field = (table: TableMeta, name: string) => {
    const f = table.fields.find((x) => x.name === name);
    if (!f) throw new Error(`no field ${name}`);
    return f;
  };
  const records = (tableId: string) => `/api/tables/${tableId}/records`;
  const choicesOf = async (fieldId: string): Promise<Choice[]> => {
    const [row] = await t.db.select().from(fields).where(eq(fields.id, fieldId));
    return ((row?.config ?? {}) as { choices?: Choice[] }).choices ?? [];
  };
  const fieldEvents = async (tableId: string) =>
    t.db
      .select()
      .from(outbox)
      .where(and(eq(outbox.tableId, tableId), eq(outbox.kind, 'field.updated')))
      .orderBy(asc(outbox.id));

  beforeAll(async () => {
    const created = await createWorkspace(t.db);
    owner = created.owner;
    workspaceId = created.workspace.id;
    api = await authedClient(t, owner);
  });

  it('creates missing options in the write, with palette colours and a field.updated event', async () => {
    const table = await newTable();
    const status = field(table, 'Status');
    const tags = await ok<FieldMeta>(
      await json('POST', `/api/tables/${table.id}/fields`, {
        name: 'Tags',
        type: 'multipleSelect',
      }),
      201
    );
    const [before] = await t.db.select().from(tables).where(eq(tables.id, table.id));

    const record = await ok<RecordData>(
      await json('POST', records(table.id), {
        typecast: true,
        fields: { [status.id]: ' Blocked ', [tags.id]: 'red, Blue, red' },
      }),
      201
    );
    const statusChoices = await choicesOf(status.id);
    expect(statusChoices.map((c) => c.name)).toEqual(['Todo', 'In progress', 'Done', 'Blocked']);
    expect(statusChoices[3]?.color).toBe(nextChoiceColor(3));
    expect(record.fields[status.id]).toBe(statusChoices[3]?.id);
    const tagChoices = await choicesOf(tags.id);
    expect(tagChoices.map((c) => [c.name, c.color])).toEqual([
      ['red', nextChoiceColor(0)],
      ['Blue', nextChoiceColor(1)],
    ]);
    expect(record.fields[tags.id]).toEqual(tagChoices.map((c) => c.id));

    const events = await fieldEvents(table.id);
    expect(events).toHaveLength(2);
    expect(events.map((e) => (e.payload as { field: FieldMeta }).field.id).sort()).toEqual(
      [status.id, tags.id].sort()
    );
    const [after] = await t.db.select().from(tables).where(eq(tables.id, table.id));
    expect(after?.schemaVersion).toBeGreaterThan(before?.schemaVersion ?? 0);

    // Known names (any case) add nothing; bulk PATCH takes the flag too.
    await ok(
      await json('PATCH', records(table.id), {
        typecast: true,
        records: [{ id: record.id, fields: { [status.id]: 'blocked', [tags.id]: ['Waiting'] } }],
      })
    );
    expect((await choicesOf(status.id)).map((c) => c.name)).toHaveLength(4);
    expect((await choicesOf(tags.id)).map((c) => c.name)).toEqual(['red', 'Blue', 'Waiting']);
    expect(await fieldEvents(table.id)).toHaveLength(3);
  });

  it('refuses unknown names without typecast, and keeps the default off', async () => {
    const table = await newTable();
    const status = field(table, 'Status');
    const res = await json('POST', records(table.id), { fields: { [status.id]: 'Nope' } });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('VALIDATION_FAILED');
    expect(await choicesOf(status.id)).toHaveLength(3);
  });

  it('refuses to create options without schema rights (TYPECAST_FORBIDDEN)', async () => {
    const table = await newTable();
    const status = field(table, 'Status');
    const editor = await authedClient(t, await addMember(t.db, workspaceId, 'editor'));
    const res = await json(
      'POST',
      records(table.id),
      { typecast: true, fields: { [status.id]: 'Blocked' } },
      editor
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; errors: { path: string }[] };
    expect(body.code).toBe('TYPECAST_FORBIDDEN');
    expect(body.errors).toEqual([
      expect.objectContaining({ path: `records.0.fields.${status.id}` }),
    ]);
    expect(await choicesOf(status.id)).toHaveLength(3);
    expect(await fieldEvents(table.id)).toHaveLength(0);
    // Existing names still work with the flag.
    await ok(
      await json(
        'POST',
        records(table.id),
        { typecast: true, fields: { [status.id]: 'done' } },
        editor
      ),
      201
    );
  });

  it('creates a new name once under 20 concurrent writes', async () => {
    const table = await newTable();
    const status = field(table, 'Status');
    const created = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        json('POST', records(table.id), {
          typecast: true,
          fields: { [status.id]: i % 2 ? 'Review' : 'REVIEW ' },
        })
      )
    );
    expect(created.map((r) => r.status)).toEqual(Array(20).fill(201));
    const choices = (await choicesOf(status.id)).filter((c) => c.name.toLowerCase() === 'review');
    expect(choices).toHaveLength(1);
    const values = await Promise.all(
      created.map(async (r) => ((await r.json()) as RecordData).fields[status.id])
    );
    expect(new Set(values)).toEqual(new Set([choices[0]?.id]));
    expect(await fieldEvents(table.id)).toHaveLength(1);
  });

  it('caps new options per call, options per field and the name length', async () => {
    const table = await newTable();
    const status = field(table, 'Status');
    const tooMany = Array.from({ length: MAX_TYPECAST_CHOICES + 1 }, (_, i) => ({
      fields: { [status.id]: `New ${i}` },
    }));
    const many = await json('POST', records(table.id), { typecast: true, records: tooMany });
    expect(many.status).toBe(422);
    expect(await choicesOf(status.id)).toHaveLength(3);
    await ok(
      await json('POST', records(table.id), {
        typecast: true,
        records: tooMany.slice(0, MAX_TYPECAST_CHOICES),
      }),
      201
    );
    expect(await choicesOf(status.id)).toHaveLength(3 + MAX_TYPECAST_CHOICES);

    const long = await json('POST', records(table.id), {
      typecast: true,
      fields: { [status.id]: 'x'.repeat(256) },
    });
    expect(long.status).toBe(422);
    expect(((await long.json()) as { errors: { path: string }[] }).errors[0]?.path).toBe(
      `records.0.fields.${status.id}`
    );

    // A field one short of the cap takes one more option, not two.
    const full = Array.from({ length: MAX_CHOICES - 1 }, (_, i) => ({
      id: newChoiceId(),
      name: `C${i}`,
      color: nextChoiceColor(i),
    }));
    await ok(await json('PATCH', `/api/fields/${status.id}`, { options: { choices: full } }));
    const two = await json('POST', records(table.id), {
      typecast: true,
      fields: { [status.id]: 'Last' },
    });
    expect(two.status).toBe(201);
    const over = await json('POST', records(table.id), {
      typecast: true,
      fields: { [status.id]: 'One too many' },
    });
    expect(over.status).toBe(422);
    expect(await choicesOf(status.id)).toHaveLength(MAX_CHOICES);
  });

  it('converts text to single and multiple select, keeping every distinct value', async () => {
    const table = await newTable();
    const name = field(table, 'Name');
    const notes = field(table, 'Notes');
    await ok(
      await json('POST', records(table.id), {
        records: [
          { fields: { [name.id]: 'Alpha', [notes.id]: 'x, y' } },
          { fields: { [name.id]: 'beta', [notes.id]: 'y' } },
          { fields: { [name.id]: 'Beta', [notes.id]: '' } },
          { fields: { [name.id]: 'Alpha' } },
        ],
      }),
      201
    );
    const single = await ok<FieldMeta>(
      await json('PATCH', `/api/fields/${name.id}`, { type: 'singleSelect' })
    );
    const multi = await ok<FieldMeta>(
      await json('PATCH', `/api/fields/${notes.id}`, { type: 'multipleSelect' })
    );
    const names = (f: FieldMeta) => (f.options as { choices: Choice[] }).choices.map((c) => c.name);
    expect(names(single)).toEqual(['Alpha', 'beta']);
    expect(names(multi)).toEqual(['x', 'y']);
    const list = await ok<{ records: RecordData[] }>(await json('GET', records(table.id)));
    const label = (f: FieldMeta, id: unknown) =>
      (f.options as { choices: Choice[] }).choices.find((c) => c.id === id)?.name;
    expect(list.records.map((r) => label(single, r.fields[name.id]))).toEqual([
      'Alpha',
      'beta',
      'beta',
      'Alpha',
    ]);
    expect(list.records[0]?.fields[notes.id]).toHaveLength(2);
  });

  it('converts 100k text rows to a single select within the conversion budget', {
    timeout: 120_000,
  }, async () => {
    const table = await newTable('Big');
    const name = field(table, 'Name');
    const [row] = await t.db.select().from(tables).where(eq(tables.id, table.id));
    const [nameRow] = await t.db.select().from(fields).where(eq(fields.id, name.id));
    if (!row || !nameRow) throw new Error('no table');
    await t.db.execute(sql`
      INSERT INTO ${qualified(row)} (id, ${sql.identifier(nameRow.dbColumn)})
      SELECT gen_random_uuid(), 'Value ' || (i % 500) FROM generate_series(1, 100000) AS i`);
    const started = performance.now();
    const converted = await ok<FieldMeta>(
      await json('PATCH', `/api/fields/${name.id}`, { type: 'singleSelect' })
    );
    const ms = performance.now() - started;
    expect((converted.options as { choices: Choice[] }).choices).toHaveLength(500);
    const [empty] = (
      await t.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM ${qualified(row)} WHERE ${sql.identifier(
          (await t.db.select().from(fields).where(eq(fields.id, name.id)))[0]?.dbColumn ?? ''
        )} IS NULL`
      )
    ).rows;
    expect(empty?.n).toBe(0);
    // Same budget as the other 100k-row schema changes' test (a background job comes later).
    expect(ms).toBeLessThan(10_000);
    process.stderr.write(`100k rows: convert text → single select ${ms.toFixed(0)} ms\n`);
  });
});
