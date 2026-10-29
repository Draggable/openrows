import {
  AUDIT_CATEGORIES,
  type AuditAction,
  type AuditEvent,
  type AuditValue,
  auditDownloads,
} from '@openrows/shared';
import { ApiError, downloadUrl } from '../../api/client';

/** What people read for each action; a new action fails the type check here. */
export const ACTION_LABELS: Record<AuditAction, string> = {
  'auth.sign_in': 'Signed in',
  'workspace.update': 'Changed workspace settings',
  'workspace.create_in_region': 'Created a workspace in another region',
  'workspace.delete': 'Deleted the workspace',
  'member.join': 'Joined the workspace',
  'member.role_change': "Changed a member's role",
  'member.remove': 'Removed a member',
  'invitation.create': 'Invited someone',
  'invitation.revoke': 'Revoked an invitation',
  'base_collaborator.add': 'Added a base collaborator',
  'base_collaborator.role_change': "Changed a base collaborator's role",
  'base_collaborator.remove': 'Removed a base collaborator',
  'share.create': 'Created a share link',
  'share.update': 'Changed a share link',
  'share.revoke': 'Revoked a share link',
  'token.create': 'Created a personal access token',
  'token.revoke': 'Revoked a personal access token',
  'oauth.authorize': 'Authorized an OAuth app',
  'oauth.revoke': "Revoked an OAuth app's access",
  'webhook.create': 'Created a webhook',
  'webhook.update': 'Changed a webhook',
  'webhook.delete': 'Deleted a webhook',
  'export.base': 'Exported a base',
  'export.csv': 'Exported a table as CSV',
  'export.audit_log': 'Exported the audit log',
  'base.delete': 'Moved a base to the trash',
  'base.restore': 'Restored a base from the trash',
  'base.destroy': 'Deleted a base permanently',
  'table.delete': 'Deleted a table',
  'field.delete': 'Deleted a field',
  'view.delete': 'Deleted a view',
  'ai_settings.update': 'Changed the AI settings',
  'ai_settings.delete': "Removed the workspace's AI key",
  'automation.create': 'Created an automation',
  'automation.update': 'Changed an automation',
  'automation.delete': 'Deleted an automation',
  'impersonation.start': 'OpenRows support started viewing as a user',
  'impersonation.end': 'OpenRows support stopped viewing as a user',
  'audit_stream.update': 'Changed the audit log stream',
  'audit_stream.delete': 'Removed the audit log stream',
  'sso.update': 'Changed single sign-on',
  'sso.delete': 'Removed single sign-on',
  'sso_domain.add': 'Added a single sign-on domain',
  'sso_domain.verify': 'Verified a single sign-on domain',
  'sso_domain.delete': 'Removed a single sign-on domain',
  'member.sso_join': 'Joined through single sign-on',
  'scim.token_create': 'Created a SCIM token',
  'scim.token_revoke': 'Revoked the SCIM token',
  'scim.update': 'Changed SCIM provisioning',
  'scim_user.create': 'Provisioned a SCIM user',
  'scim_user.update': 'Updated a SCIM user',
  'scim_user.delete': 'Deleted a SCIM user',
  'scim_group.create': 'Created a SCIM group',
  'scim_group.update': 'Updated a SCIM group',
  'scim_group.delete': 'Deleted a SCIM group',
  'scim_group.role_change': "Changed a SCIM group's role",
  'member.scim_provision': 'Joined through SCIM',
  'member.scim_deprovision': 'Removed through SCIM',
  'policy.update': 'Changed workspace policies',
};

