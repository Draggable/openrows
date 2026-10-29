import {
  FIELD_TYPE_DEFS,
  type FieldMeta,
  type FieldTypeName,
  type QueryRecordsResult,
  type TableMeta,
} from '@openrows/shared';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { type users, views } from '../../src/db/index.js';
import { useTestDb } from '../helpers/db.js';
import { authedClient, createReadyAttachment, createWorkspace } from '../helpers/factories.js';

/**
 * The ViewQuery engine through `POST /api/tables/:tableId/records/query` as openrows_app:
 * every filter operator of every field type, typed sorts, search, nested filter groups, window
 * and keyset paging, group counts, summary aggregates, saved views, and field ids confined to
 * the queried table.
 */
describe('records query', () => {
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

  async function newTable(name = 'Tasks') {
    const base = await ok<{ id: string }>(
      await json('POST', `/api/workspaces/${workspaceId}/bases`, { name: 'Base' }),
      201
    );
    return ok<TableMeta>(await json('POST', `/api/bases/${base.id}/tables`, { name }), 201);
  }
  const newField = async (tableId: string, body: Record<string, unknown>) =>
    ok<FieldMeta>(await json('POST', `/api/tables/${tableId}/fields`, body), 201);
  const createMany = async (tableId: string, rows: Record<string, unknown>[]) =>
    (
      await ok<{ records: { id: string; fields: Record<string, unknown> }[] }>(
        await json('POST', `/api/tables/${tableId}/records`, {
          records: rows.map((fields) => ({ fields })),
        }),
        201
      )
    ).records;
  const query = (tableId: string, body: Record<string, unknown>) =>
    json('POST', `/api/tables/${tableId}/records/query`, body);
  const run = async (tableId: string, body: Record<string, unknown>) =>
    ok<QueryRecordsResult>(await query(tableId, body));

  const todayUtc = () => new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    const created = await createWorkspace(t.db);
    owner = created.owner;
    workspaceId = created.workspace.id;
    api = await authedClient(t, owner);
  });

  describe('every operator of every field type', () => {
    let table: TableMeta;
    const ids: Partial<Record<FieldTypeName, string>> = {};
    let nameId: string;
    let names: Map<string, string>;
    let firstAuto: number;
    let stored: Record<string, Record<string, unknown>>;

    beforeAll(async () => {
      table = await newTable('Every type');
      const byName = (n: string) => table.fields.find((f) => f.name === n)?.id ?? '';
      nameId = byName('Name');
      ids.longText = byName('Notes');
      ids.singleSelect = byName('Status');
      const add = async (type: FieldTypeName, options?: unknown) => {
        ids[type] = (await newField(table.id, { name: type, type, options })).id;
      };
      await add('singleLineText');
      for (const type of ['number', 'currency', 'percent', 'checkbox', 'date'] as const) {
        await add(type);
      }
      await add('dateTime', { timeZone: 'America/New_York' });
      await add('duration');
      await add('rating');
      await add('multipleSelect', {
        choices: [
          { id: 'red', name: 'Red', color: 'red' },
          { id: 'green', name: 'Green', color: 'green' },
          { id: 'blue', name: 'Blue', color: 'blue' },
        ],
      });
      for (const type of [
        'email',
        'url',
        'phone',
        'attachment',
        'autoNumber',
        'createdTime',
        'lastModifiedTime',
        'createdBy',
        'lastModifiedBy',
      ] as const) {
        await add(type);
      }
      // people and barcodes.
      await add('user', { multiple: true });
      await add('barcode');
      // A self-link: records link to each other by the Name field.
      await add('link', { linkedTableId: table.id });
      const v = (type: FieldTypeName) => ids[type] ?? '';
      const at = {
        workspaceId,
        baseId: table.baseId,
        tableId: table.id,
        fieldId: v('attachment'),
      };
      const report = await createReadyAttachment(t.db, at, {
        filename: 'report.pdf',
        size: 1,
        type: 'application/pdf',
      });
      const photo = await createReadyAttachment(t.db, at, {
        filename: 'photo.png',
        size: 2,
        type: 'image/png',
      });
      const records = await createMany(table.id, [
        {
          [nameId]: 'A',
          [v('singleLineText')]: 'Apple pie',
          [v('longText')]: 'hello world',
          [v('number')]: 10,
          [v('currency')]: 5.5,
          [v('percent')]: 0.25,
          [v('checkbox')]: true,
          [v('date')]: '2024-01-15',
          // 18:30 on Jan 15 in New York.
          [v('dateTime')]: '2024-01-15T23:30:00Z',
          [v('duration')]: 3600,
          [v('rating')]: 3,
          [v('singleSelect')]: 'Todo',
          [v('multipleSelect')]: ['Red', 'Blue'],
          [v('email')]: 'a@x.com',
          [v('url')]: 'https://a.example',
          [v('phone')]: '555-1000',
          [v('attachment')]: [report],
          [v('user')]: [owner.id],
          [v('barcode')]: 'SKU-1',
        },
        {
          [nameId]: 'B',
          [v('singleLineText')]: 'Banana',
          [v('longText')]: 'goodbye',
          [v('number')]: 20,
          [v('currency')]: 10,
          [v('percent')]: 0.5,
          [v('checkbox')]: false,
          [v('date')]: '2024-02-01',
          // 22:00 on Jan 31 in New York.
          [v('dateTime')]: '2024-02-01T03:00:00Z',
          [v('duration')]: 60,
          [v('rating')]: 5,
          [v('singleSelect')]: 'Done',
          [v('multipleSelect')]: ['Blue'],
          [v('email')]: 'b@y.com',
          [v('url')]: 'https://b.example',
          [v('phone')]: '555-2000',
          [v('attachment')]: [photo],
          [v('barcode')]: { text: '4006381333931', type: 'ean13' },
        },
        {
          [nameId]: 'C',
          [v('singleLineText')]: 'apple',
          [v('number')]: 0,
          [v('date')]: todayUtc(),
        },
        { [nameId]: 'D' },
      ]);
      // A links B, B links A and C (by name, matched on the primary field).
      await ok(
        await json('PATCH', `/api/tables/${table.id}/records`, {
          records: [
            { id: records[0]?.id, fields: { [v('link')]: 'B' } },
            { id: records[1]?.id, fields: { [v('link')]: ['A', 'C'] } },
          ],
        })
      );
      names = new Map(records.map((r) => [r.id, String(r.fields[nameId])]));
      stored = Object.fromEntries(records.map((r) => [String(r.fields[nameId]), r.fields]));
      firstAuto = Number(stored['A']?.[v('autoNumber')]);
    });

    type Case = [type: FieldTypeName, operator: string, value: unknown, expected: string];
    // Expected record names, sorted. `$A.<type>` reads record A's stored value.
    const CASES: Case[] = [
      ['singleLineText', 'is', 'APPLE', 'C'],
      ['singleLineText', 'isNot', 'apple', 'ABD'],
      ['singleLineText', 'contains', 'APP', 'AC'],
      ['singleLineText', 'doesNotContain', 'app', 'BD'],
      ['singleLineText', 'isEmpty', undefined, 'D'],
      ['singleLineText', 'isNotEmpty', undefined, 'ABC'],
      ['longText', 'is', 'HELLO WORLD', 'A'],
      ['longText', 'isNot', 'goodbye', 'ACD'],
      ['longText', 'contains', 'o', 'AB'],
      ['longText', 'doesNotContain', 'world', 'BCD'],
      ['longText', 'isEmpty', undefined, 'CD'],
      ['longText', 'isNotEmpty', undefined, 'AB'],
      ['email', 'is', '$A.email', 'A'],
      ['email', 'isNot', '$A.email', 'BCD'],
      ['email', 'contains', 'y.com', 'B'],
      ['email', 'doesNotContain', 'x.com', 'BCD'],
      ['email', 'isEmpty', undefined, 'CD'],
      ['email', 'isNotEmpty', undefined, 'AB'],
      ['url', 'is', '$A.url', 'A'],
      ['url', 'isNot', '$A.url', 'BCD'],
      ['url', 'contains', 'b.ex', 'B'],
      ['url', 'doesNotContain', 'a.ex', 'BCD'],
      ['url', 'isEmpty', undefined, 'CD'],
      ['url', 'isNotEmpty', undefined, 'AB'],
      ['phone', 'is', '$A.phone', 'A'],
      ['phone', 'isNot', '$A.phone', 'BCD'],
      ['phone', 'contains', '2000', 'B'],
      ['phone', 'doesNotContain', '1000', 'BCD'],
      ['phone', 'isEmpty', undefined, 'CD'],
      ['phone', 'isNotEmpty', undefined, 'AB'],
      ['number', '=', 10, 'A'],
      ['number', '!=', 10, 'BCD'],
      ['number', '<', 10, 'C'],
      ['number', '<=', 10, 'AC'],
      ['number', '>', 10, 'B'],
      ['number', '>=', '10', 'AB'],
      ['number', 'isEmpty', undefined, 'D'],
      ['number', 'isNotEmpty', undefined, 'ABC'],
      ['currency', '=', 5.5, 'A'],
      ['currency', '!=', 5.5, 'BCD'],
      ['currency', '<', 10, 'A'],
      ['currency', '<=', 10, 'AB'],
      ['currency', '>', 5.5, 'B'],
      ['currency', '>=', 5.5, 'AB'],
      ['currency', 'isEmpty', undefined, 'CD'],
      ['currency', 'isNotEmpty', undefined, 'AB'],
      ['percent', '=', 0.25, 'A'],
      ['percent', '!=', 0.25, 'BCD'],
      ['percent', '<', 0.5, 'A'],
      ['percent', '<=', 0.5, 'AB'],
      ['percent', '>', 0.25, 'B'],
      ['percent', '>=', 0.25, 'AB'],
      ['percent', 'isEmpty', undefined, 'CD'],
      ['percent', 'isNotEmpty', undefined, 'AB'],
      ['duration', '=', 60, 'B'],
      ['duration', '!=', 60, 'ACD'],
      ['duration', '<', 3600, 'B'],
      ['duration', '<=', 3600, 'AB'],
      ['duration', '>', 60, 'A'],
      ['duration', '>=', 60, 'AB'],
      ['duration', 'isEmpty', undefined, 'CD'],
      ['duration', 'isNotEmpty', undefined, 'AB'],
      ['rating', '=', 3, 'A'],
      ['rating', '!=', 3, 'BCD'],
      ['rating', '<', 5, 'A'],
      ['rating', '<=', 5, 'AB'],
      ['rating', '>', 3, 'B'],
      ['rating', '>=', 3, 'AB'],
      ['rating', 'isEmpty', undefined, 'CD'],
      ['rating', 'isNotEmpty', undefined, 'AB'],
      ['autoNumber', '=', '$auto+0', 'A'],
      ['autoNumber', '!=', '$auto+0', 'BCD'],
      ['autoNumber', '<', '$auto+2', 'AB'],
      ['autoNumber', '<=', '$auto+2', 'ABC'],
      ['autoNumber', '>', '$auto+2', 'D'],
      ['autoNumber', '>=', '$auto+2', 'CD'],
      ['autoNumber', 'isEmpty', undefined, ''],
      ['autoNumber', 'isNotEmpty', undefined, 'ABCD'],
      ['checkbox', 'is', true, 'A'],
      ['checkbox', 'is', false, 'BCD'],
      ['date', 'is', '2024-01-15', 'A'],
      ['date', 'isNot', '2024-01-15', 'BCD'],
      ['date', 'isBefore', '2024-02-01', 'A'],
      ['date', 'isAfter', '2024-01-15', 'BC'],
      ['date', 'isOnOrBefore', '2024-02-01', 'AB'],
      ['date', 'isOnOrAfter', '2024-02-01', 'BC'],
      ['date', 'isWithin', 'pastWeek', 'C'],
      ['date', 'isEmpty', undefined, 'D'],
      ['date', 'isNotEmpty', undefined, 'ABC'],
      ['dateTime', 'is', '2024-01-31', 'B'],
      ['dateTime', 'is', '2024-02-01', ''],
      ['dateTime', 'isNot', '2024-01-15', 'BCD'],
      ['dateTime', 'isBefore', '2024-01-31', 'A'],
      ['dateTime', 'isAfter', '2024-01-15', 'B'],
      ['dateTime', 'isOnOrBefore', '2024-01-31', 'AB'],
      ['dateTime', 'isOnOrAfter', '2024-01-31', 'B'],
      ['dateTime', 'isWithin', { pastDays: 3650 }, 'AB'],
      ['dateTime', 'isWithin', 'nextYear', ''],
      ['dateTime', 'isEmpty', undefined, 'CD'],
      ['dateTime', 'isNotEmpty', undefined, 'AB'],
      ['createdTime', 'is', 'today', 'ABCD'],
      ['createdTime', 'isNot', 'today', ''],
      ['createdTime', 'isBefore', '2000-01-01', ''],
      ['createdTime', 'isAfter', '2000-01-01', 'ABCD'],
      ['createdTime', 'isOnOrBefore', 'tomorrow', 'ABCD'],
      ['createdTime', 'isOnOrAfter', 'yesterday', 'ABCD'],
      ['createdTime', 'isWithin', 'pastWeek', 'ABCD'],
      ['createdTime', 'isEmpty', undefined, ''],
      ['createdTime', 'isNotEmpty', undefined, 'ABCD'],
      ['lastModifiedTime', 'is', 'today', 'ABCD'],
      ['lastModifiedTime', 'isNot', 'today', ''],
      ['lastModifiedTime', 'isBefore', 'today', ''],
      ['lastModifiedTime', 'isAfter', 'today', ''],
      ['lastModifiedTime', 'isOnOrBefore', 'today', 'ABCD'],
      ['lastModifiedTime', 'isOnOrAfter', 'today', 'ABCD'],
      ['lastModifiedTime', 'isWithin', { nextDays: 1 }, 'ABCD'],
      ['lastModifiedTime', 'isEmpty', undefined, ''],
      ['lastModifiedTime', 'isNotEmpty', undefined, 'ABCD'],
      ['createdBy', 'is', '$owner', 'ABCD'],
      ['createdBy', 'isNot', '$owner', ''],
      ['createdBy', 'isAnyOf', ['$owner'], 'ABCD'],
      ['createdBy', 'isNoneOf', ['$owner'], ''],
      ['createdBy', 'isEmpty', undefined, ''],
      ['createdBy', 'isNotEmpty', undefined, 'ABCD'],
      ['lastModifiedBy', 'is', '00000000-0000-4000-8000-000000000000', ''],
      ['lastModifiedBy', 'isNot', '00000000-0000-4000-8000-000000000000', 'ABCD'],
      ['lastModifiedBy', 'isAnyOf', ['$owner'], 'ABCD'],
      ['lastModifiedBy', 'isNoneOf', ['$owner'], ''],
      ['lastModifiedBy', 'isEmpty', undefined, ''],
      ['lastModifiedBy', 'isNotEmpty', undefined, 'ABCD'],
      ['singleSelect', 'is', 'Todo', 'A'],
      ['singleSelect', 'isNot', 'todo', 'BCD'],
      ['singleSelect', 'isAnyOf', ['Todo', 'Done'], 'AB'],
      ['singleSelect', 'isNoneOf', ['Done'], 'ACD'],
      ['singleSelect', 'isEmpty', undefined, 'CD'],
      ['singleSelect', 'isNotEmpty', undefined, 'AB'],
      ['multipleSelect', 'hasAnyOf', ['Red'], 'A'],
      ['multipleSelect', 'hasAllOf', ['red', 'blue'], 'A'],
      ['multipleSelect', 'isExactly', ['Blue'], 'B'],
      ['multipleSelect', 'hasNoneOf', ['Red'], 'BCD'],
      ['multipleSelect', 'isEmpty', undefined, 'CD'],
      ['multipleSelect', 'isNotEmpty', undefined, 'AB'],
      ['attachment', 'contains', 'REPORT', 'A'],
      ['attachment', 'doesNotContain', 'report', 'BCD'],
      ['attachment', 'isEmpty', undefined, 'CD'],
      ['attachment', 'isNotEmpty', undefined, 'AB'],
      ['user', 'hasAnyOf', ['me'], 'A'],
      ['user', 'hasAllOf', ['$owner'], 'A'],
      ['user', 'isExactly', ['$owner'], 'A'],
      ['user', 'hasNoneOf', ['$owner'], 'BCD'],
      ['user', 'isEmpty', undefined, 'BCD'],
      ['user', 'isNotEmpty', undefined, 'A'],
      ['barcode', 'is', 'sku-1', 'A'],
      ['barcode', 'isNot', 'SKU-1', 'BCD'],
      ['barcode', 'contains', '4006', 'B'],
      ['barcode', 'doesNotContain', 'sku', 'BCD'],
      ['barcode', 'isEmpty', undefined, 'CD'],
      ['barcode', 'isNotEmpty', undefined, 'AB'],
      ['link', 'contains', 'b', 'A'],
      ['link', 'contains', 'c', 'B'],
      ['link', 'doesNotContain', 'b', 'BCD'],
      ['link', 'hasAnyOf', ['$id.C'], 'B'],
      ['link', 'hasAnyOf', ['$id.A', '$id.B'], 'AB'],
      ['link', 'hasNoneOf', ['$id.A'], 'ACD'],
      ['link', 'isEmpty', undefined, 'CD'],
      ['link', 'isNotEmpty', undefined, 'AB'],
    ];

    it('covers every operator of every type in the registry', () => {
      const covered = new Set(CASES.map(([type, op]) => `${type} ${op}`));
      // Lookups, rollups and counts need linked tables: computed.test.ts covers theirs.
      const all = Object.values(FIELD_TYPE_DEFS)
        .filter((def) => def.storage.kind !== 'computed')
        .flatMap((def) => def.filterOperators.map((op) => `${def.name} ${op}`));
      expect([...new Set(all)].filter((x) => !covered.has(x))).toEqual([]);
    });

    it.each(CASES)('%s %s %j → %s', async (type, operator, raw, expected) => {
      const resolve = (x: unknown): unknown => {
        if (Array.isArray(x)) return x.map(resolve);
        if (x === '$owner') return owner.id;
        if (typeof x === 'string' && x.startsWith('$id.')) {
          return [...names].find(([, name]) => name === x.slice(4))?.[0];
        }
        if (typeof x === 'string' && x.startsWith('$auto+')) return firstAuto + Number(x.slice(6));
        if (typeof x === 'string' && x.startsWith('$A.')) {
          return stored['A']?.[ids[x.slice(3) as FieldTypeName] ?? ''];
        }
        return x;
      };
      const res = await run(table.id, {
        query: {
          filter: {
            conditions: [{ fieldId: ids[type], operator, value: resolve(raw) }],
          },
        },
        limit: 10,
      });
      const got = res.records.map((r) => names.get(r.id) ?? '?').sort();
      expect(got.join('')).toBe(expected);
      expect(res.total).toBe(expected.length);
    });

    it('rejects an operator the field type does not support', async () => {
      const res = await query(table.id, {
        query: {
          filter: { conditions: [{ fieldId: ids.number, operator: 'contains', value: '1' }] },
        },
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { errors: { path: string }[] };
      expect(body.errors[0]?.path).toBe('query.filter.conditions.0');
    });

    it('rejects invalid values and ignores blank ones', async () => {
      const bad = await query(table.id, {
        query: {
          filter: { conditions: [{ fieldId: ids.number, operator: '=', value: 'ten' }] },
        },
      });
      expect(bad.status).toBe(422);
      const blank = await run(table.id, {
        query: { filter: { conditions: [{ fieldId: ids.number, operator: '=', value: '' }] } },
      });
      expect(blank.total).toBe(4);
    });

    it('combines nested and/or groups', async () => {
      // number >= 10 AND (text contains "ban" OR checkbox is true) → A, B
      const res = await run(table.id, {
        query: {
          filter: {
            conjunction: 'and',
            conditions: [
              { fieldId: ids.number, operator: '>=', value: 10 },
              {
                conjunction: 'or',
                conditions: [
                  { fieldId: ids.singleLineText, operator: 'contains', value: 'ban' },
                  { fieldId: ids.checkbox, operator: 'is', value: true },
                ],
              },
            ],
          },
          sorts: [{ fieldId: nameId, direction: 'asc' }],
        },
      });
      expect(res.records.map((r) => names.get(r.id))).toEqual(['A', 'B']);
      const or = await run(table.id, {
        query: {
          filter: {
            conjunction: 'or',
            conditions: [
              { fieldId: ids.number, operator: '=', value: 0 },
              { fieldId: ids.rating, operator: '=', value: 5 },
            ],
          },
          sorts: [{ fieldId: nameId, direction: 'desc' }],
        },
      });
      expect(or.records.map((r) => names.get(r.id))).toEqual(['C', 'B']);
    });

    it('searches visible text, select and number fields', async () => {
      const search = async (term: string, fields?: string[]) =>
        (await run(table.id, { query: { search: term, fields } })).records
          .map((r) => names.get(r.id))
          .sort()
          .join('');
      expect(await search('APPLE')).toBe('AC');
      expect(await search('done')).toBe('B');
      expect(await search('20')).toBe('B');
      expect(await search('100%_')).toBe('');
      expect(await search('apple', [nameId])).toBe('');
    });

    it('sorts by typed keys with empty values first', async () => {
      const order = async (type: FieldTypeName, direction: 'asc' | 'desc') =>
        (
          await run(table.id, {
            query: {
              sorts: [
                { fieldId: ids[type], direction },
                { fieldId: nameId, direction: 'asc' },
              ],
            },
          })
        ).records
          .map((r) => names.get(r.id))
          .join('');
      expect(await order('number', 'asc')).toBe('DCAB');
      expect(await order('number', 'desc')).toBe('BACD');
      // Case-insensitive: "apple" < "Apple pie" < "Banana".
      expect(await order('singleLineText', 'asc')).toBe('DCAB');
      // Choice order: Todo, In progress, Done.
      expect(await order('singleSelect', 'asc')).toBe('CDAB');
      expect(await order('multipleSelect', 'desc')).toBe('BACD');
      expect(await order('checkbox', 'desc')).toBe('ABCD');
      expect(await order('date', 'asc')).toBe('DABC');
      expect(await order('dateTime', 'desc')).toBe('BACD');
      // Links by the linked records' names: "" (C, D) < "a, c" (B) < "b" (A).
      expect(await order('link', 'asc')).toBe('CDBA');
      const bad = await query(table.id, { query: { sorts: [{ fieldId: ids.attachment }] } });
      expect(bad.status).toBe(422);
    });

    it('returns only the visible fields', async () => {
      const res = await run(table.id, { query: { fields: [nameId, ids.number ?? ''] } });
      expect(Object.keys(res.records[0]?.fields ?? {}).sort()).toEqual([nameId, ids.number].sort());
    });

    it('counts groups and computes summary aggregates', async () => {
      const res = await run(table.id, {
        query: {
          groupBy: [{ fieldId: ids.checkbox, direction: 'desc' }, { fieldId: ids.singleSelect }],
        },
        groups: true,
        aggregates: [
          { fieldId: ids.number, fn: 'sum' },
          { fieldId: ids.number, fn: 'avg' },
          { fieldId: ids.number, fn: 'min' },
          { fieldId: ids.number, fn: 'max' },
          { fieldId: ids.number, fn: 'empty' },
          { fieldId: ids.number, fn: 'filled' },
          { fieldId: ids.singleLineText, fn: 'unique' },
          { fieldId: ids.date, fn: 'min' },
          { fieldId: ids.date, fn: 'max' },
          { fieldId: nameId, fn: 'count' },
        ],
      });
      const status = table.fields.find((f) => f.name === 'Status')?.options as
        | { choices: { id: string; name: string }[] }
        | undefined;
      const statusId = (name: string) => status?.choices.find((c) => c.name === name)?.id;
      expect(res.groups).toEqual([
        { key: [true, statusId('Todo')], count: 1 },
        { key: [false, null], count: 2 },
        { key: [false, statusId('Done')], count: 1 },
      ]);
      // Records follow the group order.
      expect(res.records.map((r) => names.get(r.id))).toEqual(['A', 'C', 'D', 'B']);
      expect(res.aggregates).toEqual({
        [ids.number ?? '']: { sum: 30, avg: 10, min: 0, max: 20, empty: 1, filled: 3 },
        [ids.singleLineText ?? '']: { unique: 3 },
        [ids.date ?? '']: { min: '2024-01-15', max: todayUtc() },
        [nameId]: { count: 4 },
      });
      const bad = await query(table.id, {
        aggregates: [{ fieldId: ids.singleLineText, fn: 'sum' }],
      });
      expect(bad.status).toBe(422);
    });

    it('reads a saved view and lets the request override it', async () => {
      const [view] = await t.db.select().from(views).where(eq(views.tableId, table.id));
      if (!view) throw new Error('no view');
      await t.db
        .update(views)
        .set({
          config: {
            filter: { conditions: [{ fieldId: ids.number, operator: '>=', value: 10 }] },
            sorts: [{ fieldId: ids.number, direction: 'desc' }],
          },
        })
        .where(eq(views.id, view.id));
      const saved = await run(table.id, { viewId: view.id });
      expect(saved.records.map((r) => names.get(r.id))).toEqual(['B', 'A']);
      const overridden = await run(table.id, {
        viewId: view.id,
        query: { sorts: [{ fieldId: ids.number, direction: 'asc' }] },
      });
      expect(overridden.records.map((r) => names.get(r.id))).toEqual(['A', 'B']);
      const missing = await query(table.id, { viewId: '00000000-0000-4000-8000-000000000000' });
      expect(missing.status).toBe(404);
    });
  });

  it('refuses fields of another table, in filters, sorts, groups, fields and aggregates', async () => {
    const a = await newTable('A');
    const b = await newTable('B');
    const foreign = b.fields[0]?.id;
    const bodies = [
      { query: { filter: { conditions: [{ fieldId: foreign, operator: 'isEmpty' }] } } },
      {
        query: {
          filter: {
            conditions: [{ conditions: [{ fieldId: foreign, operator: 'is', value: 'x' }] }],
          },
        },
      },
      { query: { sorts: [{ fieldId: foreign }] } },
      { query: { groupBy: [{ fieldId: foreign }] } },
      { query: { fields: [foreign] } },
      { aggregates: [{ fieldId: foreign, fn: 'count' }] },
    ];
    for (const body of bodies) {
      const res = await query(a.id, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      const problem = (await res.json()) as { errors: { message: string }[] };
      expect(problem.errors[0]?.message).toBe('No such field in this table.');
    }
  });

  it('pages by window and by keyset cursor in the same order', async () => {
    const table = await newTable('Paging');
    const nameId = table.fields[0]?.id ?? '';
    const n = await newField(table.id, { name: 'N', type: 'number' });
    // 57 records, numbers repeating with empties, so ties and NULLs cross page boundaries.
    await createMany(
      table.id,
      Array.from({ length: 57 }, (_, i) => ({
        [nameId]: `r${String(i).padStart(2, '0')}`,
        [n.id]: i % 7 === 0 ? null : i % 5,
      }))
    );
    const spec = {
      sorts: [
        { fieldId: n.id, direction: 'desc' },
        { fieldId: nameId, direction: 'asc' },
      ],
    };
    const all = await run(table.id, { query: spec, limit: 1000 });
    expect(all.total).toBe(57);
    const expected = all.records.map((r) => r.id);

    const windowed: string[] = [];
    for (let offset = 0; offset < 57; offset += 10) {
      const page = await run(table.id, { query: spec, offset, limit: 10, count: offset === 0 });
      expect(page.offset).toBe(offset);
      windowed.push(...page.records.map((r) => r.id));
    }
    expect(windowed).toEqual(expected);

    // Keyset, with a sort of only the number (the id breaks ties).
    for (const sorts of [spec.sorts, [{ fieldId: n.id, direction: 'asc' }]]) {
      const reference = (await run(table.id, { query: { sorts }, limit: 1000 })).records.map(
        (r) => r.id
      );
      const keyset: string[] = [];
      let cursor: string | undefined;
      do {
        const page: QueryRecordsResult = await run(table.id, {
          query: { sorts },
          limit: 8,
          count: false,
          ...(cursor ? { cursor } : {}),
        });
        expect(page.total).toBeNull();
        keyset.push(...page.records.map((r) => r.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(keyset).toEqual(reference);
    }

    const tampered = await query(table.id, {
      query: spec,
      cursor: Buffer.from(JSON.stringify({ k: ['x', 'y', 'z'] })).toString('base64url'),
    });
    expect(tampered.status).toBe(422);
    const wrongShape = await query(table.id, { query: spec, cursor: 'nope' });
    expect(wrongShape.status).toBe(422);
    const both = await query(table.id, { query: spec, cursor: 'x', offset: 0 });
    expect(both.status).toBe(422);
  });
});
