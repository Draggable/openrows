import type { CreatedShare, TableMeta, ViewMeta } from '@openrows/shared';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { workspaceMemberActivity, workspacePolicies } from '../../src/db/index.js';
import type { EmailMessage } from '../../src/email/transport.js';
import { shareEmbedAncestors } from '../../src/shares/service.js';
import { useTestDb } from '../helpers/db.js';
import {
  addMember,
  authedClient,
  createToken,
  createUser,
  createWorkspace,
} from '../helpers/factories.js';

const ORIGIN = 'http://localhost:5173';
const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { origin: ORIGIN, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const bearer = (token: string): RequestInit => ({ headers: { authorization: `Bearer ${token}` } });

function inviteToken(mail: EmailMessage | undefined): string {
  const match = mail?.text.match(/\/invite\/([A-Za-z0-9_-]{43})/);
  if (!match?.[1]) throw new Error('no invitation link in the email');
  return match[1];
}

/**
 * Workspace policies: stored by the hosted admin console, enforced by the core in every
 * edition. Each policy is set here straight in `workspace_policies` (the console's routes are
 * the hosted edition's admin console tests) and checked through the API: personal access tokens refused
 * in authorize(), share links, forms and embeds refused when made and dead while it holds,
 * invitations limited to domains, and activity recorded for the member list.
 */
describe('workspace policies', () => {
  const t = useTestDb();

  async function setPolicies(
    workspaceId: string,
    values: Partial<typeof workspacePolicies.$inferInsert>
  ) {
    await t.db
      .insert(workspacePolicies)
      .values({ workspaceId, ...values })
      .onConflictDoUpdate({ target: workspacePolicies.workspaceId, set: values });
  }

  async function ok<T>(res: Response, status = 200): Promise<T> {
    if (res.status !== status) throw new Error(`${res.status}: ${await res.text()}`);
    return (status === 204 ? undefined : await res.json()) as T;
  }

  async function fixture() {
    const { workspace, owner } = await createWorkspace(t.db);
    const client = await authedClient(t, owner);
    const base = await ok<{ id: string }>(
      await client.request(`/api/workspaces/${workspace.id}/bases`, json('POST', { name: 'B' })),
      201
    );
    const table = await ok<TableMeta>(
      await client.request(`/api/bases/${base.id}/tables`, json('POST', { name: 'Tasks' })),
      201
    );
    const { views } = await ok<{ views: ViewMeta[] }>(
      await client.request(`/api/tables/${table.id}/views`)
    );
    const grid = views[0];
    if (!grid) throw new Error('no grid view');
    const form = await ok<ViewMeta>(
      await client.request(
        `/api/tables/${table.id}/views`,
        json('POST', { name: 'Intake', type: 'form' })
      ),
      201
    );
    return { workspace, owner, client, base, table, grid, form };
  }

  it('refuses personal access tokens on a workspace that turned them off', async () => {
    const f = await fixture();
    const other = await createWorkspace(t.db, { owner: f.owner });
    const { token } = await createToken(t.db, f.owner, {
      workspaceIds: [f.workspace.id, other.workspace.id],
    });
    const v1 = (baseId: string) =>
      f.client.request(`/api/v1/meta/bases/${baseId}/tables`, bearer(token));
    expect((await v1(f.base.id)).status).toBe(200);

    await setPolicies(f.workspace.id, { personalAccessTokens: false });
    const refused = await v1(f.base.id);
    expect(refused.status).toBe(403);
    // The REST API's own error shape (Airtable's).
    expect(await refused.json()).toMatchObject({ error: { code: 'POLICY_RESTRICTED' } });
    // Every route of the workspace, the workspace itself too.
    expect(
      (await f.client.request(`/api/workspaces/${f.workspace.id}`, bearer(token))).status
    ).toBe(403);
    // The token's list of workspaces leaves it out; its other workspace still works.
    const listed = await ok<{ workspaces: { id: string }[] }>(
      await f.client.request('/api/workspaces', bearer(token))
    );
    expect(listed.workspaces.map((w) => w.id)).toEqual([other.workspace.id]);
    // The signed-in session isn't affected.
    expect((await f.client.request(`/api/bases/${f.base.id}`)).status).toBe(200);
    // New tokens can't be granted the workspace or one of its bases.
    for (const grant of [{ workspaceIds: [f.workspace.id] }, { baseIds: [f.base.id] }]) {
      const created = await f.client.request(
        '/api/me/tokens',
        json('POST', {
          name: 'CI',
          scopes: ['data.records:read'],
          workspaceIds: [],
          baseIds: [],
          ...grant,
        })
      );
      expect(created.status).toBe(403);
      expect(await created.json()).toMatchObject({ code: 'POLICY_RESTRICTED' });
    }
    // Turned on again, the same token works at once.
    await setPolicies(f.workspace.id, { personalAccessTokens: true });
    expect((await v1(f.base.id)).status).toBe(200);
  });

  it('refuses new share links and stops the existing ones while share links are off', async () => {
    const f = await fixture();
    const viewLink = await ok<CreatedShare>(
      await f.client.request(`/api/views/${f.grid.id}/shares`, json('POST', {})),
      201
    );
    const baseLink = await ok<CreatedShare>(
      await f.client.request(`/api/bases/${f.base.id}/shares`, json('POST', {})),
      201
    );
    const visit = (token: string) => f.client.request(`/api/shared/${token}`);
    expect((await visit(viewLink.token)).status).toBe(200);

    await setPolicies(f.workspace.id, { shareLinks: false });
    for (const path of [`/api/views/${f.grid.id}/shares`, `/api/bases/${f.base.id}/shares`]) {
      const res = await f.client.request(path, json('POST', {}));
      expect(res.status, path).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'POLICY_RESTRICTED' });
    }
    expect((await visit(viewLink.token)).status).toBe(404);
    expect((await visit(baseLink.token)).status).toBe(404);
    // Owners still see and revoke them.
    const listed = await ok<{ shares: unknown[] }>(
      await f.client.request(`/api/views/${f.grid.id}/shares`)
    );
    expect(listed.shares).toHaveLength(1);
    // Form links are their own policy: still allowed.
    await ok(await f.client.request(`/api/views/${f.form.id}/shares`, json('POST', {})), 201);

    await setPolicies(f.workspace.id, { shareLinks: true });
    expect((await visit(viewLink.token)).status).toBe(200);
  });

  it('refuses new form links and closes the existing forms while public forms are off', async () => {
    const f = await fixture();
    const link = await ok<CreatedShare>(
      await f.client.request(`/api/views/${f.form.id}/shares`, json('POST', {})),
      201
    );
    const open = () => f.client.request(`/api/forms/${link.token}`);
    expect((await open()).status).toBe(200);
    await setPolicies(f.workspace.id, { publicForms: false });
    expect((await open()).status).toBe(404);
    const made = await f.client.request(`/api/views/${f.form.id}/shares`, json('POST', {}));
    expect(made.status).toBe(403);
    // View links are still allowed.
    await ok(await f.client.request(`/api/views/${f.grid.id}/shares`, json('POST', {})), 201);
  });

  it('refuses embed origins and frames nothing while embeds are off', async () => {
    const f = await fixture();
    const origins = { embedOrigins: ['https://intranet.example.com'] };
    const link = await ok<CreatedShare>(
      await f.client.request(`/api/views/${f.grid.id}/shares`, json('POST', origins)),
      201
    );
    expect(await shareEmbedAncestors(t.appDb, link.token)).toEqual([
      'https://intranet.example.com',
    ]);
    await setPolicies(f.workspace.id, { embeds: false });
    expect(await shareEmbedAncestors(t.appDb, link.token)).toEqual([]);
    // The link itself still opens; it just can't be framed.
    expect((await f.client.request(`/api/shared/${link.token}`)).status).toBe(200);
    const created = await f.client.request(`/api/views/${f.grid.id}/shares`, json('POST', origins));
    expect(created.status).toBe(403);
    const changed = await f.client.request(
      `/api/views/${f.grid.id}/shares/${link.share.id}`,
      json('PATCH', origins)
    );
    expect(changed.status).toBe(403);
    // Links without embed origins are still fine, and removing the origins is too.
    await ok(await f.client.request(`/api/views/${f.grid.id}/shares`, json('POST', {})), 201);
    await ok(
      await f.client.request(
        `/api/views/${f.grid.id}/shares/${link.share.id}`,
        json('PATCH', { embedOrigins: [] })
      )
    );
  });

  it('limits invitations to the allowed domains, also ones sent before', async () => {
    const f = await fixture();
    const invite = (path: string, email: string) =>
      f.client.request(path, json('POST', { email, role: 'editor' }));
    // Sent before the policy, to an address it then leaves out.
    const early = await createUser(t.db, { email: 'early@elsewhere.test' });
    await ok(await invite(`/api/workspaces/${f.workspace.id}/invitations`, early.email ?? ''), 201);
    const earlyToken = inviteToken(f.client.email.sent.at(-1));

    await setPolicies(f.workspace.id, { inviteDomains: ['acme.test'] });
    for (const path of [
      `/api/workspaces/${f.workspace.id}/invitations`,
      `/api/bases/${f.base.id}/invitations`,
    ]) {
      const refused = await invite(path, 'eve@elsewhere.test');
      expect(refused.status, path).toBe(403);
      expect(await refused.json()).toMatchObject({ code: 'POLICY_RESTRICTED' });
      expect((await invite(path, 'Ann@Acme.test')).status, path).toBe(201);
    }
    // A subdomain or look-alike isn't the domain.
    const lookAlike = await invite(
      `/api/workspaces/${f.workspace.id}/invitations`,
      'x@acme.test.evil.test'
    );
    expect(lookAlike.status).toBe(403);
    const earlyClient = await authedClient(t, early);
    const accepted = await earlyClient.request(
      `/api/invitations/${earlyToken}/accept`,
      json('POST')
    );
    expect(accepted.status).toBe(403);
    expect(await accepted.json()).toMatchObject({ code: 'POLICY_RESTRICTED' });
    const { rows } = await t.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM workspace_members
       WHERE workspace_id = ${f.workspace.id}::uuid AND user_id = ${early.id}::uuid`);
    expect(rows[0]?.n).toBe(0);
  });

  it('records when people last used the workspace, sessions and tokens alike', async () => {
    const f = await fixture();
    const editor = await addMember(t.db, f.workspace.id, 'editor');
    const activity = async (userId: string) => {
      const { rows } = await t.db.execute<{ at: Date | null }>(sql`
        SELECT last_active_at AS at FROM workspace_member_activity
         WHERE workspace_id = ${f.workspace.id}::uuid AND user_id = ${userId}::uuid`);
      return rows[0]?.at ?? null;
    };
    expect(await activity(f.owner.id)).not.toBeNull();
    expect(await activity(editor.id)).toBeNull();
    const { token } = await createToken(t.db, editor, { workspaceIds: [f.workspace.id] });
    expect(
      (await f.client.request(`/api/workspaces/${f.workspace.id}`, bearer(token))).status
    ).toBe(200);
    const first = await activity(editor.id);
    expect(first).not.toBeNull();
    // Within the interval, requests don't write again.
    await f.client.request(`/api/workspaces/${f.workspace.id}`, bearer(token));
    expect(await activity(editor.id)).toEqual(first);
    // Another workspace's activity is its own row, under RLS like any tenant table.
    await t.db.delete(workspaceMemberActivity);
    expect(await activity(f.owner.id)).toBeNull();
  });
});
