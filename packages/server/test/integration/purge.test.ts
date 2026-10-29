import type { TableMeta } from '@openrows/shared';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { qualified } from '../../src/data/columns.js';
import { personalAccessTokens, tables, type users, workspaceMembers } from '../../src/db/index.js';
import { createLogger } from '../../src/lib/logger.js';
import type { IdentityAdmin } from '../../src/purge/identity.js';
import { purgeDeleted, purgeExpiredTrash } from '../../src/purge/service.js';
import { takeSnapshot } from '../../src/snapshots/writer.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import {
  addMember,
  createReadyAttachment,
  createSession,
  createToken,
  createUser,
  createWorkspace,
} from '../helpers/factories.js';
import { MemoryObjectStore } from '../helpers/object-store.js';

/**
 * Hard deletion: after "Delete account" and the purge job, no row of any tenant table
 * names the deleted workspace, no row anywhere names the deleted user, no stored object is left
 * under the workspace's prefixes, and the provider's user is deleted; trash past 30 days goes.
 */
const t = useTestDb();
const logger = createLogger({ level: process.env['PURGE_DEBUG'] ? 'debug' : 'silent' });
const store = new MemoryObjectStore();
let app: ReturnType<typeof testApp>;
type User = typeof users.$inferSelect;

beforeAll(() => {
  app = testApp({ db: t.appDb, objectStore: store });
});

const call = (cookie: string, method: string, path: string, body?: unknown) =>
  app.app.request(path, {
    method,
    headers: {
      origin: app.config.appUrl,
      cookie: `${SESSION_COOKIE}=${cookie}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  if (r.status !== status) throw new Error(`${r.status}: ${await r.text()}`);
  return (await r.json()) as T;
}

/** A session that signed in just now (a fresh `auth_time`). */
async function recentSession(user: User): Promise<string> {
  const cookie = await createSession(t.db, user);
  await t.db.execute(sql`UPDATE sessions SET authenticated_at = now() WHERE user_id = ${user.id}`);
  return cookie;
}

/** A base with a table, a record, a comment, a stored file and a snapshot, as `cookie`. */
async function fill(cookie: string, workspaceId: string, owner: User) {
  const base = await ok<{ id: string }>(
    call(cookie, 'POST', `/api/workspaces/${workspaceId}/bases`, { name: 'Base' }),
    201
  );
  const table = await ok<TableMeta>(
    call(cookie, 'POST', `/api/bases/${base.id}/tables`, { name: 'Tasks' }),
    201
  );
  const record = await ok<{ id: string }>(
    call(cookie, 'POST', `/api/tables/${table.id}/records`, {
      fields: { [table.fields[0]?.id ?? '']: 'Hello' },
    }),
    201
  );
  await ok(
    call(cookie, 'POST', `/api/tables/${table.id}/records/${record.id}/comments`, {
      body: 'A note',
    }),
    201
  );
  const field = await ok<{ id: string }>(
    call(cookie, 'POST', `/api/tables/${table.id}/fields`, { name: 'Files', type: 'attachment' }),
    201
  );
  const file = await createReadyAttachment(
    t.db,
    { workspaceId, baseId: base.id, tableId: table.id, fieldId: field.id },
    { filename: 'a.txt', type: 'text/plain', size: 3 }
  );
  await store.put(`ws/${workspaceId}/b/${base.id}/t/${table.id}/${file.id}`, new Uint8Array(3));
  await takeSnapshot(t.appDb, store, {
    workspaceId,
    baseId: base.id,
    userId: owner.id,
    kind: 'manual',
  });
  return { base, table, record };
}

/** Every (table, column) of `public` with a uuid or uuid[] column. */
async function uuidColumns() {
  const { rows } = await t.db.execute<{
    table_name: string;
    column_name: string;
    is_array: boolean;
  }>(
    sql`SELECT c.table_name, c.column_name, c.data_type = 'ARRAY' AS is_array
          FROM information_schema.columns c
          JOIN information_schema.tables x
            ON x.table_schema = c.table_schema AND x.table_name = c.table_name
         WHERE c.table_schema = 'public' AND x.table_type = 'BASE TABLE'
           AND (c.udt_name = 'uuid' OR c.udt_name = '_uuid')`
  );
  return rows;
}

/** Rows of any public table whose uuid columns name `id`, as `table.column` → count. */
async function rowsNaming(id: string): Promise<Record<string, number>> {
  const found: Record<string, number> = {};
  for (const c of await uuidColumns()) {
    const col = sql.identifier(c.column_name);
    const where = c.is_array ? sql`${id}::uuid = ANY(${col})` : sql`${col} = ${id}::uuid`;
    const { rows } = await t.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(c.table_name)} WHERE ${where}`
    );
    const n = rows[0]?.n ?? 0;
    if (n > 0) found[`${c.table_name}.${c.column_name}`] = n;
  }
  return found;
}

