import {
  type AirtableImport,
  type Comment,
  MAX_COMMENTS_PER_RECORD,
  mentionToken,
  type RecordData,
  type TableMeta,
  type UserRole,
} from '@openrows/shared';
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
import { COLLABORATORS_FORBIDDEN } from '../../src/airtable/collaborators.js';
import {
  SHARES_FORBIDDEN,
  SHARES_NOT_RECREATED,
  SHARES_TOKEN_REJECTED,
} from '../../src/airtable/shares.js';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import type { users } from '../../src/db/index.js';
import { memoryTransport } from '../../src/email/transport.js';
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
import { planEdition } from '../helpers/plans.js';

/**
 * The Airtable importer against the recorded-fixture fake of Airtable's API: the token
 * check, a base with every Airtable field type, formulas translated or kept as text, records
 * paged by 100, record comments (authors, mentions, reactions, replies; without the scope,
 * the rest still imports), the report, the token never shown or logged and dropped after 24
 * hours, and the job writing only into its own new base.
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
  const mailbox = memoryTransport();
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

  async function commentsOf(tableId: string, recordId: string): Promise<Comment[]> {
    const page = await ok<{ comments: Comment[] }>(
      await request('GET', `/api/tables/${tableId}/records/${recordId}/comments?limit=100`)
    );
    return page.comments;
  }

  /** Starts an import of the fixture base on an app over another fake Airtable. */
  async function importWith(
    airtable: ReturnType<typeof fakeAirtable>,
    baseIds = [FIXTURE_BASE_ID]
  ) {
    const other = testApp({
      db: t.appDb,
      airtable: { http: airtable.http, sleep: instant },
      objectStore: store,
    });
    const res = await other.app.request(`/api/workspaces/${workspaceId}/airtable/imports`, {
      method: 'POST',
      headers: {
        origin: other.config.appUrl,
        cookie: `${SESSION_COOKIE}=${ownerCookie}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token: FIXTURE_TOKEN, baseIds }),
    });
    const id = ((await ok<{ imports: AirtableImport[] }>(res, 201)).imports[0]?.id ?? '') as string;
    return { app: other, id };
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
      email: mailbox,
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
      phase: 'comments',
      tables: 2,
      tablesDone: 2,
      records: 153,
      attachments: 3,
      attachmentsFailed: 2,
      // Apollo's and Hermes' tasks, written from the Tasks side (one link per cell).
      linkedRecords: 85,
      // Every record's comments were read; Apollo's and Hermes' have some.
      commentRecords: 153,
      comments: 4,
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
      Created: 'createdTime',
      Modified: 'date',
      'Created by': 'createdBy',
      'Modified by': 'user',
      'No.': 'number',
      SKU: 'barcode',
      Open: 'url',
      'AI summary': 'longText',
      'Budget x2': 'formula',
      Size: 'formula',
      Code: 'singleLineText',
      Summary: 'formula',
      'Days left': 'singleLineText',
      Source: 'singleLineText',
      'Created on': 'formula',
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
    // Created time and created by are live, with Airtable's creation time and creator;
    // CREATED_TIME() reads the same.
    expect(cell('Created by')).toBe(ada.id);
    expect(cell('Created')).toBe('2024-01-05T09:00:00.000Z');
    expect(cell('Created on')).toBe('2024-01-05');
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
    // Hermes' creator, Grace, isn't a member: nobody; the record keeps Airtable's creation time.
    expect(hermes?.fields[field('Created by').id] ?? null).toBeNull();
    expect(hermes?.fields[field('Created').id]).toBe('2024-01-06T09:00:00.000Z');
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

    // Comments: oldest first, Airtable's times, the author matched by email, a non-member's
    // comment headed by their name, mentions as tokens for members and plain names otherwise,
    // the reply in the same thread, reactions with our emoji by members.
    const thread = await commentsOf(projects.id, apollo.id);
    expect(thread.map((c) => [c.authorId, c.body, c.createdAt, c.editedAt])).toEqual([
      [
        ada.id,
        'Kickoff notes are in the **brief**. @Grace Hopper can you review?',
        '2024-01-10T09:00:00.000Z',
        null,
      ],
      [
        null,
        `**Grace Hopper (grace@airtable-fixture.test)**:\n\nLooks good to me, ${mentionToken(ada.id, 'Ada')}! Notes attached.`,
        '2024-01-10T10:30:00.000Z',
        '2024-01-10T11:00:00.000Z',
      ],
      [
        ada.id,
        'FYI @Design team and @Launch bot: the launch moved.',
        '2024-01-11T09:00:00.000Z',
        null,
      ],
    ]);
    expect(thread.map((c) => c.mentions)).toEqual([[], [ada.id], []]);
    expect(thread.map((c) => c.reactions)).toEqual([
      [{ reaction: 'thumbsUp', userIds: [ada.id] }],
      [{ reaction: 'thumbsUp', userIds: [ada.id] }],
      [],
    ]);
    const hermesThread = await commentsOf(projects.id, hermes?.id ?? '');
    expect(hermesThread).toHaveLength(1);
    expect(hermesThread[0]?.body).toContain('Ship it 🎉');
    expect(hermesThread[0]?.body).not.toContain('<script');
    expect(hermesThread[0]?.reactions).toEqual([{ reaction: 'tada', userIds: [ada.id] }]);
    // Old comments notify nobody: no notifications, no comment events (Ada is mentioned).
    const { rows: noticed } = await t.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM notifications WHERE base_id = ${job.baseId}`
    );
    expect(noticed[0]?.n).toBe(0);
    const { rows: events } = await t.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM outbox WHERE base_id = ${job.baseId} AND kind LIKE 'comment.%'`
    );
    expect(events[0]?.n).toBe(0);
    // Comment attachments aren't copied, nor their URLs kept.
    expect(fake.requests.some((r) => r.url.includes('comment-'))).toBe(false);
    const { rows: bodies } = await t.db.execute<{ body: string }>(
      sql`SELECT body FROM record_comments WHERE base_id = ${job.baseId}`
    );
    expect(bodies.some((b) => b.body.includes('airtableusercontent'))).toBe(false);
    expect(done.report.comments).toEqual({
      imported: 4,
      replies: 1,
      reactions: 3,
      unavailable: null,
      unmatchedAuthors: ['Grace Hopper (grace@airtable-fixture.test)'],
      unmatchedAuthorComments: 1,
      plainMentions: 3,
      otherReactions: 1,
      unmatchedReactions: 1,
      attachments: [
        { table: 'Projects', filename: 'screenshot.png' },
        { table: 'Projects', filename: 'review-notes.pdf' },
      ],
      emptyComments: 1,
      truncatedComments: 0,
      cappedRecords: 0,
      unreadRecords: 0,
    });
    // One request for each record's comments.
    expect(fake.requests.filter((r) => r.url.includes('/comments')).length).toBe(153);

    // Views: the grid's visible fields in order, the kanban by the single select, the
    // calendar and timeline by the first date field, the gallery covered by the attachments;
    // the block view, the form and a calendar without a date field are listed.
    const viewsOf = async (tableId: string) =>
      (
        await ok<{
          views: { id: string; name: string; type: string; config: Record<string, unknown> }[];
        }>(await request('GET', `/api/tables/${tableId}/views`))
      ).views;
    const projectViews = await viewsOf(projects.id);
    expect(projectViews.map((v) => [v.name, v.type])).toEqual([
      ['All projects', 'grid'],
      ['By status', 'kanban'],
      ['Due dates', 'calendar'],
      ['Moodboard', 'gallery'],
      ['Roadmap', 'timeline'],
    ]);
    const grid = projectViews[0]?.config['grid'] as {
      fieldOrder: string[];
      hiddenFields: string[];
    };
    expect(grid.fieldOrder).toEqual(['Name', 'Status', 'Budget', 'Tasks'].map((n) => field(n).id));
    expect(grid.hiddenFields).toContain(field('Notes').id);
    expect(grid.hiddenFields).not.toContain(field('Status').id);
    expect(projectViews[1]?.config['kanban']).toMatchObject({ stackFieldId: field('Status').id });
    expect(projectViews[2]?.config['calendar']).toMatchObject({
      dateFields: [{ startFieldId: field('Due').id }],
    });
    expect(projectViews[3]?.config['gallery']).toMatchObject({ coverFieldId: field('Files').id });
    expect(projectViews[4]?.config['timeline']).toMatchObject({ startFieldId: field('Due').id });
    expect((await viewsOf(tasks.id)).map((v) => v.name)).toEqual(['Grid view']);
    expect(done.report.views).toBe(6);
    expect(done.report.unsupportedViews.map((v) => `${v.table}.${v.view}:${v.type}`)).toEqual([
      'Projects.Gantt:block',
      'Tasks.New task:form',
      'Tasks.Task calendar:calendar',
    ]);
    expect(done.report.unsupportedViews[2]?.message).toBe(
      'There is no date field to place the records by.'
    );
    // Each view created says what Airtable's API didn't share, and what was chosen here.
    expect(done.report.partialViews.map((v) => `${v.table}.${v.view}:${v.type}`)).toEqual([
      'Projects.All projects:grid',
      'Projects.By status:kanban',
      'Projects.Due dates:calendar',
      'Projects.Moodboard:gallery',
      'Projects.Roadmap:timeline',
      'Tasks.Grid view:grid',
    ]);
    expect(done.report.partialViews[1]?.message).toContain(
      `Stacked by "Status", the table's first single select`
    );
    expect(done.report.partialViews[2]?.message).toContain(`Records placed by "Due"`);
    // The record map is gone with the job.
    const { rows: map } = await t.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM airtable_import_records WHERE job_id = ${job.id}`
    );
    expect(map[0]?.n).toBe(0);
    expect(taskRecords.map((r) => r.fields[taskPrimary?.id ?? ''])).toContain('Task 150 #150');
    expect(
      fake.requests
        .filter((r) => r.url.includes('/tblTasks000000001') && !r.url.includes('/comments'))
        .map((r) => r.url)
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
        message: 'There is no AUTONUMBER function here.',
      }),
      expect.objectContaining({
        table: 'Projects',
        field: 'Days left',
        formula: '{Due} - TODAY()',
        message: expect.stringMatching(/^"-" needs numbers, but this is a date .*, in \{Due\}$/),
      }),
      expect.objectContaining({
        table: 'Projects',
        field: 'Source',
        formula: '{Synced from} & ""',
        message: 'It reads "Synced from", which wasn\'t imported.',
      }),
      expect.objectContaining({
        table: 'Tasks',
        field: 'Label',
        formula: 'UPPER({Task})',
        message: 'It reads "Task", a formula kept as text here.',
      }),
    ]);
    expect(field('Days left').description).toBe('Airtable formula: {Due} - TODAY()');
    expect(cell('Days left')).toBe('30');
    expect(done.report.converted.map((c) => c.field)).toEqual([
      'Effort',
      'Modified',
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

    // Collaborators: Ada (a workspace editor, Airtable's "create") is a creator of the new base;
    // the others aren't members, and are only listed. Nobody was invited or emailed.
    expect(done.report.collaborators).toEqual({
      unavailable: null,
      raised: [
        {
          email: 'ada@airtable-fixture.test',
          name: 'Ada',
          level: 'create',
          role: 'creator',
          previous: 'editor',
        },
      ],
      unchanged: 0,
      notMembers: [
        { email: 'linus@airtable-fixture.test', level: 'comment' },
        { email: 'grace@airtable-fixture.test', level: 'owner' },
      ],
      notApplied: [
        {
          email: 'katherine@airtable-fixture.test',
          level: 'none',
          message: expect.stringContaining('no access'),
        },
      ],
      groups: [
        { name: 'Design team', level: 'edit', scope: 'base' },
        { name: 'Everyone', level: 'read', scope: 'workspace' },
      ],
      invitations: [],
      interfaceOnly: [],
    });
    const { rows: baseRoles } = await t.db.execute<{ user_id: string; role: string }>(
      sql`SELECT user_id::text, role FROM base_members WHERE base_id = ${job.baseId}`
    );
    expect(baseRoles).toEqual([{ user_id: ada.id, role: 'creator' }]);
    expect(mailbox.sent).toEqual([]);

    // Share links: listed with one GET, view links matched to the imported views; none created.
    expect(done.report.shares).toMatchObject({
      unavailable: null,
      note: SHARES_NOT_RECREATED,
      total: 5,
      enabled: 3,
      disabled: 2,
      byType: { base: 1, view: 3, blockInstallation: 1, other: 0 },
      viewsImported: 2,
      viewsNotImported: 1,
      unreadable: 0,
    });
    expect(
      done.report.shares?.shares.map((l) => [l.shareId, l.view?.viewId ?? null, l.createdByEmail])
    ).toEqual([
      ['shrBaseFixture001', null, 'grace@airtable-fixture.test'],
      ['shrKanbanFixture1', projectViews[1]?.id, 'ada@airtable-fixture.test'],
      ['shrFormFixture001', null, 'ada@airtable-fixture.test'],
      ['shrGridFixture001', projectViews[0]?.id, null],
      ['shrBlockFixture01', null, 'grace@airtable-fixture.test'],
    ]);
    expect(done.report.shares?.shares[1]?.view).toEqual({
      tableId: projects.id,
      table: 'Projects',
      viewId: projectViews[1]?.id,
      name: 'By status',
    });
    const asked = fake.requests.filter((r) => r.url.endsWith('/shares'));
    expect(asked.map((r) => [r.method, new URL(r.url).pathname])).toEqual([
      ['GET', `/v0/meta/bases/${FIXTURE_BASE_ID}/shares`],
    ]);
    const { rows: links } = await t.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM shares WHERE base_id = ${job.baseId}`
    );
    expect(links[0]?.n).toBe(0);

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

  it('imports everything else when the token lacks the comments scope, and says so once', async () => {
    const scopeless = fakeAirtable({ commentsScope: false });
    const { app: other, id } = await importWith(scopeless);
    await other.runJob(id);
    const done = await getImport(id);
    expect(done).toMatchObject({
      status: 'done',
      error: null,
      records: 153,
      linkedRecords: 85,
      comments: 0,
      percent: 100,
    });
    expect(done.report.comments.unavailable).toContain('data.recordComments:read');
    expect(done.report.comments.imported).toBe(0);
    // One refused request, not one per record.
    expect(scopeless.requests.filter((r) => r.url.includes('/comments'))).toHaveLength(1);
    const { rows } = await t.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM record_comments WHERE base_id = ${done.baseId}`
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("skips a record whose comments Airtable doesn't return, and stops when it keeps failing", async () => {
    const flaky = fakeAirtable({
      commentsStatus: (record) =>
        record === 'recHermes00000000' ? 404 : record.startsWith('recTask') ? 503 : undefined,
    });
    const { app: other, id } = await importWith(flaky);
    await other.runJob(id);
    const done = await getImport(id);
    expect(done).toMatchObject({ status: 'done', error: null, records: 153 });
    // Apollo's comments came over; Hermes was gone at Airtable; 5 failures in a row end the pass.
    expect(done.report.comments).toMatchObject({
      imported: 3,
      unreadRecords: 6,
      unavailable: expect.stringContaining('Airtable stopped returning comments'),
    });
    expect(flaky.requests.filter((r) => r.url.includes('/comments'))).toHaveLength(8);
  });

  it("keeps a record's newest 1,000 comments and reports the rest", async () => {
    const many = Array.from({ length: MAX_COMMENTS_PER_RECORD + 5 }, (_, i) => ({
      id: `comMany${String(i).padStart(9, '0')}`,
      // Newest first, a minute apart.
      createdTime: new Date(Date.UTC(2024, 0, 1) + (2000 - i) * 60_000).toISOString(),
      lastUpdatedTime: null,
      text: `Comment ${i}`,
      author: { id: 'usrAda0000000001', email: 'ada@airtable-fixture.test', name: 'Ada' },
    }));
    const busy = fakeAirtable({ comments: { recHermes00000000: many } });
    const { app: other, id } = await importWith(busy);
    await other.runJob(id);
    const done = await getImport(id);
    expect(done).toMatchObject({ status: 'done', comments: MAX_COMMENTS_PER_RECORD });
    expect(done.report.comments).toMatchObject({
      imported: MAX_COMMENTS_PER_RECORD,
      cappedRecords: 1,
    });
    const { rows } = await t.db.execute<{ body: string }>(
      sql`SELECT body FROM record_comments WHERE base_id = ${done.baseId} ORDER BY created_at`
    );
    expect(rows).toHaveLength(MAX_COMMENTS_PER_RECORD);
    // Airtable lists the newest first: the oldest 5 were left out.
    expect(rows[0]?.body).toBe(`Comment ${MAX_COMMENTS_PER_RECORD - 1}`);
    expect(rows.at(-1)?.body).toBe('Comment 0');
  });

  it('cancels during the comments: it stops there, and keeps the comments written', async () => {
    const { app: other, id } = await importWith(fakeAirtable());
    const cancel = () =>
      request('POST', `/api/workspaces/${workspaceId}/airtable/imports/${id}/cancel`);
    let cancelled = false;
    await other.runJob(id, {
      afterPage: async () => {
        const now = await getImport(id);
        if (now.phase === 'comments' && now.commentRecords > 0 && !cancelled) {
          cancelled = true;
          await ok<AirtableImport>(await cancel());
        }
      },
    });
    const after = await getImport(id);
    expect(after).toMatchObject({ status: 'cancelled', phase: 'comments', commentRecords: 3 });
    // The first batch was Projects' 3 records: their comments are in, Tasks' never read.
    expect(after.comments).toBe(4);
    expect(await other.runJob(id)).toEqual({ status: 'gone' });
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

/**
 * Airtable's collaborators onto the imported base: only people who are already workspace
 * members are ever given a base role (when it raises their access), silently; everyone else is
 * listed. No invitations, emails, accounts, workspace role changes or notifications.
 */
describe('Airtable import: collaborators and roles', () => {
  const t = useTestDb();
  const instant = async () => {};
  const at = (name: string) => `${name}@collab-fixture.test`;
  const level = (name: string, permissionLevel: string) => ({
    createdTime: '2024-01-01T00:00:00.000Z',
    email: at(name),
    grantedByUserId: 'usrSomeone000001',
    permissionLevel,
    userId: `usr${name.padEnd(13, '0').slice(0, 13)}`,
  });
  /** Airtable's answer for the cases below. */
  const answer = {
    id: FIXTURE_BASE_ID,
    name: 'Product launch',
    permissionLevel: 'owner',
    workspaceId: 'wspFixture0000001',
    createdTime: '2023-11-02T08:00:00.000Z',
    individualCollaborators: {
      baseCollaborators: [
        level('boss', 'owner'),
        level('importer', 'owner'),
        level('ed', 'create'),
        level('ro', 'comment'),
        level('cr', 'read'),
        level('nobody', 'none'),
        level('pending', 'edit'),
        level('stranger', 'edit'),
      ],
      workspaceCollaborators: [
        level('com', 'edit'),
        level('ro', 'read'),
        { ...level('ED', 'edit') },
      ],
    },
    groupCollaborators: {
      baseCollaborators: [
        {
          createdTime: '2024-01-01T00:00:00.000Z',
          groupId: 'ugpDesign0000001',
          name: 'Design team',
          permissionLevel: 'edit',
        },
      ],
      workspaceCollaborators: [
        {
          createdTime: '2024-01-01T00:00:00.000Z',
          groupId: 'ugpEveryone00001',
          name: 'Everyone',
          permissionLevel: 'read',
        },
      ],
    },
    // Neither is asked for; if Airtable sends them anyway, they are only listed.
    inviteLinks: {
      baseInviteLinks: [
        {
          createdTime: '2024-01-01T00:00:00.000Z',
          id: 'invPending000001',
          invitedEmail: at('pending'),
          permissionLevel: 'edit',
          referredByUserId: 'usrSomeone000001',
          restrictedToEmailDomains: [],
          type: 'singleUse',
        },
        {
          createdTime: '2024-01-01T00:00:00.000Z',
          id: 'invShared0000001',
          invitedEmail: null,
          permissionLevel: 'read',
          referredByUserId: 'usrSomeone000001',
          restrictedToEmailDomains: [],
          type: 'multiUse',
        },
      ],
      workspaceInviteLinks: [],
    },
    interfaces: {
      pbdLaunch0000001: {
        id: 'pbdLaunch0000001',
        name: 'Launch dashboard',
        createdTime: '2024-01-01T00:00:00.000Z',
        firstPublishTime: null,
        individualCollaborators: [level('iface', 'read')],
        groupCollaborators: [],
        inviteLinks: [],
      },
    },
  };

  let workspaceId: string;
  let importer: typeof users.$inferSelect;
  let cookie: string;
  const people: Record<string, typeof users.$inferSelect> = {};

  beforeAll(async () => {
    const boss = await createUser(t.db, { email: at('boss'), name: 'Boss' });
    ({
      workspace: { id: workspaceId },
    } = await createWorkspace(t.db, { owner: boss }));
    people['boss'] = boss;
    importer = await addMember(
      t.db,
      workspaceId,
      'creator',
      await createUser(t.db, { email: at('importer'), name: 'Importer' })
    );
    people['importer'] = importer;
    cookie = await createSession(t.db, importer);
    const roles: [string, UserRole][] = [
      ['ed', 'editor'],
      ['com', 'commenter'],
      ['ro', 'read_only'],
      ['cr', 'creator'],
      ['nobody', 'editor'],
      ['pending', 'read_only'],
      ['iface', 'read_only'],
    ];
    for (const [name, role] of roles) {
      people[name] = await addMember(
        t.db,
        workspaceId,
        role,
        await createUser(t.db, { email: at(name), name })
      );
    }
  });

  /** Imports the fixture base through `airtable` (as the importer) and runs the job. */
  async function run(
    airtable: ReturnType<typeof fakeAirtable>,
    opts: {
      edition?: ReturnType<typeof planEdition>['edition'];
      afterStart?: (id: string, app: ReturnType<typeof testApp>) => void;
    } = {}
  ) {
    const mailbox = memoryTransport();
    const app = testApp({
      db: t.appDb,
      airtable: { http: airtable.http, sleep: instant },
      email: mailbox,
      ...(opts.edition ? { edition: opts.edition } : {}),
    });
    const headers = {
      origin: app.config.appUrl,
      cookie: `${SESSION_COOKIE}=${cookie}`,
      'content-type': 'application/json',
    };
    const res = await app.app.request(`/api/workspaces/${workspaceId}/airtable/imports`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ token: FIXTURE_TOKEN, baseIds: [FIXTURE_BASE_ID] }),
    });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { imports: AirtableImport[] }).imports[0]?.id ?? '';
    opts.afterStart?.(id, app);
    await app.runJob(id);
    const get = await app.app.request(`/api/workspaces/${workspaceId}/airtable/imports/${id}`, {
      headers,
    });
    const done = (await get.json()) as AirtableImport;
    const { rows } = await t.db.execute<{ email: string; role: string }>(
      sql`SELECT u.email, bm.role FROM base_members bm JOIN users u ON u.id = bm.user_id
           WHERE bm.base_id = ${done.baseId} ORDER BY u.email`
    );
    return {
      app,
      mailbox,
      done,
      baseRoles: Object.fromEntries(rows.map((r) => [r.email, r.role])),
    };
  }

  /** What must never change: accounts, workspace roles, invitations, notifications. */
  async function snapshot() {
    const { rows } = await t.db.execute<{
      users: number;
      members: string;
      invitations: number;
      notifications: number;
      access: number;
    }>(sql`
      SELECT (SELECT count(*)::int FROM users) AS users,
             (SELECT string_agg(user_id::text || ':' || role, ',' ORDER BY user_id)
                FROM workspace_members WHERE workspace_id = ${workspaceId}) AS members,
             (SELECT count(*)::int FROM workspace_invitations) AS invitations,
             (SELECT count(*)::int FROM notifications) AS notifications,
             (SELECT count(*)::int FROM outbox WHERE kind LIKE 'member.%' OR kind LIKE 'baseMember.%') AS access`);
    return rows[0];
  }

  it('raises workspace members to their Airtable level on the new base, and only lists everyone else', async () => {
    const before = await snapshot();
    const fake = fakeAirtable({ collaborators: answer });
    const { app, mailbox, done, baseRoles } = await run(fake);
    expect(done).toMatchObject({ status: 'done', error: null, records: 153 });

    // Raised: an editor to creator ("create"), a commenter to editor (workspace "edit" only), a
    // read-only member to commenter (base "comment" beats workspace "read"). Nobody else.
    expect(baseRoles).toEqual({
      [at('com')]: 'editor',
      [at('ed')]: 'creator',
      [at('ro')]: 'commenter',
    });
    const c = done.report.collaborators;
    expect(c?.unavailable).toBeNull();
    expect(c?.raised).toEqual([
      { email: at('ed'), name: 'ed', level: 'create', role: 'creator', previous: 'editor' },
      { email: at('ro'), name: 'ro', level: 'comment', role: 'commenter', previous: 'read_only' },
      { email: at('com'), name: 'com', level: 'edit', role: 'editor', previous: 'commenter' },
    ]);
    // The workspace owner (never a base role), the importer, and a creator listed as "read".
    expect(c?.unchanged).toBe(3);
    expect(baseRoles[at('boss')]).toBeUndefined();
    expect(baseRoles[at('importer')]).toBeUndefined();
    expect(baseRoles[at('cr')]).toBeUndefined();
    // Not a member: listed, not invited, no account.
    expect(c?.notMembers).toEqual([{ email: at('stranger'), level: 'edit' }]);
    // An unknown level: not applied.
    expect(c?.notApplied).toEqual([
      { email: at('nobody'), level: 'none', message: expect.stringContaining('no access') },
    ]);
    expect(baseRoles[at('nobody')]).toBeUndefined();
    // Groups, an open invitation and an interface-only person: listed only, even when a member.
    expect(c?.groups).toEqual([
      { name: 'Design team', level: 'edit', scope: 'base' },
      { name: 'Everyone', level: 'read', scope: 'workspace' },
    ]);
    expect(c?.invitations).toEqual([{ email: at('pending'), level: 'edit' }]);
    expect(c?.interfaceOnly).toEqual([
      { email: at('iface'), level: 'read', interface: 'Launch dashboard' },
    ]);
    expect(baseRoles[at('pending')]).toBeUndefined();
    expect(baseRoles[at('iface')]).toBeUndefined();

    // No accounts, workspace roles, invitations, notifications, access events or emails.
    expect(await snapshot()).toEqual(before);
    expect(mailbox.sent).toEqual([]);
    const { rows: strangers } = await t.db.execute(
      sql`SELECT 1 FROM users WHERE lower(email) = ${at('stranger')}`
    );
    expect(strangers).toEqual([]);
    // Collaborators only: never invite links or interfaces.
    const asked = fake.requests.filter((r) => /\/v0\/meta\/bases\/app[^/]+\?/.test(r.url));
    expect(asked.map((r) => new URL(r.url).search)).toEqual(['?include%5B%5D=collaborators']);

    // The raised editor reaches the base as a creator now; the base's collaborators say so.
    const edCookie = await createSession(t.db, people['ed'] as typeof users.$inferSelect);
    const list = await app.app.request(`/api/bases/${done.baseId}/collaborators`, {
      headers: { cookie: `${SESSION_COOKIE}=${edCookie}` },
    });
    expect(list.status).toBe(200);
    const { collaborators } = (await list.json()) as {
      collaborators: { email: string; role: string }[];
    };
    expect(collaborators.find((x) => x.email === at('ed'))?.role).toBe('creator');
  });

  it("finishes the import when Airtable won't share the collaborators, and says so once", async () => {
    for (const status of [403, 503]) {
      const before = await snapshot();
      const { done, baseRoles } = await run(
        fakeAirtable({ collaborators: answer, collaboratorsStatus: status })
      );
      expect(done).toMatchObject({ status: 'done', error: null, records: 153 });
      expect(done.report.collaborators).toMatchObject({
        unavailable:
          status === 403
            ? COLLABORATORS_FORBIDDEN
            : expect.stringContaining("Airtable didn't answer (503)"),
        raised: [],
        notMembers: [],
      });
      expect(baseRoles).toEqual({});
      expect(await snapshot()).toEqual(before);
    }
    // An answer of another shape: the same.
    const { done } = await run(
      fakeAirtable({ collaborators: { id: FIXTURE_BASE_ID, individualCollaborators: 'x' } })
    );
    expect(done.status).toBe('done');
    expect(done.report.collaborators?.unavailable).toContain('unexpected answer');
  });

  it("finishes the import when the token can't list share links, and says so once", async () => {
    for (const [status, message] of [
      [403, SHARES_FORBIDDEN],
      [404, SHARES_FORBIDDEN],
      [401, SHARES_TOKEN_REJECTED],
      [503, expect.stringContaining("Airtable didn't answer (503)")],
    ] as const) {
      const before = await snapshot();
      const fake = fakeAirtable({ collaborators: answer, sharesStatus: status });
      const { done, baseRoles } = await run(fake);
      expect(done).toMatchObject({ status: 'done', error: null, records: 153 });
      // Everything else, the collaborators too, still came over.
      expect(done.report.collaborators?.unavailable).toBeNull();
      expect(baseRoles[at('ed')]).toBe('creator');
      expect(done.report.shares).toMatchObject({ unavailable: message, total: 0, shares: [] });
      expect(fake.requests.filter((r) => r.url.endsWith('/shares'))).toHaveLength(1);
      const { rows } = await t.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM shares WHERE base_id = ${done.baseId}`
      );
      expect(rows[0]?.n).toBe(0);
      const after = await snapshot();
      expect(after?.users).toBe(before?.users);
    }
  });

  it('gives no base roles when the import is cancelled before it ends', async () => {
    let cancel: () => Promise<void> = async () => {};
    const fake = fakeAirtable({ collaborators: answer, onCollaborators: () => cancel() });
    const { done, baseRoles } = await run(fake, {
      afterStart: (id, app) => {
        cancel = async () => {
          const res = await app.app.request(
            `/api/workspaces/${workspaceId}/airtable/imports/${id}/cancel`,
            {
              method: 'POST',
              headers: { origin: app.config.appUrl, cookie: `${SESSION_COOKIE}=${cookie}` },
            }
          );
          expect(res.status).toBe(200);
        };
      },
    });
    // Cancelled after the collaborators were read, before they were applied.
    expect(done.status).toBe('cancelled');
    expect(done.report.collaborators).toBeNull();
    expect(done.report.shares).toBeNull();
    expect(baseRoles).toEqual({});
  });

  it('gives no base roles when the import fails', async () => {
    const refusing = fakeAirtable({
      token: `patSomeoneElse001.${'0'.repeat(64)}`,
      collaborators: answer,
    });
    const app = testApp({ db: t.appDb, airtable: { http: fakeAirtable().http, sleep: instant } });
    const res = await app.app.request(`/api/workspaces/${workspaceId}/airtable/imports`, {
      method: 'POST',
      headers: {
        origin: app.config.appUrl,
        cookie: `${SESSION_COOKIE}=${cookie}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token: FIXTURE_TOKEN, baseIds: [FIXTURE_BASE_ID] }),
    });
    const id = ((await res.json()) as { imports: AirtableImport[] }).imports[0]?.id ?? '';
    const worker = testApp({ db: t.appDb, airtable: { http: refusing.http, sleep: instant } });
    await worker.runJob(id);
    const { rows } = await t.db.execute<{ status: string; base_id: string }>(
      sql`SELECT status, base_id::text FROM jobs WHERE id = ${id}`
    );
    expect(rows[0]?.status).toBe('failed');
    const { rows: roles } = await t.db.execute(
      sql`SELECT 1 FROM base_members WHERE base_id = ${rows[0]?.base_id ?? ''}::uuid`
    );
    expect(roles).toEqual([]);
  });

  it("keeps to the plan's editor seats: a raise past them is listed, the rest still apply", async () => {
    // Base roles given by the tests above would hold seats: start from none.
    await t.db.execute(sql`DELETE FROM base_members WHERE workspace_id = ${workspaceId}`);
    const plans = planEdition();
    // Owner, importer, editor, creator and the "none" editor: every seat is taken.
    plans.set(workspaceId, { limits: { editorsPerWorkspace: 5 } });
    const { done, baseRoles } = await run(fakeAirtable({ collaborators: answer }), {
      edition: plans.edition,
    });
    expect(done.status).toBe('done');
    // The editor holds a seat already, the commenter role takes none; the commenter → editor
    // raise would take a new one.
    expect(baseRoles).toEqual({ [at('ed')]: 'creator', [at('ro')]: 'commenter' });
    expect(done.report.collaborators?.notApplied).toContainEqual({
      email: at('com'),
      level: 'edit',
      message: expect.stringContaining('Not given the editor role'),
    });
  });
});
