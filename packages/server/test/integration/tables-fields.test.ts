import {
  conversionOptions,
  convertValue,
  FIELD_TYPE_NAMES,
  type FieldMeta,
  type FieldTypeName,
  getFieldType,
  type TableMeta,
} from '@openrows/shared';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { uuidv7 } from 'uuidv7';
import { beforeAll, describe, expect, it } from 'vitest';
import { inScope } from '../../src/authz/scope.js';
import { qualified, readExpression, writeColumn } from '../../src/data/columns.js';
import { fields, outbox, tables, type users } from '../../src/db/index.js';
import { useTestDb } from '../helpers/db.js';
import { authedClient, createTenant, createWorkspace } from '../helpers/factories.js';

/**
 * Bases, tables and fields on the ADR-001 storage engine: metadata and DDL in one
 * transaction through the DDL manager, outbox events, the trash, duplication, every type
 * conversion the registry allows, and the 100k-row budget. The app runs as openrows_app.
 */
describe('bases, tables and fields', () => {
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
    return (status === 204 ? undefined : await res.json()) as T;
  }

  const newBase = async (name = 'Base') =>
    ok<{ id: string }>(await json('POST', `/api/workspaces/${workspaceId}/bases`, { name }), 201);
  const newTable = async (baseId: string, name = 'Tasks') =>
    ok<TableMeta>(await json('POST', `/api/bases/${baseId}/tables`, { name }), 201);
  const newField = async (tableId: string, body: Record<string, unknown>) =>
    ok<FieldMeta>(await json('POST', `/api/tables/${tableId}/fields`, body), 201);

  async function columnsOf(tableId: string): Promise<string[]> {
    const [row] = await t.db.select().from(tables).where(eq(tables.id, tableId));
    if (!row) throw new Error('no table');
    const { rows } = await t.db.execute<{ column_name: string }>(
      sql`SELECT column_name FROM information_schema.columns
           WHERE table_schema = ${row.dbSchema} AND table_name = ${row.dbTable}
           ORDER BY ordinal_position`
    );
    return rows.map((r) => r.column_name);
  }

  const location = async (tableId: string) => {
    const [row] = await t.db.select().from(tables).where(eq(tables.id, tableId));
    if (!row) throw new Error('no table');
    return row;
  };
  const fieldRow = async (id: string) => {
    const [row] = await t.db.select().from(fields).where(eq(fields.id, id));
    if (!row) throw new Error('no field');
    return row;
  };
  const events = async (tableId: string) =>
    (await t.db.select().from(outbox).where(eq(outbox.tableId, tableId))).map((e) => e.kind);

  beforeAll(async () => {
    const created = await createWorkspace(t.db);
    owner = created.owner;
    workspaceId = created.workspace.id;
    api = await authedClient(t, owner);
  });

  it('creates, updates and trashes a base, with its record schema and outbox events', async () => {
    const base = await newBase('CRM');
    const { rows } = await t.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = ${`b_${base.id.replaceAll('-', '')}`}`
    );
    expect(rows[0]?.n).toBe(1);
    const patched = await ok<{ name: string; color: string }>(
      await json('PATCH', `/api/bases/${base.id}`, { name: 'Sales', color: '#146C55' })
    );
    expect(patched).toMatchObject({ name: 'Sales', color: '#146C55' });
    await ok(await json('DELETE', `/api/bases/${base.id}`), 204);
    expect((await json('GET', `/api/bases/${base.id}`)).status).toBe(404);
    const kinds = (await t.db.select().from(outbox).where(eq(outbox.baseId, base.id))).map(
      (e) => e.kind
    );
    expect(kinds).toEqual(['base.created', 'base.updated', 'base.deleted']);
  });

  it('creates a table with default fields, a grid view and a physical record table', async () => {
    const base = await newBase();
    const table = await newTable(base.id);
    expect(table.fields.map((f) => [f.name, f.type, f.isPrimary])).toEqual([
      ['Name', 'singleLineText', true],
      ['Notes', 'longText', false],
      ['Status', 'singleSelect', false],
    ]);
    const status = table.fields[2]?.options as { choices: { name: string }[] };
    expect(status.choices.map((c) => c.name)).toEqual(['Todo', 'In progress', 'Done']);
    const cols = await columnsOf(table.id);
    expect(cols.slice(0, 7)).toEqual([
      'id',
      'version',
      'created_at',
      'created_by',
      'updated_at',
      'updated_by',
      'deleted_at',
    ]);
    const physical = await Promise.all(table.fields.map((f) => fieldRow(f.id)));
    expect(cols.slice(7)).toEqual(physical.map((f) => f.dbColumn));
    expect(await events(table.id)).toEqual(['table.created']);

    const list = await ok<{ tables: { name: string }[] }>(
      await json('GET', `/api/bases/${base.id}/tables`)
    );
    expect(list.tables.map((x) => x.name)).toEqual(['Tasks']);
    expect((await json('POST', `/api/bases/${base.id}/tables`, { name: 'tasks' })).status).toBe(
      409
    );

    const renamed = await ok<TableMeta>(
      await json('PATCH', `/api/tables/${table.id}`, { name: 'Projects' })
    );
    expect(renamed.name).toBe('Projects');
    await ok(await json('DELETE', `/api/tables/${table.id}`), 204);
    expect((await json('GET', `/api/tables/${table.id}`)).status).toBe(404);
    expect(await events(table.id)).toEqual(['table.created', 'table.updated', 'table.deleted']);
  });

  it('creates a table with only a named primary field, for an import (#80)', async () => {
    const base = await newBase();
    const table = await ok<TableMeta>(
      await json('POST', `/api/bases/${base.id}/tables`, {
        name: 'tasks',
        primaryFieldName: ' Title ',
      }),
      201
    );
    expect(table.fields.map((f) => [f.name, f.type, f.isPrimary])).toEqual([
      ['Title', 'singleLineText', true],
    ]);
    expect((await columnsOf(table.id)).length).toBe(8);
    const blank = await json('POST', `/api/bases/${base.id}/tables`, {
      name: 'Other',
      primaryFieldName: '  ',
    });
    expect(blank.status).toBe(422);
  });

  it('adds, renames, reorders, trashes and restores fields', async () => {
    const base = await newBase();
    const table = await newTable(base.id);
    const field = await newField(table.id, {
      name: 'Estimate',
      type: 'number',
      options: { precision: 2 },
    });
    expect(field).toMatchObject({ type: 'number', options: { precision: 2 }, position: 4 });
    const row = await fieldRow(field.id);
    expect(await columnsOf(table.id)).toContain(row.dbColumn);
    const typeOf = async () => {
      const { rows } = await t.db.execute<{ data_type: string }>(
        sql`SELECT data_type FROM information_schema.columns WHERE column_name = ${row.dbColumn}`
      );
      return rows[0]?.data_type;
    };
    expect(await typeOf()).toBe('numeric');

    // Renames and reorders are metadata only: the column stays.
    const moved = await ok<FieldMeta>(
      await json('PATCH', `/api/fields/${field.id}`, { name: 'Points', position: 0.5 })
    );
    expect(moved).toMatchObject({ name: 'Points', position: 0.5 });
    expect((await fieldRow(field.id)).dbColumn).toBe(row.dbColumn);
    const reread = await ok<TableMeta>(await json('GET', `/api/tables/${table.id}`));
    expect(reread.fields.map((f) => f.name)).toEqual(['Points', 'Name', 'Notes', 'Status']);

    // Names are unique per table, case-insensitively; the primary field stays.
    expect((await json('PATCH', `/api/fields/${field.id}`, { name: 'name' })).status).toBe(409);
    const primary = reread.fields.find((f) => f.isPrimary);
    expect((await json('DELETE', `/api/fields/${primary?.id}`)).status).toBe(409);

    await ok(await json('DELETE', `/api/fields/${field.id}`), 204);
    expect((await json('PATCH', `/api/fields/${field.id}`, { name: 'X' })).status).toBe(404);
    expect(await columnsOf(table.id)).toContain(row.dbColumn);
    const trash = await ok<{ fields: FieldMeta[] }>(
      await json('GET', `/api/tables/${table.id}/fields/trash`)
    );
    expect(trash.fields.map((f) => f.id)).toEqual([field.id]);
    const restored = await ok<FieldMeta>(
      await json('POST', `/api/tables/${table.id}/fields/${field.id}/restore`)
    );
    expect(restored).toMatchObject({ id: field.id, deletedAt: null });
    expect((await json('POST', `/api/tables/${table.id}/fields/${field.id}/restore`)).status).toBe(
      404
    );
    const schemaVersion = (await location(table.id)).schemaVersion;
    expect(schemaVersion).toBeGreaterThan(reread.schemaVersion);
    expect(await events(table.id)).toEqual([
      'table.created',
      'field.created',
      'field.updated',
      'field.deleted',
      'field.restored',
    ]);
  });

  it('rolls metadata and DDL back together', async () => {
    const base = await newBase();
    const table = await newTable(base.id);
    const before = await columnsOf(table.id);
    const res = await json('POST', `/api/tables/${table.id}/fields`, {
      name: 'Bad',
      type: 'rating',
      options: { max: 99 },
    });
    expect(res.status).toBe(422);
    expect(await columnsOf(table.id)).toEqual(before);
    expect(await events(table.id)).toEqual(['table.created']);
  });

  it('gives up with 503 when the table stays locked longer than lock_timeout', async () => {
    const base = await newBase();
    const table = await newTable(base.id);
    const loc = await location(table.id);
    const reader = new pg.Client({ connectionString: t.url });
    await reader.connect();
    try {
      await reader.query('BEGIN');
      await reader.query(`SELECT * FROM "${loc.dbSchema}"."${loc.dbTable}"`);
      const started = Date.now();
      const res = await json('POST', `/api/tables/${table.id}/fields`, {
        name: 'Blocked',
        type: 'number',
      });
      expect(res.status).toBe(503);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await reader.query('ROLLBACK');
      await reader.end();
    }
    const names = (await ok<TableMeta>(await json('GET', `/api/tables/${table.id}`))).fields.map(
      (f) => f.name
    );
    expect(names).not.toContain('Blocked');
  });

  it("keeps DDL away from openrows_app and from other tenants' tables", async () => {
    const other = await createTenant(t.db);
    const base = await newBase();
    const table = await newTable(base.id);
    const loc = await location(table.id);
    const app = new pg.Client({ connectionString: t.appUrl });
    await app.connect();
    try {
      await expect(
        app.query(`ALTER TABLE "${loc.dbSchema}"."${loc.dbTable}" ADD COLUMN x text`)
      ).rejects.toMatchObject({ code: '42501' });
      await expect(app.query(`CREATE TABLE "${loc.dbSchema}".x (id int)`)).rejects.toMatchObject({
        code: '42501',
      });
      // Scoped to this workspace, the DDL functions don't find the other tenant's table.
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
      await expect(
        app.query(`SELECT ddl_add_column($1, $2, 'text', false)`, [
          other.table.id,
          `f_${'0'.repeat(32)}`,
        ])
      ).rejects.toThrow(/not found in the current workspace/);
      await app.query('ROLLBACK');
      // Names that aren't f_<hex>, and types off the list, are refused.
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
      await expect(
        app.query(`SELECT ddl_add_column($1, 'id; DROP TABLE x', 'text', false)`, [table.id])
      ).rejects.toThrow(/invalid column name/);
      await app.query('ROLLBACK');
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
      await expect(
        app.query(`SELECT ddl_add_column($1, $2, 'text; DROP TABLE x', false)`, [
          table.id,
          `f_${'0'.repeat(32)}`,
        ])
      ).rejects.toThrow(/invalid column type/);
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }
  });

  it('duplicates a table with or without its records', async () => {
    const base = await newBase();
    const table = await newTable(base.id);
    await newField(table.id, { name: 'No.', type: 'autoNumber' });
    await newField(table.id, { name: 'Created', type: 'createdTime' });
    const loc = await location(table.id);
    const name = await fieldRow(table.fields[0]?.id ?? '');
    await t.db.execute(sql`
      INSERT INTO ${qualified(loc)} (id, ${sql.identifier(name.dbColumn)}, created_by)
      VALUES (${uuidv7()}, 'a', ${owner.id}), (${uuidv7()}, 'b', ${owner.id})`);

    const empty = await ok<TableMeta>(
      await json('POST', `/api/tables/${table.id}/duplicate`, {}),
      201
    );
    expect(empty.name).toBe('Tasks copy');
    expect(empty.fields.map((f) => f.name)).toEqual(['Name', 'Notes', 'Status', 'No.', 'Created']);
    const emptyLoc = await location(empty.id);
    const count = async (l: typeof loc) =>
      (await t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${qualified(l)}`))
        .rows[0]?.n;
    expect(await count(emptyLoc)).toBe(0);

    const full = await ok<TableMeta>(
      await json('POST', `/api/tables/${table.id}/duplicate`, { includeRecords: true }),
      201
    );
    expect(full.name).toBe('Tasks copy 2');
    const fullLoc = await location(full.id);
    const copyName = await fieldRow(full.fields[0]?.id ?? '');
    const copyNo = await fieldRow(full.fields[3]?.id ?? '');
    const { rows } = await t.db.execute<{ name: string; no: string; created_by: string }>(
      sql`SELECT ${sql.identifier(copyName.dbColumn)} AS name, ${sql.identifier(copyNo.dbColumn)} AS no,
                 created_by FROM ${qualified(fullLoc)} ORDER BY id`
    );
    expect(rows).toEqual([
      { name: 'a', no: '1', created_by: owner.id },
      { name: 'b', no: '2', created_by: owner.id },
    ]);
  });

  // ---------------------------------------------------------------------------------------
  // Every conversion pair the registry allows (it allows all of them: convertValue is total)
  // ---------------------------------------------------------------------------------------

  const CHOICES = [
    { id: 'c1', name: 'Hello 42', color: 'green' },
    { id: 'c2', name: 'Done', color: 'blue' },
    { id: 'c3', name: 'Red', color: 'red' },
  ];
  const OPTIONS: Partial<Record<FieldTypeName, unknown>> = {
    number: { precision: 2 },
    singleSelect: { choices: CHOICES },
    multipleSelect: { choices: CHOICES },
    dateTime: { timeZone: 'Europe/Berlin' },
  };
  const SAMPLES: Partial<Record<FieldTypeName, unknown>> = {
    singleLineText: 'Hello 42',
    longText: 'Line 1\nDone',
    number: 42.5,
    currency: 19.99,
    percent: 0.25,
    checkbox: true,
    date: '2026-10-25',
    dateTime: '2026-10-25T14:30:00Z',
    duration: 5400,
    rating: 3,
    singleSelect: 'Done',
    multipleSelect: ['Red', 'Done'],
    email: 'ada@example.com',
    url: 'https://openrows.io/docs',
    phone: '+1 555 0100',
    attachment: [{ id: 'a1', filename: 'plan.pdf', size: 1200, type: 'application/pdf' }],
  };

  // Links convert by matching the linked table's primary field, which the pure convertValue
  // can't model: their conversions are tested in links.test.ts.
  // Lookups, rollups and counts need a link field in their options (computed.test.ts).
  const CONVERTIBLE = FIELD_TYPE_NAMES.filter(
    (type) => type !== 'link' && getFieldType(type).storage.kind !== 'computed'
  );

  describe.each(CONVERTIBLE.map((from) => [from]))('from %s', (from) => {
    it('converts to every type like convertValue', { timeout: 60_000 }, async () => {
      const base = await newBase(`Conversions from ${from}`);
      const table = await newTable(base.id);
      const loc = await location(table.id);
      const fromOptions = getFieldType(from).optionsSchema.parse(OPTIONS[from] ?? {});
      const created: FieldMeta[] = [];
      for (const to of CONVERTIBLE) {
        created.push(
          await newField(table.id, { name: `to ${to}`, type: from, options: OPTIONS[from] ?? {} })
        );
      }
      // Two records: one with a value in every field, one empty.
      const def = getFieldType(from);
      const value = def.coerce(SAMPLES[from] ?? null, fromOptions);
      if (SAMPLES[from] !== undefined) expect(value, `sample for ${from}`).not.toBeNull();
      const ids = [crypto.randomUUID(), crypto.randomUUID()];
      await t.db.execute(sql`
        INSERT INTO ${qualified(loc)} (id, created_by, updated_by)
        VALUES (${ids[0]}, ${owner.id}, ${owner.id}), (${ids[1]}, ${owner.id}, ${owner.id})`);
      if (def.storage.kind === 'column') {
        await t.db.transaction(async (tx) => {
          for (const f of created) {
            const row = await fieldRow(f.id);
            const v = def.toStorage(value as never, fromOptions);
            await writeColumn(tx, loc, row.dbColumn, def.storage.sqlType, [
              { id: ids[0] ?? '', v },
            ]);
          }
        });
      }

      const read = async (fieldId: string) => {
        const row = await fieldRow(fieldId);
        const { rows } = await t.db.execute<{ id: string; v: unknown }>(
          sql`SELECT id, ${readExpression(row)} AS v FROM ${qualified(loc)} ORDER BY id`
        );
        const typed = getFieldType(row.type as FieldTypeName);
        return new Map(rows.map((r) => [r.id, typed.fromStorage(r.v, row.config)]));
      };

      for (const [i, to] of CONVERTIBLE.entries()) {
        const field = created[i];
        if (!field) throw new Error('missing field');
        const before = await read(field.id);
        const res = await json('PATCH', `/api/fields/${field.id}`, {
          type: to,
          options: OPTIONS[to] ?? {},
        });
        expect(res.status, `${from} → ${to}: ${res.status === 200 ? '' : await res.text()}`).toBe(
          200
        );
        const after = await read(field.id);
        const target = getFieldType(to);
        // Into a select, values the requested choices can't hold become new choices.
        const toOptions = target.optionsSchema.parse(((await res.json()) as FieldMeta).options);
        const names = (o: unknown) =>
          (o as { choices?: { name: string }[] }).choices?.map((c) => c.name);
        expect(names(toOptions), `${from} → ${to} choices`).toEqual(
          names(
            conversionOptions(
              [...before.values()],
              { type: from, options: fromOptions },
              { type: to, options: target.optionsSchema.parse(OPTIONS[to] ?? {}) }
            )
          )
        );
        for (const id of ids) {
          const label = `${from} → ${to} (${id === ids[0] ? 'value' : 'empty'})`;
          if (target.readOnly) {
            // Computed targets read their identity or system column: never stored input.
            expect(after.get(id), label).not.toBeNull();
            continue;
          }
          const expected = convertValue(
            before.get(id) ?? null,
            { type: from, options: fromOptions },
            { type: to, options: toOptions }
          );
          const normalized = target.fromStorage(
            target.toStorage(expected as never, toOptions),
            toOptions
          );
          expect(after.get(id), label).toEqual(normalized);
        }
      }
      // Old columns are gone: system columns plus one column per stored field remain.
      const live = await Promise.all(created.map((f) => fieldRow(f.id)));
      const cols = await columnsOf(table.id);
      for (const f of live) {
        const stored = getFieldType(f.type as FieldTypeName).storage.kind !== 'system';
        expect(cols.includes(f.dbColumn), f.type).toBe(stored);
      }
      expect(cols).toHaveLength(7 + 3 + live.filter((f) => cols.includes(f.dbColumn)).length);
    });
  });

  // ---------------------------------------------------------------------------------------
  // ADR-001 budget: adding or altering a field on a 100k-row table takes less than 2 s
  // ---------------------------------------------------------------------------------------

  it('adds, renames and trashes a field on a 100k-row table in under 2 s', {
    timeout: 120_000,
  }, async () => {
    const base = await newBase('Big');
    const table = await newTable(base.id);
    const loc = await location(table.id);
    const name = await fieldRow(table.fields[0]?.id ?? '');
    await t.db.execute(sql`
      INSERT INTO ${qualified(loc)} (id, ${sql.identifier(name.dbColumn)})
      SELECT gen_random_uuid(), 'Row ' || i FROM generate_series(1, 100000) AS i`);
    await t.db.execute(sql`ANALYZE ${qualified(loc)}`);

    const timed = async (fn: () => Response | Promise<Response>, status: number) => {
      const started = performance.now();
      const res = await fn();
      const ms = performance.now() - started;
      expect(res.status).toBe(status);
      return { ms, res };
    };
    const add = await timed(
      () => json('POST', `/api/tables/${table.id}/fields`, { name: 'Score', type: 'number' }),
      201
    );
    expect(add.ms).toBeLessThan(2000);
    const field = (await add.res.json()) as FieldMeta;
    const rename = await timed(
      () => json('PATCH', `/api/fields/${field.id}`, { name: 'Points' }),
      200
    );
    expect(rename.ms).toBeLessThan(2000);
    const choices = (table.fields[2]?.options as { choices: unknown[] } | undefined)?.choices ?? [];
    const choice = await timed(
      () =>
        json('PATCH', `/api/fields/${table.fields[2]?.id}`, {
          options: {
            choices: [...choices, { id: 'new', name: 'Blocked', color: 'red' }],
          },
        }),
      200
    );
    expect(choice.ms).toBeLessThan(2000);
    const trash = await timed(() => json('DELETE', `/api/fields/${field.id}`), 204);
    expect(trash.ms).toBeLessThan(2000);
    // A type change rewrites every value in JS (ADR-001's in-place path); measured, not
    // budgeted: big conversions move to a background job later.
    const convert = await timed(
      () => json('PATCH', `/api/fields/${name.id}`, { type: 'longText' }),
      200
    );
    process.stderr.write(
      `100k rows: add ${add.ms.toFixed(0)} ms, rename ${rename.ms.toFixed(0)} ms, ` +
        `add choice ${choice.ms.toFixed(0)} ms, trash ${trash.ms.toFixed(0)} ms, ` +
        `convert text → long text ${convert.ms.toFixed(0)} ms\n`
    );
  });

  it('scopes the outbox to its workspace under RLS', async () => {
    const seen = await inScope(t.appDb, { userId: owner.id, workspaceId }, (tx) =>
      tx.select({ ws: outbox.workspaceId }).from(outbox)
    );
    expect(new Set(seen.map((r) => r.ws))).toEqual(new Set([workspaceId]));
  });
});
