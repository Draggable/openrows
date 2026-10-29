import { BASE_ROLES, INTERFACE_ROLES, USER_ROLES } from '@openrows/shared';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from './schema.js';

describe('schema', () => {
  it('keeps workspace roles in sync with @openrows/shared', () => {
    expect([...schema.WORKSPACE_ROLES]).toEqual([...USER_ROLES]);
    expect([...schema.BASE_ROLES]).toEqual([...BASE_ROLES]);
    expect([...schema.INTERFACE_ROLES]).toEqual([...INTERFACE_ROLES]);
  });

  it('generates UUIDv7 ids app-side', () => {
    const generate = schema.users.id.defaultFn;
    expect(generate).toBeTypeOf('function');
    const ids = Array.from({ length: 3 }, () => String(generate?.()));
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    // UUIDv7 is time-ordered.
    expect([...ids].sort()).toEqual(ids);
  });

  it('has no better-auth or legacy tables', () => {
    const names = Object.values(schema)
      .filter((v) => is(v, PgTable))
      .map((t) => getTableConfig(t).name)
      .sort();
    expect(names).toEqual([
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
  });
});
