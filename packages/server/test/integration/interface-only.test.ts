import type {
  Base,
  FieldMeta,
  Interface,
  InterfaceAccess,
  InterfaceCollaboratorList,
  InterfacePage,
  InterfacePageConfig,
  InterfacePageRecords,
  InvitationPreview,
  SharedInterfaceList,
  TableMeta,
} from '@openrows/shared';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { interfaceMembers } from '../../src/db/index.js';
import type { EmailMessage } from '../../src/email/transport.js';
import { useTestDb } from '../helpers/db.js';
import { authedClient, createUser, createWorkspace } from '../helpers/factories.js';

const ORIGIN = 'http://localhost:5173';
type Client = Awaited<ReturnType<typeof authedClient>>;

function tokenFrom(mail: EmailMessage | undefined): string {
  const match = mail?.text.match(/\/invite\/([A-Za-z0-9_-]{43})/);
  if (!match?.[1]) throw new Error('no invitation link in the email');
  return match[1];
}

/**
 * Interface-only collaborators: someone given an interface and not its base reads its
 * published pages through the interface's own routes, projected to the fields each page shows,
 * with the page filter applied on the server (`me` is them), and writes only what a page offers.
 * The base's API, other interfaces and unpublished pages are 404 to them.
 */
describe('interface-only collaborators', () => {
  const t = useTestDb();
  let owner: Client;
  let guest: Client;
  let guestId: string;
  let base: Base;
  let table: TableMeta;
  let name: FieldMeta;
  let stage: FieldMeta;
  let notes: FieldMeta;
  let secret: FieldMeta;
  let assignee: FieldMeta;
  let due: FieldMeta;
  let iface: Interface;
  let other: Interface;
  const pages: Record<string, InterfacePage> = {};
  const recordIds: string[] = [];

  async function call<T>(
    client: Client,
    method: string,
    path: string,
    body?: unknown,
    expected = 200
  ): Promise<T> {
    const res = await client.request(path, {
      method,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    expect(res.status, `${method} ${path}: ${text}`).toBe(expected);
    return (text ? JSON.parse(text) : null) as T;
  }
  const status = async (client: Client, method: string, path: string, body?: unknown) =>
    (
      await client.request(path, {
        method,
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    ).status;

  async function page(i: Interface, pageName: string, config: InterfacePageConfig, publish = true) {
    const created = await call<InterfacePage>(
      owner,
      'POST',
      `/api/bases/${base.id}/interfaces/${i.id}/pages`,
      { name: pageName, layout: config.layout, tableId: table.id },
      201
    );
    await call(owner, 'PATCH', `/api/bases/${base.id}/interfaces/${i.id}/pages/${created.id}`, {
      draft: config,
    });
    if (publish) {
      await call(
        owner,
        'POST',
        `/api/bases/${base.id}/interfaces/${i.id}/pages/${created.id}/publish`
      );
    }
    return created;
  }
  const records = (p: InterfacePage, body: Record<string, unknown> = {}, as = guest) =>
    call<InterfacePageRecords>(
      as,
      'POST',
      `/api/interfaces/${iface.id}/pages/${p.id}/records`,
      body
    );

  beforeAll(async () => {
    const ws = await createWorkspace(t.db, { name: 'Acme' });
    owner = await authedClient(t, ws.owner);
    const guestUser = await createUser(t.db, { email: 'gus@example.test', name: 'Gus' });
    guestId = guestUser.id;
    guest = await authedClient(t, guestUser);
    base = await call<Base>(
      owner,
      'POST',
      `/api/workspaces/${ws.workspace.id}/bases`,
      { name: 'Support' },
      201
    );
    table = await call<TableMeta>(
      owner,
      'POST',
      `/api/bases/${base.id}/tables`,
      { name: 'Tickets' },
      201
    );
    const field = (body: unknown) =>
      call<FieldMeta>(owner, 'POST', `/api/tables/${table.id}/fields`, body, 201);
    const fresh = await call<TableMeta>(owner, 'GET', `/api/tables/${table.id}`);
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
    notes = await field({ name: 'Details', type: 'singleLineText' });
    secret = await field({ name: 'Secret', type: 'singleLineText' });
    assignee = await field({ name: 'Assignee', type: 'user' });
    due = await field({ name: 'Due', type: 'date' });

    iface = await call<Interface>(
      owner,
      'POST',
      `/api/bases/${base.id}/interfaces`,
      { name: 'Help desk' },
      201
    );
    other = await call<Interface>(
      owner,
      'POST',
      `/api/bases/${base.id}/interfaces`,
      { name: 'Internal' },
      201
    );
    // Gus is invited to the help desk only, and accepts.
    await call(
      owner,
      'POST',
      `/api/interfaces/${iface.id}/collaborators`,
      { email: 'gus@example.test', role: 'editor' },
      201
    );
    const token = tokenFrom(owner.email.sent.at(-1));
    expect(owner.email.sent.at(-1)?.subject).toContain('Help desk');
    const preview = await call<InvitationPreview>(guest, 'GET', `/api/invitations/${token}`);
    expect(preview).toMatchObject({ interfaceId: iface.id, interfaceName: 'Help desk' });
    await call(guest, 'POST', `/api/invitations/${token}/accept`);

    const created = await call<{ records: { id: string }[] }>(
      owner,
      'POST',
      `/api/tables/${table.id}/records`,
      {
        records: [
          {
            fields: {
              [name.id]: 'Printer',
              [stage.id]: 'open',
              [secret.id]: 's1',
              [assignee.id]: [guestId],
              [due.id]: '2026-11-03',
            },
          },
          { fields: { [name.id]: 'VPN', [stage.id]: 'done', [secret.id]: 's2' } },
          { fields: { [name.id]: 'Laptop', [stage.id]: 'open', [secret.id]: 's3' } },
        ],
      },
      201
    );
    recordIds.push(...created.records.map((r) => r.id));

    pages['mine'] = await page(iface, 'Assigned to me', {
      layout: 'recordReview',
      tableId: table.id,
      sorts: [],
      fields: [stage.id],
      filter: {
        conjunction: 'and',
        conditions: [{ fieldId: assignee.id, operator: 'hasAnyOf', value: ['me'] }],
      },
      elements: [
        { id: 'n', type: 'field', x: 0, y: 0, w: 6, h: 2, fieldId: notes.id, editable: true },
        { id: 's', type: 'field', x: 6, y: 0, w: 6, h: 2, fieldId: stage.id, editable: false },
      ],
    });
    pages['board'] = await page(iface, 'Board', {
      layout: 'kanban',
      tableId: table.id,
      sorts: [],
      fields: [],
      elements: [],
      kanban: { stackFieldId: stage.id, cardFields: [due.id] },
    });
    pages['calendar'] = await page(iface, 'Calendar', {
      layout: 'calendar',
      tableId: table.id,
      sorts: [],
      fields: [],
      elements: [],
      calendar: { dateFields: [{ startFieldId: due.id }] },
    });
    pages['form'] = await page(iface, 'New ticket', {
      layout: 'form',
      tableId: table.id,
      sorts: [],
      fields: [],
      elements: [],
      form: {
        fields: [
          { fieldId: name.id, label: 'Subject', required: true },
          { fieldId: notes.id, label: '', required: false },
        ],
        submitLabel: 'Send',
        successMessage: 'Thanks',
      },
    });
    pages['draft'] = await page(
      iface,
      'Unpublished',
      { layout: 'recordList', tableId: table.id, sorts: [], fields: [secret.id], elements: [] },
      false
    );
    pages['other'] = await page(other, 'Everything', {
      layout: 'recordList',
      tableId: table.id,
      sorts: [],
      fields: [secret.id],
      elements: [],
    });
  });

  it('reaches the interface and its published pages only', async () => {
    const access = await call<InterfaceAccess>(guest, 'GET', `/api/interfaces/${iface.id}`);
    expect(access).toMatchObject({ access: 'interface', canEdit: false, role: 'editor' });
    expect(access.baseName).toBe('Support');
    expect(access.interface.pages.map((p) => p.name)).toEqual([
      'Assigned to me',
      'Board',
      'Calendar',
      'New ticket',
    ]);
    expect(access.interface.pages.every((p) => p.draft === null)).toBe(true);
    const shared = await call<SharedInterfaceList>(guest, 'GET', '/api/me/interfaces');
    expect(shared.interfaces).toEqual([
      {
        id: iface.id,
        name: 'Help desk',
        baseId: base.id,
        baseName: 'Support',
        workspaceName: 'Acme',
        role: 'editor',
      },
    ]);
    // The owner reaches it through the base, with drafts.
    const ownerView = await call<InterfaceAccess>(owner, 'GET', `/api/interfaces/${iface.id}`);
    expect(ownerView).toMatchObject({ access: 'base', canEdit: true, role: 'owner' });
    expect(ownerView.interface.pages).toHaveLength(5);
  });

  it("can't reach the base's API, other interfaces or unpublished pages", async () => {
    const refused = [
      ['GET', `/api/bases/${base.id}`],
      ['GET', `/api/bases/${base.id}/tables`],
      ['GET', `/api/bases/${base.id}/interfaces`],
      ['GET', `/api/bases/${base.id}/interfaces/${iface.id}/pages/${pages['mine']?.id}`],
      ['GET', `/api/tables/${table.id}`],
      ['GET', `/api/tables/${table.id}/records`],
      ['POST', `/api/tables/${table.id}/records/query`, {}],
      ['GET', `/api/tables/${table.id}/records/${recordIds[0]}`],
      ['PATCH', `/api/tables/${table.id}/records/${recordIds[0]}`, { fields: {} }],
      ['GET', `/api/fields/${secret.id}/link-candidates`],
      ['GET', `/api/bases/${base.id}/events?since=0`],
      ['GET', `/api/interfaces/${other.id}`],
      ['POST', `/api/interfaces/${other.id}/pages/${pages['other']?.id}/records`, {}],
      // A page of another interface through this one's path, and the unpublished page.
      ['POST', `/api/interfaces/${iface.id}/pages/${pages['other']?.id}/records`, {}],
      ['POST', `/api/interfaces/${iface.id}/pages/${pages['draft']?.id}/records`, {}],
      ['POST', `/api/interfaces/${iface.id}/pages/${pages['mine']?.id}/records`, { draft: true }],
      ['GET', `/api/workspaces/${base.workspaceId}/collaborators`],
    ] as const;
    for (const [method, path, body] of refused) {
      expect(await status(guest, method, path, body), `${method} ${path}`).toBe(404);
    }
    // Managing the interface's collaborators needs a creator.
    expect(await status(guest, 'GET', `/api/interfaces/${iface.id}/collaborators`)).toBe(403);
  });

  it('reads only the fields a page shows, filtered for the viewer', async () => {
    const mine = await records(pages['mine'] as InterfacePage);
    expect(mine.records.map((r) => r.fields[name.id])).toEqual(['Printer']);
    expect(mine.fields.map((f) => f.name).sort()).toEqual(['Details', 'Name', 'Stage']);
    for (const r of mine.records) {
      expect(Object.keys(r.fields).sort()).toEqual([name.id, notes.id, stage.id].sort());
    }
    expect(mine.editable).toEqual([notes.id]);
    // The owner isn't assigned anything: the same page lists nothing for them.
    expect((await records(pages['mine'] as InterfacePage, {}, owner)).records).toEqual([]);

    const board = await records(pages['board'] as InterfacePage);
    expect(board.total).toBe(3);
    expect(board.fields.map((f) => f.id).sort()).toEqual([name.id, stage.id, due.id].sort());
    expect(JSON.stringify(board)).not.toContain('s1');

    const calendar = await records(pages['calendar'] as InterfacePage, {
      from: '2026-11-01',
      to: '2026-11-30',
    });
    expect(calendar.records.map((r) => r.fields[name.id])).toEqual(['Printer']);

    const form = await records(pages['form'] as InterfacePage);
    expect(form).toMatchObject({ records: [], total: 0, canSubmit: true });
    expect(form.fields.map((f) => f.id).sort()).toEqual([name.id, notes.id].sort());
  });

  it('edits only the editable fields of records the page lists', async () => {
    const path = (id: string) =>
      `/api/interfaces/${iface.id}/pages/${pages['mine']?.id}/records/${id}`;
    const printer = recordIds[0] as string;
    await call(guest, 'PATCH', path(printer), { fields: { [notes.id]: 'Jammed' } }, 204);
    const after = await records(pages['mine'] as InterfacePage);
    expect(after.records[0]?.fields[notes.id]).toBe('Jammed');
    // A field the page shows read-only, or doesn't show at all.
    expect(await status(guest, 'PATCH', path(printer), { fields: { [stage.id]: 'done' } })).toBe(
      403
    );
    expect(await status(guest, 'PATCH', path(printer), { fields: { [secret.id]: 'x' } })).toBe(403);
    // A record the page's filter leaves out (not assigned to Gus).
    expect(
      await status(guest, 'PATCH', path(recordIds[1] as string), {
        fields: { [notes.id]: 'x' },
      })
    ).toBe(404);
    // Pages that don't edit.
    expect(
      await status(
        guest,
        'PATCH',
        `/api/interfaces/${iface.id}/pages/${pages['board']?.id}/records/${printer}`,
        { fields: { [notes.id]: 'x' } }
      )
    ).toBe(403);
  });

  it('submits form pages with their fields only, and "created by me" filters', async () => {
    const path = `/api/interfaces/${iface.id}/pages/${pages['form']?.id}/submissions`;
    expect(await status(guest, 'POST', path, { fields: { [notes.id]: 'no subject' } })).toBe(422);
    expect(
      await status(guest, 'POST', path, { fields: { [name.id]: 'Mouse', [secret.id]: 'x' } })
    ).toBe(403);
    const { id } = await call<{ id: string }>(
      guest,
      'POST',
      path,
      { fields: { [name.id]: 'Mouse', [notes.id]: 'Broken wheel' } },
      201
    );
    const record = await call<{ fields: Record<string, unknown>; createdBy: string }>(
      owner,
      'GET',
      `/api/tables/${table.id}/records/${id}`
    );
    expect(record.fields[name.id]).toBe('Mouse');
    expect(record.createdBy).toBe(guestId);

    const createdBy = await call<FieldMeta>(
      owner,
      'POST',
      `/api/tables/${table.id}/fields`,
      { name: 'Created by', type: 'createdBy' },
      201
    );
    const mineCreated = await page(iface, 'My requests', {
      layout: 'recordList',
      tableId: table.id,
      sorts: [],
      fields: [notes.id],
      filter: {
        conjunction: 'and',
        conditions: [{ fieldId: createdBy.id, operator: 'is', value: 'me' }],
      },
      elements: [],
    });
    const listed = await records(mineCreated);
    expect(listed.records.map((r) => r.fields[name.id])).toEqual(['Mouse']);
  });

  it('a read-only collaborator reads but never writes', async () => {
    await t.db
      .update(interfaceMembers)
      .set({ role: 'read_only' })
      .where(eq(interfaceMembers.userId, guestId));
    try {
      expect((await records(pages['form'] as InterfacePage)).canSubmit).toBe(false);
      expect((await records(pages['mine'] as InterfacePage)).editable).toEqual([]);
      expect(
        await status(
          guest,
          'POST',
          `/api/interfaces/${iface.id}/pages/${pages['form']?.id}/submissions`,
          { fields: { [name.id]: 'Nope' } }
        )
      ).toBe(403);
    } finally {
      await t.db
        .update(interfaceMembers)
        .set({ role: 'editor' })
        .where(eq(interfaceMembers.userId, guestId));
    }
  });

  it('creators list, change and remove interface-only collaborators', async () => {
    const list = await call<InterfaceCollaboratorList>(
      owner,
      'GET',
      `/api/interfaces/${iface.id}/collaborators`
    );
    expect(list.collaborators).toMatchObject([{ userId: guestId, role: 'editor', name: 'Gus' }]);
    expect(list.invitations).toEqual([]);
    // Base collaborators aren't invited to an interface: they see it already.
    expect(
      await status(owner, 'POST', `/api/interfaces/${iface.id}/collaborators`, {
        email: (await call<{ user: { email: string } }>(owner, 'GET', '/api/me')).user.email,
        role: 'editor',
      })
    ).toBe(409);
    await call(owner, 'PATCH', `/api/interfaces/${iface.id}/collaborators/${guestId}`, {
      role: 'read_only',
    });
    await call(
      owner,
      'DELETE',
      `/api/interfaces/${iface.id}/collaborators/${guestId}`,
      undefined,
      204
    );
    expect(await status(guest, 'GET', `/api/interfaces/${iface.id}`)).toBe(404);
    expect(
      (await call<SharedInterfaceList>(guest, 'GET', '/api/me/interfaces')).interfaces
    ).toEqual([]);
  });
});