/** Rows of every table with a `workspace_id` column that belong to `workspaceId`. */
async function tenantRows(workspaceId: string): Promise<Record<string, number>> {
  const { rows: cols } = await t.db.execute<{ table_name: string }>(
    sql`SELECT c.table_name FROM information_schema.columns c
          JOIN information_schema.tables x
            ON x.table_schema = c.table_schema AND x.table_name = c.table_name
         WHERE c.table_schema = 'public' AND c.column_name = 'workspace_id'
           AND x.table_type = 'BASE TABLE'`
  );
  expect(cols.length).toBeGreaterThan(20);
  const found: Record<string, number> = {};
  for (const { table_name: name } of cols) {
    const { rows } = await t.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(name)} WHERE workspace_id = ${workspaceId}`
    );
    if ((rows[0]?.n ?? 0) > 0) found[name] = rows[0]?.n ?? 0;
  }
  return found;
}

const keysUnder = (workspaceId: string) =>
  [...store.objects.keys()].filter(
    (k) => k.startsWith(`ws/${workspaceId}/`) || k.startsWith(`snapshots/ws/${workspaceId}/`)
  );

function fakeIdentity() {
  const deleted: { issuer: string; subject: string }[] = [];
  const identity: IdentityAdmin = {
    async deleteUser(issuer, subject) {
      deleted.push({ issuer, subject });
      return 'deleted';
    },
  };
  return { identity, deleted };
}

describe('POST /api/me/delete', () => {
  it('needs the email typed again and a recent sign-in', async () => {
    const { owner } = await createWorkspace(t.db);
    const stale = await createSession(t.db, owner);
    const old = await call(stale, 'POST', '/api/me/delete', { confirmEmail: owner.email });
    expect(old.status).toBe(403);
    expect(((await old.json()) as { code: string }).code).toBe('REAUTHENTICATION_REQUIRED');
    await t.db.execute(
      sql`UPDATE sessions SET authenticated_at = now() - interval '11 minutes'
           WHERE user_id = ${owner.id}`
    );
    expect(
      (await call(stale, 'POST', '/api/me/delete', { confirmEmail: owner.email })).status
    ).toBe(403);
    await t.db.execute(
      sql`UPDATE sessions SET authenticated_at = now() WHERE user_id = ${owner.id}`
    );
    const wrong = await call(stale, 'POST', '/api/me/delete', {
      confirmEmail: 'someone@else.test',
    });
    expect(wrong.status).toBe(422);
    await t.db.execute(
      sql`UPDATE sessions SET authenticated_at = NULL WHERE user_id = ${owner.id}`
    );
    // Nothing happened.
    const preview = await ok<{ reauthenticatedUntil: string | null }>(
      call(stale, 'GET', '/api/me/deletion')
    );
    expect(preview.reauthenticatedUntil).toBeNull();
  });

  it("refuses while the user is a shared workspace's only owner, until someone else is", async () => {
    const { owner, workspace } = await createWorkspace(t.db, { name: 'Team' });
    const other = await addMember(t.db, workspace.id, 'editor');
    const cookie = await recentSession(owner);
    const preview = await ok<{ workspaces: { id: string; outcome: string; others: number }[] }>(
      call(cookie, 'GET', '/api/me/deletion')
    );
    expect(preview.workspaces).toEqual([
      expect.objectContaining({ id: workspace.id, outcome: 'blocked', others: 1 }),
    ]);
    const refused = await call(cookie, 'POST', '/api/me/delete', { confirmEmail: owner.email });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe('SOLE_OWNER');

    await t.db
      .update(workspaceMembers)
      .set({ role: 'owner' })
      .where(eq(workspaceMembers.userId, other.id));
    const after = await ok<{ workspaces: { outcome: string }[] }>(
      call(cookie, 'GET', '/api/me/deletion')
    );
    expect(after.workspaces[0]?.outcome).toBe('leave');
    await ok(call(cookie, 'POST', '/api/me/delete', { confirmEmail: owner.email?.toUpperCase() }));
    // Signed out everywhere at once.
    expect((await call(cookie, 'GET', '/api/me')).status).toBe(401);
  });
});

describe('the purge of a deleted account', () => {
  it('leaves no row naming the user or their workspace, no file, no provider user', async () => {
    // Ada owns "Solo" alone and is an editor in Bob's "Shared".
    const { owner: ada, workspace: solo } = await createWorkspace(t.db, { name: 'Solo' });
    const { owner: bob, workspace: shared } = await createWorkspace(t.db, { name: 'Shared' });
    await addMember(t.db, shared.id, 'editor', ada);
    const adaCookie = await recentSession(ada);
    const bobCookie = await createSession(t.db, bob);
    await createToken(t.db, ada, { workspaceIds: [solo.id] });
    const mine = await fill(adaCookie, solo.id, ada);
    const theirs = await fill(bobCookie, shared.id, bob);
    // Ada's traces in Bob's workspace: a comment, a mention of her in Bob's, a personal view.
    await ok(
      call(
        adaCookie,
        'POST',
        `/api/tables/${theirs.table.id}/records/${theirs.record.id}/comments`,
        {
          body: `Thanks @[Bob](user:${bob.id})`,
        }
      ),
      201
    );
    await ok(
      call(
        bobCookie,
        'POST',
        `/api/tables/${theirs.table.id}/records/${theirs.record.id}/comments`,
        {
          body: `Over to you @[Ada Lovelace](user:${ada.id})`,
        }
      ),
      201
    );
    await ok(
      call(adaCookie, 'POST', `/api/tables/${theirs.table.id}/views`, {
        name: 'Mine',
        type: 'grid',
        personal: true,
      }),
      201
    );
    expect(keysUnder(solo.id).length).toBeGreaterThanOrEqual(2);
    const soloSchema = sql.identifier(`b_${mine.base.id.replaceAll('-', '')}`);

    const preview = await ok<{ workspaces: { id: string; outcome: string }[] }>(
      call(adaCookie, 'GET', '/api/me/deletion')
    );
    expect(preview.workspaces).toEqual([
      expect.objectContaining({ id: solo.id, outcome: 'delete' }),
    ]);
    const done = await ok<{ workspaces: number; purgeBy: string }>(
      call(adaCookie, 'POST', '/api/me/delete', { confirmEmail: ada.email })
    );
    expect(done.workspaces).toBe(1);
    // The request queued the purge for the worker.
    const { rows: queued } = await t.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'purge.deleted'`
    );
    expect(queued[0]?.n).toBeGreaterThan(0);

    const { identity, deleted } = fakeIdentity();
    const result = await purgeDeleted({ db: t.appDb, logger, store, identity });
    expect(result.workspaces).toBe(1);
    expect(result.skipped).toBe(0);
    expect(deleted).toContainEqual({ issuer: ada.oidcIssuer, subject: ada.oidcSubject });

    expect(await rowsNaming(ada.id)).toEqual({});
    expect(await rowsNaming(solo.id)).toEqual({});
    expect(await tenantRows(solo.id)).toEqual({});
    expect(keysUnder(solo.id)).toEqual([]);
    const { rows: schemas } = await t.db.execute(
      sql`SELECT 1 FROM pg_namespace WHERE nspname = ${`b_${mine.base.id.replaceAll('-', '')}`}`
    );
    expect(schemas).toEqual([]);
    expect(soloSchema).toBeDefined();
    const { rows: comments } = await t.db.execute<{ body: string; author_id: string | null }>(
      sql`SELECT body, author_id FROM record_comments WHERE workspace_id = ${shared.id}
           ORDER BY created_at`
    );
    // Bob's workspace keeps its content; Ada's name and id are gone from it.
    expect(comments.map((c) => c.body)).toEqual([
      'A note',
      `Thanks @[Bob](user:${bob.id})`,
      'Over to you @Deleted user',
    ]);
    expect(comments[1]?.author_id).toBeNull();
    expect(keysUnder(shared.id).length).toBeGreaterThan(0);
    const { rows: views } = await t.db.execute(
      sql`SELECT 1 FROM views WHERE workspace_id = ${shared.id} AND personal`
    );
    expect(views).toEqual([]);

    // A second run has nothing left to do.
    expect(await purgeDeleted({ db: t.appDb, logger, store, identity })).toMatchObject({
      users: 0,
      workspaces: 0,
    });
  });

  it('gives a workspace the deleted user solely owned to its next member, and keeps them out', async () => {
    const { owner, workspace } = await createWorkspace(t.db);
    const creator = await addMember(t.db, workspace.id, 'creator');
    const coOwner = await addMember(t.db, workspace.id, 'owner');
    await addMember(t.db, workspace.id, 'editor');
    const cookie = await recentSession(owner);
    await ok(call(cookie, 'POST', '/api/me/delete', { confirmEmail: owner.email }));
    // The other owner left after the request: the purge promotes the creator, not the editor.
    await t.db.delete(workspaceMembers).where(eq(workspaceMembers.userId, coOwner.id));
    const { identity } = fakeIdentity();
    await purgeDeleted({ db: t.appDb, logger, store, identity });
    const members = await t.db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspace.id));
    expect(members.filter((m) => m.role === 'owner')).toEqual([
      expect.objectContaining({ userId: creator.id }),
    ]);
    expect(members).toHaveLength(2);
    // And the deleted account can't sign back in meanwhile: its sessions are gone.
    expect((await call(cookie, 'GET', '/api/me')).status).toBe(401);
  });

  it('retries later when the provider fails, keeping the account marked', async () => {
    const user = await createUser(t.db);
    await t.db.execute(sql`UPDATE users SET deleted_at = now() WHERE id = ${user.id}`);
    const failing: IdentityAdmin = {
      async deleteUser() {
        throw new Error('provider down');
      },
    };
    await expect(purgeDeleted({ db: t.appDb, logger, store, identity: failing })).rejects.toThrow(
      'provider down'
    );
    const { rows } = await t.db.execute(sql`SELECT 1 FROM users WHERE id = ${user.id}`);
    expect(rows).toHaveLength(1);
    await purgeDeleted({ db: t.appDb, logger, store, identity: fakeIdentity().identity });
    expect((await t.db.execute(sql`SELECT 1 FROM users WHERE id = ${user.id}`)).rows).toEqual([]);
  });
});

