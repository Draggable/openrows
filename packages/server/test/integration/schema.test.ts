import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashSessionToken } from '../../src/auth/session-token.js';
import { bases, fields, sessions, tables, users, workspaceMembers } from '../../src/db/index.js';
import { useTestDb } from '../helpers/db.js';
import { authedClient, createSession, createUser, createWorkspace } from '../helpers/factories.js';

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Postgres error code of a rejected query (Drizzle wraps the driver error in `cause`). */
async function pgError(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
  return undefined;
}

describe('metadata schema', () => {
  const t = useTestDb();

  async function createBase(workspaceId: string) {
    const [base] = await t.db
      .insert(bases)
      .values({
        workspaceId,
        name: 'Base',
        dbSchema: `b_${crypto.randomUUID().replaceAll('-', '')}`,
      })
      .returning();
    if (!base) throw new Error('no base');
    return base;
  }

  async function createTable(workspaceId: string, baseId: string) {
    const [table] = await t.db
      .insert(tables)
      .values({
        workspaceId,
        baseId,
        name: 'Table',
        dbSchema: 'b_x',
        dbTable: `t_${crypto.randomUUID().replaceAll('-', '')}`,
      })
      .returning();
    if (!table) throw new Error('no table');
    return table;
  }

  it('creates users with app-generated UUIDv7 ids', async () => {
    const user = await createUser(t.db);
    expect(user.id).toMatch(UUIDV7);
    expect(user.isSystemAdmin).toBe(false);
  });

  it('allows one user per OIDC issuer and subject', async () => {
    const user = await createUser(t.db);
    expect(await pgError(createUser(t.db, { oidcSubject: user.oidcSubject }))).toBe('23505');
    // The same subject at another issuer is a different identity.
    await createUser(t.db, { oidcSubject: user.oidcSubject, oidcIssuer: 'https://other.test' });
  });

  it('stores only session token hashes and deletes sessions with their user', async () => {
    const user = await createUser(t.db);
    const token = await createSession(t.db, user);
    const [row] = await t.db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(row?.idHash).toBe(hashSessionToken(token));
    expect(row?.idHash).not.toContain(token);

    await t.db.delete(users).where(eq(users.id, user.id));
    expect(await t.db.select().from(sessions).where(eq(sessions.userId, user.id))).toEqual([]);
  });

  it('rejects unknown workspace roles', async () => {
    const { workspace } = await createWorkspace(t.db);
    const other = await createUser(t.db);
    const insert = t.db
      .insert(workspaceMembers)
      // @ts-expect-error: the role is not in WORKSPACE_ROLES
      .values({ workspaceId: workspace.id, userId: other.id, role: 'superuser' });
    expect(await pgError(insert)).toBe('23514');
  });

  it('rejects a child that points at a parent in another workspace', async () => {
    const { workspace: a } = await createWorkspace(t.db);
    const { workspace: b } = await createWorkspace(t.db);
    const baseInA = await createBase(a.id);

    expect(await pgError(createTable(b.id, baseInA.id))).toBe('23503');
    const table = await createTable(a.id, baseInA.id);
    const field = t.db
      .insert(fields)
      .values({ workspaceId: b.id, tableId: table.id, name: 'F', type: 'text', dbColumn: 'f_1' });
    expect(await pgError(field)).toBe('23503');
  });

  it('allows one live primary field per table and cascades deletes', async () => {
    const { workspace } = await createWorkspace(t.db);
    const base = await createBase(workspace.id);
    const table = await createTable(workspace.id, base.id);
    const primary = { workspaceId: workspace.id, tableId: table.id, type: 'text', isPrimary: true };
    await t.db.insert(fields).values({ ...primary, name: 'Name', dbColumn: 'f_a' });
    expect(
      await pgError(t.db.insert(fields).values({ ...primary, name: 'Other', dbColumn: 'f_b' }))
    ).toBe('23505');

    await t.db.delete(bases).where(eq(bases.id, base.id));
    expect(await t.db.select().from(fields).where(eq(fields.tableId, table.id))).toEqual([]);
  });
});

describe('test helpers', () => {
  const t = useTestDb();

  it('authedClient sends a session cookie backed by a real session row', async () => {
    const { owner } = await createWorkspace(t.db);
    const client = await authedClient(t, owner);
    const res = await client.request('/health');
    expect(res.status).toBe(200);
    const [row] = await t.db
      .select()
      .from(sessions)
      .where(eq(sessions.idHash, hashSessionToken(client.token)));
    expect(row?.userId).toBe(owner.id);
  });

  it('gives each test file its own database', async () => {
    expect(t.url).toMatch(/\/test_[0-9a-f]{32}$/);
  });
});
