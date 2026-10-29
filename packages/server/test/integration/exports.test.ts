import type { Base, FieldMeta, ImportJob, RecordData, TableMeta } from '@openrows/shared';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { qualified } from '../../src/data/columns.js';
import { baseMembers, fields, tables, type users, workspaceMembers } from '../../src/db/index.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import {
  addMember,
  createReadyAttachment,
  createSession,
  createUser,
  createWorkspace,
} from '../helpers/factories.js';
import { MemoryObjectStore } from '../helpers/object-store.js';
import { zipOf } from '../helpers/unzip.js';

interface ExportedTable {
  id: string;
  name: string;
  csv: string;
  records: string;
  fields: (Omit<FieldMeta, 'tableId' | 'deletedAt'> & { options: Record<string, unknown> })[];
  views: { id: string; name: string; personal: boolean }[];
}
interface ExportedSchema {
  format: string;
  version: number;
  base: { id: string; name: string };
  tables: ExportedTable[];
}
interface ExportedRecord {
  id: string;
  fields: Record<string, unknown>;
}

const jsonl = <T>(buf: Buffer | undefined): T[] =>
  (buf?.toString() ?? '')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as T);

/**
 * Data export: a whole base as a ZIP (schema, CSV and JSON lines per table, attachments)
 * that re-imports into a fresh workspace through the CSV import; what a reader may export (no
 * other tenant's base, no one else's personal views, a base-only collaborator only their base);
 * the account export (profile, memberships, comments, owned bases); the rate limit; and a
 * 100k-row base streamed in bounded memory.
 */
