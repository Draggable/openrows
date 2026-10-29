import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inScope } from '../../src/authz/scope.js';
import {
  bases,
  fields,
  notifications,
  RLS_EXEMPT_TABLES,
  tables,
  views,
} from '../../src/db/index.js';
import { useTestDb } from '../helpers/db.js';
import { createTenant, createToken } from '../helpers/factories.js';

/**
 * ADR-002 defence in depth: even when the app layer is bypassed (a query with no tenant filter,
 * or no authorization at all), openrows_app can't see or change another workspace's rows.
 * Every query here runs as openrows_app, the server's production role.
 */
/**
 * Tenant tables whose rows only their recipient reads: writers in the workspace insert,
 * the recipient (`app.user_id`) reads, marks and deletes, across workspaces. Tested on their own.
 */
const RECIPIENT_TABLES = ['notifications'];
/** User-owned tables: only their owner (`app.user_id`) sees or changes a row. */
const USER_TABLES = [
  'personal_access_tokens',
  'personal_access_token_usage',
  // OAuth apps: their owner's; authorizations, codes and tokens the consenting person's.
  'oauth_apps',
  'oauth_authorizations',
  'oauth_codes',
  'oauth_tokens',
  // Sync connector accounts: the connected person's.
  'sync_connector_accounts',
];
/** The ops console's audit log: system admins and the user it names (admin-console.test.ts). */
const ADMIN_TABLES = ['admin_audit_log'];
/**
 * Service notices: global notices anyone signed in reads, and each user's own dismissals
 * and deliveries, written only through their functions (notices.test.ts).
 */
const NOTICE_TABLES = ['legal_notices', 'legal_notice_dismissals', 'legal_notice_deliveries'];
/** Tenant tables the app role may only insert into and read (the workspace audit log). */
const APPEND_ONLY_TABLES = ['workspace_audit_events'];
/** Written only through a SECURITY DEFINER function: the app role can't touch the rows. */
const FUNCTION_WRITTEN_TABLES = ['ai_credit_counts'];