const CATEGORY_NAMES: Record<string, string> = {
  auth: 'Sign-ins',
  workspace: 'Workspace',
  member: 'Members',
  invitation: 'Invitations',
  base_collaborator: 'Base collaborators',
  share: 'Share links',
  token: 'Access tokens',
  oauth: 'OAuth apps',
  webhook: 'Webhooks',
  export: 'Exports',
  base: 'Bases',
  table: 'Tables',
  field: 'Fields',
  view: 'Views',
  ai_settings: 'AI settings',
  automation: 'Automations',
  impersonation: 'Support access',
  audit_stream: 'Audit log stream',
  sso: 'Single sign-on',
  sso_domain: 'Single sign-on domains',
  scim: 'SCIM provisioning',
  scim_user: 'SCIM users',
  scim_group: 'SCIM groups',
  policy: 'Policies',
};

/** The filter's choices: every category, by name. */
export const CATEGORY_OPTIONS = AUDIT_CATEGORIES.map((c) => ({
  value: c,
  label: CATEGORY_NAMES[c] ?? c,
})).sort((a, b) => a.label.localeCompare(b.label));

export interface AuditFilterForm {
  category: string;
  q: string;
  /** Local dates, YYYY-MM-DD; empty: open. */
  from: string;
  to: string;
}

export const EMPTY_FILTERS: AuditFilterForm = { category: '', q: '', from: '', to: '' };

/** The list's and the export's query: the dates as the start of the local day (`to` inclusive). */
export function filterQuery(f: AuditFilterForm): Record<string, string> {
  const out: Record<string, string> = {};
  if (f.category) out['action'] = f.category;
  if (f.q.trim()) out['q'] = f.q.trim();
  const day = (d: string, plus = 0) => {
    const at = new Date(`${d}T00:00:00`);
    if (Number.isNaN(at.getTime())) return undefined;
    at.setDate(at.getDate() + plus);
    return at.toISOString();
  };
  const from = f.from ? day(f.from) : undefined;
  const to = f.to ? day(f.to, 1) : undefined;
  if (from) out['from'] = from;
  if (to) out['to'] = to;
  return out;
}

export function exportUrl(
  workspaceId: string,
  filters: Record<string, string>,
  format: 'csv' | 'json'
): string {
  return downloadUrl(auditDownloads.export, {
    params: { workspaceId },
    query: { ...filters, format },
  });
}

function show(v: AuditValue | AuditValue[] | undefined): string {
  if (v === undefined || v === null) return '—';
  if (Array.isArray(v)) return v.length ? v.map((x) => String(x)).join(', ') : '—';
  return String(v);
}

/** The entry's before/after as short lines: `role: editor → creator`, `events: record.created`. */
export function summaryLines(e: AuditEvent): string[] {
  const before = e.summary.before ?? {};
  const after = e.summary.after ?? {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys.map((k) => {
    if (k in before && k in after) return `${k}: ${show(before[k])} → ${show(after[k])}`;
    return `${k}: ${show(k in after ? after[k] : before[k])}`;
  });
}

/** Who did it, for people. */
export function actorText(e: AuditEvent): string {
  if (e.actor.kind === 'system') return 'OpenRows';
  if (e.actor.kind === 'scim') return 'Identity provider (SCIM)';
  const who = e.actor.email ?? 'A deleted account';
  if (e.actor.kind === 'admin') return `OpenRows support (${who})`;
  if (e.actor.kind === 'token') return `${who} (access token)`;
  return who;
}

export function targetText(e: AuditEvent): string {
  const name = e.target.name ?? e.target.id;
  return name ? `${e.target.type.replace('_', ' ')} ${name}` : e.target.type.replace('_', ' ');
}

/**
 * Why the log can't be shown: this edition has none (404: self-hosted), the plan lacks it (403
 * PLAN_FEATURE_REQUIRED), or something else went wrong.
 */
export type AuditUnavailable = 'edition' | 'plan' | 'error';

export function unavailable(err: unknown): AuditUnavailable {
  if (err instanceof ApiError && err.status === 404) return 'edition';
  if (err instanceof ApiError && err.code === 'PLAN_FEATURE_REQUIRED') return 'plan';
  return 'error';
}

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function timeText(at: string): string {
  return dateTime.format(new Date(at));
}
