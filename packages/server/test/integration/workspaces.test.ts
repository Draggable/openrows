import { BaseListSchema, BaseSchema, WorkspaceListSchema, WorkspaceSchema } from '@openrows/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { baseMembers, bases } from '../../src/db/index.js';
import { useTestDb } from '../helpers/db.js';
import {
  addMember,
  authedClient,
  createBase,
  createUser,
  createWorkspace,
} from '../helpers/factories.js';

const ORIGIN = 'http://localhost:5173';
const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { origin: ORIGIN, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('workspace and base routes', () => {
  const t = useTestDb();

  it('creates a workspace owned by the caller and lists only the caller’s workspaces', async () => {
    const user = await createUser(t.db);
    await createWorkspace(t.db); // someone else's
    const client = await authedClient(t, user);

    const created = await client.request('/api/workspaces', json({ name: '  Acme  ' }));
    expect(created.status).toBe(201);
    const workspace = WorkspaceSchema.parse(await created.json());
    expect(workspace).toMatchObject({ name: 'Acme', role: 'owner' });

    const list = WorkspaceListSchema.parse(await (await client.request('/api/workspaces')).json());
    expect(list.workspaces.map((w) => [w.id, w.role])).toEqual([[workspace.id, 'owner']]);

    const renamed = await client.request(
      `/api/workspaces/${workspace.id}`,
      json({ name: 'Acme Inc' }, 'PATCH')
    );
    expect(WorkspaceSchema.parse(await renamed.json()).name).toBe('Acme Inc');
  });

  it('creates bases in a workspace and lists them with the caller’s effective role', async () => {
    const { workspace, owner } = await createWorkspace(t.db);
    const creator = await addMember(t.db, workspace.id, 'creator');
    const client = await authedClient(t, creator);

    const res = await client.request(
      `/api/workspaces/${workspace.id}/bases`,
      json({ name: 'CRM', color: '#336699' })
    );
    expect(res.status).toBe(201);
    const base = BaseSchema.parse(await res.json());
    expect(base).toMatchObject({ name: 'CRM', workspaceId: workspace.id, role: 'creator' });
    const [row] = await t.db.select().from(bases).where(eq(bases.id, base.id));
    expect(row).toMatchObject({
      createdBy: creator.id,
      dbSchema: `b_${base.id.replaceAll('-', '')}`,
    });

    // A base role never lowers the workspace role (the higher one wins); the owner stays
    // owner.
    await t.db.insert(baseMembers).values({
      workspaceId: workspace.id,
      baseId: base.id,
      userId: creator.id,
      role: 'read_only',
    });
    const list = BaseListSchema.parse(
      await (await client.request(`/api/workspaces/${workspace.id}/bases`)).json()
    );
    expect(list.bases.map((b) => b.role)).toEqual(['creator']);
    const ownerClient = await authedClient(t, owner);
    const asOwner = BaseSchema.parse(
      await (await ownerClient.request(`/api/bases/${base.id}`)).json()
    );
    expect(asOwner.role).toBe('owner');
  });

  it('lets a base-only collaborator into the base and nothing else in the workspace', async () => {
    const { workspace } = await createWorkspace(t.db);
    const base = await createBase(t.db, workspace.id);
    const sibling = await createBase(t.db, workspace.id);
    const guest = await createUser(t.db);
    await t.db
      .insert(baseMembers)
      .values({ workspaceId: workspace.id, baseId: base.id, userId: guest.id, role: 'editor' });
    const client = await authedClient(t, guest);

    const res = await client.request(`/api/bases/${base.id}`);
    expect(res.status).toBe(200);
    expect(BaseSchema.parse(await res.json()).role).toBe('editor');
    expect((await client.request(`/api/bases/${sibling.id}`)).status).toBe(404);
    expect((await client.request(`/api/workspaces/${workspace.id}`)).status).toBe(404);
    // The workspace's base list shows them their base only.
    const list = BaseListSchema.parse(
      await (await client.request(`/api/workspaces/${workspace.id}/bases`)).json()
    );
    expect(list.bases.map((b) => b.id)).toEqual([base.id]);
  });

  it('answers 404 for trashed bases and malformed ids, 400 and 422 for bad bodies', async () => {
    const { workspace, owner } = await createWorkspace(t.db);
    const base = await createBase(t.db, workspace.id, { deletedAt: new Date() });
    const client = await authedClient(t, owner);
    expect((await client.request(`/api/bases/${base.id}`)).status).toBe(404);
    expect((await client.request('/api/bases/not-a-uuid')).status).toBe(404);

    const notJson = await client.request('/api/workspaces', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: '{',
    });
    expect(notJson.status).toBe(400);
    expect((await client.request('/api/workspaces', json({ name: '' }))).status).toBe(422);
  });
});