describe('row-level security', () => {
  const t = useTestDb();
  let a: Awaited<ReturnType<typeof createTenant>>;
  let b: Awaited<ReturnType<typeof createTenant>>;
  let tenantTables: string[];
  let client: pg.Client;

  beforeAll(async () => {
    a = await createTenant(t.db);
    b = await createTenant(t.db);
    client = new pg.Client({ connectionString: t.appUrl });
    await client.connect();
    const exempt: readonly string[] = RLS_EXEMPT_TABLES;
    const { rows } = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
    );
    tenantTables = rows
      .map((r) => r.tablename)
      .filter(
        (n) =>
          !exempt.includes(n) &&
          !RECIPIENT_TABLES.includes(n) &&
          !USER_TABLES.includes(n) &&
          !ADMIN_TABLES.includes(n) &&
          !NOTICE_TABLES.includes(n)
      );
  });
  afterAll(() => client.end());

  /** Runs `fn` in a transaction with the given RLS settings, then rolls back. */
  async function scoped<T>(
    settings: { workspaceId?: string; userId?: string },
    fn: () => Promise<T>
  ): Promise<T> {
    await client.query('BEGIN');
    try {
      await client.query(
        `SELECT set_config('app.workspace_id', $1, true), set_config('app.user_id', $2, true)`,
        [settings.workspaceId ?? '', settings.userId ?? '']
      );
      return await fn();
    } finally {
      await client.query('ROLLBACK');
    }
  }

  const tenantColumn = (table: string) => (table === 'workspaces' ? 'id' : 'workspace_id');

  async function workspacesIn(table: string): Promise<string[]> {
    const { rows } = await client.query<{ ws: string }>(
      `SELECT DISTINCT ${tenantColumn(table)} AS ws FROM ${table}`
    );
    return rows.map((r) => r.ws).sort();
  }

  it('covers every tenant table with data in both workspaces', async () => {
    expect(tenantTables).toEqual([
      'ai_credit_counts',
      'ai_field_cells',
      'airtable_import_records',
      'api_call_counts',
      'attachments',
      'automation_email_counts',
      'automation_matches',
      'automation_run_counts',
      'automation_runs',
      'automations',
      'base_extensions',
      'base_members',
      'base_scripts',
      'base_snapshots',
      'bases',
      'billing_subscriptions',
      'fields',
      'form_submissions',
      'interface_members',
      'interface_pages',
      'interfaces',
      'jobs',
      'outbox',
      'record_comment_reactions',
      'record_comments',
      'record_revisions',
      'shares',
      'storage_garbage',
      'table_record_counts',
      'table_sync_runs',
      'table_syncs',
      'tables',
      'usage_warnings_sent',
      'view_record_positions',
      'view_sections',
      'views',
      'webhook_deliveries',
      'webhooks',
      'workspace_ai_settings',
      'workspace_audit_events',
      'workspace_audit_streams',
      'workspace_invitations',
      'workspace_member_activity',
      'workspace_members',
      'workspace_policies',
      'workspace_scim_group_members',
      'workspace_scim_groups',
      'workspace_scim_settings',
      'workspace_scim_users',
      'workspace_sso_connections',
      'workspace_sso_domains',
      'workspaces',
    ]);
  });

  it('shows nothing when no workspace is set (fails closed)', async () => {
    for (const table of tenantTables) {
      expect(await workspacesIn(table), table).toEqual([]);
      expect(await scoped({}, () => workspacesIn(table)), table).toEqual([]);
    }
  });

  it('shows only the scoped workspace, in every tenant table', async () => {
    for (const table of tenantTables) {
      expect(
        await scoped({ workspaceId: a.workspace.id }, () => workspacesIn(table)),
        table
      ).toEqual([a.workspace.id]);
      expect(
        await scoped({ workspaceId: b.workspace.id }, () => workspacesIn(table)),
        table
      ).toEqual([b.workspace.id]);
    }
  });

  it('blocks writes into, and updates or deletes of, another workspace', async () => {
    await scoped({ workspaceId: a.workspace.id }, async () => {
      for (const table of tenantTables) {
        // Append-only: no UPDATE or DELETE at all (below).
        if (APPEND_ONLY_TABLES.includes(table)) continue;
        const col = tenantColumn(table);
        if (FUNCTION_WRITTEN_TABLES.includes(table)) {
          for (const text of [
            `UPDATE ${table} SET ${col} = ${col} WHERE ${col} = $1`,
            `DELETE FROM ${table} WHERE ${col} = $1`,
          ]) {
            await client.query('SAVEPOINT attempt');
            await expect(client.query(text, [a.workspace.id]), text).rejects.toMatchObject({
              code: '42501',
            });
            await client.query('ROLLBACK TO SAVEPOINT attempt');
          }
          continue;
        }
        // The app role may update only some columns of workspaces (not plan or id).
        const set = table === 'workspaces' ? 'name' : col;
        const updated = await client.query(
          `UPDATE ${table} SET ${set} = ${set} WHERE ${col} = $1`,
          [b.workspace.id]
        );
        expect(updated.rowCount, `update ${table}`).toBe(0);
        const deleted = await client.query(`DELETE FROM ${table} WHERE ${col} = $1`, [
          b.workspace.id,
        ]);
        expect(deleted.rowCount, `delete ${table}`).toBe(0);
      }
      // Moving one of A's rows into B, or inserting into B, violates WITH CHECK.
      const refused = async (text: string, values: unknown[]) => {
        await client.query('SAVEPOINT attempt');
        await expect(client.query(text, values)).rejects.toMatchObject({ code: '42501' });
        await client.query('ROLLBACK TO SAVEPOINT attempt');
      };
      await refused('UPDATE views SET workspace_id = $1 WHERE id = $2', [
        b.workspace.id,
        a.view.id,
      ]);
      await refused(
        `INSERT INTO bases (id, workspace_id, name, db_schema) VALUES ($1, $2, 'x', $3)`,
        [crypto.randomUUID(), b.workspace.id, `b_${crypto.randomUUID().replaceAll('-', '')}`]
      );
    });
    expect(
      await t.db.select().from(bases).where(eq(bases.workspaceId, b.workspace.id))
    ).toHaveLength(1);
  });

  it('refuses any change to the audit log, even in its own workspace (#157)', async () => {
    await scoped({ workspaceId: a.workspace.id }, async () => {
      for (const text of [
        `UPDATE workspace_audit_events SET action = 'x'`,
        'DELETE FROM workspace_audit_events',
        'TRUNCATE workspace_audit_events',
      ]) {
        await client.query('SAVEPOINT attempt');
        await expect(client.query(text), text).rejects.toMatchObject({ code: '42501' });
        await client.query('ROLLBACK TO SAVEPOINT attempt');
      }
      // Inserting into another workspace violates the policy.
      await client.query('SAVEPOINT attempt');
      await expect(
        client.query(
          `INSERT INTO workspace_audit_events (id, workspace_id, action, actor_kind, target_type)
           VALUES ($1, $2, 'workspace.update', 'user', 'workspace')`,
          [crypto.randomUUID(), b.workspace.id]
        )
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK TO SAVEPOINT attempt');
    });
  });

  it('lets a user see only their own memberships and workspaces before a workspace is set', async () => {
    const memberships = await scoped({ userId: a.owner.id }, () =>
      client.query('SELECT workspace_id, user_id FROM workspace_members')
    );
    expect(memberships.rows).toEqual([{ workspace_id: a.workspace.id, user_id: a.owner.id }]);
    const visible = await scoped({ userId: a.owner.id }, () => workspacesIn('workspaces'));
    expect(visible).toEqual([a.workspace.id]);
    // The user scope reveals no tenant data.
    expect(await scoped({ userId: a.owner.id }, () => workspacesIn('bases'))).toEqual([]);
  });

  it('shows notifications only to their recipient, and takes them only into the scoped workspace', async () => {
    const recipients = () =>
      client.query<{ user_id: string; workspace_id: string }>(
        'SELECT user_id, workspace_id FROM notifications'
      );
    // No user, or a workspace alone (even with another member of it): nothing.
    expect((await recipients()).rows).toEqual([]);
    expect((await scoped({ workspaceId: a.workspace.id }, recipients)).rows).toEqual([]);
    expect(
      (await scoped({ workspaceId: a.workspace.id, userId: a.owner.id }, recipients)).rows
    ).toEqual([]);
    // The recipient sees their own, whatever the workspace scope.
    for (const workspaceId of [undefined, b.workspace.id]) {
      expect((await scoped({ userId: a.collaborator.id, workspaceId }, recipients)).rows).toEqual([
        { user_id: a.collaborator.id, workspace_id: a.workspace.id },
      ]);
    }
    // Nobody else marks or deletes them.
    await scoped({ workspaceId: a.workspace.id, userId: a.owner.id }, async () => {
      expect((await client.query('UPDATE notifications SET read_at = now()')).rowCount).toBe(0);
      expect((await client.query('DELETE FROM notifications')).rowCount).toBe(0);
    });
    // A writer in A notifies anyone in A, but can't put a notification into B.
    await scoped({ workspaceId: a.workspace.id, userId: a.owner.id }, async () => {
      const insert = (workspaceId: string, baseId: string, tableId: string) =>
        client.query(
          `INSERT INTO notifications (id, workspace_id, user_id, kind, base_id, table_id, record_id)
           VALUES (gen_random_uuid(), $1, $2, 'mention', $3, $4, gen_random_uuid())`,
          [workspaceId, a.collaborator.id, baseId, tableId]
        );
      expect((await insert(a.workspace.id, a.base.id, a.table.id)).rowCount).toBe(1);
      await client.query('SAVEPOINT attempt');
      await expect(insert(b.workspace.id, b.base.id, b.table.id)).rejects.toMatchObject({
        code: '42501',
      });
      await client.query('ROLLBACK TO SAVEPOINT attempt');
    });
    const seen = await inScope(t.appDb, { userId: b.collaborator.id }, (tx) =>
      tx.select().from(notifications)
    );
    expect(seen.map((n) => n.workspaceId)).toEqual([b.workspace.id]);
  });

  it('ends the scope with the transaction, so pooled connections never inherit it', async () => {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [a.workspace.id]);
    await client.query('COMMIT');
    expect(await workspacesIn('bases')).toEqual([]);
  });

  it('confines an unfiltered Drizzle query to the scoped workspace', async () => {
    const seen = await inScope(
      t.appDb,
      { userId: a.owner.id, workspaceId: a.workspace.id },
      async (tx) => ({
        bases: await tx.select().from(bases),
        tables: await tx.select().from(tables),
        fields: await tx.select().from(fields),
        views: await tx.select().from(views),
      })
    );
    expect(seen.bases.map((r) => r.id)).toEqual([a.base.id]);
    expect(seen.tables.map((r) => r.id)).toEqual([a.table.id]);
    expect(seen.fields.map((r) => r.id)).toEqual([a.field.id]);
    expect(seen.views.map((r) => r.id)).toEqual([a.view.id]);
    // The same query outside any scope sees nothing.
    expect(await t.appDb.select().from(bases)).toEqual([]);
  });

  it('keeps personal access tokens to their owner (#102)', async () => {
    const mine = await createToken(t.db, a.owner, { workspaceIds: [a.workspace.id] });
    const theirs = await createToken(t.db, b.owner, { workspaceIds: [b.workspace.id] });
    const ids = async () =>
      (await client.query<{ id: string }>('SELECT id FROM personal_access_tokens')).rows.map(
        (r) => r.id
      );
    expect(await ids()).toEqual([]);
    expect(await scoped({ workspaceId: a.workspace.id }, ids)).toEqual([]);
    expect(await scoped({ userId: a.owner.id }, ids)).toEqual([mine.id]);
    await scoped({ userId: a.owner.id }, async () => {
      const changed = await client.query(
        'UPDATE personal_access_tokens SET revoked_at = now() WHERE id = $1',
        [theirs.id]
      );
      expect(changed.rowCount).toBe(0);
      const deleted = await client.query('DELETE FROM personal_access_tokens WHERE id = $1', [
        theirs.id,
      ]);
      expect(deleted.rowCount).toBe(0);
      await expect(
        client.query(
          `INSERT INTO personal_access_tokens (id, user_id, name, public_id, secret_hash, scopes, expires_at)
           VALUES (gen_random_uuid(), $1, 'x', 'forgedpublic', 'h', '{}', now())`,
          [b.owner.id]
        )
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('keeps OAuth apps to their owner and authorizations to who consented (#125)', async () => {
    const appId = uuidv7();
    const authorizationId = uuidv7();
    await t.db.execute(sql`
      INSERT INTO oauth_apps (id, owner_id, name, client_id, secret_hash, redirect_uris)
      VALUES (${appId}, ${a.owner.id}, 'App', ${`or_app_${appId}`}, 'h', '{https://x.test/cb}')`);
    await t.db.execute(sql`
      INSERT INTO oauth_authorizations (id, user_id, app_id, scopes)
      VALUES (${authorizationId}, ${b.owner.id}, ${appId}, '{data.records:read}')`);
    await t.db.execute(sql`
      INSERT INTO oauth_tokens (id, authorization_id, user_id, kind, public_id, secret_hash, expires_at)
      VALUES (${uuidv7()}, ${authorizationId}, ${b.owner.id}, 'access', ${`p${appId.slice(0, 11)}`}, 'h', now())`);
    const count = (table: string) => async () =>
      Number((await client.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
    for (const table of ['oauth_apps', 'oauth_authorizations', 'oauth_tokens']) {
      expect(await count(table)()).toBe(0);
      expect(await scoped({ workspaceId: a.workspace.id }, count(table))).toBe(0);
    }
    expect(await scoped({ userId: a.owner.id }, count('oauth_apps'))).toBe(1);
    expect(await scoped({ userId: a.owner.id }, count('oauth_authorizations'))).toBe(0);
    expect(await scoped({ userId: a.owner.id }, count('oauth_tokens'))).toBe(0);
    expect(await scoped({ userId: b.owner.id }, count('oauth_apps'))).toBe(0);
    expect(await scoped({ userId: b.owner.id }, count('oauth_authorizations'))).toBe(1);
    expect(await scoped({ userId: b.owner.id }, count('oauth_tokens'))).toBe(1);
    await scoped({ userId: b.owner.id }, async () => {
      const changed = await client.query(
        "UPDATE oauth_apps SET redirect_uris = '{https://evil.test/}' WHERE id = $1",
        [appId]
      );
      expect(changed.rowCount).toBe(0);
      await expect(
        client.query(
          `INSERT INTO oauth_authorizations (id, user_id, app_id, scopes)
           VALUES (gen_random_uuid(), $1, $2, '{}')`,
          [a.owner.id, appId]
        )
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  it("keeps token usage counters to the token's owner (#104)", async () => {
    const mine = await createToken(t.db, a.owner, { workspaceIds: [a.workspace.id] });
    const theirs = await createToken(t.db, b.owner, { workspaceIds: [b.workspace.id] });
    // Counted through the SECURITY DEFINER pat_use, as bearer auth does.
    await client.query('SELECT pat_use($1), pat_use($1), pat_use($2)', [mine.id, theirs.id]);
    const usage = async () =>
      (
        await client.query<{ token_id: string; requests: number }>(
          'SELECT token_id, requests FROM personal_access_token_usage'
        )
      ).rows;
    expect(await usage()).toEqual([]);
    expect(await scoped({ userId: a.owner.id }, usage)).toEqual([
      { token_id: mine.id, requests: 2 },
    ]);
    await scoped({ userId: a.owner.id }, async () => {
      const changed = await client.query(
        'UPDATE personal_access_token_usage SET requests = 0 WHERE token_id = $1',
        [theirs.id]
      );
      expect(changed.rowCount).toBe(0);
      await expect(
        client.query(
          `INSERT INTO personal_access_token_usage (token_id, user_id, day, requests)
           VALUES ($1, $2, '2020-01-01', 5)`,
          [theirs.id, b.owner.id]
        )
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('runs the server as a role that cannot switch RLS off', async () => {
    await expect(client.query('SET row_security = off; SELECT * FROM bases')).rejects.toMatchObject(
      {
        code: '42501',
      }
    );
  });
});