describe('data export', () => {
  const t = useTestDb();
  const store = new MemoryObjectStore();
  let app: ReturnType<typeof testApp>;
  let owner: typeof users.$inferSelect;
  let workspaceId: string;
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
  async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
    const r = await res;
    if (r.status !== status) throw new Error(`${r.status}: ${await r.text()}`);
    return (await r.json()) as T;
  }
  const newBase = (name: string, ws = workspaceId, cookie = ownerCookie) =>
    ok<Base>(request('POST', `/api/workspaces/${ws}/bases`, { name }, cookie), 201);
  const newTable = (baseId: string, body: Record<string, unknown>, cookie = ownerCookie) =>
    ok<TableMeta>(request('POST', `/api/bases/${baseId}/tables`, body, cookie), 201);
  const newField = (tableId: string, body: Record<string, unknown>, cookie = ownerCookie) =>
    ok<FieldMeta>(request('POST', `/api/tables/${tableId}/fields`, body, cookie), 201);
  const fieldOf = (table: TableMeta, name: string): FieldMeta => {
    const f = table.fields.find((x) => x.name === name);
    if (!f) throw new Error(`no field ${name}`);
    return f;
  };
  const exportBase = (baseId: string, cookie = ownerCookie, qs = '') =>
    request('GET', `/api/bases/${baseId}/export.zip${qs}`, undefined, cookie);

  async function allRecords(tableId: string, cookie = ownerCookie): Promise<RecordData[]> {
    const out: RecordData[] = [];
    let cursor: string | null = null;
    do {
      const qs: string = cursor ? `&cursor=${cursor}` : '';
      const page: { records: RecordData[]; nextCursor: string | null } = await ok(
        request('GET', `/api/tables/${tableId}/records?limit=1000${qs}`, undefined, cookie)
      );
      out.push(...page.records);
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }

  beforeAll(async () => {
    const created = await createWorkspace(t.db);
    owner = created.owner;
    workspaceId = created.workspace.id;
    app = testApp({ db: t.appDb, objectStore: store });
    ownerCookie = await createSession(t.db, owner);
  });

  it('round-trips: a base export re-imports into a fresh workspace', async () => {
    const base = await newBase('Roadmap');
    const people = await newTable(base.id, { name: 'People', primaryFieldName: 'Name' });
    const email = await newField(people.id, { name: 'Email', type: 'email' });
    const tasks = await newTable(base.id, { name: 'Tasks' });
    const estimate = await newField(tasks.id, {
      name: 'Estimate',
      type: 'number',
      options: { precision: 1 },
    });
    const done = await newField(tasks.id, { name: 'Done', type: 'checkbox' });
    const due = await newField(tasks.id, { name: 'Due', type: 'date' });
    const owners = await newField(tasks.id, {
      name: 'Owner',
      type: 'link',
      options: { linkedTableId: people.id },
    });
    const pName = fieldOf(people, 'Name');
    const created = await ok<{ records: RecordData[] }>(
      request('POST', `/api/tables/${people.id}/records`, {
        records: [
          { fields: { [pName.id]: 'Ada', [email.id]: 'ada@example.com' } },
          { fields: { [pName.id]: 'Grace "Amazing" Hopper', [email.id]: 'grace@example.com' } },
        ],
      }),
      201
    );
    const [ada, grace] = created.records;
    const tName = fieldOf(tasks, 'Name');
    const status = fieldOf(tasks, 'Status');
    const notes = fieldOf(tasks, 'Notes');
    await ok(
      request('POST', `/api/tables/${tasks.id}/records`, {
        typecast: true,
        records: [
          {
            fields: {
              [tName.id]: 'Write spec',
              [notes.id]: 'Line one\nLine two, with a comma',
              [status.id]: 'Done',
              [estimate.id]: 3.5,
              [done.id]: true,
              [due.id]: '2026-01-31',
              [owners.id]: [ada?.id, grace?.id],
            },
          },
          {
            fields: {
              [tName.id]: 'Ship it',
              [status.id]: 'In progress',
              [estimate.id]: -12,
              [owners.id]: [grace?.id],
            },
          },
          { fields: { [tName.id]: 'Empty' } },
        ],
      }),
      201
    );

    const res = await exportBase(base.id);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="Roadmap /);
    const files = await zipOf(res);
    const schema = JSON.parse(files.get('schema.json')?.toString() ?? '') as ExportedSchema;
    expect(schema).toMatchObject({ format: 'openrows.base-export', version: 1 });
    expect(schema.tables.map((x) => [x.name, x.csv, x.records])).toEqual([
      ['People', 'tables/01 People.csv', 'records/01 People.jsonl'],
      ['Tasks', 'tables/02 Tasks.csv', 'records/02 Tasks.jsonl'],
    ]);
    const exportedTasks = schema.tables[1];
    expect(exportedTasks?.fields.find((f) => f.id === owners.id)?.options).toMatchObject({
      linkedTableId: people.id,
    });
    // The JSON lines keep record ids, and link values the linked records' ids.
    const taskLines = jsonl<ExportedRecord>(files.get('records/02 Tasks.jsonl'));
    expect(taskLines).toHaveLength(3);
    expect(taskLines[0]?.fields[owners.id]).toEqual([
      { id: ada?.id, name: 'Ada' },
      { id: grace?.id, name: 'Grace "Amazing" Hopper' },
    ]);
    const peopleLines = jsonl<ExportedRecord>(files.get('records/01 People.jsonl'));
    expect(peopleLines.map((r) => r.id)).toEqual([ada?.id, grace?.id]);

    // Re-import into another owner's fresh workspace: tables and fields from the schema, then
    // each table's CSV through the CSV import, People first so the links find their names.
    const other = await createWorkspace(t.db);
    const otherCookie = await createSession(t.db, other.owner);
    const target = await newBase('Imported', other.workspace.id, otherCookie);
    const fieldMap = new Map<string, string>();
    const tableMap = new Map<string, TableMeta>();
    const importOwn = new Map<string, Set<string>>();
    for (const table of schema.tables) {
      const primary = table.fields.find((f) => f.isPrimary);
      const created = await newTable(
        target.id,
        { name: table.name, primaryFieldName: primary?.name },
        otherCookie
      );
      tableMap.set(table.id, created);
      if (primary) fieldMap.set(primary.id, fieldOf(created, primary.name).id);
      importOwn.set(table.id, new Set(primary ? [primary.id] : []));
    }
    for (const table of schema.tables) {
      const into = tableMap.get(table.id);
      for (const f of table.fields) {
        if (f.isPrimary || fieldMap.has(f.id) || !into) continue;
        // A link is imported from the later table (by names the earlier one already has); the
        // earlier side's field is then the inverse the server makes.
        const order = (id: unknown) => schema.tables.findIndex((x) => x.id === id);
        if (f.type === 'link' && order(f.options['linkedTableId']) > order(table.id)) continue;
        const options =
          f.type === 'link'
            ? { linkedTableId: tableMap.get(String(f.options['linkedTableId']))?.id }
            : f.options;
        const made = await newField(into.id, { name: f.name, type: f.type, options }, otherCookie);
        fieldMap.set(f.id, made.id);
        importOwn.get(table.id)?.add(f.id);
        const inverse = f.options['inverseLinkFieldId'];
        const madeInverse = (made.options as { inverseLinkFieldId?: string }).inverseLinkFieldId;
        if (typeof inverse === 'string' && madeInverse) fieldMap.set(inverse, madeInverse);
      }
    }
    for (const table of schema.tables) {
      const into = tableMap.get(table.id);
      if (!into) continue;
      const own = importOwn.get(table.id) ?? new Set();
      const job = await ok<ImportJob>(
        request(
          'POST',
          `/api/tables/${into.id}/imports`,
          {
            csv: files.get(table.csv)?.toString().replace(/^﻿/, ''),
            columns: table.fields.flatMap((f, index) => {
              const fieldId = fieldMap.get(f.id);
              return fieldId && own.has(f.id) ? [{ index, fieldId }] : [];
            }),
          },
          otherCookie
        ),
        201
      );
      await app.runJob(job.id);
      expect(
        await ok<ImportJob>(
          request('GET', `/api/tables/${into.id}/imports/${job.id}`, undefined, otherCookie)
        )
      ).toMatchObject({
        status: 'done',
        skippedCells: 0,
        processedRows: table.name === 'Tasks' ? 3 : 2,
      });
    }

    // Same counts, and the same values field by field (links by the linked records' names).
    for (const table of schema.tables) {
      const into = tableMap.get(table.id);
      const source = jsonl<ExportedRecord>(files.get(table.records));
      const copy = await allRecords(into?.id ?? '', otherCookie);
      expect(copy).toHaveLength(source.length);
      const comparable = (values: Record<string, unknown>, ids: (id: string) => string) =>
        Object.fromEntries(
          table.fields.map((f) => {
            const v = values[ids(f.id)] ?? null;
            const plain = Array.isArray(v)
              ? v.map((x) => (typeof x === 'object' && x && 'name' in x ? x.name : x))
              : v;
            return [f.name, plain];
          })
        );
      expect(copy.map((r) => comparable(r.fields, (id) => fieldMap.get(id) ?? id))).toEqual(
        source.map((r) => comparable(r.fields, (id) => id))
      );
    }
  });

  it('exports what the caller can read: never another tenant, base or personal view', async () => {
    const base = await newBase('Scoped');
    const table = await newTable(base.id, { name: 'Things' });
    const mine = await ok<{ id: string }>(
      request('POST', `/api/tables/${table.id}/views`, { name: 'Mine', personal: true }),
      201
    );
    const reader = await addMember(t.db, workspaceId, 'read_only');
    const readerCookie = await createSession(t.db, reader);
    const res = await exportBase(base.id, readerCookie);
    expect(res.status).toBe(200);
    const schema = JSON.parse(
      (await zipOf(res)).get('schema.json')?.toString() ?? ''
    ) as ExportedSchema;
    const viewIds = schema.tables[0]?.views.map((v) => v.id) ?? [];
    expect(viewIds).not.toContain(mine.id);
    expect(viewIds.length).toBeGreaterThan(0);
    // The owner's own export includes their personal view.
    const ownSchema = JSON.parse(
      (await zipOf(await exportBase(base.id))).get('schema.json')?.toString() ?? ''
    ) as ExportedSchema;
    expect(ownSchema.tables[0]?.views.map((v) => v.id)).toContain(mine.id);

    // Another tenant, with a valid id: 404. Anonymous: 401.
    const stranger = await createWorkspace(t.db);
    expect((await exportBase(base.id, await createSession(t.db, stranger.owner))).status).toBe(404);
    expect((await app.app.request(`/api/bases/${base.id}/export.zip`)).status).toBe(401);

    // A base-only collaborator exports their base, not the workspace's others.
    const other = await newBase('Other');
    const guest = await createUser(t.db);
    const guestCookie = await createSession(t.db, guest);
    await t.db
      .insert(baseMembers)
      .values({ workspaceId, baseId: base.id, userId: guest.id, role: 'read_only' });
    expect((await exportBase(base.id, guestCookie)).status).toBe(200);
    expect((await exportBase(other.id, guestCookie)).status).toBe(404);

    // A trashed table isn't exported.
    const trashed = await newTable(base.id, { name: 'Trashed' });
    expect((await request('DELETE', `/api/tables/${trashed.id}`)).status).toBe(204);
    const after = JSON.parse(
      (await zipOf(await exportBase(base.id))).get('schema.json')?.toString() ?? ''
    ) as ExportedSchema;
    expect(after.tables.map((x) => x.name)).toEqual(['Things']);
  });

  it('puts attachment files in the archive, or signed URLs with attachments=links', async () => {
    const base = await newBase('Files');
    const table = await newTable(base.id, { name: 'Docs' });
    const field = await newField(table.id, { name: 'Files', type: 'attachment' });
    const file = await createReadyAttachment(
      t.db,
      { workspaceId, baseId: base.id, tableId: table.id, fieldId: field.id },
      { filename: '../../etc/passwd', type: 'text/plain', size: 5 }
    );
    store.objects.set(
      `ws/${workspaceId}/b/${base.id}/t/${table.id}/${file.id}`,
      Buffer.from('hello')
    );

    const files = await zipOf(await exportBase(base.id));
    const manifest = jsonl<Record<string, unknown>>(files.get('attachments.jsonl'));
    // The name is one path segment inside attachments/<id>/: no `/`, never `..` alone.
    expect(manifest).toEqual([
      expect.objectContaining({ id: file.id, size: 5, filename: '../../etc/passwd' }),
    ]);
    const path = String(manifest[0]?.['path']);
    expect(path).toMatch(new RegExp(`^attachments/${file.id}/[^/]+$`));
    expect(path.split('/').at(-1)).not.toMatch(/^\.+$/);
    expect(files.get(path)?.toString()).toBe('hello');

    // A file gone from storage is a note in its place; the archive still completes.
    store.objects.delete(`ws/${workspaceId}/b/${base.id}/t/${table.id}/${file.id}`);
    const without = await zipOf(await exportBase(base.id));
    expect(without.has(path)).toBe(false);
    expect(without.get(`${path}.unavailable.txt`)?.toString()).toMatch(/couldn't be read/);

    const linked = await zipOf(await exportBase(base.id, ownerCookie, '?attachments=links'));
    expect([...linked.keys()].some((k) => k.startsWith('attachments/'))).toBe(false);
    expect(jsonl<Record<string, unknown>>(linked.get('attachments.jsonl'))[0]).toMatchObject({
      id: file.id,
      url: expect.stringContaining('X-Amz-Signature'),
      urlExpiresAt: expect.any(String),
    });
    expect((await exportBase(base.id, ownerCookie, '?attachments=nope')).status).toBe(422);
  });

  it('exports an account: profile, memberships, comments everywhere, owned bases', async () => {
    const me = await createUser(t.db, { email: 'me@example.com', name: 'Me' });
    const myCookie = await createSession(t.db, me);
    const mine = await createWorkspace(t.db, { owner: me, name: 'My space' });
    const myBase = await newBase('Personal CRM', mine.workspace.id, myCookie);
    await newTable(myBase.id, { name: 'Contacts' }, myCookie);
    // A member (editor) of the shared workspace: they comment there, then leave it.
    await addMember(t.db, workspaceId, 'editor', me);
    const shared = await newBase('Team');
    const table = await newTable(shared.id, { name: 'Tasks' });
    const record = await ok<{ records: RecordData[] }>(
      request('POST', `/api/tables/${table.id}/records`, { records: [{ fields: {} }] }),
      201
    );
    const recordId = record.records[0]?.id ?? '';
    await ok(
      request(
        'POST',
        `/api/tables/${table.id}/records/${recordId}/comments`,
        { body: 'My words' },
        myCookie
      ),
      201
    );
    await ok(
      request(
        'POST',
        `/api/tables/${table.id}/records/${recordId}/comments`,
        { body: 'Not mine' },
        ownerCookie
      ),
      201
    );

    const files = await zipOf(await request('GET', '/api/me/export.zip', undefined, myCookie));
    const account = JSON.parse(files.get('account.json')?.toString() ?? '') as {
      format: string;
      user: { id: string; email: string };
      sessions: unknown[];
      workspaces: { workspaceId: string; role: string }[];
      bases: { baseId: string; path: string }[];
    };
    expect(account.format).toBe('openrows.account-export');
    expect(account.user).toMatchObject({ id: me.id, email: 'me@example.com' });
    expect(JSON.stringify(account)).not.toMatch(/token|idHash/i);
    expect(account.sessions.length).toBeGreaterThan(0);
    expect(account.workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workspaceId: mine.workspace.id, role: 'owner' }),
        expect.objectContaining({ workspaceId, role: 'editor' }),
      ])
    );
    // Bases of the workspaces they own only, each a whole-base export.
    expect(account.bases).toEqual([
      {
        workspaceId: mine.workspace.id,
        baseId: myBase.id,
        name: 'Personal CRM',
        path: expect.any(String),
      },
    ]);
    const path = account.bases[0]?.path ?? '';
    expect(path).toBe('bases/01 My space/01 Personal CRM/');
    expect(files.has(`${path}schema.json`)).toBe(true);
    expect(files.has(`${path}tables/01 Contacts.csv`)).toBe(true);
    expect([...files.keys()].some((k) => k.includes('Team'))).toBe(false);
    expect(jsonl<{ body: string }>(files.get('comments.jsonl')).map((c) => c.body)).toEqual([
      'My words',
    ]);

    // Their comments stay in the export after they leave the workspace.
    await t.db.delete(workspaceMembers).where(eq(workspaceMembers.userId, me.id));
    const later = await zipOf(await request('GET', '/api/me/export.zip', undefined, myCookie));
    expect(jsonl<{ body: string }>(later.get('comments.jsonl')).map((c) => c.body)).toEqual([
      'My words',
    ]);
    expect((await app.app.request('/api/me/export.zip')).status).toBe(401);
  });

  it('rate-limits exports per user', async () => {
    const user = await createUser(t.db);
    const cookie = await createSession(t.db, user);
    for (let i = 0; i < 10; i++) {
      const res = await request('GET', '/api/me/export.zip', undefined, cookie);
      expect(res.status).toBe(200);
      await res.arrayBuffer();
    }
    const res = await request('GET', '/api/me/export.zip', undefined, cookie);
    expect(res.status).toBe(429);
    // Another user isn't affected.
    const next = await request('GET', '/api/me/export.zip', undefined, ownerCookie);
    expect(next.status).toBe(200);
    await next.arrayBuffer();
  });

  it('exports a 100k-row base in bounded memory', { timeout: 240_000 }, async () => {
    const base = await newBase('Big');
    const table = await newTable(base.id, { name: 'Rows', primaryFieldName: 'Name' });
    const hours = await newField(table.id, { name: 'Hours', type: 'number' });
    const [row] = await t.db.select().from(tables).where(eq(tables.id, table.id));
    const [nameRow] = await t.db
      .select()
      .from(fields)
      .where(eq(fields.id, fieldOf(table, 'Name').id));
    const [hoursRow] = await t.db.select().from(fields).where(eq(fields.id, hours.id));
    if (!row || !nameRow || !hoursRow) throw new Error('no table');
    await t.db.execute(sql`
      INSERT INTO ${qualified(row)} (id, ${sql.identifier(nameRow.dbColumn)}, ${sql.identifier(hoursRow.dbColumn)})
      SELECT (lpad(to_hex(n), 8, '0') || '-0000-7000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
             'Row ' || n || ' ' || md5(n::text), n
        FROM generate_series(1, 100000) AS n`);

    let peak = 0;
    global.gc?.();
    const start = process.memoryUsage().heapUsed;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().heapUsed - start);
    }, 20);
    const chunks: Uint8Array[] = [];
    try {
      const res = await exportBase(base.id);
      expect(res.status).toBe(200);
      // Read as it streams; the compressed chunks are kept (outside the JS heap) to check below.
      for await (const chunk of res.body ?? []) chunks.push(chunk);
    } finally {
      clearInterval(timer);
    }
    // Pages of 1,000 records at a time: a generous bound against a regression that would hold
    // the whole table (100k records as objects take hundreds of MB).
    expect(peak).toBeLessThan(150 * 1024 * 1024);
    const files = await zipOf(new Response(Buffer.concat(chunks)));
    const csv = files.get('tables/01 Rows.csv')?.toString() ?? '';
    expect(csv.split('\r\n').filter((l) => l !== '')).toHaveLength(100_001);
    const lines = jsonl<ExportedRecord>(files.get('records/01 Rows.jsonl'));
    expect(lines).toHaveLength(100_000);
    expect(lines.reduce((sum, r) => sum + Number(r.fields[hours.id]), 0)).toBe(
      (100_000 * 100_001) / 2
    );
  });
});
