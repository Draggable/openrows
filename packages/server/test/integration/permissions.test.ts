import {
  type EditPermission,
  type FieldMeta,
  type ImportJob,
  type LinkOptions,
  permissionAllows,
  type RecordData,
  type TableMeta,
  type UserRole,
} from '@openrows/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { baseMembers, type users } from '../../src/db/index.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, createSession, createUser, createWorkspace } from '../helpers/factories.js';

type User = typeof users.$inferSelect;

/**
 * Table and field edit permissions through the API as openrows_app: for every role and
 * every restriction, each record write path (create, update, bulk update, typecast, CSV import,
 * the inverse side of a link, delete and restore) is allowed or refused as
 * `permissionAllows` says; a refusal is a 403 EDIT_RESTRICTED naming the field and writes
 * nothing. Commenters and read-only users never write (403 FORBIDDEN at the route).
 */
describe('edit permissions', () => {
  const t = useTestDb();
  let app: ReturnType<typeof testApp>;
  let workspaceId: string;
  /** Who writes: each workspace role, a listed editor and a base-level editor override. */
  type ActorName =
    | 'owner'
    | 'creator'
    | 'editor'
    | 'commenter'
    | 'read_only'
    | 'listedEditor'
    | 'baseEditor';
  type Actor = { user: User; role: UserRole; cookie: string };
  const actors = {} as Record<ActorName, Actor>;
  let ownerCookie: string;

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
    if (res.status !== status) throw new Error(`${res.status}: ${await res.text()}`);
    return (status === 204 ? undefined : await res.json()) as T;
  }

  const fieldOf = (table: TableMeta, name: string): FieldMeta => {
    const f = table.fields.find((x) => x.name === name);
    if (!f) throw new Error(`no field ${name}`);
    return f;
  };
  const records = (tableId: string) => `/api/tables/${tableId}/records`;

  /** A base with Tasks (Name, Budget, Projects → Projects) and Projects (Name, Tasks inverse). */
  async function world() {
    const base = await ok<{ id: string }>(
      await request('POST', `/api/workspaces/${workspaceId}/bases`, { name: 'Base' }),
      201
    );
    // The base override: a read-only workspace member who edits in this base.
    await t.db.insert(baseMembers).values({
      workspaceId,
      baseId: base.id,
      userId: actors.baseEditor.user.id,
      role: 'editor',
    });
    const newTable = async (name: string) =>
      ok<TableMeta>(await request('POST', `/api/bases/${base.id}/tables`, { name }), 201);
    const projects = await newTable('Projects');
    const tasks = await newTable('Tasks');
    const budget = await ok<FieldMeta>(
      await request('POST', `/api/tables/${tasks.id}/fields`, { name: 'Budget', type: 'number' }),
      201
    );
    const link = await ok<FieldMeta>(
      await request('POST', `/api/tables/${tasks.id}/fields`, {
        name: 'Projects',
        type: 'link',
        options: { linkedTableId: projects.id },
      }),
      201
    );
    const inverseId = (link.options as LinkOptions).inverseLinkFieldId as string;
    const project = await ok<RecordData>(
      await request('POST', records(projects.id), {
        fields: { [fieldOf(projects, 'Name').id]: 'Alpha' },
      }),
      201
    );
    const seeded = await ok<{ records: RecordData[] }>(
      await request('POST', records(tasks.id), {
        records: [{ fields: {} }, { fields: {} }, { fields: {} }],
      }),
      201
    );
    return { base, projects, tasks, budget, link, inverseId, project, rows: seeded.records };
  }

  const setField = (fieldId: string, edit: EditPermission) =>
    request('PATCH', `/api/fields/${fieldId}`, { permissions: { edit } });
  const setTable = (tableId: string, permissions: Record<string, EditPermission>) =>
    request('PATCH', `/api/tables/${tableId}`, { permissions });

  beforeAll(async () => {
    const { workspace, owner } = await createWorkspace(t.db);
    workspaceId = workspace.id;
    app = testApp({ db: t.appDb });
    ownerCookie = await createSession(t.db, owner);
    actors.owner = { user: owner, role: 'owner', cookie: ownerCookie };
    for (const role of ['creator', 'editor', 'commenter', 'read_only'] as const) {
      const user = await addMember(t.db, workspaceId, role);
      actors[role] = { user, role, cookie: await createSession(t.db, user) };
    }
    const listed = await addMember(t.db, workspaceId, 'editor');
    actors.listedEditor = {
      user: listed,
      role: 'editor',
      cookie: await createSession(t.db, listed),
    };
    const baseEditor = await addMember(t.db, workspaceId, 'read_only');
    actors.baseEditor = {
      user: baseEditor,
      role: 'editor',
      cookie: await createSession(t.db, baseEditor),
    };
  });

  /** The restrictions every matrix runs through (`specific` lists the listed editor). */
  const restrictions = (): EditPermission[] => [
    { level: 'editors' },
    { level: 'creators' },
    { level: 'specific', userIds: [actors.listedEditor.user.id], roles: [] },
    { level: 'specific', userIds: [], roles: ['owner'] },
    { level: 'nobody' },
  ];

  /** The status a write by `actor` gets under `permission`: route role first, then the rule. */
  function expected(actor: { user: User; role: UserRole }, permission: EditPermission, ok: number) {
    if (actor.role === 'commenter' || actor.role === 'read_only') return 403;
    return permissionAllows(permission, { role: actor.role, userId: actor.user.id }) ? ok : 403;
  }

  it('enforces field permissions on create, update, bulk, typecast, import and link inverse', async () => {
    const w = await world();
    const names = Object.keys(actors) as ActorName[];
    const outcomes: string[] = [];
    const wanted: string[] = [];
    for (const permission of restrictions()) {
      await ok(await setField(w.budget.id, permission));
      await ok(await setField(w.inverseId, permission));
      for (const name of names) {
        const actor = actors[name];
        const tag = `${permission.level}${'roles' in permission ? permission.roles.join('') : ''}/${name}`;
        const check = async (path: string, res: Response, okStatus: number) => {
          const want = expected(actor, permission, okStatus);
          outcomes.push(`${tag}/${path}: ${res.status}`);
          wanted.push(`${tag}/${path}: ${want}`);
          if (res.status === 403 && actor.role !== 'commenter' && actor.role !== 'read_only') {
            const body = (await res.json()) as {
              code: string;
              fieldIds?: string[];
              detail: string;
            };
            expect(body.code).toBe('EDIT_RESTRICTED');
            expect(body.detail).toMatch(/Budget|Tasks/);
          }
        };
        const row = w.rows[0] as RecordData;
        const other = w.rows[1] as RecordData;
        await check(
          'create',
          await request(
            'POST',
            records(w.tasks.id),
            { fields: { [w.budget.id]: 1 } },
            actor.cookie
          ),
          201
        );
        await check(
          'update',
          await request(
            'PATCH',
            `${records(w.tasks.id)}/${row.id}`,
            { fields: { [w.budget.id]: 2 } },
            actor.cookie
          ),
          200
        );
        await check(
          'bulk',
          await request(
            'PATCH',
            records(w.tasks.id),
            {
              records: [
                { id: row.id, fields: { [w.budget.id]: 3 } },
                { id: other.id, fields: { [w.budget.id]: 4 } },
              ],
            },
            actor.cookie
          ),
          200
        );
        await check(
          'typecast',
          await request(
            'PATCH',
            records(w.tasks.id),
            { typecast: true, records: [{ id: row.id, fields: { [w.budget.id]: '5' } }] },
            actor.cookie
          ),
          200
        );
        // The Projects link writes the inverse "Tasks" field of Projects, restricted the same.
        await check(
          'link inverse',
          await request(
            'PATCH',
            `${records(w.tasks.id)}/${other.id}`,
            { fields: { [w.link.id]: [w.project.id] } },
            actor.cookie
          ),
          200
        );
        const imported = await request(
          'POST',
          `/api/tables/${w.tasks.id}/imports`,
          { csv: 'Budget\n7\n', columns: [{ index: 0, fieldId: w.budget.id }] },
          actor.cookie
        );
        // Run it, as the worker would: one import per table runs at a time.
        if (imported.status === 201) {
          await app.runJob(((await imported.clone().json()) as ImportJob).id);
        }
        await check('import', imported, 201);
      }
    }
    expect(outcomes).toEqual(wanted);
    // Something of each kind happened.
    expect(outcomes.some((o) => o.endsWith('403'))).toBe(true);
    expect(outcomes.some((o) => o.endsWith('200'))).toBe(true);
  });

  it('a refused write names the field and writes nothing, not even the allowed cells', async () => {
    const w = await world();
    await ok(await setField(w.budget.id, { level: 'creators' }));
    const editor = actors.editor as { cookie: string };
    const row = w.rows[0] as RecordData;
    const name = fieldOf(w.tasks, 'Name').id;
    const res = await request(
      'PATCH',
      `${records(w.tasks.id)}/${row.id}`,
      { fields: { [name]: 'Renamed', [w.budget.id]: 9 } },
      editor.cookie
    );
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = (await res.json()) as {
      code: string;
      detail: string;
      fieldIds: string[];
      errors: { path: string; message: string }[];
    };
    expect(body).toMatchObject({
      code: 'EDIT_RESTRICTED',
      detail: `You don't have permission to edit "Budget".`,
      fieldIds: [w.budget.id],
      errors: [{ path: `records.0.fields.${w.budget.id}` }],
    });
    const after = await ok<RecordData>(
      await request('GET', `${records(w.tasks.id)}/${row.id}`, undefined, editor.cookie)
    );
    expect(after.fields[name]).toBeNull();
    // The unrestricted cell alone is fine, and the editor still reads the restricted one.
    await ok(
      await request(
        'PATCH',
        `${records(w.tasks.id)}/${row.id}`,
        { fields: { [name]: 'Renamed' } },
        editor.cookie
      )
    );
    expect(after.fields).toHaveProperty(w.budget.id);
  });

  it('enforces table permissions: add, delete and restore, edit', async () => {
    const w = await world();
    const name = fieldOf(w.tasks, 'Name').id;
    const outcomes: string[] = [];
    const wanted: string[] = [];
    const editors = { level: 'editors' } as const;
    for (const permission of restrictions()) {
      // One record per actor to delete, made while nothing is restricted.
      await ok(
        await setTable(w.tasks.id, {
          addRecords: editors,
          deleteRecords: editors,
          editRecords: editors,
        })
      );
      const victims = await ok<{ records: RecordData[] }>(
        await request('POST', records(w.tasks.id), {
          records: Object.keys(actors).map(() => ({ fields: {} })),
        }),
        201
      );
      await ok(
        await setTable(w.tasks.id, {
          addRecords: permission,
          deleteRecords: permission,
          editRecords: permission,
        })
      );
      for (const [i, [who, actor]] of Object.entries(actors).entries()) {
        const tag = `${permission.level}/${who}`;
        const record = (path: string, res: Response, status: number) => {
          outcomes.push(`${tag}/${path}: ${res.status}`);
          wanted.push(`${tag}/${path}: ${expected(actor, permission, status)}`);
        };
        record(
          'create',
          await request('POST', records(w.tasks.id), { fields: {} }, actor.cookie),
          201
        );
        record(
          'edit',
          await request(
            'PATCH',
            `${records(w.tasks.id)}/${(w.rows[2] as RecordData).id}`,
            { fields: { [name]: who } },
            actor.cookie
          ),
          200
        );
        record(
          'delete',
          await request(
            'POST',
            `${records(w.tasks.id)}/delete`,
            { recordIds: [victims.records[i]?.id] },
            actor.cookie
          ),
          200
        );
      }
    }
    expect(outcomes).toEqual(wanted);
  });

  it('separates add, edit and delete, and checks restore and typecast-created linked records', async () => {
    const w = await world();
    const editor = actors.editor as { cookie: string };
    const name = fieldOf(w.tasks, 'Name').id;
    // Editors may add records but not edit them: a new record with values is fine.
    await ok(await setTable(w.tasks.id, { editRecords: { level: 'creators' } }));
    await ok(
      await request('POST', records(w.tasks.id), { fields: { [name]: 'New' } }, editor.cookie),
      201
    );
    const edit = await request(
      'PATCH',
      `${records(w.tasks.id)}/${(w.rows[0] as RecordData).id}`,
      { fields: { [name]: 'Edited' } },
      editor.cookie
    );
    expect(edit.status).toBe(403);
    // An empty patch changes nothing and isn't refused.
    await ok(
      await request(
        'PATCH',
        `${records(w.tasks.id)}/${(w.rows[0] as RecordData).id}`,
        { fields: {} },
        editor.cookie
      )
    );
    // The other keys stay when one is changed.
    const table = await ok<TableMeta>(
      await setTable(w.tasks.id, { deleteRecords: { level: 'creators' } })
    );
    expect(table.permissions).toEqual({
      addRecords: { level: 'editors' },
      deleteRecords: { level: 'creators' },
      editRecords: { level: 'creators' },
    });
    const del = await request(
      'POST',
      `${records(w.tasks.id)}/delete`,
      { recordIds: [(w.rows[1] as RecordData).id] },
      editor.cookie
    );
    expect(del.status).toBe(403);
    await ok(
      await request('POST', `${records(w.tasks.id)}/delete`, {
        recordIds: [(w.rows[1] as RecordData).id],
      })
    );
    const restore = await request(
      'POST',
      `${records(w.tasks.id)}/restore`,
      { recordIds: [(w.rows[1] as RecordData).id] },
      editor.cookie
    );
    expect(restore.status).toBe(403);

    // Typecast names that create Projects records need Projects' addRecords.
    await ok(await setTable(w.tasks.id, { editRecords: { level: 'editors' } }));
    await ok(await setTable(w.projects.id, { addRecords: { level: 'nobody' } }));
    const creator = actors.creator as { cookie: string };
    const typecast = await request(
      'PATCH',
      records(w.tasks.id),
      {
        typecast: true,
        records: [{ id: (w.rows[2] as RecordData).id, fields: { [w.link.id]: 'Zeta' } }],
      },
      creator.cookie
    );
    expect(typecast.status).toBe(403);
    expect(((await typecast.json()) as { detail: string }).detail).toContain('"Projects"');
  });

  it('refuses an import up front naming the field, and fails a running one that loses the right', async () => {
    const w = await world();
    await ok(await setField(w.budget.id, { level: 'nobody' }));
    const res = await request('POST', `/api/tables/${w.tasks.id}/imports`, {
      csv: 'Budget\n1\n',
      columns: [{ index: 0, fieldId: w.budget.id }],
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: 'EDIT_RESTRICTED',
      fieldIds: [w.budget.id],
      errors: [{ path: 'columns.0.fieldId' }],
    });
    await ok(await setTable(w.tasks.id, { addRecords: { level: 'creators' } }));
    const editor = actors.editor as { cookie: string };
    const add = await request(
      'POST',
      `/api/tables/${w.tasks.id}/imports`,
      { csv: 'Name\nA\n', columns: [{ index: 0, fieldId: fieldOf(w.tasks, 'Name').id }] },
      editor.cookie
    );
    expect(add.status).toBe(403);
    // Allowed for the creator; the job runs under the same check.
    const job = await ok<ImportJob>(
      await request(
        'POST',
        `/api/tables/${w.tasks.id}/imports`,
        { csv: 'Name\nA\n', columns: [{ index: 0, fieldId: fieldOf(w.tasks, 'Name').id }] },
        actors.creator.cookie
      ),
      201
    );
    await app.runJob(job.id);
    const done = await ok<ImportJob>(
      await request(
        'GET',
        `/api/tables/${w.tasks.id}/imports/${job.id}`,
        undefined,
        actors.creator.cookie
      )
    );
    expect(done.status).toBe('done');
  });

  it('commenters read every field but write nothing', async () => {
    const w = await world();
    const commenter = actors.commenter as { cookie: string };
    const row = w.rows[0] as RecordData;
    const read = await ok<RecordData>(
      await request('GET', `${records(w.tasks.id)}/${row.id}`, undefined, commenter.cookie)
    );
    expect(read.fields).toHaveProperty(w.budget.id);
    const writes = [
      request('POST', records(w.tasks.id), { fields: {} }, commenter.cookie),
      request(
        'PATCH',
        `${records(w.tasks.id)}/${row.id}`,
        { fields: { [w.budget.id]: 1 } },
        commenter.cookie
      ),
      request('POST', `${records(w.tasks.id)}/delete`, { recordIds: [row.id] }, commenter.cookie),
      request(
        'POST',
        `/api/tables/${w.tasks.id}/imports`,
        { csv: 'Budget\n1\n', columns: [{ index: 0, fieldId: w.budget.id }] },
        commenter.cookie
      ),
    ];
    for (const res of await Promise.all(writes)) expect(res.status).toBe(403);
    // Even when a specific permission names them.
    const user = actors.commenter.user;
    await ok(await setField(w.budget.id, { level: 'specific', userIds: [user.id], roles: [] }));
    const listed = await request(
      'PATCH',
      `${records(w.tasks.id)}/${row.id}`,
      { fields: { [w.budget.id]: 1 } },
      commenter.cookie
    );
    expect(listed.status).toBe(403);
  });

  it('only creators set permissions, and only for collaborators of the base', async () => {
    const w = await world();
    for (const who of ['editor', 'commenter', 'read_only', 'baseEditor'] as const) {
      const cookie = actors[who].cookie;
      const field = await request(
        'PATCH',
        `/api/fields/${w.budget.id}`,
        { permissions: { edit: { level: 'nobody' } } },
        cookie
      );
      expect(field.status).toBe(403);
      const table = await request(
        'PATCH',
        `/api/tables/${w.tasks.id}`,
        { permissions: { addRecords: { level: 'nobody' } } },
        cookie
      );
      expect(table.status).toBe(403);
    }
    const creator = actors.creator.cookie;
    const set = await ok<FieldMeta>(
      await request(
        'PATCH',
        `/api/fields/${w.budget.id}`,
        { permissions: { edit: { level: 'creators' } } },
        creator
      )
    );
    expect(set.permissions).toEqual({ edit: { level: 'creators' } });
    const read = await ok<TableMeta>(
      await request('GET', `/api/tables/${w.tasks.id}`, undefined, actors.editor.cookie)
    );
    expect(fieldOf(read, 'Budget').permissions).toEqual({ edit: { level: 'creators' } });
    expect(fieldOf(read, 'Name').permissions).toEqual({ edit: { level: 'editors' } });

    // Someone from another workspace (or nobody at all) can't be listed.
    const stranger = await createUser(t.db);
    const { owner: otherOwner } = await createWorkspace(t.db);
    for (const id of [stranger.id, otherOwner.id, '0190a000-0000-7000-8000-000000000000']) {
      const res = await request('PATCH', `/api/fields/${w.budget.id}`, {
        permissions: { edit: { level: 'specific', userIds: [id] } },
      });
      expect(res.status).toBe(422);
    }
    // At most 100 people, and only known levels and roles.
    const many = Array.from(
      { length: 101 },
      (_, i) => `0190a000-0000-7000-8000-${String(i).padStart(12, '0')}`
    );
    for (const edit of [
      { level: 'specific', userIds: many },
      { level: 'everyone' },
      { level: 'specific', roles: ['commenter'] },
    ]) {
      const res = await request('PATCH', `/api/fields/${w.budget.id}`, { permissions: { edit } });
      expect(res.status).toBe(422);
    }
    // A base collaborator (the base-level editor) can be listed.
    const baseEditor = actors.baseEditor.user;
    await ok(
      await request('PATCH', `/api/fields/${w.budget.id}`, {
        permissions: { edit: { level: 'specific', userIds: [baseEditor.id] } },
      })
    );
  });
});
