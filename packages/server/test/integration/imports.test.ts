import {
  type FieldMeta,
  type ImportJob,
  parseCsv,
  type RecordData,
  type TableMeta,
  type ViewMeta,
} from '@openrows/shared';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { qualified } from '../../src/data/columns.js';
import { tables, type users } from '../../src/db/index.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, createSession, createWorkspace } from '../helpers/factories.js';

/**
 * CSV import and export through the API as openrows_app: the mapping checks, the job and
 * its progress, type coercion through the registry, a 100k-row import, and the streaming export
 * of a view (filter, sorts, hidden fields, column order, formula-injection guard).
 */
describe('CSV import and export', () => {
  const t = useTestDb();
  let owner: typeof users.$inferSelect;
  let workspaceId: string;
  let app: ReturnType<typeof testApp>;
  let ownerCookie: string;

  const request = (method: string, path: string, body?: unknown, cookie = ownerCookie) =>
    app.app.request(path, {
      method,
      headers: {
        origin: app.config.appUrl,
        cookie: `${SESSION_COOKIE}=${cookie}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  async function ok<T>(res: Response, status = 200): Promise<T> {
    if (res.status !== status) throw new Error(`${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  async function newTable(name = 'Tasks') {
    const base = await ok<{ id: string }>(
      await request('POST', `/api/workspaces/${workspaceId}/bases`, { name: 'Base' }),
      201
    );
    return ok<TableMeta>(await request('POST', `/api/bases/${base.id}/tables`, { name }), 201);
  }
  const tableMeta = async (id: string) => ok<TableMeta>(await request('GET', `/api/tables/${id}`));
  const fieldOf = (table: TableMeta, name: string): FieldMeta => {
    const f = table.fields.find((x) => x.name === name);
    if (!f) throw new Error(`no field ${name}`);
    return f;
  };

  /** Starts an import and waits for its job to finish. */
  async function runImport(tableId: string, body: Record<string, unknown>, cookie = ownerCookie) {
    const job = await ok<ImportJob>(
      await request('POST', `/api/tables/${tableId}/imports`, body, cookie),
      201
    );
    expect(job).toMatchObject({ status: 'running', tableId });
    await app.runJob(job.id);
    return ok<ImportJob>(
      await request('GET', `/api/tables/${tableId}/imports/${job.id}`, undefined, cookie)
    );
  }

  /** Every live record, oldest first. */
  async function allRecords(tableId: string): Promise<RecordData[]> {
    const out: RecordData[] = [];
    let cursor: string | null = null;
    do {
      const qs: string = cursor ? `&cursor=${cursor}` : '';
      const page: { records: RecordData[]; nextCursor: string | null } = await ok(
        await request('GET', `/api/tables/${tableId}/records?limit=1000${qs}`)
      );
      out.push(...page.records);
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }

  async function exportCsv(tableId: string, query: Record<string, string> = {}) {
    const qs = new URLSearchParams(query).toString();
    return request('GET', `/api/tables/${tableId}/export.csv${qs ? `?${qs}` : ''}`);
  }

  beforeAll(async () => {
    const created = await createWorkspace(t.db);
    owner = created.owner;
    workspaceId = created.workspace.id;
    app = testApp({ db: t.appDb });
    ownerCookie = await createSession(t.db, owner);
  });

  describe('import', () => {
    it('maps columns to existing and new fields with inferred types', async () => {
      const table = await newTable();
      const csv = [
        'Title,Estimate,Due,Done,Status,Ignored',
        'Write spec,3.5,2024-01-31,yes,Todo,x',
        '"Ship, then rest",12,2024-02-01,no,Done,y',
        'Bad number,lots,not a date,yes,Unknown,z',
        ',,,,,',
      ].join('\r\n');
      const job = await runImport(table.id, {
        csv,
        columns: [
          { index: 0, fieldId: fieldOf(table, 'Name').id },
          { index: 1, newField: { name: 'Estimate', type: 'number', options: { precision: 1 } } },
          { index: 2, newField: { name: 'Due', type: 'date' } },
          { index: 3, newField: { name: 'Done', type: 'checkbox' } },
          { index: 4, fieldId: fieldOf(table, 'Status').id },
        ],
      });
      expect(job).toMatchObject({
        status: 'done',
        totalRows: 4,
        processedRows: 4,
        error: null,
      });
      // "lots", "not a date" and the unknown status can't be read; they stay empty.
      expect(job.skippedCells).toBe(3);
      expect(job.createdFieldIds).toHaveLength(3);
      expect(job.finishedAt).not.toBeNull();

      const meta = await tableMeta(table.id);
      expect(meta.fields.map((f) => [f.name, f.type])).toEqual(
        expect.arrayContaining([
          ['Estimate', 'number'],
          ['Due', 'date'],
          ['Done', 'checkbox'],
        ])
      );
      const status = fieldOf(meta, 'Status');
      const doneChoice = (
        status.options as { choices: { id: string; name: string }[] }
      ).choices.find((c) => c.name === 'Done');
      const rows = await allRecords(table.id);
      const v = (r: RecordData | undefined, name: string) => r?.fields[fieldOf(meta, name).id];
      expect(rows).toHaveLength(4);
      expect(v(rows[0], 'Name')).toBe('Write spec');
      expect(v(rows[0], 'Estimate')).toBe(3.5);
      expect(v(rows[0], 'Due')).toBe('2024-01-31');
      expect(v(rows[0], 'Done')).toBe(true);
      expect(v(rows[1], 'Name')).toBe('Ship, then rest');
      expect(v(rows[1], 'Status')).toBe(doneChoice?.id);
      expect(v(rows[1], 'Done')).toBe(false);
      expect(v(rows[2], 'Estimate')).toBeNull();
      expect(v(rows[2], 'Due')).toBeNull();
      expect(v(rows[2], 'Status')).toBeNull();
      expect(v(rows[3], 'Name')).toBeNull();
    });

    it('refuses a malformed file and a bad mapping, without changing anything', async () => {
      const table = await newTable();
      const name = fieldOf(table, 'Name').id;
      const post = (body: unknown) => request('POST', `/api/tables/${table.id}/imports`, body);
      const unclosed = await post({ csv: 'A\n"open', columns: [{ index: 0, fieldId: name }] });
      expect(unclosed.status).toBe(422);
      expect(await unclosed.text()).toMatch(/never closes/);
      expect((await post({ csv: 'A\n', columns: [{ index: 0, fieldId: name }] })).status).toBe(422);
      for (const columns of [
        [{ index: 5, fieldId: name }],
        [{ index: 0, fieldId: '01900000-0000-7000-8000-000000000000' }],
        [
          { index: 0, fieldId: name },
          { index: 1, fieldId: name },
        ],
        [{ index: 0, newField: { name: 'notes', type: 'singleLineText' } }],
        [{ index: 0, newField: { name: 'Auto', type: 'autoNumber' } }],
        [{ index: 0, newField: { name: 'N', type: 'number', options: { precision: 99 } } }],
        [{ index: 0 }],
      ]) {
        const res = await post({ csv: 'A,B\n1,2\n', columns });
        expect(res.status, JSON.stringify(columns)).toBe(422);
      }
      expect(await allRecords(table.id)).toEqual([]);
      expect((await tableMeta(table.id)).fields).toHaveLength(3);
    });

    it('lets editors import into existing fields only', async () => {
      const table = await newTable();
      const editor = await addMember(t.db, workspaceId, 'editor');
      const cookie = await createSession(t.db, editor);
      const refused = await request(
        'POST',
        `/api/tables/${table.id}/imports`,
        { csv: 'A\n1\n', columns: [{ index: 0, newField: { name: 'A', type: 'number' } }] },
        cookie
      );
      expect(refused.status).toBe(403);
      const job = await runImport(
        table.id,
        { csv: 'A\nOne\n', columns: [{ index: 0, fieldId: fieldOf(table, 'Name').id }] },
        cookie
      );
      expect(job.status).toBe('done');
      expect(await allRecords(table.id)).toHaveLength(1);
    });

    it('adds missing select options with typecast, only for schema roles (#70)', async () => {
      const table = await newTable();
      const status = fieldOf(table, 'Status');
      const body = {
        csv: 'Name,Status\nA,Blocked\nB,blocked\nC,Done\nD,Waiting\nE,\n',
        typecast: true,
        columns: [
          { index: 0, fieldId: fieldOf(table, 'Name').id },
          { index: 1, fieldId: status.id },
        ],
      };
      const editor = await addMember(t.db, workspaceId, 'editor');
      const refused = await request(
        'POST',
        `/api/tables/${table.id}/imports`,
        body,
        await createSession(t.db, editor)
      );
      expect(refused.status).toBe(422);
      expect(((await refused.json()) as { code: string }).code).toBe('TYPECAST_FORBIDDEN');

      const job = await runImport(table.id, body);
      expect(job).toMatchObject({ status: 'done', skippedCells: 0 });
      const choices = (
        fieldOf(await tableMeta(table.id), 'Status').options as {
          choices: { id: string; name: string }[];
        }
      ).choices;
      expect(choices.map((c) => c.name)).toEqual([
        'Todo',
        'In progress',
        'Done',
        'Blocked',
        'Waiting',
      ]);
      const byName = new Map(choices.map((c) => [c.name, c.id]));
      expect((await allRecords(table.id)).map((r) => r.fields[status.id])).toEqual([
        byName.get('Blocked'),
        byName.get('Blocked'),
        byName.get('Done'),
        byName.get('Waiting'),
        null,
      ]);
      // Without the flag, unknown options are skipped cells, as before.
      const plain = await runImport(table.id, {
        ...body,
        typecast: false,
        csv: 'Name,Status\nF,Later\n',
      });
      expect(plain.skippedCells).toBe(1);
    });

    it("reads a job only through the job's table", async () => {
      const table = await newTable();
      const other = await newTable('Other');
      const job = await runImport(table.id, {
        csv: 'A\nOne\n',
        columns: [{ index: 0, fieldId: fieldOf(table, 'Name').id }],
      });
      const res = await request('GET', `/api/tables/${other.id}/imports/${job.id}`);
      expect(res.status).toBe(404);
    });

    it('imports a 100,000-row CSV completely and correctly', { timeout: 300_000 }, async () => {
      const table = await newTable('Big');
      const n = 100_000;
      const lines = ['Name,Amount,Day,Tag'];
      for (let i = 0; i < n; i++) {
        const day = `2024-01-${String((i % 28) + 1).padStart(2, '0')}`;
        lines.push(`"Row ${i}, quoted",${i}.25,${day},${['red', 'green', 'blue'][i % 3]}`);
      }
      const started = Date.now();
      const job = await runImport(table.id, {
        csv: `${lines.join('\n')}\n`,
        columns: [
          { index: 0, fieldId: fieldOf(table, 'Name').id },
          { index: 1, newField: { name: 'Amount', type: 'number', options: { precision: 2 } } },
          { index: 2, newField: { name: 'Day', type: 'date' } },
          { index: 3, newField: { name: 'Tag', type: 'singleLineText' } },
        ],
      });
      const seconds = (Date.now() - started) / 1000;
      expect(job).toMatchObject({
        status: 'done',
        totalRows: n,
        processedRows: n,
        skippedCells: 0,
      });

      const meta = await tableMeta(table.id);
      const [row] = await t.db.select().from(tables).where(sql`id = ${table.id}`);
      if (!row) throw new Error('no table');
      const dbColumns = new Map(
        (
          await t.db.execute<{ id: string; db_column: string }>(
            sql`SELECT id, db_column FROM fields WHERE table_id = ${table.id}`
          )
        ).rows.map((r) => [r.id, r.db_column])
      );
      const col = (name: string) => sql.identifier(dbColumns.get(fieldOf(meta, name).id) ?? '');
      const stats = await t.db.execute<{
        n: number;
        names: number;
        total: string;
        days: number;
        tags: number;
      }>(sql`
        SELECT count(*)::int AS n,
               count(DISTINCT ${col('Name')})::int AS names,
               sum(${col('Amount')})::text AS total,
               count(DISTINCT ${col('Day')})::int AS days,
               count(DISTINCT ${col('Tag')})::int AS tags
          FROM ${qualified(row)} WHERE deleted_at IS NULL`);
      // Sum of i + 0.25 for i < n.
      expect(stats.rows[0]).toEqual({
        n,
        names: n,
        total: ((n * (n - 1)) / 2 + n * 0.25).toFixed(2),
        days: 28,
        tags: 3,
      });
      const sample = await t.db.execute<{ name: string; amount: string; day: string }>(sql`
        SELECT ${col('Name')} AS name, ${col('Amount')}::text AS amount, ${col('Day')}::text AS day
          FROM ${qualified(row)} WHERE ${col('Name')} = 'Row 54321, quoted'`);
      expect(sample.rows).toEqual([
        { name: 'Row 54321, quoted', amount: '54321.25', day: '2024-01-02' },
      ]);
      console.info(`100k-row import: ${seconds.toFixed(1)} s`);
    });
  });

  describe('export', () => {
    it('streams the view: filter, sorts, hidden fields and column order', async () => {
      const table = await newTable();
      const name = fieldOf(table, 'Name');
      const notes = fieldOf(table, 'Notes');
      const status = fieldOf(table, 'Status');
      const estimate = await ok<FieldMeta>(
        await request('POST', `/api/tables/${table.id}/fields`, {
          name: 'Estimate',
          type: 'number',
          options: { precision: 1 },
        }),
        201
      );
      const records = Array.from({ length: 2500 }, (_, i) => ({
        fields: {
          [name.id]: `R${String(i).padStart(4, '0')}`,
          [estimate.id]: i % 10,
          [notes.id]: 'n',
        },
      }));
      for (let i = 0; i < records.length; i += 1000) {
        await ok(
          await request('POST', `/api/tables/${table.id}/records`, {
            records: records.slice(i, i + 1000),
          }),
          201
        );
      }
      const [view] = (
        await ok<{ views: ViewMeta[] }>(await request('GET', `/api/tables/${table.id}/views`))
      ).views;
      if (!view) throw new Error('no view');
      await ok(
        await request('PATCH', `/api/views/${view.id}`, {
          name: 'Big ones',
          grid: { fieldOrder: [estimate.id, notes.id, status.id], hiddenFields: [notes.id] },
          query: {
            filter: {
              conjunction: 'and',
              conditions: [{ fieldId: estimate.id, operator: '>=', value: 8 }],
            },
            sorts: [
              { fieldId: estimate.id, direction: 'desc' },
              { fieldId: name.id, direction: 'asc' },
            ],
          },
        })
      );

      const res = await exportCsv(table.id, { viewId: view.id });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
      expect(res.headers.get('content-disposition')).toContain('filename="Tasks - Big ones.csv"');
      const bytes = new Uint8Array(await res.arrayBuffer());
      // A UTF-8 BOM first, for Excel.
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const text = new TextDecoder().decode(bytes);
      const rows = parseCsv(text, { delimiter: ',' });
      expect(rows[0]).toEqual(['Name', 'Estimate', 'Status']);
      const body = rows.slice(1);
      expect(body).toHaveLength(500);
      expect(body[0]).toEqual(['R0009', '9.0', '']);
      expect(body[249]).toEqual(['R2499', '9.0', '']);
      expect(body[250]).toEqual(['R0008', '8.0', '']);
      expect(body.at(-1)).toEqual(['R2498', '8.0', '']);

      // The caller's unsaved changes: another filter and only two fields.
      const inline = await exportCsv(table.id, {
        viewId: view.id,
        query: JSON.stringify({
          filter: {
            conjunction: 'and',
            conditions: [{ fieldId: estimate.id, operator: '=', value: 0 }],
          },
          fields: [estimate.id, name.id],
        }),
      });
      const inlineRows = parseCsv(await inline.text(), { delimiter: ',' });
      expect(inlineRows[0]).toEqual(['Estimate', 'Name']);
      expect(inlineRows).toHaveLength(251);

      // The whole table without a view: every record, every field, table order.
      const all = parseCsv(await (await exportCsv(table.id)).text(), { delimiter: ',' });
      expect(all[0]).toEqual(['Name', 'Notes', 'Status', 'Estimate']);
      expect(all).toHaveLength(2501);
    });

    it('neutralizes formula injection in cells and headers', async () => {
      const table = await newTable();
      const name = fieldOf(table, 'Name');
      await ok(
        await request('PATCH', `/api/fields/${fieldOf(table, 'Notes').id}`, { name: '=cmd|x' })
      );
      const payloads = [
        '=HYPERLINK("http://evil.test","click")',
        '+1+1',
        '-2+3',
        '@SUM(A1:A2)',
        '\t=1',
        '=1,2\n3',
        'safe',
        '-12.5',
      ];
      await ok(
        await request('POST', `/api/tables/${table.id}/records`, {
          records: payloads.map((p) => ({ fields: { [name.id]: p } })),
        }),
        201
      );
      const text = await (await exportCsv(table.id)).text();
      const rows = parseCsv(text, { delimiter: ',' });
      expect(rows[0]?.[1]).toBe("'=cmd|x");
      const names = rows.slice(1).map((r) => r[0]);
      expect(names).toEqual([
        `'=HYPERLINK("http://evil.test","click")`,
        "'+1+1",
        "'-2+3",
        "'@SUM(A1:A2)",
        "'\t=1",
        // Single line text turns the line break into a space on save.
        "'=1,2 3",
        'safe',
        '-12.5',
      ]);
      // No cell starts a formula, other than a plain negative number.
      for (const cell of rows.flat()) {
        if (!/^-\d+(\.\d+)?$/.test(cell)) expect(cell).not.toMatch(/^[=+\-@\t\r]/);
      }
    });

    it('refuses a bad query and a view of another table', async () => {
      const table = await newTable();
      const other = await newTable('Other');
      const [otherView] = (
        await ok<{ views: ViewMeta[] }>(await request('GET', `/api/tables/${other.id}/views`))
      ).views;
      expect((await exportCsv(table.id, { query: '{nope' })).status).toBe(422);
      const unknownField = JSON.stringify({
        sorts: [{ fieldId: '01900000-0000-7000-8000-000000000000', direction: 'asc' }],
      });
      expect((await exportCsv(table.id, { query: unknownField })).status).toBe(422);
      expect((await exportCsv(table.id, { viewId: otherView?.id ?? '' })).status).toBe(404);
    });

    it('round-trips: an export imports back to the same values', async () => {
      const source = await newTable('Source');
      const name = fieldOf(source, 'Name');
      const amount = await ok<FieldMeta>(
        await request('POST', `/api/tables/${source.id}/fields`, {
          name: 'Amount',
          type: 'currency',
        }),
        201
      );
      await ok(
        await request('POST', `/api/tables/${source.id}/records`, {
          records: [
            { fields: { [name.id]: 'a, "quoted" line', [amount.id]: 1234.5 } },
            { fields: { [name.id]: 'b', [amount.id]: -3 } },
          ],
        }),
        201
      );
      const csv = await (await exportCsv(source.id)).text();
      const target = await newTable('Target');
      const job = await runImport(target.id, {
        csv,
        columns: [
          { index: 0, fieldId: fieldOf(target, 'Name').id },
          { index: 3, newField: { name: 'Amount', type: 'currency' } },
        ],
      });
      expect(job).toMatchObject({ status: 'done', skippedCells: 0 });
      const meta = await tableMeta(target.id);
      const rows = await allRecords(target.id);
      expect(
        rows.map((r) => [r.fields[fieldOf(meta, 'Name').id], r.fields[fieldOf(meta, 'Amount').id]])
      ).toEqual([
        ['a, "quoted" line', 1234.5],
        ['b', -3],
      ]);
    });
  });
});
