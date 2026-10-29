import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { outbox, tables } from '../../src/db/index.js';
import { DEMO_WORKSPACE_NAME, findUserByEmail, seedDemo } from '../../src/seed/index.js';
import { useTestDb } from '../helpers/db.js';
import { authedClient, createUser } from '../helpers/factories.js';

/** The Product Roadmap demo seed, run as openrows_app under RLS like the app. */
describe('seedDemo', () => {
  const t = useTestDb();

  it('creates the demo workspace: 5 tables, 31 fields, 2,000 records, visible to its owner', async () => {
    const user = await createUser(t.db, { email: 'Demo.Owner@example.test' });
    expect((await findUserByEmail(t.appDb, 'demo.owner@EXAMPLE.test'))?.id).toBe(user.id);

    const result = await seedDemo(t.appDb, { userId: user.id });
    expect(result.created).toBe(true);
    expect(result.tables.map((x) => x.name)).toEqual([
      'Features',
      'Epics',
      'Releases',
      'Customer feedback',
      'Team',
    ]);
    expect(result.tables.reduce((n, x) => n + x.fields, 0)).toBe(31);
    expect(result.tables.reduce((n, x) => n + x.records, 0)).toBe(2000);

    // Really stored, in the per-table record tables (ADR-001).
    let stored = 0;
    for (const { id } of result.tables) {
      const [row] = await t.db.select().from(tables).where(eq(tables.id, id));
      if (!row) throw new Error('no table row');
      const res = await t.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM ${sql.identifier(row.dbSchema)}.${sql.identifier(row.dbTable)}`
      );
      stored += res.rows[0]?.n ?? 0;
    }
    expect(stored).toBe(2000);
    const events = await t.db
      .select({ n: sql<number>`count(*)::int` })
      .from(outbox)
      .where(eq(outbox.workspaceId, result.workspaceId));
    expect(events[0]?.n).toBeGreaterThan(2000);

    // Through the API, as the owner: the workspace, base and a filtered query.
    const api = await authedClient(t, user);
    const ws = (await (await api.request('/api/workspaces')).json()) as {
      workspaces: { id: string; name: string; role: string }[];
    };
    expect(ws.workspaces).toContainEqual(
      expect.objectContaining({ id: result.workspaceId, name: DEMO_WORKSPACE_NAME, role: 'owner' })
    );
    const features = result.tables[0];
    if (!features) throw new Error('no Features table');
    const page = (await (
      await api.request(`/api/tables/${features.id}/records?limit=1000`)
    ).json()) as { records: { fields: Record<string, unknown> }[] };
    expect(page.records).toHaveLength(1000);
  });

  it('is idempotent per user and invisible to other users', async () => {
    const user = await createUser(t.db);
    const first = await seedDemo(t.appDb, { userId: user.id });
    const again = await seedDemo(t.appDb, { userId: user.id });
    expect(again).toEqual({ ...first, created: false });

    const stranger = await authedClient(t, await createUser(t.db));
    expect((await stranger.request(`/api/workspaces/${first.workspaceId}`)).status).toBe(404);
    expect((await stranger.request(`/api/bases/${first.baseId}`)).status).toBe(404);
  });
});
