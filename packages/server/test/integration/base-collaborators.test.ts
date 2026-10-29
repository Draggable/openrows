import {
  BaseCollaboratorListSchema,
  BaseCollaboratorSchema,
  BaseListSchema,
  InvitationListSchema,
  InvitationPreviewSchema,
  InvitationSchema,
  TableSchema,
  ViewListSchema,
  WorkspaceListSchema,
  WorkspaceSchema,
} from '@openrows/shared';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { baseMembers, bases, workspaceInvitations } from '../../src/db/index.js';
import type { EmailMessage } from '../../src/email/transport.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, authedClient, createUser, createWorkspace } from '../helpers/factories.js';

const ORIGIN = 'http://localhost:5173';
const send = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { origin: ORIGIN, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const del = (): RequestInit => ({ method: 'DELETE', headers: { origin: ORIGIN } });

function tokenFrom(mail: EmailMessage | undefined): string {
  const match = mail?.text.match(/\/invite\/([A-Za-z0-9_-]{43})/);
  if (!match?.[1]) throw new Error('no invitation link in the email');
  return match[1];
}

type Client = Awaited<ReturnType<typeof authedClient>>;

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const body = r.status === 204 ? null : await r.json();
  expect(r.status, JSON.stringify(body)).toBe(status);
  return body as T;
}

