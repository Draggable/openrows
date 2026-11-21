import type {
  Base,
  FieldMeta,
  Interface,
  InterfaceAccess,
  InterfacePage,
  InterfacePageConfig,
  InterfacePageRecords,
  TableMeta,
} from '@openrows/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { interfaceMembers } from '../../src/db/index.js';
import type { FieldVisibility } from '../../src/realtime/projection.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, createSession, createUser, createWorkspace } from '../helpers/factories.js';

const ORIGIN = 'http://localhost:5173';

/**
 * Hierarchical list interface pages: the page's records nested under their parent (a link to
 * records of the same table), read through the page's records route like every other page. The
 * parent link leaves only as ids of records the page lists for the viewer (its filter, `me`, the
 * viewer's filter elements), never a record the page leaves out; only the fields the page shows,
 * less hidden ones. The tree is read-only, unpublished pages stay invisible to non-creators, and
 * the base's API stays closed to interface-only collaborators.
 */
describe('interface hierarchical list pages', () => {
  const t = useTestDb();
  let app: ReturnType<typeof testApp>['app'];
  const cookies = new Map<string, string>();
  let ownerId: string;
  let guestId: string;
  let viewerId: string;
  let memberId: string;
  let base: Base;
  let table: TableMeta;
  let projects: TableMeta;
  let name: FieldMeta;
  let parent: FieldMeta;
  let notes: FieldMeta;
  let secret: FieldMeta;
  let assignee: FieldMeta;
  let createdBy: FieldMeta;
  let project: FieldMeta;
  let iface: Interface;
  const pages: Record<string, InterfacePage> = {};
  const ids = { epicA: '', taskA1: '', taskA2: '', subA1: '', epicB: '', taskB1: '' };

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

  const recordsPath = (page: string) =>
    `/api/interfaces/${iface.id}/pages/${pages[page]?.id}/records`;
  const pageRecords = (who: string, page: string, body: Record<string, unknown> = {}) =>
    call<InterfacePageRecords>(who, 'POST', recordsPath(page), body);
  const edit = (who: string, page: string, recordId: string, fields: Record<string, unknown>) =>
    request(who, 'PATCH', `${recordsPath(page)}/${recordId}`, { fields });
  const stored = async (recordId: string) =>
    (
      await call<{ fields: Record<string, unknown> }>(
        ownerId,
        'GET',
        `/api/tables/${table.id}/records/${recordId}`
      )
    ).fields;
  const pagePath = (pageId = '') =>
    `/api/bases/${base.id}/interfaces/${iface.id}/pages${pageId ? `/${pageId}` : ''}`;

  async function page(pageName: string, config: InterfacePageConfig, publish = true) {
    const created = await call<InterfacePage>(
      ownerId,
      'POST',
      pagePath(),
      { name: pageName, layout: config.layout, tableId: table.id },
      201
    );
    await call(ownerId, 'PATCH', pagePath(created.id), { draft: config });
    if (publish) await call(ownerId, 'POST', `${pagePath(created.id)}/publish`);
    return created;
  }

  /** The records' parents as the page sends them: record id → listed parent ids. */
  const parents = (answer: InterfacePageRecords) =>
    Object.fromEntries(answer.records.map((r) => [r.id, r.links?.[parent.id] ?? null]));
  const sorted = (list: string[]) => [...list].sort();

  beforeAll(async () => {
    ({ app } = testApp({ db: t.appDb }));
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
      { name: 'Planning' },
      201
    );
    table = await call<TableMeta>(
      ownerId,
      'POST',
      `/api/bases/${base.id}/tables`,
      { name: 'Tasks' },
      201
    );
    projects = await call<TableMeta>(
      ownerId,
      'POST',
      `/api/bases/${base.id}/tables`,
      { name: 'Projects' },
      201
    );
    const field = (body: unknown) =>
      call<FieldMeta>(ownerId, 'POST', `/api/tables/${table.id}/fields`, body, 201);
    const fresh = await call<TableMeta>(ownerId, 'GET', `/api/tables/${table.id}`);
    name = fresh.fields.find((f) => f.isPrimary) as FieldMeta;
    parent = await field({ name: 'Parent', type: 'link', options: { linkedTableId: table.id } });
    notes = await field({ name: 'Details', type: 'singleLineText' });
    secret = await field({ name: 'Secret', type: 'singleLineText' });
    assignee = await field({ name: 'Assignee', type: 'user', options: { multiple: true } });
    createdBy = await field({ name: 'Created by', type: 'createdBy' });
    project = await field({
      name: 'Project',
      type: 'link',
      options: { linkedTableId: projects.id },
    });

    iface = await call<Interface>(
      ownerId,
      'POST',
      `/api/bases/${base.id}/interfaces`,
      { name: 'Work' },
      201
    );
    await t.db.insert(interfaceMembers).values([
      { workspaceId: base.workspaceId, interfaceId: iface.id, userId: guestId, role: 'editor' },
      { workspaceId: base.workspaceId, interfaceId: iface.id, userId: viewerId, role: 'read_only' },
    ]);

    const team = [guestId, viewerId, memberId];
    const row = (title: string, details: string, people: string[]) => ({
      fields: {
        [name.id]: title,
        [notes.id]: details,
        [secret.id]: `SECRET-${title}`,
        [assignee.id]: people,
      },
    });
    const created = await call<{ records: { id: string }[] }>(
      ownerId,
      'POST',
      `/api/tables/${table.id}/records`,
      {
        records: [
          row('Epic A', 'epic', team),
          row('Task A1', 'task one', team),
          row('Task A2', 'task two', team),
          row('Sub A1', 'sub task', team),
          // Only the owner's: everyone else's "me" page leaves it out.
          row('Epic B', 'epic', [ownerId]),
          row('Task B1', 'task b', team),
        ],
      },
      201
    );
    const [epicA, taskA1, taskA2, subA1, epicB, taskB1] = created.records.map((r) => r.id);
    if (!epicA || !taskA1 || !taskA2 || !subA1 || !epicB || !taskB1) throw new Error('records');
    Object.assign(ids, { epicA, taskA1, taskA2, subA1, epicB, taskB1 });
    await call(ownerId, 'PATCH', `/api/tables/${table.id}/records`, {
      records: [
        { id: taskA1, fields: { [parent.id]: [epicA] } },
        { id: taskA2, fields: { [parent.id]: [epicA] } },
        { id: subA1, fields: { [parent.id]: [taskA1] } },
        { id: taskB1, fields: { [parent.id]: [epicB] } },
      ],
    });

    const common = { tableId: table.id, sorts: [], elements: [] };
    const mine = {
      conjunction: 'and' as const,
      conditions: [{ fieldId: assignee.id, operator: 'hasAnyOf' as const, value: ['me'] }],
    };
    pages['tree'] = await page('Tree', {
      ...common,
      layout: 'list',
      filter: mine,
      fields: [notes.id],
      list: { parentFieldId: parent.id },
      elements: [
        { id: 'f1', type: 'filter', fieldId: notes.id, label: '', x: 0, y: 0, w: 4, h: 1 },
      ],
    });
    pages['createdByMe'] = await page('Created by me', {
      ...common,
      layout: 'list',
      fields: [],
      filter: {
        conjunction: 'and',
        conditions: [{ fieldId: createdBy.id, operator: 'is', value: 'me' }],
      },
      list: { parentFieldId: parent.id },
    });
    // The parent picked as a row field too: still sent only as structure.
    pages['parentAsField'] = await page('Parent as a field', {
      ...common,
      layout: 'list',
      filter: mine,
      fields: [notes.id, parent.id],
      list: { parentFieldId: parent.id },
    });
    pages['unpublished'] = await page(
      'Unpublished',
      { ...common, layout: 'list', fields: [notes.id], list: { parentFieldId: parent.id } },
      false
    );
  });

  it('nests the listed records under their listed parent for Can view and Can edit', async () => {
    for (const who of [guestId, viewerId]) {
      const tree = await pageRecords(who, 'tree');
      expect(sorted(tree.records.map((r) => r.id))).toEqual(
        sorted([ids.epicA, ids.taskA1, ids.taskA2, ids.subA1, ids.taskB1])
      );
      expect(parents(tree)).toEqual({
        [ids.epicA]: [],
        [ids.taskA1]: [ids.epicA],
        [ids.taskA2]: [ids.epicA],
        [ids.subA1]: [ids.taskA1],
        // Its parent isn't on this viewer's page: a root, and the parent's id never leaves.
        [ids.taskB1]: [],
      });
      expect(tree.list).toEqual({ parentFieldId: parent.id, rowFields: [notes.id] });
      // Only the shown fields: the primary and the list's.
      expect(sorted(tree.fields.map((f) => f.id))).toEqual(sorted([name.id, notes.id]));
      for (const r of tree.records) {
        expect(sorted(Object.keys(r.fields))).toEqual(sorted([name.id, notes.id]));
      }
      const text = JSON.stringify(tree);
      for (const leak of [ids.epicB, 'Epic B', 'SECRET-', secret.id, assignee.id]) {
        expect(text).not.toContain(leak);
      }
      // The tree is read-only.
      expect(tree.editable).toEqual([]);
    }
  });

  it('never sends the parent field as a value, even when picked as a row field', async () => {
    for (const who of [guestId, viewerId, memberId]) {
      const tree = await pageRecords(who, 'parentAsField');
      expect(tree.list).toEqual({ parentFieldId: parent.id, rowFields: [notes.id] });
      expect(sorted(tree.fields.map((f) => f.id))).toEqual(sorted([name.id, notes.id]));
      for (const r of tree.records) {
        expect(sorted(Object.keys(r.fields))).toEqual(sorted([name.id, notes.id]));
      }
      expect(parents(tree)[ids.taskB1]).toEqual([]);
      const text = JSON.stringify(tree);
      for (const leak of [ids.epicB, 'Epic B']) expect(text).not.toContain(leak);
    }
  });

  it("refuses a filter element on the list's parent field", async () => {
    const res = await request(ownerId, 'PATCH', pagePath(pages['unpublished']?.id), {
      draft: {
        layout: 'list',
        tableId: table.id,
        fields: [notes.id],
        list: { parentFieldId: parent.id },
        elements: [
          { id: 'p1', type: 'filter', fieldId: parent.id, label: '', x: 0, y: 0, w: 4, h: 1 },
        ],
      },
    });
    expect(res.status).toBe(422);
    const problem = (await res.json()) as { errors?: { path: string }[] };
    expect(problem.errors?.map((e) => e.path)).toEqual(['draft.elements.0.fieldId']);
  });

  it("applies the viewer's filter elements to the structure too", async () => {
    // "task" leaves Epic A out: its children become roots, Sub A1 stays under Task A1.
    const tree = await pageRecords(guestId, 'tree', { filters: { f1: 'task' } });
    expect(parents(tree)).toEqual({
      [ids.taskA1]: [],
      [ids.taskA2]: [],
      [ids.subA1]: [ids.taskA1],
      [ids.taskB1]: [],
    });
    expect(JSON.stringify(tree)).not.toContain(ids.epicA);
  });

  it('"Me" and "Created by me" limit the listed records per viewer', async () => {
    // The owner is assigned Epic B only.
    const owners = await pageRecords(ownerId, 'tree');
    expect(parents(owners)).toEqual({ [ids.epicB]: [] });
    const members = await pageRecords(memberId, 'tree');
    expect(members.records).toHaveLength(5);
    // The owner created every record; Gus created none.
    expect((await pageRecords(guestId, 'createdByMe')).records).toEqual([]);
    const all = await pageRecords(ownerId, 'createdByMe');
    expect(all.records).toHaveLength(6);
    expect(parents(all)[ids.taskB1]).toEqual([ids.epicB]);
    expect(all.list?.rowFields).toEqual([]);
    expect(all.fields.map((f) => f.id)).toEqual([name.id]);
  });

  it('never writes through the page, whoever asks', async () => {
    const before = await stored(ids.taskA1);
    const attempts: Record<string, unknown>[] = [
      { [notes.id]: 'changed' },
      { [name.id]: 'Renamed' },
      { [parent.id]: [] },
      { [parent.id]: [ids.taskA2] },
    ];
    for (const who of [guestId, viewerId, memberId, ownerId]) {
      for (const fields of attempts) {
        expect((await edit(who, 'tree', ids.taskA1, fields)).status, JSON.stringify(fields)).toBe(
          403
        );
      }
    }
    expect(await stored(ids.taskA1)).toEqual(before);
  });

  it('keeps an unpublished page invisible to everyone but its creators', async () => {
    for (const who of [guestId, viewerId, memberId]) {
      expect(await status(who, 'POST', recordsPath('unpublished'), {})).toBe(404);
      expect(await status(who, 'POST', recordsPath('unpublished'), { draft: true })).toBe(404);
      // Nor a published page's draft.
      expect(await status(who, 'POST', recordsPath('tree'), { draft: true })).toBe(404);
    }
    const access = await call<InterfaceAccess>(guestId, 'GET', `/api/interfaces/${iface.id}`);
    expect(access.interface.pages.map((p) => p.id)).not.toContain(pages['unpublished']?.id);
    // Its creators preview the draft.
    const draft = await pageRecords(ownerId, 'unpublished', { draft: true });
    expect(draft.records).toHaveLength(6);
  });

  it('leaves out fields hidden from the viewer, the parent link included', async () => {
    const open = app;
    const hide = (fieldIds: string[]): FieldVisibility => ({
      hiddenFields: (v) => (v.userId === guestId ? new Set(fieldIds) : new Set()),
    });
    try {
      ({ app } = testApp({ db: t.appDb, visibility: hide([notes.id]) }));
      const tree = await pageRecords(guestId, 'tree');
      expect(tree.fields.map((f) => f.id)).toEqual([name.id]);
      expect(tree.list).toEqual({ parentFieldId: parent.id, rowFields: [] });
      expect(JSON.stringify(tree.records)).not.toContain('task one');
      expect(parents(tree)[ids.subA1]).toEqual([ids.taskA1]);

      // Without the parent field, no structure leaves: every record is a root.
      ({ app } = testApp({ db: t.appDb, visibility: hide([parent.id]) }));
      const flat = await pageRecords(guestId, 'tree');
      expect(flat.list?.parentFieldId).toBeNull();
      expect(flat.records).toHaveLength(5);
      for (const r of flat.records) expect(r.links).toBeUndefined();
      // Others still get the tree.
      expect(parents(await pageRecords(viewerId, 'tree'))[ids.taskA1]).toEqual([ids.epicA]);
    } finally {
      app = open;
    }
  });

  it("interface-only collaborators still can't reach the base's API", async () => {
    const refused = [
      ['GET', `/api/bases/${base.id}`],
      ['GET', `/api/tables/${table.id}`],
      ['GET', `/api/tables/${table.id}/records`],
      ['POST', `/api/tables/${table.id}/records/query`, {}],
      ['GET', `/api/tables/${table.id}/records/${ids.taskA1}`],
      ['PATCH', `/api/tables/${table.id}/records/${ids.taskA1}`, { fields: { [notes.id]: 'x' } }],
      ['POST', `/api/tables/${table.id}/attachments`, {}],
      ['GET', `/api/bases/${base.id}/interfaces`],
    ] as const;
    for (const who of [guestId, viewerId]) {
      for (const [method, path, body] of refused) {
        expect(await status(who, method, path, body), `${method} ${path}`).toBe(404);
      }
    }
  });

  it('defaults a new page to the first self link and refuses any other parent field', async () => {
    const created = await call<InterfacePage>(
      ownerId,
      'POST',
      pagePath(),
      { name: 'Outline', layout: 'list', tableId: table.id },
      201
    );
    expect(created.draft?.layout).toBe('list');
    expect(created.draft?.list).toEqual({ parentFieldId: parent.id });
    const draft = created.draft as InterfacePageConfig;
    const save = (parentFieldId: string | null) =>
      request(ownerId, 'PATCH', pagePath(created.id), {
        draft: { ...draft, list: { parentFieldId } },
      });
    for (const wrong of [
      notes.id,
      project.id,
      createdBy.id,
      '01900000-0000-7000-8000-000000000099',
    ]) {
      const res = await save(wrong);
      expect(res.status, wrong).toBe(422);
      const problem = (await res.json()) as { errors?: { path: string }[] };
      expect(problem.errors?.map((e) => e.path)).toEqual(['draft.list.parentFieldId']);
    }
    // A flat list, then the self link again.
    expect((await save(null)).status).toBe(200);
    expect((await save(parent.id)).status).toBe(200);
    const published = await call<InterfacePage>(ownerId, 'POST', `${pagePath(created.id)}/publish`);
    expect(published.published?.list).toEqual({ parentFieldId: parent.id });
    // On a table without a link to itself, a new page starts flat.
    const other = await call<InterfacePage>(
      ownerId,
      'POST',
      pagePath(),
      { name: 'Projects', layout: 'list', tableId: projects.id },
      201
    );
    expect(other.draft?.list).toEqual({ parentFieldId: null });
  });
});
