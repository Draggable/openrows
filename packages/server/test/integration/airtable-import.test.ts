import type { AirtableImport, RecordData, TableMeta } from '@openrows/shared';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURE_BASE_ID,
  FIXTURE_OTHER_BASE_ID,
  FIXTURE_TOKEN,
  fakeAirtable,
  LARGE_BASE_ID,
  PNG_1PX,
} from '../../src/airtable/__fixtures__/fake.js';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import type { users } from '../../src/db/index.js';
import { sweepJobs } from '../../src/jobs/status.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import {
  addMember,
  createBase,
  createSession,
  createTableWithFields,
  createUser,
  createWorkspace,
} from '../helpers/factories.js';
import { MemoryObjectStore } from '../helpers/object-store.js';

/**
 * The Airtable importer against the recorded-fixture fake of Airtable's API: the token
 * check, a base with every Airtable field type, formulas translated or kept as text, records
 * paged by 100, the report, the token never shown or logged and dropped after 24 hours, and the
 * job writing only into its own new base.
 */
describe('Airtable import', () => {
  const t = useTestDb();
  let owner: typeof users.$inferSelect;
  let ada: typeof users.$inferSelect;
  let workspaceId: string;
  let ownerCookie: string;
  let editorCookie: string;
  let fake: ReturnType<typeof fakeAirtable>;
  let app: ReturnType<typeof testApp>;
  let store: MemoryObjectStore;
  const instant = async () => {};

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
    const text = await res.text();
    if (res.status !== status) throw new Error(`${res.status}: ${text}`);
    expect(text).not.toContain(FIXTURE_TOKEN);
    return JSON.parse(text) as T;
  }

  const startImport = async (baseIds = [FIXTURE_BASE_ID], cookie = ownerCookie) =>
    ok<{ imports: AirtableImport[] }>(
      await request(
        'POST',
        `/api/workspaces/${workspaceId}/airtable/imports`,
        { token: FIXTURE_TOKEN, baseIds },
        cookie
      ),
      201
    );

  const getImport = async (id: string) =>
    ok<AirtableImport>(
      await request('GET', `/api/workspaces/${workspaceId}/airtable/imports/${id}`)
    );

  async function tablesOf(baseId: string): Promise<TableMeta[]> {
    const list = await ok<{ tables: { id: string }[] }>(
      await request('GET', `/api/bases/${baseId}/tables`)
    );
    return Promise.all(
      list.tables.map(async (x) => ok<TableMeta>(await request('GET', `/api/tables/${x.id}`)))
    );
  }

  async function allRecords(tableId: string): Promise<RecordData[]> {
    const page = await ok<{ records: RecordData[] }>(
      await request('GET', `/api/tables/${tableId}/records?limit=1000`)
    );
    return page.records;
  }

  beforeAll(async () => {
    fake = fakeAirtable();
    store = new MemoryObjectStore();
    app = testApp({
      db: t.appDb,
      airtable: { http: fake.http, sleep: instant },
      objectStore: store,
    });
    ({
      workspace: { id: workspaceId },
      owner,
    } = await createWorkspace(t.db));
    ownerCookie = await createSession(t.db, owner);
    ada = await addMember(
      t.db,
      workspaceId,
      'editor',
      await createUser(t.db, { email: 'ada@airtable-fixture.test', name: 'Ada' })
    );
    editorCookie = await createSession(t.db, ada);
  });

  it('lists the bases a token reads, and refuses a bad token without echoing it', async () => {
    const list = await ok<{ bases: { id: string; name: string }[] }>(
      await request('POST', `/api/workspaces/${workspaceId}/airtable/bases`, {
        token: FIXTURE_TOKEN,
      })
    );
    expect(list.bases.map((b) => b.id)).toEqual([FIXTURE_BASE_ID, FIXTURE_OTHER_BASE_ID]);

    const wrong = `patWrongToken0001.${'f'.repeat(64)}`;
    const res = await request('POST', `/api/workspaces/${workspaceId}/airtable/bases`, {
      token: wrong,
    });
    expect(res.status).toBe(422);
    const body = await res.text();
    expect(body).toContain('Airtable rejected the token');
    expect(body).not.toContain(wrong);
    // Not a token at all: the schema refuses it before any call.
    const before = fake.requests.length;
    const bad = await request('POST', `/api/workspaces/${workspaceId}/airtable/bases`, {
      token: 'key123',
    });
    expect(bad.status).toBe(422);
    expect(fake.requests.length).toBe(before);
    // Only creators: an editor gets 403.
    const editor = await request(
      'POST',
      `/api/workspaces/${workspaceId}/airtable/bases`,
      { token: FIXTURE_TOKEN },
      editorCookie
    );
    expect(editor.status).toBe(403);
  });

  it('refuses a base the token does not list', async () => {
    const res = await request('POST', `/api/workspaces/${workspaceId}/airtable/imports`, {
      token: FIXTURE_TOKEN,
      baseIds: ['appNotListed00001'],
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("The token can't read every base you picked");
  });

  it('imports a base with every Airtable field type', async () => {
    // Another base of the same workspace: the job must not touch it.
    const bystander = await createBase(t.db, workspaceId, { name: 'Bystander' });
    await createTableWithFields(t.db, owner, bystander, 'Untouched');
    const tablesBefore = await t.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM tables WHERE base_id = ${bystander.id}`
    );

    const started = await startImport();
    expect(started.imports).toHaveLength(1);
    const job = started.imports[0] as AirtableImport;
    expect(job).toMatchObject({
      status: 'running',
      phase: 'schema',
      name: 'Product launch',
      airtableBaseId: FIXTURE_BASE_ID,
    });

    // The token is in the row only encrypted, and never in pg-boss's job data.
    const { rows: stored } = await t.db.execute<{ payload: string | null; row: string }>(
      sql`SELECT payload, row_to_json(j)::text AS row FROM jobs j WHERE id = ${job.id}`
    );
    expect(stored[0]?.payload).toBeTruthy();
    expect(stored[0]?.row).not.toContain(FIXTURE_TOKEN);
    const { rows: boss } = await t.db.execute<{ data: string }>(
      sql`SELECT data::text AS data FROM pgboss.job WHERE id = ${job.id}`
    );
    expect(boss[0]?.data).not.toContain(FIXTURE_TOKEN);

    await app.runJob(job.id);
    const done = await getImport(job.id);
    expect(done.error).toBeNull();
    expect(done.status).toBe('done');
    expect(done).toMatchObject({
      phase: 'links',
      tables: 2,
      tablesDone: 2,
      records: 153,
      attachments: 3,
      attachmentsFailed: 2,
      // Apollo's and Hermes' tasks, written from the Tasks side (one link per cell).
      linkedRecords: 85,
      percent: 100,
    });

    // The token is gone from the row once the job ended.
    const { rows: after } = await t.db.execute<{ payload: string | null }>(
      sql`SELECT payload FROM jobs WHERE id = ${job.id}`
    );
    expect(after[0]?.payload).toBeNull();

    const tables = await tablesOf(job.baseId);
    expect(tables.map((x) => x.name)).toEqual(['Projects', 'Tasks']);
    const projects = tables[0] as TableMeta;
    expect(projects.description).toBe('Everything we ship');
    const types = Object.fromEntries(projects.fields.map((f) => [f.name, f.type]));
    expect(types).toEqual({
      Name: 'singleLineText',
      Notes: 'longText',
      Brief: 'longText',
      Contact: 'email',
      Website: 'url',
      Phone: 'phone',
      Estimate: 'number',
      Budget: 'currency',
      Done: 'percent',
      'Time spent': 'duration',
      Priority: 'rating',
      Shipped: 'checkbox',
      Due: 'date',
      Kickoff: 'dateTime',
      Status: 'singleSelect',
      Tags: 'multipleSelect',
      Owner: 'user',
      Team: 'user',
      Tasks: 'link',
      'Task names': 'lookup',
      'Task count': 'count',
      Effort: 'number',
      Files: 'attachment',
      Created: 'dateTime',
      Modified: 'date',
      'Created by': 'user',
      'Modified by': 'user',
      'No.': 'number',
      SKU: 'barcode',
      Open: 'url',
      'AI summary': 'longText',
      'Budget x2': 'formula',
      Size: 'formula',
      Code: 'singleLineText',
      Summary: 'formula',
    });
    const field = (name: string) => {
      const f = projects.fields.find((x) => x.name === name);
      if (!f) throw new Error(`no field ${name}`);
      return f;
    };
    expect(field('Name').isPrimary).toBe(true);
    expect(field('Notes').description).toBe('Free text');
    expect(field('Brief').options).toMatchObject({ richText: true });
    expect(field('Estimate').options).toMatchObject({ precision: 1 });
    expect(field('Budget').options).toMatchObject({ precision: 2, currencyCode: 'EUR' });
    expect(field('Time spent').options).toMatchObject({ format: 'h:mm:ss' });
    expect(field('Priority').options).toMatchObject({ max: 5, icon: 'star', color: 'olive' });
    expect(field('Due').options).toMatchObject({ dateFormat: 'iso' });
    expect(field('Kickoff').options).toMatchObject({
      dateFormat: 'european',
      timeFormat: '24h',
      timeZone: 'Europe/Berlin',
    });
    expect(field('Status').options).toMatchObject({
      choices: [
        { name: 'Todo', color: 'red' },
        { name: 'Doing', color: 'olive' },
        { name: 'Done', color: 'green' },
      ],
    });
    expect(field('Tags').options).toMatchObject({
      choices: [
        { name: 'Web', color: 'blue' },
        { name: 'Mobile', color: 'violet' },
        { name: 'API', color: 'teal' },
      ],
    });
    expect(field('Owner').options).toMatchObject({ multiple: false });
    expect(field('Team').options).toMatchObject({ multiple: true });
    expect(field('Budget x2').options).toMatchObject({ isValid: true, resultType: 'number' });
    expect(field('Code').description).toBe('Airtable formula: AUTONUMBER() & "-" & {Name}');

    const records = await allRecords(projects.id);
    expect(records).toHaveLength(3);
    const apollo = records.find((r) => r.fields[field('Name').id] === 'Apollo');
    if (!apollo) throw new Error('no Apollo');
    const cell = (name: string) => apollo.fields[field(name).id];
    const statusChoices = (field('Status').options as { choices: { id: string; name: string }[] })
      .choices;
    const tagChoices = (field('Tags').options as { choices: { id: string; name: string }[] })
      .choices;
    expect(cell('Notes')).toBe('Line one\nLine two');
    expect(cell('Contact')).toBe('apollo@example.com');
    expect(cell('Website')).toBe('https://example.com/apollo');
    expect(cell('Phone')).toBe('+1 555 0100');
    expect(cell('Estimate')).toBe(12.5);
    expect(cell('Budget')).toBe(1234.56);
    expect(cell('Done')).toBe(0.75);
    expect(cell('Time spent')).toBe(5400);
    expect(cell('Priority')).toBe(4);
    expect(cell('Shipped')).toBe(true);
    expect(cell('Due')).toBe('2024-03-01');
    expect(cell('Kickoff')).toBe('2024-01-10T08:30:00.000Z');
    expect(cell('Status')).toBe(statusChoices.find((c) => c.name === 'Doing')?.id);
    expect(cell('Tags')).toEqual(
      ['Web', 'API'].map((n) => tagChoices.find((c) => c.name === n)?.id)
    );
    // Collaborators by email: Ada is a member, Grace isn't (a skipped cell).
    expect(cell('Owner')).toEqual([ada.id]);
    expect(cell('Team')).toEqual([ada.id]);
    expect(cell('Created by')).toEqual([ada.id]);
    expect(cell('Created')).toBe('2024-01-05T09:00:00.000Z');
    expect(cell('Modified')).toBe('2024-02-01');
    expect(cell('No.')).toBe(1);
    expect(cell('SKU')).toEqual({ text: '4006381333931', type: 'ean13' });
    expect(cell('Open')).toBe('https://example.com/open/1');
    expect(cell('AI summary')).toBe('A short summary');
    // Translated formulas compute here; untranslated ones keep Airtable's values.
    expect(cell('Budget x2')).toBe(2469.12);
    expect(cell('Size')).toBe('big');
    expect(cell('Code')).toBe('1-Apollo');
    // Links: the record map turned Airtable's ids into ours, both ways; the lookup,
    // count and the formula over the lookup compute from them.
    const linkIds = (v: unknown) => ((v ?? []) as { id: string }[]).map((x) => x.id).sort();
    expect((cell('Tasks') as unknown[]).length).toBe(75);
    expect(cell('Task count')).toBe(75);
    expect(cell('Summary')).toMatch(/^Write spec, Task 3, /);
    const hermes = records.find((r) => r.fields[field('Name').id] === 'Hermes');
    expect(hermes?.fields[field('Task count').id]).toBe(10);
    // Effort's rollup function isn't in Airtable's API: Airtable's value is kept.
    expect(cell('Effort')).toBe(1);

    // Attachments: copied into our storage; the image's type comes from its bytes, a
    // "PNG" that isn't one is stored as a download, and files off Airtable's hosts or missing
    // there are reported.
    const files = cell('Files') as { id: string; filename: string; type: string; width?: number }[];
    expect(files.map((f) => [f.filename, f.type])).toEqual([
      ['logo.png', 'image/png'],
      ['brief.txt', 'text/plain'],
    ]);
    expect(files[0]?.width).toBe(1);
    const { rows: copied } = await t.db.execute<{ key: string; thumb: string | null }>(
      sql`SELECT storage_key AS key, thumbnail_key AS thumb FROM attachments
           WHERE id = ${files[0]?.id ?? ''} AND status = 'ready'`
    );
    expect(store.objects.get(copied[0]?.key ?? '')?.byteLength).toBe(PNG_1PX.byteLength);
    expect(store.objects.has(copied[0]?.thumb ?? '')).toBe(true);
    expect(hermes?.fields[field('Files').id]).toEqual([
      expect.objectContaining({ filename: 'fake.png', type: 'application/octet-stream' }),
    ]);
    expect(done.report.failedAttachments).toEqual([
      {
        table: 'Projects',
        field: 'Files',
        filename: 'elsewhere.pdf',
        message: "Files are only copied from Airtable's hosts, not files.example.com.",
      },
      {
        table: 'Projects',
        field: 'Files',
        filename: 'missing.doc',
        message: 'Airtable answered 404 for the file.',
      },
    ]);
    // Only Airtable's hosts were asked for files.
    expect(fake.requests.some((r) => r.url.includes('files.example.com'))).toBe(false);

    // Tasks: 150 records over two pages; the primary formula became text with its values.
    const tasks = tables[1] as TableMeta;
    const taskPrimary = tasks.fields.find((f) => f.isPrimary);
    expect(taskPrimary).toMatchObject({ name: 'Task', type: 'singleLineText' });
    const taskRecords = await allRecords(tasks.id);
    expect(taskRecords).toHaveLength(150);
    // Airtable's inverse link is our link's inverse field, renamed, single like Airtable's.
    const project = tasks.fields.find((f) => f.name === 'Project');
    expect(project).toMatchObject({ type: 'link', options: { prefersSingleRecordLink: true } });
    expect(field('Tasks').options).toMatchObject({ inverseLinkFieldId: project?.id });
    const linkedToApollo = taskRecords.filter((r) =>
      linkIds(r.fields[project?.id ?? '']).includes(apollo.id)
    );
    expect(linkedToApollo.map((r) => r.id).sort()).toEqual(linkIds(cell('Tasks')));
    expect(taskRecords.filter((r) => !r.fields[project?.id ?? '']).length).toBe(65);

    // Views: the grid's visible fields in order, the kanban by the single select;
    // calendar and form views are listed.
    const viewsOf = async (tableId: string) =>
      (
        await ok<{ views: { name: string; type: string; config: Record<string, unknown> }[] }>(
          await request('GET', `/api/tables/${tableId}/views`)
        )
      ).views;
    const projectViews = await viewsOf(projects.id);
    expect(projectViews.map((v) => [v.name, v.type])).toEqual([
      ['All projects', 'grid'],
      ['By status', 'kanban'],
    ]);
    const grid = projectViews[0]?.config['grid'] as {
      fieldOrder: string[];
      hiddenFields: string[];
    };
    expect(grid.fieldOrder).toEqual(['Name', 'Status', 'Budget', 'Tasks'].map((n) => field(n).id));
    expect(grid.hiddenFields).toContain(field('Notes').id);
    expect(grid.hiddenFields).not.toContain(field('Status').id);
    expect(projectViews[1]?.config['kanban']).toMatchObject({ stackFieldId: field('Status').id });
    expect((await viewsOf(tasks.id)).map((v) => v.name)).toEqual(['Grid view']);
    expect(done.report.views).toBe(3);
    expect(done.report.unsupportedViews.map((v) => `${v.table}.${v.view}:${v.type}`)).toEqual([
      'Projects.Due dates:calendar',
      'Tasks.New task:form',
    ]);
    // The record map is gone with the job.
    const { rows: map } = await t.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM airtable_import_records WHERE job_id = ${job.id}`
    );
    expect(map[0]?.n).toBe(0);
    expect(taskRecords.map((r) => r.fields[taskPrimary?.id ?? ''])).toContain('Task 150 #150');
    expect(
      fake.requests.filter((r) => r.url.includes('/tblTasks000000001')).map((r) => r.url)
    ).toHaveLength(2);

    // The report.
    expect(done.report.tables).toEqual([
      { name: 'Projects', tableId: projects.id, fields: projects.fields.length, records: 3 },
      { name: 'Tasks', tableId: tasks.id, fields: tasks.fields.length, records: 150 },
    ]);
    expect(done.report.unsupportedFields.map((f) => `${f.table}.${f.field}:${f.type}`)).toEqual([
      'Projects.Synced from:externalSyncSource',
    ]);
    // The primary formula when its table is created; the others once every table exists.
    expect(done.report.untranslatedFormulas).toEqual([
      expect.objectContaining({ table: 'Tasks', field: 'Task' }),
      expect.objectContaining({
        table: 'Projects',
        field: 'Code',
        formula: 'AUTONUMBER() & "-" & {Name}',
        message: 'Unknown function AUTONUMBER',
      }),
    ]);
    expect(done.report.converted.map((c) => c.field)).toEqual([
      'Effort',
      'Created',
      'Modified',
      'Created by',
      'Modified by',
      'No.',
      'Open',
      'AI summary',
      'Number',
    ]);
    // Grace alone (Apollo's modified by, Hermes' owner and created by) and Hermes' invalid
    // barcode; Apollo's team keeps Ada.
    expect(done.report.skippedCells).toBe(4);
    expect(done.report.truncatedTables).toEqual([]);

    // The job wrote only into its own base.
    const tablesAfter = await t.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM tables WHERE base_id = ${bystander.id}`
    );
    expect(tablesAfter.rows[0]?.n).toBe(tablesBefore.rows[0]?.n);
    const { rows: outside } = await t.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM tables WHERE created_at > ${done.createdAt}::timestamptz
            AND base_id <> ${job.baseId}`
    );
    expect(outside[0]?.n).toBe(0);

    // The list shows it to who started it.
    const list = await ok<{ imports: AirtableImport[] }>(
      await request('GET', `/api/workspaces/${workspaceId}/airtable/imports`)
    );
    expect(list.imports.map((i) => i.id)).toContain(job.id);

    // The token never reached the logs; the API's requests went to api.airtable.com with it,
    // and file downloads to Airtable's file hosts without it.
    expect(JSON.stringify(app.logs)).not.toContain(FIXTURE_TOKEN);
    const hosts = new Set(fake.requests.map((r) => new URL(r.url).host));
    expect([...hosts].sort()).toEqual([
      'api.airtable.com',
      'dl.airtable.com',
      'v5.airtableusercontent.com',
    ]);
    for (const r of fake.requests) {
      const api = new URL(r.url).host === 'api.airtable.com';
      // (The first test's wrong token went to Airtable too, and was refused.)
      if (api) expect(r.authorization, r.url).toMatch(/^Bearer pat/);
      else expect(r.authorization, r.url).toBeUndefined();
    }
  });

  it('fails the job with a message when Airtable refuses the token later', async () => {
    const refusing = fakeAirtable({ token: `patSomeoneElse001.${'0'.repeat(64)}` });
    const other = testApp({ db: t.appDb, airtable: { http: fake.http, sleep: instant } });
    const res = await other.app.request(`/api/workspaces/${workspaceId}/airtable/imports`, {
      method: 'POST',
      headers: {
        origin: other.config.appUrl,
        cookie: `${SESSION_COOKIE}=${ownerCookie}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token: FIXTURE_TOKEN, baseIds: [FIXTURE_BASE_ID] }),
    });
    const { imports } = (await res.json()) as { imports: AirtableImport[] };
    const id = imports[0]?.id ?? '';
    // The worker's Airtable no longer takes the token (revoked meanwhile).
    const worker = testApp({ db: t.appDb, airtable: { http: refusing.http, sleep: instant } });
    await worker.runJob(id);
    const failed = await getImport(id);
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed.error).toContain('Airtable rejected the token');
    expect(JSON.stringify(worker.logs)).not.toContain(FIXTURE_TOKEN);
  });

  it('waits out a 429 and spaces its requests', async () => {
    const slow = fakeAirtable();
    const waits: number[] = [];
    let clock = Date.now();
    const sleep = async (ms: number) => {
      waits.push(ms);
      clock += ms;
    };
    const limited = testApp({
      db: t.appDb,
      airtable: { http: slow.http, sleep, now: () => clock },
    });
    const res = await limited.app.request(`/api/workspaces/${workspaceId}/airtable/imports`, {
      method: 'POST',
      headers: {
        origin: limited.config.appUrl,
        cookie: `${SESSION_COOKIE}=${ownerCookie}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token: FIXTURE_TOKEN, baseIds: [FIXTURE_BASE_ID] }),
    });
    const { imports } = (await res.json()) as { imports: AirtableImport[] };
    slow.rateLimitNext(1);
    await limited.runJob(imports[0]?.id ?? '');
    expect(await getImport(imports[0]?.id ?? '')).toMatchObject({ status: 'done', records: 153 });
    expect(waits).toContain(30_000);
    // Every other wait keeps to 5 requests a second.
    expect(waits.filter((w) => w !== 30_000).every((w) => w > 0 && w <= 200)).toBe(true);
  });

  it('resumes the links after a crash, without writing a link twice', async () => {
    const small = fakeAirtable({ large: { companies: 20, contacts: 250 } });
    const other = testApp({ db: t.appDb, airtable: { http: small.http, sleep: instant } });
    const res = await other.app.request(`/api/workspaces/${workspaceId}/airtable/imports`, {
      method: 'POST',
      headers: {
        origin: other.config.appUrl,
        cookie: `${SESSION_COOKIE}=${ownerCookie}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token: FIXTURE_TOKEN, baseIds: [LARGE_BASE_ID] }),
    });
    const id = ((await res.json()) as { imports: AirtableImport[] }).imports[0]?.id ?? '';
    // 4 pages of records, then the first of 3 batches of links: the worker dies there.
    let calls = 0;
    await expect(
      other.runJob(id, {
        afterPage: () => {
          if (++calls === 5) throw new Error('worker died');
        },
      })
    ).rejects.toThrow('worker died');
    expect(await getImport(id)).toMatchObject({
      status: 'running',
      phase: 'links',
      linkedRecords: 100,
    });
    await other.runJob(id);
    const done = await getImport(id);
    expect(done).toMatchObject({ status: 'done', records: 270, linkedRecords: 250 });
    const { rows } = await t.db.execute<{ junction: string }>(
      sql`SELECT format('%I.%I', t.db_schema, f.db_column) AS junction
            FROM fields f JOIN tables t ON t.id = f.table_id
           WHERE t.base_id = ${done.baseId} AND f.type = 'link' AND f.name = 'Contacts'`
    );
    const junction = rows[0]?.junction ?? '';
    const { rows: n } = await t.db.execute<{ n: number }>(
      sql.raw(`SELECT count(*)::int AS n FROM ${junction}`)
    );
    expect(n[0]?.n).toBe(250);
  });

  it('cancels an import: it stops, and the base keeps what was imported', async () => {
    const { imports } = await startImport();
    const id = imports[0]?.id ?? '';
    const cancel = () =>
      request('POST', `/api/workspaces/${workspaceId}/airtable/imports/${id}/cancel`);
    // Cancelled after the first page of records.
    await app.runJob(id, {
      afterPage: async () => {
        await ok<AirtableImport>(await cancel());
      },
    });
    const cancelled = await getImport(id);
    expect(cancelled).toMatchObject({ status: 'cancelled', records: 3 });
    expect(cancelled.error).toContain('cancelled');
    expect(cancelled.finishedAt).not.toBeNull();
    const { rows } = await t.db.execute<{ payload: string | null; maps: number }>(
      sql`SELECT payload, (SELECT count(*)::int FROM airtable_import_records WHERE job_id = ${id}) AS maps
            FROM jobs WHERE id = ${id}`
    );
    expect(rows[0]).toEqual({ payload: null, maps: 0 });
    expect((await tablesOf(cancelled.baseId)).map((x) => x.name)).toEqual(['Projects', 'Tasks']);
    // Again: nothing changes. Someone else: 404.
    expect(await ok<AirtableImport>(await cancel())).toMatchObject({ status: 'cancelled' });
    const res = await request(
      'POST',
      `/api/workspaces/${workspaceId}/airtable/imports/${id}/cancel`,
      undefined,
      editorCookie
    );
    expect(res.status).toBe(403);
    expect(await app.runJob(id)).toEqual({ status: 'gone' });
  });

  it('drops the token after 24 hours and fails a job still running', async () => {
    const { imports } = await startImport();
    const id = imports[0]?.id ?? '';
    await t.db.execute(
      sql`UPDATE jobs SET created_at = now() - interval '25 hours' WHERE id = ${id}`
    );
    await sweepJobs(t.appDb);
    const { rows } = await t.db.execute<{ payload: string | null; status: string }>(
      sql`SELECT payload, status FROM jobs WHERE id = ${id}`
    );
    expect(rows[0]).toEqual({ payload: null, status: 'failed' });
    expect((await getImport(id)).error).toContain('more than 24 hours');
    // A run after that has nothing to do.
    expect(await app.runJob(id)).toEqual({ status: 'gone' });
  });

  it('is only readable by who started it', async () => {
    const { imports } = await startImport();
    const id = imports[0]?.id ?? '';
    const creator = await addMember(t.db, workspaceId, 'creator');
    const cookie = await createSession(t.db, creator);
    const res = await request(
      'GET',
      `/api/workspaces/${workspaceId}/airtable/imports/${id}`,
      undefined,
      cookie
    );
    expect(res.status).toBe(404);
    const list = await ok<{ imports: AirtableImport[] }>(
      await request('GET', `/api/workspaces/${workspaceId}/airtable/imports`, undefined, cookie)
    );
    expect(list.imports).toEqual([]);
  });
});
