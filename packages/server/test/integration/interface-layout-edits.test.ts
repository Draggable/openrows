import type {
  Base,
  FieldMeta,
  Interface,
  InterfacePage,
  InterfacePageConfig,
  InterfacePageRecords,
  TableMeta,
} from '@openrows/shared';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import {
  fields as fieldRows,
  interfaceMembers,
  interfacePages,
  tables,
} from '../../src/db/index.js';
import type { FieldVisibility } from '../../src/realtime/projection.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, createSession, createUser, createWorkspace } from '../helpers/factories.js';

const ORIGIN = 'http://localhost:5173';

/**
 * Kanban, calendar and timeline interface pages let their viewers make the edits the views'
 * drags make (a card to another stack, an event or bar to other dates) through the page's
 * record route: only for those who may edit records (interface-only editors, base members with
 * record:update), only the fields the page shows them and a page may write, only on records the
 * published page lists for them (its filter, `me` as the viewer). The base's API stays closed to
 * interface-only collaborators.
 */
describe('interface layout pages: drag edits through the page', () => {
  const t = useTestDb();
  let app: ReturnType<typeof testApp>['app'];
  const cookies = new Map<string, string>();
  let ownerId: string;
  let guestId: string;
  let viewerId: string;
  let memberId: string;
  let commenterId: string;
  let base: Base;
  let table: TableMeta;
  let name: FieldMeta;
  let stage: FieldMeta;
  let start: FieldMeta;
  let end: FieldMeta;
  let assignee: FieldMeta;
  let owner: FieldMeta;
  let notes: FieldMeta;
  let secret: FieldMeta;
  let files: FieldMeta;
  let createdBy: FieldMeta;
  let iface: Interface;
  const pages: Record<string, InterfacePage> = {};
  const records: Record<'laptop' | 'desk', string> = { laptop: '', desk: '' };

  const request = (who: string, method: string, path: string, body?: unknown) => {
    const headers = new Headers({ origin: ORIGIN });
    headers.set('cookie', `${SESSION_COOKIE}=${cookies.get(who)}`);
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

  const pageRecords = (who: string, page: string, body: Record<string, unknown> = {}) =>
    call<InterfacePageRecords>(
      who,
      'POST',
      `/api/interfaces/${iface.id}/pages/${pages[page]?.id}/records`,
      body
    );
  const edit = (who: string, page: string, recordId: string, fields: Record<string, unknown>) =>
    request(
      who,
      'PATCH',
      `/api/interfaces/${iface.id}/pages/${pages[page]?.id}/records/${recordId}`,
      {
        fields,
      }
    );
  const stored = async (recordId: string) =>
    (
      await call<{ fields: Record<string, unknown> }>(
        ownerId,
        'GET',
        `/api/tables/${table.id}/records/${recordId}`
      )
    ).fields;

  async function page(pageName: string, config: InterfacePageConfig, publish = true) {
    const created = await call<InterfacePage>(
      ownerId,
      'POST',
      `/api/bases/${base.id}/interfaces/${iface.id}/pages`,
      { name: pageName, layout: config.layout, tableId: table.id },
      201
    );
    await call(
      ownerId,
      'PATCH',
      `/api/bases/${base.id}/interfaces/${iface.id}/pages/${created.id}`,
      { draft: config }
    );
    if (publish) {
      await call(
        ownerId,
        'POST',
        `/api/bases/${base.id}/interfaces/${iface.id}/pages/${created.id}/publish`
      );
    }
    return created;
  }

  beforeAll(async () => {
    ({ app } = testApp({ db: t.appDb }));
    const ws = await createWorkspace(t.db, { name: 'Acme' });
    ownerId = ws.owner.id;
    const guest = await createUser(t.db, { email: 'gus@example.test', name: 'Gus' });
    const viewer = await createUser(t.db, { email: 'vi@example.test', name: 'Vi' });
    const member = await addMember(t.db, ws.workspace.id, 'editor');
    const commenter = await addMember(t.db, ws.workspace.id, 'commenter');
    guestId = guest.id;
    viewerId = viewer.id;
    memberId = member.id;
    commenterId = commenter.id;
    for (const u of [ws.owner, guest, viewer, member, commenter]) {
      cookies.set(u.id, await createSession(t.db, u));
    }

    base = await call<Base>(
      ownerId,
      'POST',
      `/api/workspaces/${ws.workspace.id}/bases`,
      { name: 'Office' },
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
    stage = await field({
      name: 'Stage',
      type: 'singleSelect',
      options: {
        choices: [
          { id: 'open', name: 'Open', color: 'green' },
          { id: 'done', name: 'Done', color: 'blue' },
        ],
      },
    });
    start = await field({ name: 'Start', type: 'date' });
    end = await field({ name: 'End', type: 'date' });
    assignee = await field({ name: 'Assignee', type: 'user', options: { multiple: true } });
    owner = await field({ name: 'Owner', type: 'user' });
    notes = await field({ name: 'Details', type: 'singleLineText' });
    secret = await field({ name: 'Secret', type: 'singleLineText' });
    files = await field({ name: 'Files', type: 'attachment' });
    createdBy = await field({ name: 'Created by', type: 'createdBy' });

    iface = await call<Interface>(
      ownerId,
      'POST',
      `/api/bases/${base.id}/interfaces`,
      { name: 'Planning' },
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
            fields: {
              [name.id]: 'Laptop',
              [stage.id]: 'open',
              [start.id]: '2026-11-02',
              [end.id]: '2026-11-04',
              [assignee.id]: [guestId, viewerId, memberId],
              [owner.id]: [memberId],
              [secret.id]: 's1',
            },
          },
          {
            fields: {
              [name.id]: 'Desk',
              [stage.id]: 'open',
              [start.id]: '2026-11-10',
              [secret.id]: 's2',
            },
          },
        ],
      },
      201
    );
    records.laptop = created.records[0]?.id ?? '';
    records.desk = created.records[1]?.id ?? '';

    const mine = {
      conjunction: 'and' as const,
      conditions: [{ fieldId: assignee.id, operator: 'hasAnyOf' as const, value: ['me'] }],
    };
    const common = { tableId: table.id, sorts: [], fields: [], elements: [], filter: mine };
    pages['board'] = await page('Board', {
      ...common,
      layout: 'kanban',
      kanban: { stackFieldId: stage.id, cardFields: [notes.id, files.id] },
    });
    pages['calendar'] = await page('Calendar', {
      ...common,
      layout: 'calendar',
      calendar: { dateFields: [{ startFieldId: start.id, endFieldId: end.id }] },
    });
    pages['timeline'] = await page('Timeline', {
      ...common,
      layout: 'timeline',
      timeline: { startFieldId: start.id, endFieldId: end.id, scale: 'week' },
    });
    // People on the cards; and a board stacked by a person (as a page becomes when its stack
    // field turns into a user field), stored as it would be.
    pages['people'] = await page('By person', {
      ...common,
      layout: 'kanban',
      kanban: { stackFieldId: stage.id, cardFields: [assignee.id] },
    });
    pages['ownerStack'] = await page('By owner', {
      ...common,
      layout: 'kanban',
      kanban: { stackFieldId: stage.id, cardFields: [] },
    });
    const userStacked = {
      ...common,
      layout: 'kanban',
      kanban: { stackFieldId: owner.id, cardFields: [] },
    };
    await t.db
      .update(interfacePages)
      .set({ draft: userStacked, published: userStacked })
      .where(eq(interfacePages.id, pages['ownerStack'].id));
    pages['createdByMe'] = await page('Created by me', {
      ...common,
      layout: 'kanban',
      filter: {
        conjunction: 'and',
        conditions: [{ fieldId: createdBy.id, operator: 'is', value: 'me' }],
      },
      kanban: { stackFieldId: stage.id, cardFields: [] },
    });
    // A filter element on a field the board doesn't draw: its values come for the choices only.
    pages['filtered'] = await page('Filtered', {
      ...common,
      layout: 'kanban',
      elements: [
        { id: 'f1', type: 'filter', fieldId: secret.id, label: '', x: 0, y: 0, w: 4, h: 1 },
      ],
      kanban: { stackFieldId: stage.id, cardFields: [] },
    });
    pages['unpublished'] = await page(
      'Unpublished',
      { ...common, layout: 'kanban', kanban: { stackFieldId: stage.id, cardFields: [] } },
      false
    );
  });

  const sorted = (ids: string[]) => [...ids].sort();

  it('lists the shown fields a page lets its viewer write', async () => {
    const board = await pageRecords(guestId, 'board');
    expect(board.records.map((r) => r.id)).toEqual([records.laptop]);
    // The stack and card fields; never files.
    expect(sorted(board.editable)).toEqual(sorted([name.id, stage.id, notes.id]));
    const calendar = await pageRecords(guestId, 'calendar', {
      from: '2026-11-01',
      to: '2026-11-30',
    });
    expect(sorted(calendar.editable)).toEqual(sorted([name.id, start.id, end.id]));
    const timeline = await pageRecords(guestId, 'timeline', {
      from: '2026-11-01',
      to: '2026-11-30',
    });
    expect(sorted(timeline.editable)).toEqual(sorted([name.id, start.id, end.id]));
    // People on the cards, or a board stacked by a person: never written through the page.
    expect(sorted((await pageRecords(guestId, 'people')).editable)).toEqual(
      sorted([name.id, stage.id])
    );
    const byOwner = await pageRecords(guestId, 'ownerStack');
    expect(byOwner.kanban?.stackFieldId).toBe(owner.id);
    expect(byOwner.editable).toEqual([name.id]);
    // Can view: nothing to write.
    for (const p of ['board', 'calendar', 'timeline']) {
      expect((await pageRecords(viewerId, p)).editable).toEqual([]);
    }
  });

  it('an interface-only editor moves a card, an event and a bar through the page', async () => {
    expect((await edit(guestId, 'board', records.laptop, { [stage.id]: 'done' })).status).toBe(204);
    expect((await stored(records.laptop))[stage.id]).toBe('done');
    const board = await pageRecords(guestId, 'board');
    expect(board.records[0]?.fields[stage.id]).toBe('done');
    // To the empty stack.
    expect((await edit(guestId, 'board', records.laptop, { [stage.id]: null })).status).toBe(204);
    expect((await stored(records.laptop))[stage.id] ?? null).toBeNull();

    // A calendar event moved by three days keeps its length.
    expect(
      (
        await edit(guestId, 'calendar', records.laptop, {
          [start.id]: '2026-11-05',
          [end.id]: '2026-11-07',
        })
      ).status
    ).toBe(204);
    let after = await stored(records.laptop);
    expect([after[start.id], after[end.id]]).toEqual(['2026-11-05', '2026-11-07']);

    // A timeline bar's end dragged out by two days.
    expect(
      (await edit(guestId, 'timeline', records.laptop, { [end.id]: '2026-11-09' })).status
    ).toBe(204);
    after = await stored(records.laptop);
    expect([after[start.id], after[end.id]]).toEqual(['2026-11-05', '2026-11-09']);
    const window = await pageRecords(guestId, 'timeline', { from: '2026-11-01', to: '2026-11-30' });
    expect(window.records[0]?.fields[end.id]).toBe('2026-11-09');
  });

  it('refuses fields the page does not show or may not write, and records it does not list', async () => {
    const before = await stored(records.laptop);
    const refused: [string, string, Record<string, unknown>, number][] = [
      // Not on the page.
      ['board', records.laptop, { [secret.id]: 'x' }, 403],
      ['calendar', records.laptop, { [stage.id]: 'done' }, 403],
      ['timeline', records.laptop, { [notes.id]: 'x' }, 403],
      // On the page, but a type a page never writes.
      ['board', records.laptop, { [files.id]: [] }, 403],
      ['people', records.laptop, { [assignee.id]: [guestId] }, 403],
      ['ownerStack', records.laptop, { [owner.id]: [guestId] }, 403],
      ['ownerStack', records.laptop, { [owner.id]: null }, 403],
      // A shown field beside one that isn't: the whole write is refused.
      ['board', records.laptop, { [stage.id]: 'done', [secret.id]: 'x' }, 403],
      // A record the page's "me" filter leaves out.
      ['board', records.desk, { [stage.id]: 'done' }, 404],
      ['calendar', records.desk, { [start.id]: '2026-11-11' }, 404],
      // Created by the owner, not by Gus.
      ['createdByMe', records.laptop, { [stage.id]: 'done' }, 404],
      // Never published.
      ['unpublished', records.laptop, { [stage.id]: 'done' }, 404],
    ];
    for (const [p, id, fields, expected] of refused) {
      expect((await edit(guestId, p, id, fields)).status, `${p} ${JSON.stringify(fields)}`).toBe(
        expected
      );
    }
    expect(await stored(records.laptop)).toEqual(before);
    expect((await stored(records.desk))[stage.id]).toBe('open');
    // The owner created the record, so their "created by me" page lists it.
    expect(
      (await edit(ownerId, 'createdByMe', records.laptop, { [stage.id]: 'open' })).status
    ).toBe(204);
  });

  it('Can view and base commenters never write through the page', async () => {
    const before = await stored(records.laptop);
    for (const p of ['board', 'calendar', 'timeline']) {
      const fields = p === 'board' ? { [stage.id]: 'done' } : { [start.id]: '2026-11-20' };
      expect((await edit(viewerId, p, records.laptop, fields)).status).toBe(403);
      expect((await edit(commenterId, p, records.laptop, fields)).status).toBe(403);
    }
    expect(await stored(records.laptop)).toEqual(before);
  });

  it('base members who may edit records make the same writes through the page', async () => {
    const board = await pageRecords(memberId, 'board');
    expect(sorted(board.editable)).toEqual(sorted([name.id, stage.id, notes.id]));
    expect((await edit(memberId, 'board', records.laptop, { [stage.id]: 'done' })).status).toBe(
      204
    );
    expect(
      (await edit(memberId, 'timeline', records.laptop, { [start.id]: '2026-11-06' })).status
    ).toBe(204);
    const after = await stored(records.laptop);
    expect([after[stage.id], after[start.id]]).toEqual(['done', '2026-11-06']);
    // The page's limits hold for them too.
    expect((await edit(memberId, 'board', records.laptop, { [secret.id]: 'x' })).status).toBe(403);
    expect((await edit(memberId, 'board', records.desk, { [stage.id]: 'done' })).status).toBe(404);
  });

  it("follows the table's edit permission", async () => {
    await t.db
      .update(tables)
      .set({ permissions: { editRecords: { level: 'creators' } } })
      .where(eq(tables.id, table.id));
    try {
      expect((await pageRecords(guestId, 'board')).editable).toEqual([]);
      expect((await pageRecords(memberId, 'board')).editable).toEqual([]);
      expect((await edit(guestId, 'board', records.laptop, { [stage.id]: 'open' })).status).toBe(
        403
      );
    } finally {
      await t.db.update(tables).set({ permissions: {} }).where(eq(tables.id, table.id));
    }
  });

  it("never writes a filter element's field the layout doesn't draw", async () => {
    const filtered = await pageRecords(guestId, 'filtered');
    expect(filtered.fields.map((f) => f.id)).toContain(secret.id);
    expect(sorted(filtered.editable)).toEqual(sorted([name.id, stage.id]));
    const before = await stored(records.laptop);
    expect((await edit(guestId, 'filtered', records.laptop, { [secret.id]: 'x' })).status).toBe(
      403
    );
    expect((await edit(memberId, 'filtered', records.laptop, { [secret.id]: 'x' })).status).toBe(
      403
    );
    expect(await stored(records.laptop)).toEqual(before);
  });

  it("follows a field's edit permission", async () => {
    await t.db
      .update(fieldRows)
      .set({ permissions: { edit: { level: 'creators' } } })
      .where(eq(fieldRows.id, stage.id));
    try {
      const before = await stored(records.laptop);
      for (const who of [guestId, memberId]) {
        expect((await pageRecords(who, 'board')).editable).not.toContain(stage.id);
        expect((await edit(who, 'board', records.laptop, { [stage.id]: 'open' })).status).toBe(403);
      }
      expect(await stored(records.laptop)).toEqual(before);
      // The owner is a creator: the same drag goes through for them.
      expect((await pageRecords(ownerId, 'board')).editable).toContain(stage.id);
    } finally {
      await t.db.update(fieldRows).set({ permissions: {} }).where(eq(fieldRows.id, stage.id));
    }
  });

  it("interface-only editors still can't reach the base's records, or write hidden fields", async () => {
    const refused = [
      ['GET', `/api/bases/${base.id}`],
      ['GET', `/api/tables/${table.id}`],
      ['GET', `/api/tables/${table.id}/records`],
      ['POST', `/api/tables/${table.id}/records/query`, {}],
      ['GET', `/api/tables/${table.id}/records/${records.laptop}`],
      [
        'PATCH',
        `/api/tables/${table.id}/records/${records.laptop}`,
        { fields: { [stage.id]: 'open' } },
      ],
      ['POST', `/api/tables/${table.id}/attachments`, {}],
    ] as const;
    for (const who of [guestId, viewerId]) {
      for (const [method, path, body] of refused) {
        expect(await status(who, method, path, body), `${method} ${path}`).toBe(404);
      }
    }

    const hidden: ReadonlySet<string> = new Set([end.id]);
    const visibility: FieldVisibility = {
      hiddenFields: (v) => (v.userId === guestId ? hidden : new Set()),
    };
    const open = app;
    ({ app } = testApp({ db: t.appDb, visibility }));
    try {
      const timeline = await pageRecords(guestId, 'timeline', {
        from: '2026-11-01',
        to: '2026-11-30',
      });
      expect(timeline.editable).not.toContain(end.id);
      expect(timeline.fields.map((f) => f.id)).not.toContain(end.id);
      expect(Object.keys(timeline.records[0]?.fields ?? {})).not.toContain(end.id);
      const before = await stored(records.laptop);
      expect(
        (await edit(guestId, 'timeline', records.laptop, { [end.id]: '2026-11-30' })).status
      ).toBe(403);
      expect((await stored(records.laptop))[end.id]).toBe(before[end.id]);
      // The fields still shown to them stay writable.
      expect(
        (await edit(guestId, 'timeline', records.laptop, { [start.id]: '2026-11-03' })).status
      ).toBe(204);
    } finally {
      app = open;
    }
  });
});