describe('base collaborators and base invitations (#91)', () => {
  const t = useTestDb();

  /** A workspace with two real bases (created through the API) and its owner's client. */
  async function world() {
    const { workspace, owner } = await createWorkspace(t.db, { name: 'Acme' });
    const ownerClient = await authedClient(t, owner);
    const newBase = (name: string) =>
      json<{ id: string }>(
        ownerClient.request(`/api/workspaces/${workspace.id}/bases`, send({ name })),
        201
      );
    const roadmap = await newBase('Roadmap');
    const finance = await newBase('Finance');
    return { workspace, owner, ownerClient, roadmap, finance };
  }

  /** Invites `email` to `baseId` as `inviter` and accepts as `user`. */
  async function inviteAndAccept(
    inviter: Client,
    baseId: string,
    user: Awaited<ReturnType<typeof createUser>>,
    role = 'editor'
  ) {
    await json(
      inviter.request(`/api/bases/${baseId}/invitations`, send({ email: user.email, role })),
      201
    );
    const token = tokenFrom(inviter.email.sent.at(-1));
    const client = await authedClient(t, user);
    const workspace = WorkspaceSchema.parse(
      await json(client.request(`/api/invitations/${token}/accept`, send(undefined)))
    );
    return { client, token, workspace };
  }

  it('invites a base-only collaborator, who then sees just that base', async () => {
    const w = await world();
    const guest = await createUser(t.db, { email: 'gina@example.test', name: 'Gina' });

    const invitation = InvitationSchema.parse(
      await json(
        w.ownerClient.request(
          `/api/bases/${w.roadmap.id}/invitations`,
          send({ email: ' Gina@Example.test', role: 'editor' })
        ),
        201
      )
    );
    expect(invitation).toMatchObject({
      baseId: w.roadmap.id,
      email: 'gina@example.test',
      role: 'editor',
      emailSent: true,
    });
    const mail = w.ownerClient.email.sent.at(-1);
    expect(mail?.subject).toContain('Roadmap');
    expect(mail?.text).toContain('the base "Roadmap" in Acme');
    // Listed on the base, not with the workspace's invitations.
    const onBase = InvitationListSchema.parse(
      await json(w.ownerClient.request(`/api/bases/${w.roadmap.id}/invitations`))
    );
    expect(onBase.invitations.map((i) => i.email)).toEqual(['gina@example.test']);
    const onWorkspace = InvitationListSchema.parse(
      await json(w.ownerClient.request(`/api/workspaces/${w.workspace.id}/invitations`))
    );
    expect(onWorkspace.invitations).toEqual([]);
    expect(
      (
        await json<{ invitations: unknown[] }>(
          w.ownerClient.request(`/api/bases/${w.finance.id}/invitations`)
        )
      ).invitations
    ).toEqual([]);

    const token = tokenFrom(mail);
    const client = await authedClient(t, guest);
    const preview = InvitationPreviewSchema.parse(
      await json(client.request(`/api/invitations/${token}`))
    );
    expect(preview).toMatchObject({
      workspaceName: 'Acme',
      baseId: w.roadmap.id,
      baseName: 'Roadmap',
      role: 'editor',
      status: 'pending',
      emailMatches: true,
      alreadyMember: false,
    });
    const accepted = WorkspaceSchema.parse(
      await json(client.request(`/api/invitations/${token}/accept`, send(undefined)))
    );
    expect(accepted).toMatchObject({ id: w.workspace.id, role: null });
    // Single use.
    expect((await client.request(`/api/invitations/${token}/accept`, send(undefined))).status).toBe(
      409
    );

    const list = WorkspaceListSchema.parse(await json(client.request('/api/workspaces')));
    expect(list.workspaces).toMatchObject([{ id: w.workspace.id, name: 'Acme', role: null }]);
    const theirBases = BaseListSchema.parse(
      await json(client.request(`/api/workspaces/${w.workspace.id}/bases`))
    );
    expect(theirBases.bases.map((b) => [b.name, b.role])).toEqual([['Roadmap', 'editor']]);
    expect((await client.request(`/api/bases/${w.roadmap.id}`)).status).toBe(200);
    expect((await client.request(`/api/bases/${w.finance.id}`)).status).toBe(404);
    expect((await client.request(`/api/bases/${w.finance.id}/tables`)).status).toBe(404);
    expect((await client.request(`/api/workspaces/${w.workspace.id}`)).status).toBe(404);
    expect((await client.request(`/api/workspaces/${w.workspace.id}/members`)).status).toBe(404);
    // An editor doesn't manage the base's people.
    expect((await client.request(`/api/bases/${w.roadmap.id}/collaborators`)).status).toBe(403);

    // The owner sees everyone with access and their effective roles.
    const people = BaseCollaboratorListSchema.parse(
      await json(w.ownerClient.request(`/api/bases/${w.roadmap.id}/collaborators`))
    );
    expect(people.collaborators.map((p) => [p.name, p.workspaceRole, p.baseRole, p.role])).toEqual([
      ['Gina', null, 'editor', 'editor'],
      ['Test User', 'owner', null, 'owner'],
    ]);
    // Other bases don't list Gina.
    const finance = BaseCollaboratorListSchema.parse(
      await json(w.ownerClient.request(`/api/bases/${w.finance.id}/collaborators`))
    );
    expect(finance.collaborators.map((p) => p.userId)).toEqual([w.owner.id]);
  });

  it('changes and removes base roles; the effective role is the higher one', async () => {
    const w = await world();
    const guest = await createUser(t.db, { name: 'Gus' });
    const { client: guestClient } = await inviteAndAccept(w.ownerClient, w.roadmap.id, guest);
    const editor = await addMember(t.db, w.workspace.id, 'editor', await createUser(t.db));
    const creator = await addMember(t.db, w.workspace.id, 'creator', await createUser(t.db));
    const path = (id: string) => `/api/bases/${w.roadmap.id}/collaborators/${id}`;

    // Raise the guest to creator: they now manage the base's people.
    const raised = BaseCollaboratorSchema.parse(
      await json(w.ownerClient.request(path(guest.id), send({ role: 'creator' }, 'PATCH')))
    );
    expect(raised).toMatchObject({ baseRole: 'creator', role: 'creator' });
    expect((await guestClient.request(`/api/bases/${w.roadmap.id}/collaborators`)).status).toBe(
      200
    );
    // A base role is at most creator.
    expect(
      (await guestClient.request(path(editor.id), send({ role: 'owner' }, 'PATCH'))).status
    ).toBe(422);

    // A workspace editor raised in this base only.
    const editorClient = await authedClient(t, editor);
    expect(
      BaseCollaboratorSchema.parse(
        await json(guestClient.request(path(editor.id), send({ role: 'creator' }, 'PATCH')))
      )
    ).toMatchObject({ workspaceRole: 'editor', baseRole: 'creator', role: 'creator' });
    const editorBases = BaseListSchema.parse(
      await json(editorClient.request(`/api/workspaces/${w.workspace.id}/bases`))
    );
    expect(editorBases.bases.map((b) => [b.name, b.role])).toEqual([
      ['Roadmap', 'creator'],
      ['Finance', 'editor'],
    ]);
    expect((await editorClient.request(`/api/bases/${w.finance.id}/collaborators`)).status).toBe(
      403
    );

    // A lower base role never lowers the workspace role.
    expect(
      BaseCollaboratorSchema.parse(
        await json(w.ownerClient.request(path(creator.id), send({ role: 'read_only' }, 'PATCH')))
      )
    ).toMatchObject({ workspaceRole: 'creator', baseRole: 'read_only', role: 'creator' });
    const creatorClient = await authedClient(t, creator);
    expect(
      (await creatorClient.request(`/api/bases/${w.roadmap.id}`, send({ name: 'R' }, 'PATCH')))
        .status
    ).toBe(200);

    // Owners are owners everywhere; strangers are invited, not added by id.
    expect(
      (await w.ownerClient.request(path(w.owner.id), send({ role: 'editor' }, 'PATCH'))).status
    ).toBe(409);
    const stranger = await createUser(t.db);
    expect(
      (await w.ownerClient.request(path(stranger.id), send({ role: 'editor' }, 'PATCH'))).status
    ).toBe(404);
    // Removing a base role: a workspace member falls back to the workspace role.
    await json(w.ownerClient.request(path(editor.id), del()), 204);
    expect((await w.ownerClient.request(path(editor.id), del())).status).toBe(404);
    expect((await editorClient.request(`/api/bases/${w.roadmap.id}/collaborators`)).status).toBe(
      403
    );
    // A base-only collaborator loses the base, and the workspace leaves their list.
    await json(w.ownerClient.request(path(guest.id), del()), 204);
    expect((await guestClient.request(`/api/bases/${w.roadmap.id}`)).status).toBe(404);
    expect((await guestClient.request(`/api/workspaces/${w.workspace.id}/bases`)).status).toBe(404);
    const list = WorkspaceListSchema.parse(await json(guestClient.request('/api/workspaces')));
    expect(list.workspaces.map((x) => x.id)).not.toContain(w.workspace.id);
  });

  it('refuses base invitations for people who already have that access', async () => {
    const w = await world();
    const editor = await addMember(t.db, w.workspace.id, 'editor');
    const invite = (email: string | null, role: string) =>
      w.ownerClient.request(`/api/bases/${w.roadmap.id}/invitations`, send({ email, role }));

    expect((await invite(editor.email, 'editor')).status).toBe(409);
    expect((await invite(editor.email, 'commenter')).status).toBe(409);
    expect((await invite(w.owner.email, 'creator')).status).toBe(409);
    expect((await invite('someone@example.test', 'owner')).status).toBe(422);

    // A workspace editor invited as creator of one base: accepting raises them there.
    await json(invite(editor.email, 'creator'), 201);
    const editorClient = await authedClient(t, editor);
    const preview = InvitationPreviewSchema.parse(
      await json(
        editorClient.request(`/api/invitations/${tokenFrom(w.ownerClient.email.sent.at(-1))}`)
      )
    );
    expect(preview.alreadyMember).toBe(false);
    const accepted = WorkspaceSchema.parse(
      await json(
        editorClient.request(
          `/api/invitations/${tokenFrom(w.ownerClient.email.sent.at(-1))}/accept`,
          send(undefined)
        )
      )
    );
    expect(accepted.role).toBe('editor');
    const [row] = await t.db
      .select()
      .from(baseMembers)
      .where(and(eq(baseMembers.baseId, w.roadmap.id), eq(baseMembers.userId, editor.id)));
    expect(row?.role).toBe('creator');
    // Now a base collaborator: invite again is a conflict (change the role instead).
    expect((await invite(editor.email, 'creator')).status).toBe(409);
  });

  it('resends and revokes base invitations, scoped to their base', async () => {
    const w = await world();
    const inv = InvitationSchema.parse(
      await json(
        w.ownerClient.request(
          `/api/bases/${w.roadmap.id}/invitations`,
          send({ email: 'new@example.test', role: 'commenter' })
        ),
        201
      )
    );
    const first = tokenFrom(w.ownerClient.email.sent.at(-1));
    // Inviting again re-issues the same invitation.
    const again = InvitationSchema.parse(
      await json(
        w.ownerClient.request(
          `/api/bases/${w.roadmap.id}/invitations`,
          send({ email: 'new@example.test', role: 'editor' })
        ),
        201
      )
    );
    expect(again).toMatchObject({ id: inv.id, role: 'editor' });
    // A workspace invitation for the same address is a separate one.
    await json(
      w.ownerClient.request(
        `/api/workspaces/${w.workspace.id}/invitations`,
        send({ email: 'new@example.test', role: 'read_only' })
      ),
      201
    );
    expect(
      await t.db
        .select()
        .from(workspaceInvitations)
        .where(eq(workspaceInvitations.workspaceId, w.workspace.id))
    ).toHaveLength(2);

    // Another base's and the workspace's routes don't reach it.
    expect(
      (await w.ownerClient.request(`/api/bases/${w.finance.id}/invitations/${inv.id}`, del()))
        .status
    ).toBe(404);
    expect(
      (
        await w.ownerClient.request(
          `/api/workspaces/${w.workspace.id}/invitations/${inv.id}`,
          del()
        )
      ).status
    ).toBe(404);
    expect(
      (
        await w.ownerClient.request(
          `/api/workspaces/${w.workspace.id}/invitations/${inv.id}/resend`,
          send(undefined)
        )
      ).status
    ).toBe(404);

    await json(
      w.ownerClient.request(
        `/api/bases/${w.roadmap.id}/invitations/${inv.id}/resend`,
        send(undefined)
      )
    );
    const second = tokenFrom(w.ownerClient.email.sent.at(-1));
    expect(second).not.toBe(first);
    const guest = await createUser(t.db, { email: 'new@example.test' });
    const guestClient = await authedClient(t, guest);
    expect((await guestClient.request(`/api/invitations/${first}`)).status).toBe(404);
    await json(
      w.ownerClient.request(`/api/bases/${w.roadmap.id}/invitations/${inv.id}`, del()),
      204
    );
    expect(
      (await guestClient.request(`/api/invitations/${second}/accept`, send(undefined))).status
    ).toBe(409);
  });

  it('invalidates a base invitation when its base goes to the trash', async () => {
    const w = await world();
    const guest = await createUser(t.db);
    const { client } = await inviteAndAccept(w.ownerClient, w.roadmap.id, guest, 'read_only');
    await json(
      w.ownerClient.request(
        `/api/bases/${w.finance.id}/invitations`,
        send({ email: guest.email, role: 'editor' })
      ),
      201
    );
    const token = tokenFrom(w.ownerClient.email.sent.at(-1));
    await t.db.update(bases).set({ deletedAt: new Date() }).where(eq(bases.id, w.finance.id));
    expect((await client.request(`/api/invitations/${token}`)).status).toBe(404);
    // Trashing their only base takes the workspace off their list.
    await t.db.update(bases).set({ deletedAt: new Date() }).where(eq(bases.id, w.roadmap.id));
    const list = WorkspaceListSchema.parse(await json(client.request('/api/workspaces')));
    expect(list.workspaces.map((x) => x.id)).not.toContain(w.workspace.id);
  });

  it('locked views: only creators (workspace or base) unlock or reconfigure; editors edit records', async () => {
    const w = await world();
    const editor = await addMember(t.db, w.workspace.id, 'editor');
    const baseCreator = await addMember(t.db, w.workspace.id, 'editor');
    await t.db.insert(baseMembers).values({
      workspaceId: w.workspace.id,
      baseId: w.roadmap.id,
      userId: baseCreator.id,
      role: 'creator',
    });
    const table = TableSchema.parse(
      await json(
        w.ownerClient.request(`/api/bases/${w.roadmap.id}/tables`, send({ name: 'Tasks' })),
        201
      )
    );
    const { views } = ViewListSchema.parse(
      await json(w.ownerClient.request(`/api/tables/${table.id}/views`))
    );
    const view = views[0];
    if (!view) throw new Error('no view');
    const primary = table.fields.find((f) => f.isPrimary);
    if (!primary) throw new Error('no primary field');
    await json(w.ownerClient.request(`/api/views/${view.id}`, send({ locked: true }, 'PATCH')));

    const editorClient = await authedClient(t, editor);
    const viewPath = `/api/views/${view.id}`;
    expect((await editorClient.request(viewPath, send({ locked: false }, 'PATCH'))).status).toBe(
      403
    );
    expect(
      (await editorClient.request(viewPath, send({ grid: { rowHeight: 'tall' } }, 'PATCH'))).status
    ).toBe(403);
    expect((await editorClient.request(viewPath, del())).status).toBe(403);
    // Records aren't part of the view's configuration.
    await json(
      editorClient.request(
        `/api/tables/${table.id}/records`,
        send({ records: [{ fields: { [primary.id]: 'Still editable' } }] })
      ),
      201
    );
    // A workspace editor who is a creator of this base may unlock it.
    const creatorClient = await authedClient(t, baseCreator);
    expect(
      await json<{ locked: boolean }>(
        creatorClient.request(viewPath, send({ locked: false }, 'PATCH'))
      )
    ).toMatchObject({ locked: false });
  });
});
