import {
  type ButtonOptions,
  type FieldMeta,
  type ImportJob,
  parseCsv,
  type RecordData,
  type TableMeta,
} from '@openrows/shared';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { baseMembers, type users, workspaceMembers } from '../../src/db/index.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, createSession, createUser, createWorkspace } from '../helpers/factories.js';

type User = typeof users.$inferSelect;

/**
 * The remaining field types of through the API as openrows_app: user fields (values limited
 * to the base's collaborators on write, former members kept, filters with `me`, sort by name,
 * CSV import by name and export by name), barcodes (validation per type, text filters and
 * sort), buttons (URL formulas computed by the engine, only http(s)) and rich text (sanitized
 * on write).
 */
describe('user, barcode, button and rich text fields', () => {
  const t = useTestDb();
  let owner: User;
  let ada: User;
  let guest: User;
  let stranger: User;
  let workspaceId: string;
  let app: ReturnType<typeof testApp>;
  let cookie: string;

  const request = (method: string, path: string, body?: unknown) =>
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

  let baseId: string;
  async function newTable(name = 'Tasks') {
    return ok<TableMeta>(await request('POST', `/api/bases/${baseId}/tables`, { name }), 201);
  }
  const primary = (table: TableMeta) => table.fields.find((f) => f.isPrimary)?.id ?? '';
  const field = async (tableId: string, name: string, type: string, options: unknown = {}) =>
    ok<FieldMeta>(
      await request('POST', `/api/tables/${tableId}/fields`, { name, type, options }),
      201
    );
  const records = (tableId: string) => `/api/tables/${tableId}/records`;
  const write = (tableId: string, cells: Record<string, unknown>[]) =>
    request('POST', records(tableId), { records: cells.map((fields) => ({ fields })) });
  const create = async (tableId: string, cells: Record<string, unknown>[]) =>
    (await ok<{ records: RecordData[] }>(await write(tableId, cells), 201)).records;
  const update = (tableId: string, id: string, cells: Record<string, unknown>) =>
    request('PATCH', records(tableId), { records: [{ id, fields: cells }] });
  const query = async (tableId: string, body: unknown) =>
    (
      await ok<{ records: RecordData[] }>(
        await request('POST', `${records(tableId)}/query`, { query: body })
      )
    ).records;

  beforeAll(async () => {
    app = testApp({ db: t.appDb });
    owner = await createUser(t.db, { name: 'Zoe Owner', email: 'zoe@example.test' });
    ({
      workspace: { id: workspaceId },
    } = await createWorkspace(t.db, { owner }));
    ada = await addMember(
      t.db,
      workspaceId,
      'editor',
      await createUser(t.db, { name: 'Ada Lovelace', email: 'ada@example.test' })
    );
    guest = await createUser(t.db, { name: 'Gina Guest', email: 'gina@example.test' });
    // A user of another workspace: never a valid user cell value here.
    stranger = (await createWorkspace(t.db)).owner;
    cookie = await createSession(t.db, owner);
    baseId = (
      await ok<{ id: string }>(
        await request('POST', `/api/workspaces/${workspaceId}/bases`, { name: 'Base' }),
        201
      )
    ).id;
    await t.db
      .insert(baseMembers)
      .values({ workspaceId, baseId, userId: guest.id, role: 'editor' });
  });

  describe('user', () => {
    let table: TableMeta;
    let people: FieldMeta;
    let owners: FieldMeta;

    beforeAll(async () => {
      table = await newTable('People');
      people = await field(table.id, 'People', 'user', { multiple: true });
      owners = await field(table.id, 'Owner', 'user');
    });

    it('accepts collaborators of the base and refuses anyone else (422)', async () => {
      const [r] = await create(table.id, [
        { [primary(table)]: 'r1', [people.id]: [ada.id, { id: guest.id }], [owners.id]: owner.id },
      ]);
      expect(r?.fields[people.id]).toEqual([ada.id, guest.id]);
      expect(r?.fields[owners.id]).toEqual([owner.id]);
      expect(people.options).toEqual({ multiple: true, notify: false });

      const res = await write(table.id, [{ [people.id]: [ada.id, stranger.id] }]);
      expect(res.status).toBe(422);
      expect(await res.text()).toContain('Only collaborators of this base');
      const unknown = await write(table.id, [
        { [owners.id]: '0190f5a2-7b3c-7d4e-8f00-0123456789ab' },
      ]);
      expect(unknown.status).toBe(422);
      // Several people in a single-user field: the first one is kept.
      const [one] = await create(table.id, [{ [owners.id]: [ada.id, owner.id] }]);
      expect(one?.fields[owners.id]).toEqual([ada.id]);
    });

    it('keeps a removed member in cells, and lets an update keep them', async () => {
      const temp = await addMember(
        t.db,
        workspaceId,
        'editor',
        await createUser(t.db, { name: 'Tom Temp', email: 'tom@example.test' })
      );
      const [r] = await create(table.id, [{ [primary(table)]: 'temp', [people.id]: [temp.id] }]);
      if (!r) throw new Error('no record');
      await t.db
        .delete(workspaceMembers)
        .where(
          and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, temp.id))
        );
      const read = await ok<RecordData>(await request('GET', `${records(table.id)}/${r.id}`));
      expect(read.fields[people.id]).toEqual([temp.id]);
      // Adding someone keeps the former member; adding them anew elsewhere is refused.
      const kept = await update(table.id, r.id, { [people.id]: [temp.id, ada.id] });
      expect(kept.status).toBe(200);
      expect((await write(table.id, [{ [people.id]: [temp.id] }])).status).toBe(422);
    });

    it('filters with `me` and has-any/all/none, and sorts by the first name', async () => {
      const t2 = await newTable('Assign');
      const who = await field(t2.id, 'Who', 'user', { multiple: true });
      const name = primary(t2);
      await create(t2.id, [
        { [name]: 'zoe', [who.id]: [owner.id] },
        { [name]: 'ada+zoe', [who.id]: [ada.id, owner.id] },
        { [name]: 'gina', [who.id]: [guest.id] },
        { [name]: 'none' },
      ]);
      const names = (rs: RecordData[]) => rs.map((r) => r.fields[name]);
      const filter = (operator: string, value?: unknown) => ({
        filter: { conjunction: 'and', conditions: [{ fieldId: who.id, operator, value }] },
      });
      expect(names(await query(t2.id, filter('hasAnyOf', ['me']))).sort()).toEqual([
        'ada+zoe',
        'zoe',
      ]);
      expect(names(await query(t2.id, filter('hasAllOf', [ada.id, owner.id])))).toEqual([
        'ada+zoe',
      ]);
      expect(names(await query(t2.id, filter('isExactly', [owner.id])))).toEqual(['zoe']);
      expect(names(await query(t2.id, filter('hasNoneOf', ['me']))).sort()).toEqual([
        'gina',
        'none',
      ]);
      expect(names(await query(t2.id, filter('isEmpty')))).toEqual(['none']);
      const bad = await request('POST', `${records(t2.id)}/query`, {
        query: filter('hasAnyOf', ['you']),
      });
      expect(bad.status).toBe(422);
      const sorted = await query(t2.id, { sorts: [{ fieldId: who.id, direction: 'asc' }] });
      expect(names(sorted)).toEqual(['none', 'ada+zoe', 'gina', 'zoe']);
      const grouped = await query(t2.id, { groupBy: [{ fieldId: who.id, direction: 'asc' }] });
      expect(grouped).toHaveLength(4);
    });

    it('imports people by name or email and exports their names', async () => {
      const t3 = await newTable('Import');
      const who = await field(t3.id, 'Who', 'user', { multiple: true });
      const job = await ok<ImportJob>(
        await request('POST', `/api/tables/${t3.id}/imports`, {
          csv: 'Name,Who\na,"Ada Lovelace, gina@example.test"\nb,Nobody Known\n',
          columns: [
            { index: 0, fieldId: primary(t3) },
            { index: 1, fieldId: who.id },
          ],
        }),
        201
      );
      await app.runJob(job.id);
      const done = await ok<ImportJob>(
        await request('GET', `/api/tables/${t3.id}/imports/${job.id}`)
      );
      expect(done).toMatchObject({ status: 'done', skippedCells: 1 });
      const rows = await query(t3.id, { sorts: [{ fieldId: primary(t3), direction: 'asc' }] });
      expect(rows[0]?.fields[who.id]).toEqual([ada.id, guest.id]);
      expect(rows[1]?.fields[who.id] ?? null).toBeNull();

      const res = await request('GET', `/api/tables/${t3.id}/export.csv`);
      expect(res.status).toBe(200);
      const [header = [], ...lines] = parseCsv(await res.text());
      expect(lines.find((r) => r[0] === 'a')?.[header.indexOf('Who')]).toBe(
        'Ada Lovelace, Gina Guest'
      );
    });
  });

  describe('barcode', () => {
    it('validates per type, filters and sorts on the text', async () => {
      const table = await newTable('Stock');
      const code = await field(table.id, 'Code', 'barcode');
      const name = primary(table);
      await create(table.id, [
        { [name]: 'ean', [code.id]: { text: '4006381333931', type: 'ean13' } },
        { [name]: 'guess', [code.id]: 'SKU-42' },
        { [name]: 'qr', [code.id]: { text: 'https://openrows.io', type: 'qr' } },
      ]);
      const bad = await write(table.id, [{ [code.id]: { text: '4006381333932', type: 'ean13' } }]);
      expect(bad.status).toBe(422);
      const unknownType = await write(table.id, [{ [code.id]: { text: 'x', type: 'pdf417' } }]);
      expect(unknownType.status).toBe(422);

      const rows = await query(table.id, { sorts: [{ fieldId: code.id, direction: 'asc' }] });
      expect(rows.map((r) => r.fields[code.id])).toEqual([
        { text: '4006381333931', type: 'ean13' },
        { text: 'https://openrows.io', type: 'qr' },
        { text: 'SKU-42', type: 'code128' },
      ]);
      const sku = await query(table.id, {
        filter: {
          conjunction: 'and',
          conditions: [{ fieldId: code.id, operator: 'contains', value: 'sku' }],
        },
      });
      expect(sku.map((r) => r.fields[name])).toEqual(['guess']);
      expect((await query(table.id, { search: '40063' })).map((r) => r.fields[name])).toEqual([
        'ean',
      ]);
    });
  });

  describe('button', () => {
    it('computes its URL formula, keeping only http(s) URLs', async () => {
      const table = await newTable('Links');
      const name = primary(table);
      const open = await field(table.id, 'Open', 'button', {
        label: 'Open page',
        formula: 'IF({Name} = "bad", "javascript:alert(1)", "https://openrows.io/p/" & {Name})',
      });
      const opts = open.options as ButtonOptions;
      expect(opts.label).toBe('Open page');
      expect(opts.formula).toContain(`{${name}}`);
      expect(opts.isValid).toBe(true);
      const empty = await field(table.id, 'Later', 'button');
      expect((empty.options as ButtonOptions).label).toBe('Open');

      const [a, b] = await create(table.id, [{ [name]: 'docs' }, { [name]: 'bad' }]);
      if (!a || !b) throw new Error('no records');
      expect(a.fields[open.id]).toBe('https://openrows.io/p/docs');
      expect(b.fields[open.id] ?? null).toBeNull();
      expect(a.fields[empty.id] ?? null).toBeNull();
      // The URL follows the record.
      const res = await ok<{ records: RecordData[] }>(
        await update(table.id, a.id, { [name]: 'x' })
      );
      expect(res.records[0]?.fields[open.id]).toBe('https://openrows.io/p/x');
      // Not writable, not sortable, and filters only test for a URL.
      expect((await write(table.id, [{ [open.id]: 'https://evil.example' }])).status).toBe(422);
      const sort = await request('POST', `${records(table.id)}/query`, {
        query: { sorts: [{ fieldId: open.id, direction: 'asc' }] },
      });
      expect(sort.status).toBe(422);
      const withUrl = await query(table.id, {
        filter: { conjunction: 'and', conditions: [{ fieldId: open.id, operator: 'isNotEmpty' }] },
      });
      expect(withUrl.map((r) => r.id)).toEqual([a.id]);
      // An invalid URL formula is a 422.
      const invalid = await request('POST', `/api/tables/${table.id}/fields`, {
        name: 'Broken',
        type: 'button',
        options: { formula: '"https://x.io/" & {Nope}' },
      });
      expect(invalid.status).toBe(422);
    });
  });

  describe('rich text', () => {
    it('sanitizes Markdown on write and when rich text is turned on', async () => {
      const table = await newTable('Notes');
      const notes = table.fields.find((f) => f.type === 'longText');
      if (!notes) throw new Error('no long text');
      const [plain] = await create(table.id, [{ [notes.id]: '<b>x</b> [a](javascript:alert(1))' }]);
      if (!plain) throw new Error('no record');
      expect(plain.fields[notes.id]).toBe('<b>x</b> [a](javascript:alert(1))');
      await ok(await request('PATCH', `/api/fields/${notes.id}`, { options: { richText: true } }));
      const read = await ok<RecordData>(await request('GET', `${records(table.id)}/${plain.id}`));
      expect(read.fields[notes.id]).toBe('x a');
      const [rich] = await create(table.id, [
        { [notes.id]: '**Hi** <img src=x onerror=alert(1)>[ok](https://openrows.io)' },
      ]);
      expect(rich?.fields[notes.id]).toBe('**Hi** [ok](https://openrows.io)');
    });

    it('stores what the WYSIWYG editor writes as it is, and no unsafe link however spelled (#85)', async () => {
      const table = await newTable('Briefs');
      const notes = table.fields.find((f) => f.type === 'longText');
      if (!notes) throw new Error('no long text');
      await ok(await request('PATCH', `/api/fields/${notes.id}`, { options: { richText: true } }));
      // The editor's Markdown: nested marks, escapes, check lists, quotes, code.
      const written = [
        '## Plan',
        '**bold *and italic*** \\*literal\\* \\[not\\](a link) https\\://not.linked',
        '- [x] done\n- [ ] next',
        '> quote',
        '```\nconst a = 1;\n```',
      ].join('\n\n');
      const [kept] = await create(table.id, [{ [notes.id]: written }]);
      expect(kept?.fields[notes.id]).toBe(written);
      // Labels with brackets or code spans don't smuggle a javascript: link past the sanitizer.
      const [unsafe] = await create(table.id, [
        {
          [notes.id]:
            '[a [b] c](javascript:alert(1)) [`]`](javascript:alert(2)) \\![x](javascript:alert(3))',
        },
      ]);
      const stored = String(unsafe?.fields[notes.id]);
      expect(stored).not.toMatch(/javascript/);
      expect(stored).toBe('[a [b] c] `]` \\!x');
    });
  });
});