describe('the purge of a deleted workspace', () => {
  it('owner-only delete, then nothing of it is left, token grants included', async () => {
    const { owner, workspace } = await createWorkspace(t.db);
    const editor = await addMember(t.db, workspace.id, 'editor');
    const cookie = await createSession(t.db, owner);
    await fill(cookie, workspace.id, owner);
    const grant = await createToken(t.db, editor, { workspaceIds: [workspace.id] });
    expect(
      (await call(await createSession(t.db, editor), 'DELETE', `/api/workspaces/${workspace.id}`))
        .status
    ).toBe(403);
    expect((await call(cookie, 'DELETE', `/api/workspaces/${workspace.id}`)).status).toBe(204);

    const result = await purgeDeleted({ db: t.appDb, logger, store });
    expect(result.workspaces).toBe(1);
    expect(await tenantRows(workspace.id)).toEqual({});
    expect(await rowsNaming(workspace.id)).toEqual({});
    expect(keysUnder(workspace.id)).toEqual([]);
    const [token] = await t.db
      .select()
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.id, grant.id));
    expect(token?.workspaceIds).toEqual([]);
  });

  it('waits for an object store before deleting anything', async () => {
    const { owner, workspace } = await createWorkspace(t.db);
    await call(await createSession(t.db, owner), 'DELETE', `/api/workspaces/${workspace.id}`);
    const result = await purgeDeleted({ db: t.appDb, logger });
    expect(result.workspaces).toBe(0);
    expect(result.skipped).toBeGreaterThan(0);
    expect(await tenantRows(workspace.id)).not.toEqual({});
    await purgeDeleted({ db: t.appDb, logger, store });
    expect(await tenantRows(workspace.id)).toEqual({});
  });
});

