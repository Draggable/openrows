import type {
  Base,
  FieldMeta,
  Interface,
  InterfacePage,
  InterfacePageConfig,
  InterfacePageRecords,
  TableMeta,
} from '@openrows/shared';
import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { beforeAll, describe, expect, it } from 'vitest';
import { storageKey } from '../../src/attachments/service.js';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { runAutomationJob } from '../../src/automations/run.js';
import { qualified } from '../../src/data/columns.js';
import { attachments, automations, fields, interfaceMembers, tables } from '../../src/db/index.js';
import { createLogger } from '../../src/lib/logger.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, createSession, createUser, createWorkspace } from '../helpers/factories.js';
import { MemoryObjectStore } from '../helpers/object-store.js';

const ORIGIN = 'http://localhost:5173';

/**
 * What an interface page lets its viewers do beyond reading and typing: click a record review's
 * buttons that run automations, and download the files the page shows. Both go through the
 * interface's own routes, checked against the published page on every request (its filter with
 * `me` as the viewer, the records it lists, the fields it shows); interface-only collaborators
 * still reach nothing of the base itself.
 */
describe('interface page actions: automation buttons and files', () => {
  const t = useTestDb();
  const store = new MemoryObjectStore();
  const logger = createLogger({ level: 'silent' });
  let app: ReturnType<typeof testApp>['app'];
  const cookies = new Map<string, string>();
  let ownerId: string;
  let guestId: string;
  let viewerId: string;
  let memberId: string;
  let base: Base;
  let table: TableMeta;
  let name: FieldMeta;
  let notes: FieldMeta;
  let assignee: FieldMeta;
  let files: FieldMeta;
  let privateFiles: FieldMeta;
  let approve: FieldMeta;
  let archive: FieldMeta;
  let iface: Interface;
  let other: Interface;
  let automationId: string;
  const pages: Record<string, InterfacePage> = {};
  const records: Record<'mine' | 'theirs', string> = { mine: '', theirs: '' };
  const fileIds: Record<'shown' | 'hidden' | 'unlisted', string> = {
    shown: '',
    hidden: '',
    unlisted: '',
  };

  const request = (who: string | null, method: string, path: string, body?: unknown) => {
    const headers = new Headers({ origin: ORIGIN });
    if (who) headers.set('cookie', `${SESSION_COOKIE}=${cookies.get(who)}`);
    if (body !== undefined) headers.set('content-type', 'application/json');
    return app.request(path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  };
  async function call<T>(
    who: string,
    method: string,
    path: string,
    body?: unknown,
    expected = 200
  ): Promise<T> {
    const res = await request(who, method, path, body);
    const text = await res.text();
    expect(res.status, `${method} ${path}: ${text}`).toBe(expected);
    return (text ? JSON.parse(text) : null) as T;
  }
  const status = async (who: string, method: string, path: string, body?: unknown) =>
    (await request(who, method, path, body)).status;

  const click = (who: string, recordId: string, fieldId = approve.id, page = pages['review']) =>
    request(
      who,
      'POST',
      `/api/interfaces/${iface.id}/pages/${page?.id}/records/${recordId}/buttons/${fieldId}`
    );
  const fileUrl = (attachmentId: string, page = pages['review'], suffix = '') =>
    `/api/interfaces/${iface.id}/pages/${page?.id}/attachments/${attachmentId}${suffix}`;
  const pageRecords = (who: string, page = pages['review']) =>
    call<InterfacePageRecords>(
      who,
      'POST',
      `/api/interfaces/${iface.id}/pages/${page?.id}/records`,
      {}
    );

  /** Runs the automation jobs the app sent, as the worker would. */
  const seen = new Set<string>();
  const runSent = async () => {
    const { rows } = await t.db.execute<{ id: string; data: unknown }>(
      sql`SELECT id, data FROM pgboss.job WHERE name = 'automations.run' ORDER BY created_on`
    );
    for (const job of rows) {
      if (seen.has(job.id)) continue;
      seen.add(job.id);
      await runAutomationJob({ db: t.appDb, logger }, job.data);
    }
  };
  const notesOf = async (recordId: string) =>
    (
      await call<{ fields: Record<string, unknown> }>(
        ownerId,
        'GET',
        `/api/tables/${table.id}/records/${recordId}`
      )
    ).fields[notes.id] ?? null;

  async function page(i: Interface, pageName: string, config: InterfacePageConfig, publish = true) {
    const created = await call<InterfacePage>(
      ownerId,
      'POST',
      `/api/bases/${base.id}/interfaces/${i.id}/pages`,
      { name: pageName, layout: config.layout, tableId: table.id },
      201
    );
    await call(ownerId, 'PATCH', `/api/bases/${base.id}/interfaces/${i.id}/pages/${created.id}`, {
      draft: config,
    });
    if (publish) {
      await call(
        ownerId,
        'POST',
        `/api/bases/${base.id}/interfaces/${i.id}/pages/${created.id}/publish`
      );
    }
    return created;
  }

  /** A confirmed file of `field` in the record's cell (as an upload would leave it). */
  async function attach(field: FieldMeta, recordId: string, filename: string): Promise<string> {
    const id = uuidv7();
    const ids = { workspaceId: base.workspaceId, baseId: base.id, tableId: table.id };
    const key = storageKey({ ...ids, id });
    await t.db.insert(attachments).values({
      ...ids,
      id,
      fieldId: field.id,
      storageKey: key,
      filename,
      contentType: 'image/png',
      size: 3,
      status: 'ready',
      createdBy: ownerId,
    });
    await store.put(key, new Uint8Array([1, 2, 3]));
    const [row] = await t.db.select().from(tables).where(eq(tables.id, table.id));
    const [f] = await t.db.select().from(fields).where(eq(fields.id, field.id));
    if (!row || !f) throw new Error('attach: no table or field');
    await t.db.execute(
      sql`UPDATE ${qualified(row)} SET ${sql.identifier(f.dbColumn)} = ${JSON.stringify([
        { id, filename, size: 3, type: 'image/png' },
      ])}::jsonb WHERE id = ${recordId}`
    );
    return id;
  }

  beforeAll(async () => {
    ({ app } = testApp({ db: t.appDb, objectStore: store }));
    const ws = await createWorkspace(t.db, { name: 'Acme' });
    ownerId = ws.owner.id;
    const guest = await createUser(t.db, { email: 'gus@example.test', name: 'Gus' });
    const viewer = await createUser(t.db, { email: 'vi@example.test', name: 'Vi' });
    const member = await addMember(t.db, ws.workspace.id, 'editor');
    guestId = guest.id;
    viewerId = viewer.id;
    memberId = member.id;
    for (const u of [ws.owner, guest, viewer, member]) {
      cookies.set(u.id, await createSession(t.db, u));
    }

    base = await call<Base>(
      ownerId,
      'POST',
      `/api/workspaces/${ws.workspace.id}/bases`,
      { name: 'Support' },
      201
    );
    table = await call<TableMeta>(
      ownerId,
      'POST',
      `/api/bases/${base.id}/tables`,
      { name: 'Requests' },
      201
    );
    const field = (body: unknown) =>
      call<FieldMeta>(ownerId, 'POST', `/api/tables/${table.id}/fields`, body, 201);
    const fresh = await call<TableMeta>(ownerId, 'GET', `/api/tables/${table.id}`);
    name = fresh.fields.find((f) => f.isPrimary) as FieldMeta;
    notes = await field({ name: 'Details', type: 'singleLineText' });
    assignee = await field({ name: 'Assignee', type: 'user', options: { multiple: true } });
    files = await field({ name: 'Files', type: 'attachment' });
    privateFiles = await field({ name: 'Private files', type: 'attachment' });
    approve = await field({
      name: 'Approve',
      type: 'button',
      options: { label: 'Approve', action: 'runAutomation' },
    });
    archive = await field({
      name: 'Archive',
      type: 'button',
      options: { label: 'Archive', action: 'runAutomation' },
    });

    // Gus and Vi get the help desk only (people of the interface may be assigned records).
    iface = await call<Interface>(
      ownerId,
      'POST',
      `/api/bases/${base.id}/interfaces`,
      { name: 'Help desk' },
      201
    );
    other = await call<Interface>(
      ownerId,
      'POST',
      `/api/bases/${base.id}/interfaces`,
      { name: 'Internal' },
      201
    );
    await t.db.insert(interfaceMembers).values([
      { workspaceId: base.workspaceId, interfaceId: iface.id, userId: guestId, role: 'editor' },
      { workspaceId: base.workspaceId, interfaceId: iface.id, userId: viewerId, role: 'read_only' },
    ]);

    const created = await call<{ records: { id: string }[] }>(
      ownerId,
      'POST',
      `/api/tables/${table.id}/records`,
      {
        records: [
          {
            fields: { [name.id]: 'Laptop', [assignee.id]: [guestId, viewerId, memberId] },
          },
          { fields: { [name.id]: 'Desk' } },
        ],
      },
      201
    );
    records.mine = created.records[0]?.id ?? '';
    records.theirs = created.records[1]?.id ?? '';
    fileIds.shown = await attach(files, records.mine, 'photo.png');
    fileIds.hidden = await attach(privateFiles, records.mine, 'secret.png');
    fileIds.unlisted = await attach(files, records.theirs, 'desk.png');

    // Each button runs an automation that notes who clicked.
    for (const button of [approve, archive]) {
      const created = await call<{ id: string }>(
        ownerId,
        'POST',
        `/api/bases/${base.id}/automations`,
        {
          name: `On ${button.name}`,
          enabled: true,
          trigger: { type: 'buttonClicked', tableId: table.id, fieldId: button.id },
          actions: [
            {
              type: 'updateRecord',
              tableId: table.id,
              recordId: '{{trigger.record.id}}',
              fields: { [notes.id]: `${button.name}d by {{trigger.user.name}}` },
            },
          ],
        },
        201
      );
      if (button === approve) automationId = created.id;
    }

    // A record review of the viewer's own requests, with the Approve button and the files.
    const review: InterfacePageConfig = {
      layout: 'recordReview',
      tableId: table.id,
      sorts: [],
      fields: [],
      filter: {
        conjunction: 'and',
        conditions: [{ fieldId: assignee.id, operator: 'hasAnyOf', value: ['me'] }],
      },
      elements: [
        { id: 'f', type: 'field', x: 0, y: 0, w: 6, h: 2, fieldId: files.id, editable: false },
        {
          id: 'b',
          type: 'button',
          x: 6,
          y: 0,
          w: 3,
          h: 1,
          label: 'Approve',
          action: { type: 'runAutomation', fieldId: approve.id },
        },
      ],
    };
    pages['review'] = await page(iface, 'My requests', review);
    pages['draft'] = await page(iface, 'Unpublished', review, false);
    pages['dashboard'] = await page(iface, 'Overview', {
      layout: 'dashboard',
      tableId: table.id,
      sorts: [],
      fields: [files.id],
      elements: [],
    });
    pages['other'] = await page(other, 'Everything', review);
  });

  it('tells each viewer which buttons they may click, and shows no other field', async () => {
    const asGuest = await pageRecords(guestId);
    expect(asGuest.buttons).toEqual({ [approve.id]: 'ready' });
    expect(asGuest.records.map((r) => r.id)).toEqual([records.mine]);
    expect(asGuest.fields.map((f) => f.id).sort()).toEqual([name.id, files.id].sort());
    const text = JSON.stringify(asGuest);
    expect(text).not.toContain('secret.png');
    expect(text).not.toContain(archive.id);
    expect((await pageRecords(viewerId)).buttons).toEqual({ [approve.id]: 'readOnly' });
    expect((await pageRecords(memberId)).buttons).toEqual({ [approve.id]: 'ready' });
  });

  it('an interface-only editor clicks an exposed button on a listed record', async () => {
    const res = await click(guestId, records.mine);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ started: 1 });
    await runSent();
    expect(await notesOf(records.mine)).toBe('Approved by Gus');
    const runs = await call<{ runs: { triggeredBy: string | null; status: string }[] }>(
      ownerId,
      'GET',
      `/api/bases/${base.id}/automations/${automationId}/runs?limit=10`
    );
    expect(runs.runs[0]).toMatchObject({ status: 'succeeded', triggeredBy: guestId });
  });

  it('base members who may edit the record click through the page too', async () => {
    expect((await click(memberId, records.mine)).status).toBe(200);
    // And on the base, as before.
    expect(
      (
        await request(
          memberId,
          'POST',
          `/api/tables/${table.id}/records/${records.mine}/buttons/${approve.id}`
        )
      ).status
    ).toBe(200);
    await runSent();
  });

  it('refuses read-only viewers, other buttons and records, and pages it may not use', async () => {
    expect((await click(viewerId, records.mine)).status).toBe(403);
    // A button field the page doesn't have, a field that isn't a button, a record it doesn't list.
    expect((await click(guestId, records.mine, archive.id)).status).toBe(404);
    expect((await click(guestId, records.mine, notes.id)).status).toBe(404);
    expect((await click(guestId, records.theirs)).status).toBe(404);
    expect((await click(guestId, uuidv7())).status).toBe(404);
    // The unpublished page, another interface's page through this one, a dashboard.
    expect((await click(guestId, records.mine, approve.id, pages['draft'])).status).toBe(404);
    expect((await click(guestId, records.mine, approve.id, pages['other'])).status).toBe(404);
    expect((await click(guestId, records.mine, approve.id, pages['dashboard'])).status).toBe(404);
    // Nothing started.
    const { rows } = await t.db.execute<{ id: string }>(
      sql`SELECT id FROM pgboss.job WHERE name = 'automations.run'`
    );
    expect(rows.filter((r) => !seen.has(r.id))).toEqual([]);
  });

  it('refuses a button whose automation is off, or when the table restricts editing', async () => {
    await t.db.update(automations).set({ enabled: false }).where(eq(automations.id, automationId));
    try {
      expect((await pageRecords(guestId)).buttons).toEqual({ [approve.id]: 'noAutomation' });
      const res = await click(guestId, records.mine);
      expect(res.status).toBe(409);
    } finally {
      await t.db.update(automations).set({ enabled: true }).where(eq(automations.id, automationId));
    }
    await t.db
      .update(tables)
      .set({ permissions: { editRecords: { level: 'creators' } } })
      .where(eq(tables.id, table.id));
    try {
      expect((await pageRecords(guestId)).buttons).toEqual({ [approve.id]: 'readOnly' });
      const res = await click(guestId, records.mine);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe('EDIT_RESTRICTED');
    } finally {
      await t.db.update(tables).set({ permissions: {} }).where(eq(tables.id, table.id));
    }
  });

  it('downloads the files the page shows, to viewers and editors alike', async () => {
    for (const who of [viewerId, guestId, memberId]) {
      const res = await request(who, 'GET', fileUrl(fileIds.shown));
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('X-Amz-Signature');
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      const thumb = await request(
        who,
        'GET',
        fileUrl(fileIds.shown, pages['review'], '/thumbnail')
      );
      expect(thumb.status).toBe(302);
    }
  });

  it("refuses files the page doesn't show, and the base's file routes", async () => {
    const refused = [
      // A field the page doesn't show, a record it doesn't list, a made-up id.
      ['GET', fileUrl(fileIds.hidden)],
      ['GET', fileUrl(fileIds.unlisted)],
      ['GET', fileUrl(uuidv7())],
      // Pages that list no records, aren't published, or belong to another interface.
      ['GET', fileUrl(fileIds.shown, pages['dashboard'])],
      ['GET', fileUrl(fileIds.shown, pages['draft'])],
      ['GET', fileUrl(fileIds.shown, pages['other'])],
      ['GET', `${fileUrl(fileIds.shown)}?draft=true`],
      // The base's own routes: files, uploads and the button click.
      ['GET', `/api/tables/${table.id}/attachments/${fileIds.shown}`],
      ['GET', `/api/tables/${table.id}/attachments/${fileIds.shown}/thumbnail`],
      [
        'POST',
        `/api/tables/${table.id}/attachments`,
        { fieldId: files.id, filename: 'x.png', size: 3, contentType: 'image/png' },
      ],
      ['POST', `/api/tables/${table.id}/attachments/${fileIds.shown}/confirm`],
      ['POST', `/api/tables/${table.id}/records/${records.mine}/buttons/${approve.id}`],
      ['GET', `/api/tables/${table.id}/records/${records.mine}`],
      ['GET', `/api/bases/${base.id}`],
      ['GET', `/api/interfaces/${other.id}`],
    ] as const;
    for (const who of [viewerId, guestId]) {
      for (const [method, path, body] of refused) {
        expect(await status(who, method, path, body), `${method} ${path}`).toBe(404);
      }
    }
    // Their records route still projects the page only.
    const listed = await pageRecords(guestId);
    expect(JSON.stringify(listed)).not.toContain(fileIds.hidden);
    expect(JSON.stringify(listed)).not.toContain(fileIds.unlisted);
  });

  it('a removed collaborator loses the files and buttons at once', async () => {
    const path = fileUrl(fileIds.shown);
    expect((await request(viewerId, 'GET', path)).status).toBe(302);
    await t.db
      .delete(interfaceMembers)
      .where(
        and(eq(interfaceMembers.interfaceId, iface.id), eq(interfaceMembers.userId, viewerId))
      );
    expect((await request(viewerId, 'GET', path)).status).toBe(404);
    expect((await request(viewerId, 'GET', `/api/interfaces/${iface.id}`)).status).toBe(404);
    await t.db
      .delete(interfaceMembers)
      .where(and(eq(interfaceMembers.interfaceId, iface.id), eq(interfaceMembers.userId, guestId)));
    expect((await click(guestId, records.mine)).status).toBe(404);
    expect((await request(guestId, 'GET', path)).status).toBe(404);
  });
});
