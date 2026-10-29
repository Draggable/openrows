import type { FieldMeta, TableMeta, ViewMeta } from '@openrows/shared';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { fields, tables, type users } from '../../src/db/index.js';
import { useTestDb } from '../helpers/db.js';
import { authedClient, createWorkspace } from '../helpers/factories.js';

/**
 * Calendar views: the `calendar` layout checked on write and pruned on read, and the
 * `dateRange` query that fetches only the records of the visible days (date-only fields never
 * shift, datetimes count by their day in the field's zone, across DST).
 */
describe('calendar views', () => {
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

  type Cal = {
    table: TableMeta;
    view: ViewMeta;
    name: FieldMeta;
    start: FieldMeta;
    end: FieldMeta;
    due: FieldMeta;
    stage: FieldMeta;
  };

  async function newCalendar(): Promise<Cal> {
    const base = await ok<{ id: string }>(
      await json('POST', `/api/workspaces/${workspaceId}/bases`, { name: 'Base' }),
      201
    );
    const table = await ok<TableMeta>(
      await json('POST', `/api/bases/${base.id}/tables`, { name: 'Events' }),
      201
    );
    const field = async (body: unknown) =>
      ok<FieldMeta>(await json('POST', `/api/tables/${table.id}/fields`, body), 201);
    const name = table.fields.find((f) => f.isPrimary);
    if (!name) throw new Error('no primary field');
    const start = await field({ name: 'Start', type: 'date' });
    const end = await field({ name: 'End', type: 'date' });
    const due = await field({
      name: 'Due',
      type: 'dateTime',
      options: { timeZone: 'America/New_York' },
    });
    const stage = await field({
      name: 'Stage',
      type: 'singleSelect',
      options: { choices: [{ id: 'a', name: 'A', color: 'blue' }] },
    });
    const view = await ok<ViewMeta>(
      await json('POST', `/api/tables/${table.id}/views`, { name: 'Calendar', type: 'calendar' }),
      201
    );
    return { table, view, name, start, end, due, stage };
  }

  async function addRecords(c: Cal, rows: Record<string, unknown>[]) {
    await ok(
      await json('POST', `/api/tables/${c.table.id}/records`, {
        records: rows.map((fields) => ({ fields })),
      }),
      201
    );
  }

  async function inRange(
    c: Cal,
    from: string,
    to: string,
    pairs: { startFieldId: string; endFieldId?: string | null }[]
  ): Promise<string[]> {
    const res = await ok<{ records: { fields: Record<string, unknown> }[] }>(
      await json('POST', `/api/tables/${c.table.id}/records/query`, {
        viewId: c.view.id,
        query: { dateRange: { from, to, fields: pairs } },
        limit: 1000,
      })
    );
    return res.records.map((r) => String(r.fields[c.name.id])).sort();
  }

  beforeAll(async () => {
    const tenant = await createWorkspace(t.db);
    owner = tenant.owner;
    workspaceId = tenant.workspace.id;
    api = await authedClient(t, owner);
  });

  it('saves a calendar layout, refuses fields that are not dates, prunes on read', async () => {
    const c = await newCalendar();
    const saved = await ok<ViewMeta>(
      await json('PATCH', `/api/views/${c.view.id}`, {
        calendar: {
          dateFields: [
            { startFieldId: c.start.id, endFieldId: c.end.id },
            { startFieldId: c.due.id },
          ],
          colorFieldId: c.stage.id,
          mode: 'week',
        },
      })
    );
    expect(saved.config.calendar).toEqual({
      dateFields: [{ startFieldId: c.start.id, endFieldId: c.end.id }, { startFieldId: c.due.id }],
      colorFieldId: c.stage.id,
      mode: 'week',
    });

    const bad = await json('PATCH', `/api/views/${c.view.id}`, {
      calendar: {
        dateFields: [{ startFieldId: c.name.id }],
        colorFieldId: c.start.id,
      },
    });
    expect(bad.status).toBe(422);
    const problem = (await bad.json()) as { errors: { path: string }[] };
    expect(problem.errors.map((e) => e.path)).toEqual([
      'calendar.dateFields.0.startFieldId',
      'calendar.colorFieldId',
    ]);
    const unknown = await json('PATCH', `/api/views/${c.view.id}`, {
      calendar: { colour: 'red' },
    });
    expect(unknown.status).toBe(422);

    // Deleting the end field turns the pair into single days; the stored config keeps it.
    await ok(await json('DELETE', `/api/fields/${c.end.id}`), 204);
    const view = await ok<ViewMeta>(await json('GET', `/api/views/${c.view.id}`));
    expect(view.config.calendar?.dateFields).toEqual([
      { startFieldId: c.start.id, endFieldId: null },
      { startFieldId: c.due.id },
    ]);
  });

  it('returns only the records whose range meets the window', async () => {
    const c = await newCalendar();
    const f = (n: string, start: string | null, end: string | null = null) => ({
      [c.name.id]: n,
      [c.start.id]: start,
      [c.end.id]: end,
    });
    await addRecords(c, [
      f('before', '2026-02-20', '2026-02-28'),
      f('overlapsStart', '2026-02-25', '2026-03-02'),
      f('inside', '2026-03-10'),
      f('lastDay', '2026-03-31'),
      f('spansAll', '2026-01-01', '2026-12-31'),
      f('after', '2026-04-01', '2026-04-03'),
      f('endBeforeStart', '2026-04-02', '2026-03-05'),
      f('undated', null, '2026-03-05'),
    ]);
    const pair = [{ startFieldId: c.start.id, endFieldId: c.end.id }];
    expect(await inRange(c, '2026-03-01', '2026-03-31', pair)).toEqual([
      'inside',
      'lastDay',
      'overlapsStart',
      'spansAll',
    ]);
    // Without the end field, only start days count.
    expect(await inRange(c, '2026-03-01', '2026-03-31', [{ startFieldId: c.start.id }])).toEqual([
      'inside',
      'lastDay',
    ]);
    // The window is inclusive and date-only values never shift with a zone.
    const lastDay = await ok<{ total: number }>(
      await json('POST', `/api/tables/${c.table.id}/records/query`, {
        query: {
          timeZone: 'Pacific/Kiritimati',
          dateRange: { from: '2026-03-31', to: '2026-03-31', fields: pair },
        },
      })
    );
    expect(lastDay.total).toBe(2);

    const bad = await json('POST', `/api/tables/${c.table.id}/records/query`, {
      query: {
        dateRange: { from: '2026-03-01', to: '2026-03-02', fields: [{ startFieldId: c.name.id }] },
      },
    });
    expect(bad.status).toBe(422);
  });

  it('places datetimes on their day in the field zone, across DST', async () => {
    const c = await newCalendar();
    // New York springs forward on 2026-03-08 and falls back on 2026-11-01.
    await addRecords(c, [
      // 23:30 on March 7 in New York (EST, -05:00) is 04:30 UTC on March 8.
      { [c.name.id]: 'lateSat', [c.due.id]: '2026-03-08T04:30:00Z' },
      // 00:30 on March 8 (EST) is 05:30 UTC.
      { [c.name.id]: 'earlySun', [c.due.id]: '2026-03-08T05:30:00Z' },
      // 23:30 on March 8 (EDT, -04:00) is 03:30 UTC on March 9.
      { [c.name.id]: 'lateSun', [c.due.id]: '2026-03-09T03:30:00Z' },
      // 00:30 on November 1 (EDT) is 04:30 UTC; 23:30 (EST) is 04:30 UTC on November 2.
      { [c.name.id]: 'fallEarly', [c.due.id]: '2026-11-01T04:30:00Z' },
      { [c.name.id]: 'fallLate', [c.due.id]: '2026-11-02T04:30:00Z' },
    ]);
    const due = [{ startFieldId: c.due.id }];
    expect(await inRange(c, '2026-03-08', '2026-03-08', due)).toEqual(['earlySun', 'lateSun']);
    expect(await inRange(c, '2026-03-07', '2026-03-07', due)).toEqual(['lateSat']);
    expect(await inRange(c, '2026-11-01', '2026-11-01', due)).toEqual(['fallEarly', 'fallLate']);
  });

  it('serves a month of 20,000 records from the window alone', async () => {
    const c = await newCalendar();
    const [loc] = await t.db
      .select({ schema: tables.dbSchema, name: tables.dbTable })
      .from(tables)
      .where(eq(tables.id, c.table.id));
    const cols = await t.db
      .select({ id: fields.id, column: fields.dbColumn })
      .from(fields)
      .where(eq(fields.tableId, c.table.id));
    const col = (id: string) => sql.identifier(cols.find((x) => x.id === id)?.column ?? '');
    if (!loc) throw new Error('no table');
    // 20,000 records over 2,000 days from 2022-01-01: 10 a day.
    await t.db.execute(sql`
      INSERT INTO ${sql.identifier(loc.schema)}.${sql.identifier(loc.name)}
             (id, ${col(c.name.id)}, ${col(c.start.id)})
      SELECT gen_random_uuid(), 'Event ' || i, DATE '2022-01-01' + (i % 2000)
        FROM generate_series(0, 19999) AS i`);

    const started = Date.now();
    const res = await ok<{ records: unknown[]; total: number }>(
      await json('POST', `/api/tables/${c.table.id}/records/query`, {
        viewId: c.view.id,
        query: {
          dateRange: {
            from: '2023-03-01',
            to: '2023-03-31',
            fields: [{ startFieldId: c.start.id }],
          },
        },
        limit: 1000,
      })
    );
    const elapsed = Date.now() - started;
    console.info(`calendar: a month of 20k records in ${elapsed} ms`);
    expect(res.total).toBe(310);
    expect(res.records).toHaveLength(310);
    expect(elapsed).toBeLessThan(5_000);
  });
});