describe('the trash purge', () => {
  it('deletes bases, tables, fields, views and records in the trash past 30 days', async () => {
    const { owner, workspace } = await createWorkspace(t.db);
    const cookie = await createSession(t.db, owner);
    const keep = await fill(cookie, workspace.id, owner);
    const gone = await fill(cookie, workspace.id, owner);
    const extra = await ok<TableMeta>(
      call(cookie, 'POST', `/api/bases/${keep.base.id}/tables`, { name: 'Old' }),
      201
    );
    const field = keep.table.fields.find((f) => !f.isPrimary);
    const view = await ok<{ id: string }>(
      call(cookie, 'POST', `/api/tables/${keep.table.id}/views`, { name: 'Old', type: 'grid' }),
      201
    );
    const recent = await ok<{ id: string }>(
      call(cookie, 'POST', `/api/tables/${keep.table.id}/records`, { fields: {} }),
      201
    );
    await ok(
      call(cookie, 'POST', `/api/tables/${keep.table.id}/records/delete`, {
        recordIds: [keep.record.id, recent.id],
      })
    );
    for (const path of [
      `/api/bases/${gone.base.id}`,
      `/api/tables/${extra.id}`,
      `/api/fields/${field?.id}`,
      `/api/views/${view.id}`,
    ]) {
      const r = await call(cookie, 'DELETE', path);
      expect(r.ok, path).toBe(true);
    }
    // All of it 31 days ago, except the second record.
    const [tableRow] = await t.db.select().from(tables).where(eq(tables.id, keep.table.id));
    if (!tableRow) throw new Error('no table');
    const old = sql`now() - interval '31 days'`;
    await t.db.execute(sql`UPDATE bases SET deleted_at = ${old} WHERE id = ${gone.base.id}`);
    await t.db.execute(sql`UPDATE tables SET deleted_at = ${old} WHERE id = ${extra.id}`);
    await t.db.execute(sql`UPDATE fields SET deleted_at = ${old} WHERE id = ${field?.id ?? ''}`);
    await t.db.execute(sql`UPDATE views SET deleted_at = ${old} WHERE id = ${view.id}`);
    await t.db.execute(
      sql`UPDATE ${qualified(tableRow)} SET deleted_at = ${old} WHERE id = ${keep.record.id}`
    );

    const result = await purgeExpiredTrash({ db: t.appDb, logger, store });
    expect(result).toMatchObject({ bases: 1, tables: 1, fields: 1, views: 1, errors: 0 });
    expect(result.records).toBeGreaterThanOrEqual(1);
    const left = async (q: ReturnType<typeof sql>) => (await t.db.execute(q)).rows.length;
    expect(await left(sql`SELECT 1 FROM bases WHERE id = ${gone.base.id}`)).toBe(0);
    expect(await left(sql`SELECT 1 FROM tables WHERE id = ${extra.id}`)).toBe(0);
    expect(await left(sql`SELECT 1 FROM fields WHERE id = ${field?.id ?? ''}`)).toBe(0);
    expect(await left(sql`SELECT 1 FROM views WHERE id = ${view.id}`)).toBe(0);
    expect(await left(sql`SELECT 1 FROM ${qualified(tableRow)} WHERE id = ${keep.record.id}`)).toBe(
      0
    );
    expect(await left(sql`SELECT 1 FROM record_comments WHERE record_id = ${keep.record.id}`)).toBe(
      0
    );
    // Still in its 30 days.
    expect(await left(sql`SELECT 1 FROM ${qualified(tableRow)} WHERE id = ${recent.id}`)).toBe(1);
    // The purged base's files are left to the attachment GC (storage_garbage).
    expect(
      await left(sql`SELECT 1 FROM storage_garbage WHERE workspace_id = ${workspace.id}`)
    ).toBeGreaterThan(0);
  });
});
