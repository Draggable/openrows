import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, runMigrations } from '../../src/db/migrate.js';
import { GLOBAL_TABLES, RLS_EXEMPT_TABLES } from '../../src/db/schema.js';
import { createDatabase } from '../helpers/db.js';

const run = promisify(execFile);
const serverDir = fileURLToPath(new URL('../..', import.meta.url));
const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
  entries: { tag: string }[];
};

async function query<T extends pg.QueryResultRow>(url: string, sql: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.end();
  }
}

const publicTables = (url: string) =>
  query<{ table_name: string }>(
    url,
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' ORDER BY table_name`
  ).then((rows) => rows.map((r) => r.table_name));

describe('migrations', () => {
  let fresh: Awaited<ReturnType<typeof createDatabase>>;

  beforeAll(async () => {
    fresh = await createDatabase({ template: false });
  });
  afterAll(() => fresh.drop());

  it('bring a fresh Postgres to the latest schema through `npm run db:migrate`', async () => {
    expect(await publicTables(fresh.url)).toEqual([]);

    const { stdout } = await run('npm', ['run', 'db:migrate'], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: fresh.url },
    });
    expect(stdout).toContain('Migrations applied');

    expect(await publicTables(fresh.url)).toEqual([
      'admin_audit_log',
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
      'billing_events',
      'billing_subscriptions',
      'fields',
      'form_submissions',
      'interface_members',
      'interface_pages',
      'interfaces',
      'jobs',
      'legal_notice_deliveries',
      'legal_notice_dismissals',
      'legal_notices',
      'notifications',
      'oauth_apps',
      'oauth_authorizations',
      'oauth_codes',
      'oauth_tokens',
      'outbound_leases',
      'outbox',
      'outbox_relay_cursor',
      'personal_access_token_usage',
      'personal_access_tokens',
      'rate_limit_buckets',
      'record_comment_reactions',
      'record_comments',
      'record_revisions',
      'sessions',
      'shares',
      'storage_garbage',
      'sync_connector_accounts',
      'table_record_counts',
      'table_sync_runs',
      'table_syncs',
      'tables',
      'usage_warnings_sent',
      'users',
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
    const applied = await query(fresh.url, 'SELECT hash FROM drizzle.__drizzle_migrations');
    expect(applied).toHaveLength(journal.entries.length);
    // pg-boss's schema (ADR-004): installed by the owner, used (rows only) by the app role.
    const [boss] = await query<{
      version: number;
      usage: boolean;
      insert: boolean;
      create: boolean;
    }>(
      fresh.url,
      `SELECT (SELECT version FROM pgboss.version) AS version,
              has_schema_privilege('openrows_app', 'pgboss', 'USAGE') AS usage,
              has_table_privilege('openrows_app', 'pgboss.job', 'INSERT') AS insert,
              has_schema_privilege('openrows_app', 'pgboss', 'CREATE') AS create`
    );
    expect(boss).toMatchObject({ usage: true, insert: true, create: false });
    expect(boss?.version).toBeGreaterThan(0);
  });

  it('are idempotent and safe to run concurrently', async () => {
    await Promise.all([runMigrations(fresh.url), runMigrations(fresh.url)]);
    const applied = await query(fresh.url, 'SELECT hash FROM drizzle.__drizzle_migrations');
    expect(applied).toHaveLength(journal.entries.length);
  });

  it('exit non-zero when the database is unreachable', async () => {
    const bad = new URL(fresh.url);
    bad.port = '1';
    await expect(
      run('node', ['--import', 'tsx', 'src/migrate.ts'], {
        cwd: serverDir,
        env: { ...process.env, DATABASE_URL: bad.toString() },
      })
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Migration failed') });
  });

  // ADR-002: every table is either global (allowlisted) or tenant-owned with a NOT NULL
  // workspace_id.
  it('classify every public table as global or tenant-owned', async () => {
    const rows = await query<{ table_name: string; is_nullable: string | null }>(
      fresh.url,
      `SELECT t.table_name, c.is_nullable
       FROM information_schema.tables t
       LEFT JOIN information_schema.columns c
         ON c.table_schema = t.table_schema AND c.table_name = t.table_name
        AND c.column_name = 'workspace_id'
       WHERE t.table_schema = 'public'`
    );
    const global: readonly string[] = GLOBAL_TABLES;
    for (const { table_name, is_nullable } of rows) {
      if (global.includes(table_name)) {
        expect(is_nullable, `${table_name} is global and must not have workspace_id`).toBeNull();
      } else {
        expect(is_nullable, `${table_name} needs workspace_id NOT NULL`).toBe('NO');
      }
    }
  });

  // ADR-002: every table except the global allowlist has RLS enabled *and forced* (so even the
  // table owner is subject to it) and at least one policy. A new tenant table without its
  // policy fails here.
  it('put forced row-level security and a policy on every tenant table', async () => {
    const rows = await query<{
      relname: string;
      enabled: boolean;
      forced: boolean;
      policies: number;
    }>(
      fresh.url,
      `SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'`
    );
    const exempt: readonly string[] = RLS_EXEMPT_TABLES;
    for (const r of rows) {
      if (exempt.includes(r.relname)) continue;
      expect(r, `${r.relname} needs ENABLE + FORCE ROW LEVEL SECURITY and a policy`).toMatchObject({
        enabled: true,
        forced: true,
        policies: expect.any(Number),
      });
      expect(r.policies, r.relname).toBeGreaterThan(0);
    }
  });

  it('create openrows_app as a role that RLS applies to, with DML rights only', async () => {
    const [role] = await query<Record<string, boolean>>(
      fresh.url,
      `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = 'openrows_app'`
    );
    expect(role).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
    });
    const owned = await query(
      fresh.url,
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'openrows_app'`
    );
    expect(owned).toEqual([]);
    const [create] = await query<{ ok: boolean }>(
      fresh.url,
      `SELECT has_schema_privilege('openrows_app', 'public', 'CREATE') AS ok`
    );
    expect(create?.ok).toBe(false);
  });

  it('refuse to run as an owner that RLS would apply to', async () => {
    const db = await createDatabase({ template: false });
    try {
      const role = `owner_${Date.now()}`;
      await query(db.url, `CREATE ROLE ${role} LOGIN PASSWORD 'pw' NOBYPASSRLS`);
      await query(db.url, `GRANT ALL ON SCHEMA public TO ${role}`);
      await query(
        db.url,
        `GRANT CREATE ON DATABASE "${new URL(db.url).pathname.slice(1)}" TO ${role}`
      );
      const asRole = new URL(db.url);
      asRole.username = role;
      asRole.password = 'pw';
      await expect(runMigrations(asRole.toString())).rejects.toThrow(/BYPASSRLS/);
    } finally {
      await db.drop();
    }
  });
});
