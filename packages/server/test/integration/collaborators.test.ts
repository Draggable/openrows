import type { Collaborator, FieldMeta, QueryRecordsResult, TableMeta } from '@openrows/shared';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { baseMembers, bases, type users } from '../../src/db/index.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, authedClient, createUser, createWorkspace } from '../helpers/factories.js';

type User = typeof users.$inferSelect;
type Client = Awaited<ReturnType<typeof authedClient>>;

/**
 * The collaborator directory as openrows_app: who each caller sees (members, base-only
 * collaborators of their bases, emails only for workspace members), tenant isolation, and the
 * query engine's user features: sort and group by name, `me` in filters, names in the CSV export.
 */
describe('collaborator directory', () => {
  const t = useTestDb();
  const origin = 'http://localhost:5173';
  let workspaceId: string;
  let owner: User;
  let editor: User;
  let commenter: User;
  let guestA: User;
  let guestB: User;
  let baseA: { id: string };
  let baseB: { id: string };
  let api: Client;

  const json = (client: Client, method: string, path: string, body?: unknown) =>
    client.request(path, {
      method,
      headers: { origin, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  async function ok<T>(res: Response, status = 200): Promise<T> {
    if (res.status !== status) throw new Error(`${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  const directory = async (client: Client, id = workspaceId) =>
    ok<{ collaborators: Collaborator[] }>(
      await json(client, 'GET', `/api/workspaces/${id}/collaborators`)
    );

  const addGuest = (baseId: string, user: User) =>
    t.db.insert(baseMembers).values({ workspaceId, baseId, userId: user.id, role: 'editor' });

  beforeAll(async () => {
    owner = await createUser(t.db, { name: 'Zoe Zed', email: 'zoe@example.test' });
    ({
      workspace: { id: workspaceId },
    } = await createWorkspace(t.db, { owner }));
    editor = await addMember(
      t.db,
      workspaceId,
      'editor',
      await createUser(t.db, { name: 'adam apple', email: 'adam@example.test' })
    );
    commenter = await addMember(
      t.db,
      workspaceId,
      'commenter',
      await createUser(t.db, { name: 'Mia Moss', email: 'mia@example.test' })
    );
    guestA = await createUser(t.db, { name: 'Gina Guest', email: 'gina@example.test' });
    guestB = await createUser(t.db, { name: null, email: 'bert@example.test' });
    api = await authedClient(t, owner);
    baseA = await ok(
      await json(api, 'POST', `/api/workspaces/${workspaceId}/bases`, { name: 'A' }),
      201
    );
    baseB = await ok(
      await json(api, 'POST', `/api/workspaces/${workspaceId}/bases`, { name: 'B' }),
      201
    );
    await addGuest(baseA.id, guestA);
    await addGuest(baseB.id, guestB);
  });

  it('lists members and every base-only collaborator, by name, with emails, to members', async () => {
    const { collaborators } = await directory(await authedClient(t, commenter));
    expect(collaborators.map((c) => c.name)).toEqual([
      'adam apple',
      'bert@example.test',
      'Gina Guest',
      'Mia Moss',
      'Zoe Zed',
    ]);
    const zoe = collaborators.find((c) => c.id === owner.id);
    expect(zoe).toMatchObject({ email: 'zoe@example.test', initials: 'ZZ' });
    expect(zoe?.color).toMatch(/^[a-z]+$/);
    expect(collaborators.find((c) => c.id === guestB.id)?.initials).toBe('B');
  });

  it("shows a base-only collaborator only their bases' people, without emails", async () => {
    const { collaborators } = await directory(await authedClient(t, guestA));
    expect(collaborators.map((c) => c.id).sort()).toEqual(
      [owner.id, editor.id, commenter.id, guestA.id].sort()
    );
    expect(collaborators.some((c) => c.id === guestB.id)).toBe(false);
    expect(collaborators.every((c) => c.email === undefined)).toBe(true);
  });

  it('names an email-only user "Collaborator" to callers who may not see emails', async () => {
    const both = await createUser(t.db, { name: 'Both Bases' });
    await addGuest(baseA.id, both);
    await addGuest(baseB.id, both);
    const { collaborators } = await directory(await authedClient(t, both));
    expect(collaborators.find((c) => c.id === guestB.id)).toEqual({
      id: guestB.id,
      name: 'Collaborator',
      initials: 'C',
      color: expect.any(String),
    });
  });

  it('answers 404 to other tenants, collaborators of trashed bases and malformed ids', async () => {
    const stranger = await createUser(t.db);
    const other = await createWorkspace(t.db, { owner: stranger });
    const strangerApi = await authedClient(t, stranger);
    expect(
      (await json(strangerApi, 'GET', `/api/workspaces/${workspaceId}/collaborators`)).status
    ).toBe(404);
    // Their own directory never lists this workspace's people.
    const own = await directory(strangerApi, other.workspace.id);
    expect(own.collaborators.map((c) => c.id)).toEqual([stranger.id]);

    const trashedGuest = await createUser(t.db);
    const [trashed] = await t.db
      .insert(bases)
      .values({
        workspaceId,
        name: 'Old',
        dbSchema: 'b_trashed00000000000000000000000000',
        deletedAt: new Date(),
      })
      .returning();
    if (!trashed) throw new Error('no base');
    await addGuest(trashed.id, trashedGuest);
    const trashedApi = await authedClient(t, trashedGuest);
    expect(
      (await json(trashedApi, 'GET', `/api/workspaces/${workspaceId}/collaborators`)).status
    ).toBe(404);
    expect((await json(api, 'GET', '/api/workspaces/not-a-uuid/collaborators')).status).toBe(404);
    await t.db.delete(baseMembers).where(eq(baseMembers.baseId, trashed.id));
  });

  describe('user fields in queries', () => {
    let table: TableMeta;
    let createdBy: FieldMeta;
    let name: FieldMeta;

    beforeAll(async () => {
      table = await ok(
        await json(api, 'POST', `/api/bases/${baseA.id}/tables`, { name: 'People' }),
        201
      );
      createdBy = await ok(
        await json(api, 'POST', `/api/tables/${table.id}/fields`, {
          name: 'Author',
          type: 'createdBy',
        }),
        201
      );
      name = table.fields.find((f) => f.isPrimary) as FieldMeta;
      // Zoe (owner), adam (editor) and Gina (base-only editor) each create records.
      const writers: [User, string[]][] = [
        [owner, ['z1', 'z2']],
        [editor, ['a1']],
        [guestA, ['g1']],
      ];
      for (const [user, names] of writers) {
        const client = await authedClient(t, user);
        await ok(
          await json(client, 'POST', `/api/tables/${table.id}/records`, {
            records: names.map((n) => ({ fields: { [name.id]: n } })),
          }),
          201
        );
      }
    });

    const run = async (client: Client, body: Record<string, unknown>) =>
      ok<QueryRecordsResult>(
        await json(client, 'POST', `/api/tables/${table.id}/records/query`, body)
      );
    const names = (r: QueryRecordsResult) => r.records.map((x) => x.fields[name.id]);

    it('sorts by created by on the name, ignoring case', async () => {
      const asc = await run(api, {
        query: { sorts: [{ fieldId: createdBy.id, direction: 'asc' }] },
      });
      expect(names(asc)).toEqual(['a1', 'g1', 'z1', 'z2']);
      const desc = await run(api, {
        query: { sorts: [{ fieldId: createdBy.id, direction: 'desc' }] },
      });
      expect(names(desc)).toEqual(['z1', 'z2', 'g1', 'a1']);
      // Keyset pages follow the same order.
      const first = await run(api, {
        query: { sorts: [{ fieldId: createdBy.id, direction: 'asc' }] },
        limit: 2,
      });
      const second = await run(api, {
        query: { sorts: [{ fieldId: createdBy.id, direction: 'asc' }] },
        limit: 2,
        cursor: first.nextCursor,
      });
      expect([...names(first), ...names(second)]).toEqual(['a1', 'g1', 'z1', 'z2']);
    });

    it('groups by created by in name order', async () => {
      const r = await run(api, {
        query: { groupBy: [{ fieldId: createdBy.id, direction: 'asc' }] },
        groups: true,
      });
      expect(r.groups?.map((g) => [g.key[0], g.count])).toEqual([
        [editor.id, 1],
        [guestA.id, 1],
        [owner.id, 2],
      ]);
    });

    it('filters `is me`, `isAnyOf` and `isNoneOf` with the signed-in user', async () => {
      const filter = (operator: string, value: unknown) => ({
        query: { filter: { conditions: [{ fieldId: createdBy.id, operator, value }] } },
      });
      expect(names(await run(api, filter('is', 'me')))).toEqual(['z1', 'z2']);
      const editorApi = await authedClient(t, editor);
      expect(names(await run(editorApi, filter('is', 'me')))).toEqual(['a1']);
      expect(names(await run(editorApi, filter('isAnyOf', ['me', guestA.id])))).toEqual([
        'a1',
        'g1',
      ]);
      expect(names(await run(api, filter('isNoneOf', ['me'])))).toEqual(['a1', 'g1']);
      // A saved view keeps `me`, so it means whoever looks at it.
      const view = await ok<{ id: string }>(
        await json(api, 'POST', `/api/tables/${table.id}/views`, { name: 'Mine', type: 'grid' }),
        201
      );
      await ok(
        await json(api, 'PATCH', `/api/views/${view.id}`, {
          query: {
            filter: { conditions: [{ fieldId: createdBy.id, operator: 'is', value: 'me' }] },
          },
        })
      );
      expect(names(await run(editorApi, { viewId: view.id }))).toEqual(['a1']);
      expect(
        (await json(api, 'POST', `/api/tables/${table.id}/records/query`, filter('is', 'you')))
          .status
      ).toBe(422);
    });

    it('writes display names for user cells in the CSV export', async () => {
      const res = await api.request(
        `/api/tables/${table.id}/export.csv?query=${encodeURIComponent(
          JSON.stringify({ sorts: [{ fieldId: createdBy.id, direction: 'asc' }] })
        )}`
      );
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('a1,');
      const lines = text.trim().split(/\r?\n/);
      expect(lines.at(1)).toContain('adam apple');
      expect(lines.at(2)).toContain('Gina Guest');
      expect(lines.at(-1)).toContain('Zoe Zed');
    });
  });
});
