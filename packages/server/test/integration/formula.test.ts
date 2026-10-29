import type {
  FieldMeta,
  FormulaOptions,
  LinkOptions,
  RecordData,
  TableMeta,
} from '@openrows/shared';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { fields, tables, type users } from '../../src/db/index.js';
import { drainComputed } from '../helpers/computed.js';
import { useTestDb } from '../helpers/db.js';
import { authedClient, createWorkspace } from '../helpers/factories.js';

/**
 * Formula fields: options normalized to the stored form, validation and cycles (422),
 * recompute on record writes (through other formulas and rollups), sort and filter on the
 * stored results, and a 100k-record benchmark.
 */
describe('formula fields', () => {
  const t = useTestDb();
  let owner: typeof users.$inferSelect;
  let workspaceId: string;
  let api: Awaited<ReturnType<typeof authedClient>>;

  const json = (method: string, path: string, body?: unknown) =>
    api.request(path, {
      method,
      headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  async function ok<T>(res: Response, status = 200): Promise<T> {
    if (res.status !== status) throw new Error(`${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  const newBase = async () =>
    ok<{ id: string }>(
      await json('POST', `/api/workspaces/${workspaceId}/bases`, { name: 'Base' }),
      201
    );
  const newTable = async (baseId: string, name: string) =>
    ok<TableMeta>(await json('POST', `/api/bases/${baseId}/tables`, { name }), 201);
  const primary = (table: TableMeta) => {
    const f = table.fields.find((x) => x.isPrimary);
    if (!f) throw new Error('no primary');
    return f.id;
  };
  const addField = (tableId: string, name: string, type: string, options: unknown = {}) =>
    json('POST', `/api/tables/${tableId}/fields`, { name, type, options });
  const field = async (tableId: string, name: string, type: string, options: unknown = {}) =>
    ok<FieldMeta>(await addField(tableId, name, type, options), 201);
  const records = (tableId: string) => `/api/tables/${tableId}/records`;
  const create = async (tableId: string, cells: Record<string, unknown>[]) =>
    (
      await ok<{ records: RecordData[] }>(
        await json('POST', records(tableId), { records: cells.map((fields) => ({ fields })) }),
        201
      )
    ).records;
  const update = async (tableId: string, id: string, cells: Record<string, unknown>) =>
    ok<{ records: RecordData[] }>(
      await json('PATCH', records(tableId), { records: [{ id, fields: cells }] })
    );
  const get = async (tableId: string, id: string) =>
    ok<RecordData>(await json('GET', `${records(tableId)}/${id}`));
  const query = async (tableId: string, body: unknown) =>
    ok<{ records: RecordData[]; total?: number }>(
      await json('POST', `${records(tableId)}/query`, body)
    );

  beforeAll(async () => {
    const created = await createWorkspace(t.db);
    owner = created.owner;
    workspaceId = created.workspace.id;
    api = await authedClient(t, owner);
  });

  it('stores the formula by field id and recomputes on writes, through other formulas', async () => {
    const base = await newBase();
    const items = await newTable(base.id, 'Items');
    const price = await field(items.id, 'Price', 'number', { precision: 2 });
    const qty = await field(items.id, 'Qty', 'number');
    const due = await field(items.id, 'Due', 'date');
    const total = await field(items.id, 'Total', 'formula', { formula: '{Price} * Qty' });
    const opts = total.options as FormulaOptions;
    expect(opts.formula).toBe(`{${price.id}} * {${qty.id}}`);
    expect(opts.resultType).toBe('number');
    expect(opts.isValid).toBe(true);
    expect([...opts.referencedFieldIds].sort()).toEqual([price.id, qty.id].sort());
    const label = await field(items.id, 'Label', 'formula', {
      formula: `IF({Total} > 100, "big: " & {Name}, "small") & " / " & DATETIME_FORMAT(DATEADD({Due}, 1, "month"), "YYYY-MM-DD")`,
    });
    expect((label.options as FormulaOptions).resultType).toBe('text');
    const id = await field(items.id, 'Id', 'formula', { formula: 'RECORD_ID()' });

    const [a, b] = await create(items.id, [
      { [primary(items)]: 'Anvil', [price.id]: 60, [qty.id]: 2, [due.id]: '2026-01-31' },
      { [primary(items)]: 'Bolt', [price.id]: 0.5 },
    ]);
    if (!a || !b) throw new Error('no records');
    expect(a.fields[total.id]).toBe(120);
    expect(a.fields[label.id]).toBe('big: Anvil / 2026-02-28');
    expect(a.fields[id.id]).toBe(a.id);
    expect(b.fields[total.id]).toBe(0);
    expect(b.fields[label.id]).toBe('small / ');

    // A write recomputes the formula and the formula reading it, in the response too.
    const res = await update(items.id, a.id, { [qty.id]: 1 });
    expect(res.records[0]?.fields[total.id]).toBe(60);
    expect(res.records[0]?.fields[label.id]).toBe('small / 2026-02-28');
    // A renamed field keeps the formula working (it's stored by id).
    await ok(await json('PATCH', `/api/fields/${price.id}`, { name: 'Unit price' }));
    await update(items.id, a.id, { [price.id]: 200 });
    expect((await get(items.id, a.id)).fields[total.id]).toBe(200);

    // Reconfiguring recomputes every record; the stored form is accepted back as is.
    const edited = await ok<FieldMeta>(
      await json('PATCH', `/api/fields/${total.id}`, {
        options: { formula: `{${price.id}} * 2 + {${qty.id}}` },
      })
    );
    expect((edited.options as FormulaOptions).formula).toBe(`{${price.id}} * 2 + {${qty.id}}`);
    expect((await get(items.id, a.id)).fields[total.id]).toBe(401);
    expect((await get(items.id, b.id)).fields[total.id]).toBe(1);

    // Sort and filter on the stored results.
    const sorted = await query(items.id, {
      query: { sorts: [{ fieldId: total.id, direction: 'desc' }] },
    });
    expect(sorted.records.map((r) => r.id)).toEqual([a.id, b.id]);
    const filtered = await query(items.id, {
      query: { filter: { conditions: [{ fieldId: total.id, operator: '>', value: 10 }] } },
    });
    expect(filtered.records.map((r) => r.id)).toEqual([a.id]);

    // Errors show as #ERROR! and don't fail the write.
    const ratio = await field(items.id, 'Ratio', 'formula', { formula: '{Total} / {Qty}' });
    expect((await get(items.id, b.id)).fields[ratio.id]).toBe('#ERROR!');
    expect((await get(items.id, a.id)).fields[ratio.id]).toBe(401);

    // A field a formula reads can't be deleted (409 with the formula's id).
    const del = await json('DELETE', `/api/fields/${qty.id}`);
    expect(del.status).toBe(409);
    const problem = (await del.json()) as { fieldIds?: string[] };
    expect(problem.fieldIds).toEqual(expect.arrayContaining([total.id]));
  });

  it('rejects formulas that do not parse, do not type-check or are circular', async () => {
    const base = await newBase();
    const table = await newTable(base.id, 'T');
    const n = await field(table.id, 'N', 'number');
    const expect422 = async (res: Response, message: RegExp) => {
      expect(res.status).toBe(422);
      const body = (await res.json()) as { errors?: { path: string; message: string }[] };
      expect(body.errors?.[0]?.path).toBe('options.formula');
      expect(body.errors?.[0]?.message).toMatch(message);
    };
    await expect422(await addField(table.id, 'Bad', 'formula', { formula: '1 +' }), /./);
    await expect422(await addField(table.id, 'Empty', 'formula', {}), /Write a formula/);
    await expect422(
      await addField(table.id, 'Unknown', 'formula', { formula: 'NOPE(1)' }),
      /Unknown function/
    );
    await expect422(
      await addField(table.id, 'Typed', 'formula', { formula: '{N} + "a"' }),
      /needs numbers/
    );
    await expect422(await addField(table.id, 'Missing', 'formula', { formula: '{Nope} + 1' }), /./);
    const self = await addField(table.id, 'Self', 'formula', { formula: '{Self} + 1' });
    await expect422(self, /circular reference/);
    const a = await field(table.id, 'A', 'formula', { formula: '{N} + 1' });
    const b = await field(table.id, 'B', 'formula', { formula: '{A} * 2' });
    await expect422(
      await json('PATCH', `/api/fields/${a.id}`, { options: { formula: '{B} + 1' } }),
      /circular reference \(A → B → A\)/
    );
    expect(b.id).toBeTruthy();
    // The primary field can't become a formula (yet).
    const res = await json('PATCH', `/api/fields/${primary(table)}`, {
      type: 'formula',
      options: { formula: '{N} & ""' },
    });
    expect(res.status).toBe(422);
    expect(n.id).toBeTruthy();
  });

  it('reads rollups and link names, and a converted field becomes a formula', async () => {
    const base = await newBase();
    const projects = await newTable(base.id, 'Projects');
    const tasks = await newTable(base.id, 'Tasks');
    const hours = await field(tasks.id, 'Hours', 'number');
    const link = await field(tasks.id, 'Project', 'link', { linkedTableId: projects.id });
    const inverse = (link.options as LinkOptions).inverseLinkFieldId as string;
    const sum = await field(projects.id, 'Sum', 'rollup', {
      recordLinkFieldId: inverse,
      fieldIdInLinkedTable: hours.id,
      function: 'SUM',
    });
    const days = await field(projects.id, 'Days', 'formula', { formula: 'ROUND({Sum} / 8, 1)' });
    const names = await field(tasks.id, 'Where', 'formula', {
      formula: 'ARRAYJOIN({Project}, "+") & ": " & {Hours}',
    });
    const [p] = await create(projects.id, [{ [primary(projects)]: 'Apollo' }]);
    if (!p) throw new Error('no project');
    const [t1] = await create(tasks.id, [{ [hours.id]: 12, [link.id]: [p.id] }]);
    if (!t1) throw new Error('no task');
    expect((await get(projects.id, p.id)).fields[sum.id]).toBe(12);
    expect((await get(projects.id, p.id)).fields[days.id]).toBe(1.5);
    expect((await get(tasks.id, t1.id)).fields[names.id]).toBe('Apollo: 12');
    await update(tasks.id, t1.id, { [hours.id]: 4 });
    expect((await get(projects.id, p.id)).fields[days.id]).toBe(0.5);

    // Converting a number field to a formula computes it for every record.
    const conv = await ok<FieldMeta>(
      await json('PATCH', `/api/fields/${hours.id}`, {
        type: 'formula',
        options: { formula: 'LEN({Project} & "")' },
      })
    );
    expect(conv.type).toBe('formula');
    expect((await get(tasks.id, t1.id)).fields[hours.id]).toBe(6);
  });

  it('creates and computes a formula field on 100k records in under 30 s', async () => {
    const base = await newBase();
    const table = await newTable(base.id, 'Big');
    const price = await field(table.id, 'Price', 'number');
    const qty = await field(table.id, 'Qty', 'number');
    const N = 100_000;
    const [loc] = await t.db
      .select({ schema: tables.dbSchema, name: tables.dbTable })
      .from(tables)
      .where(eq(tables.id, table.id));
    const cols = await t.db
      .select({ id: fields.id, column: fields.dbColumn })
      .from(fields)
      .where(eq(fields.tableId, table.id));
    const col = (id: string) => cols.find((c) => c.id === id)?.column ?? '';
    if (!loc) throw new Error('no table');
    // Seed the rows directly (the API's 1,000-record writes would dominate the test).
    await t.db.execute(sql`
      INSERT INTO ${sql.identifier(loc.schema)}.${sql.identifier(loc.name)}
             (id, ${sql.identifier(col(primary(table)))}, ${sql.identifier(col(price.id))}, ${sql.identifier(col(qty.id))})
      SELECT gen_random_uuid(), 'Item ' || i, (i % 1000) / 10.0, i % 7 FROM generate_series(1, ${N}) AS i`);

    const started = Date.now();
    const total = await field(table.id, 'Total', 'formula', {
      formula: 'IF({Qty} > 0, ROUND({Price} * {Qty} * 1.2, 2), BLANK()) & ""',
    });
    // Past the sync limit: the request returns at once and the worker computes it.
    expect(total.recomputing).toBe(true);
    await drainComputed(t.appDb, t.db);
    const elapsed = Date.now() - started;
    const [totalCol] = await t.db
      .select({ column: fields.dbColumn })
      .from(fields)
      .where(eq(fields.id, total.id));
    console.info(
      `formula: created, then computed by the worker over 100k records in ${elapsed} ms`
    );
    expect(elapsed).toBeLessThan(30_000);
    const { rows } = await t.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM ${sql.identifier(loc.schema)}.${sql.identifier(loc.name)}
       WHERE ${sql.identifier(totalCol?.column ?? '')} IS NOT NULL`);
    // Qty = 0 for one record in 7 gives blank.
    expect(rows[0]?.n).toBe(N - Math.floor(N / 7));
  }, 120_000);
});
