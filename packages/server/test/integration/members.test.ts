import {
  InvitationListSchema,
  InvitationPreviewSchema,
  InvitationSchema,
  MemberListSchema,
  WorkspaceListSchema,
  WorkspaceSchema,
} from '@openrows/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { baseMembers, users, workspaceInvitations, workspaceMembers } from '../../src/db/index.js';
import type { EmailMessage } from '../../src/email/transport.js';
import { ensurePersonalWorkspace } from '../../src/workspaces/service.js';
import { useTestDb } from '../helpers/db.js';
import {
  addMember,
  authedClient,
  createBase,
  createUser,
  createWorkspace,
} from '../helpers/factories.js';

const ORIGIN = 'http://localhost:5173';
const send = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { origin: ORIGIN, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/** The token in the accept link of the last invitation email. */
function tokenFrom(mail: EmailMessage | undefined): string {
  const match = mail?.text.match(/\/invite\/([A-Za-z0-9_-]{43})/);
  if (!match?.[1]) throw new Error('no invitation link in the email');
  return match[1];
}

describe('members and invitations (#16)', () => {
  const t = useTestDb();

  it('creates one personal workspace per user, even when sign-ins race', async () => {
    const user = await createUser(t.appDb, { name: 'Grace Hopper' });
    const ids = await Promise.all([1, 2, 3].map(() => ensurePersonalWorkspace(t.appDb, user)));
    expect(new Set(ids).size).toBe(1);
    const memberships = await t.db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, user.id));
    expect(memberships).toMatchObject([{ workspaceId: ids[0], role: 'owner' }]);
    // Another user's lookup is their own (legacy ignored the user id, claude-review M5).
    const other = await createUser(t.appDb, { name: null });
    expect(await ensurePersonalWorkspace(t.appDb, other)).not.toBe(ids[0]);
    const client = await authedClient(t, user);
    const list = WorkspaceListSchema.parse(await (await client.request('/api/workspaces')).json());
    expect(list.workspaces.map((w) => w.name)).toEqual(["Grace's workspace"]);
  });

  it('invites by email; the invitee accepts and sees the workspace', async () => {
    const { workspace, owner } = await createWorkspace(t.db);
    const invitee = await createUser(t.db, { email: 'bob@example.test', name: 'Bob' });
    const ownerClient = await authedClient(t, owner);

    const res = await ownerClient.request(
      `/api/workspaces/${workspace.id}/invitations`,
      send({ email: '  Bob@Example.TEST ', role: 'creator' })
    );
    expect(res.status).toBe(201);
    const invitation = InvitationSchema.parse(await res.json());
    expect(invitation).toMatchObject({
      email: 'bob@example.test',
      role: 'creator',
      emailSent: true,
    });
    expect(ownerClient.email.sent).toHaveLength(1);
    const mail = ownerClient.email.sent[0];
    expect(mail?.to).toBe('bob@example.test');
    expect(mail?.subject).toContain(workspace.name);
    const token = tokenFrom(mail);
    // Only the hash is stored.
    const [row] = await t.db.select().from(workspaceInvitations);
    expect(row?.tokenHash).not.toContain(token);

    const pending = InvitationListSchema.parse(
      await (await ownerClient.request(`/api/workspaces/${workspace.id}/invitations`)).json()
    );
    expect(pending.invitations.map((i) => i.id)).toEqual([invitation.id]);

    const bob = await authedClient(t, invitee);
    // Before accepting, Bob can't see the workspace.
    expect((await bob.request(`/api/workspaces/${workspace.id}`)).status).toBe(404);
    const preview = InvitationPreviewSchema.parse(
      await (await bob.request(`/api/invitations/${token}`)).json()
    );
    expect(preview).toMatchObject({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      status: 'pending',
      role: 'creator',
      emailMatches: true,
      alreadyMember: false,
    });

    const accepted = await bob.request(`/api/invitations/${token}/accept`, send(undefined));
    expect(accepted.status).toBe(200);
    expect(WorkspaceSchema.parse(await accepted.json())).toMatchObject({
      id: workspace.id,
      role: 'creator',
    });
    const list = WorkspaceListSchema.parse(await (await bob.request('/api/workspaces')).json());
    expect(list.workspaces.map((w) => [w.id, w.role])).toEqual([[workspace.id, 'creator']]);
    const members = MemberListSchema.parse(
      await (await bob.request(`/api/workspaces/${workspace.id}/members`)).json()
    );
    expect(members.members.map((m) => [m.email, m.role])).toEqual([
      [owner.email, 'owner'],
      ['bob@example.test', 'creator'],
    ]);

    // The link works once; the invitation is no longer pending.
    const again = await bob.request(`/api/invitations/${token}/accept`, send(undefined));
    expect(again.status).toBe(409);
    const after = InvitationListSchema.parse(
      await (await ownerClient.request(`/api/workspaces/${workspace.id}/invitations`)).json()
    );
    expect(after.invitations).toEqual([]);
  });

  it('accepting needs a verified email that matches the invitation (H6)', async () => {
    const { workspace, owner } = await createWorkspace(t.db);
    const ownerClient = await authedClient(t, owner);
    await ownerClient.request(
      `/api/workspaces/${workspace.id}/invitations`,
      send({ email: 'carol@example.test' })
    );
    const token = tokenFrom(ownerClient.email.sent[0]);

    const mallory = await authedClient(
      t,
      await createUser(t.db, { email: 'mallory@example.test' })
    );
    const preview = InvitationPreviewSchema.parse(
      await (await mallory.request(`/api/invitations/${token}`)).json()
    );
    expect(preview.emailMatches).toBe(false);
    const refused = await mallory.request(`/api/invitations/${token}/accept`, send(undefined));
    expect(refused.status).toBe(403);

    const unverified = await authedClient(
      t,
      await createUser(t.db, { email: 'carol@example.test', emailVerified: false })
    );
    expect(
      (await unverified.request(`/api/invitations/${token}/accept`, send(undefined))).status
    ).toBe(403);
    const memberCount = await t.db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspace.id));
    expect(memberCount).toHaveLength(1);

    // Unknown and malformed tokens are 404.
    expect((await mallory.request(`/api/invitations/${'x'.repeat(43)}`)).status).toBe(404);
    expect((await mallory.request('/api/invitations/short')).status).toBe(404);
  });

  it('expires, revokes and resends (a resend invalidates the old link)', async () => {
    const { workspace, owner } = await createWorkspace(t.db);
    const dave = await createUser(t.db, { email: 'dave@example.test' });
    const ownerClient = await authedClient(t, owner);
    const daveClient = await authedClient(t, dave);
    const invitation = InvitationSchema.parse(
      await (
        await ownerClient.request(
          `/api/workspaces/${workspace.id}/invitations`,
          send({ email: 'dave@example.test', role: 'editor' })
        )
      ).json()
    );
    const first = tokenFrom(ownerClient.email.sent[0]);

    await t.db
      .update(workspaceInvitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(workspaceInvitations.id, invitation.id));
    const expired = InvitationPreviewSchema.parse(
      await (await daveClient.request(`/api/invitations/${first}`)).json()
    );
    expect(expired.status).toBe('expired');
    expect(
      (await daveClient.request(`/api/invitations/${first}/accept`, send(undefined))).status
    ).toBe(409);

    const resent = await ownerClient.request(
      `/api/workspaces/${workspace.id}/invitations/${invitation.id}/resend`,
      send(undefined)
    );
    expect(resent.status).toBe(200);
    const second = tokenFrom(ownerClient.email.sent[1]);
    expect(second).not.toBe(first);
    expect((await daveClient.request(`/api/invitations/${first}`)).status).toBe(404);

    // Inviting the same address again re-issues the same invitation.
    const reinvited = InvitationSchema.parse(
      await (
        await ownerClient.request(
          `/api/workspaces/${workspace.id}/invitations`,
          send({ email: 'dave@example.test', role: 'commenter' })
        )
      ).json()
    );
    expect(reinvited).toMatchObject({ id: invitation.id, role: 'commenter' });
    const third = tokenFrom(ownerClient.email.sent[2]);

    const revoked = await ownerClient.request(
      `/api/workspaces/${workspace.id}/invitations/${invitation.id}`,
      send(undefined, 'DELETE')
    );
    expect(revoked.status).toBe(204);
    const preview = InvitationPreviewSchema.parse(
      await (await daveClient.request(`/api/invitations/${third}`)).json()
    );
    expect(preview.status).toBe('revoked');
    expect(
      (await daveClient.request(`/api/invitations/${third}/accept`, send(undefined))).status
    ).toBe(409);
    // Revoking again: no longer pending.
    expect(
      (
        await ownerClient.request(
          `/api/workspaces/${workspace.id}/invitations/${invitation.id}`,
          send(undefined, 'DELETE')
        )
      ).status
    ).toBe(404);
  });

  it('refuses to invite a member, and only owners invite owners', async () => {
    const { workspace, owner } = await createWorkspace(t.db);
    const creator = await addMember(t.db, workspace.id, 'creator');
    const ownerClient = await authedClient(t, owner);
    const creatorClient = await authedClient(t, creator);
    const url = `/api/workspaces/${workspace.id}/invitations`;

    const member = await ownerClient.request(
      url,
      send({ email: (creator.email ?? '').toUpperCase() })
    );
    expect(member.status).toBe(409);
    expect(
      (await creatorClient.request(url, send({ email: 'x@example.test', role: 'owner' }))).status
    ).toBe(403);
    expect(
      (await creatorClient.request(url, send({ email: 'x@example.test', role: 'creator' }))).status
    ).toBe(201);
    expect(
      (await ownerClient.request(url, send({ email: 'y@example.test', role: 'owner' }))).status
    ).toBe(201);
    expect((await ownerClient.request(url, send({ email: 'not an email' }))).status).toBe(422);
  });

  it('keeps the invitation when the email fails, and says so', async () => {
    const { workspace, owner } = await createWorkspace(t.db);
    const client = await authedClient(t, owner, {
      email: {
        async send() {
          throw new Error('SMTP down');
        },
      },
    });
    const res = await client.request(
      `/api/workspaces/${workspace.id}/invitations`,
      send({ email: 'eve@example.test' })
    );
    expect(res.status).toBe(201);
    expect(InvitationSchema.parse(await res.json()).emailSent).toBe(false);
  });

  it('changes roles: only owners touch owner, and a workspace keeps an owner', async () => {
    const { workspace, owner } = await createWorkspace(t.db);
    const creator = await addMember(t.db, workspace.id, 'creator');
    const editor = await addMember(t.db, workspace.id, 'editor');
    const ownerClient = await authedClient(t, owner);
    const creatorClient = await authedClient(t, creator);
    const member = (u: { id: string }) => `/api/workspaces/${workspace.id}/members/${u.id}`;

    expect(
      (await creatorClient.request(member(editor), send({ role: 'commenter' }, 'PATCH'))).status
    ).toBe(200);
    expect(
      (await creatorClient.request(member(editor), send({ role: 'owner' }, 'PATCH'))).status
    ).toBe(403);
    expect(
      (await creatorClient.request(member(owner), send({ role: 'editor' }, 'PATCH'))).status
    ).toBe(403);
    expect((await creatorClient.request(member(owner), send(undefined, 'DELETE'))).status).toBe(
      403
    );

    // The last owner can't step down or be removed.
    expect(
      (await ownerClient.request(member(owner), send({ role: 'creator' }, 'PATCH'))).status
    ).toBe(409);
    expect((await ownerClient.request(member(owner), send(undefined, 'DELETE'))).status).toBe(409);
    // With a second owner, they can.
    expect(
      (await ownerClient.request(member(creator), send({ role: 'owner' }, 'PATCH'))).status
    ).toBe(200);
    expect(
      (await ownerClient.request(member(owner), send({ role: 'creator' }, 'PATCH'))).status
    ).toBe(200);

    expect(
      (
        await ownerClient.request(
          `/api/workspaces/${workspace.id}/members/${crypto.randomUUID()}`,
          send(undefined, 'DELETE')
        )
      ).status
    ).toBe(404);
  });

  it('removing a member ends their access with the next request (M4)', async () => {
    const { workspace, owner } = await createWorkspace(t.db);
    const base = await createBase(t.db, workspace.id);
    const editor = await addMember(t.db, workspace.id, 'editor');
    await t.db
      .insert(baseMembers)
      .values({ workspaceId: workspace.id, baseId: base.id, userId: editor.id, role: 'creator' });
    const ownerClient = await authedClient(t, owner);
    const editorClient = await authedClient(t, editor);
    expect((await editorClient.request(`/api/bases/${base.id}`)).status).toBe(200);

    const removed = await ownerClient.request(
      `/api/workspaces/${workspace.id}/members/${editor.id}`,
      send(undefined, 'DELETE')
    );
    expect(removed.status).toBe(204);
    // Same session, no sign-out: the workspace and its base are gone for them.
    expect((await editorClient.request(`/api/workspaces/${workspace.id}`)).status).toBe(404);
    expect((await editorClient.request(`/api/bases/${base.id}`)).status).toBe(404);
    expect(await t.db.select().from(baseMembers).where(eq(baseMembers.userId, editor.id))).toEqual(
      []
    );
  });

  it('deletes a workspace for everyone (owners only)', async () => {
    const { workspace, owner } = await createWorkspace(t.db);
    const creator = await addMember(t.db, workspace.id, 'creator');
    const ownerClient = await authedClient(t, owner);
    const creatorClient = await authedClient(t, creator);
    expect(
      (await creatorClient.request(`/api/workspaces/${workspace.id}`, send(undefined, 'DELETE')))
        .status
    ).toBe(403);
    expect(
      (await ownerClient.request(`/api/workspaces/${workspace.id}`, send(undefined, 'DELETE')))
        .status
    ).toBe(204);
    expect((await ownerClient.request(`/api/workspaces/${workspace.id}`)).status).toBe(404);
    expect((await creatorClient.request(`/api/workspaces/${workspace.id}`)).status).toBe(404);
    const list = WorkspaceListSchema.parse(
      await (await creatorClient.request('/api/workspaces')).json()
    );
    expect(list.workspaces).toEqual([]);
    // A deleted personal workspace isn't recreated on the next sign-in.
    await t.db
      .update(users)
      .set({ personalWorkspaceId: workspace.id })
      .where(eq(users.id, owner.id));
    expect(await ensurePersonalWorkspace(t.appDb, owner)).toBe(workspace.id);
  });
});
