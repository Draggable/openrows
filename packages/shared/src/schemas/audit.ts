import { z } from 'zod';

/**
 * The workspace audit log: an append-only record of security-relevant actions in a
 * workspace (sign-ins, members and roles, shares, tokens and webhooks, exports, deletions,
 * settings, automation edits, support impersonation). The core records events through the
 * edition's AuditSink, which does nothing in the OSS edition; the hosted edition keeps them for
 * workspaces whose plan has the audit log (Enterprise) and serves them to the workspace's owners
 *. Entries hold who, from where, what and a short before/after summary: never
 * secrets and never cell values.
 */

/** Every action the audit log records, `<category>.<verb>`. */
export const AUDIT_ACTIONS = [
  // Sign-in (OIDC today; enterprise SSO when it lands), into each of the user's workspaces.
  'auth.sign_in',
  'workspace.update',
  // Data residency: a workspace created in another region by one of this one's owners.
  'workspace.create_in_region',
  'workspace.delete',
  'member.join',
  'member.role_change',
  'member.remove',
  'invitation.create',
  'invitation.revoke',
  'base_collaborator.add',
  'base_collaborator.role_change',
  'base_collaborator.remove',
  'share.create',
  'share.update',
  'share.revoke',
  'token.create',
  'token.revoke',
  // OAuth apps: a person authorizing one, and revoking it.
  'oauth.authorize',
  'oauth.revoke',
  'webhook.create',
  'webhook.update',
  'webhook.delete',
  'export.base',
  'export.csv',
  'export.audit_log',
  'base.delete',
  'base.restore',
  'base.destroy',
  'table.delete',
  'field.delete',
  'view.delete',
  'ai_settings.update',
  'ai_settings.delete',
  'automation.create',
  'automation.update',
  'automation.delete',
  'impersonation.start',
  'impersonation.end',
  'audit_stream.update',
  'audit_stream.delete',
  // Single sign-on: the connection, its domains and JIT joins.
  'sso.update',
  'sso.delete',
  'sso_domain.add',
  'sso_domain.verify',
  'sso_domain.delete',
  'member.sso_join',
  // SCIM provisioning: the token and settings, the identity provider's users and groups,
  // and the memberships they give.
  'scim.token_create',
  'scim.token_revoke',
  'scim.update',
  'scim_user.create',
  'scim_user.update',
  'scim_user.delete',
  'scim_group.create',
  'scim_group.update',
  'scim_group.delete',
  'scim_group.role_change',
  'member.scim_provision',
  'member.scim_deprovision',
  // The admin console's policies.
  'policy.update',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** The filter's categories: an action's part before the dot. */
export const AUDIT_CATEGORIES = [
  ...new Set(AUDIT_ACTIONS.map((a) => a.slice(0, a.indexOf('.')))),
] as readonly string[];

export function auditCategory(action: AuditAction): string {
  return action.slice(0, action.indexOf('.'));
}

/** Who did it: a signed-in user, a personal access token, a system admin, or the system. */
export const AUDIT_ACTOR_KINDS = ['user', 'token', 'admin', 'system', 'scim'] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

/** What a summary may hold: at most this many keys, values cut to this many characters. */
export const AUDIT_SUMMARY_MAX_KEYS = 20;
export const AUDIT_SUMMARY_MAX_CHARS = 200;
/** User agents are cut to this many characters. */
export const AUDIT_USER_AGENT_MAX = 400;

/** Keys a summary never keeps, whatever a caller passes: anything that could be a credential. */
const SECRET_KEY = /secret|token|password|passphrase|key|credential|authorization|cookie|hash/i;

export type AuditValue = string | number | boolean | null;
export type AuditValues = Record<string, AuditValue | AuditValue[]>;

/**
 * A summary's before/after side as it may be stored: primitive values (and short lists of them)
 * only, at most AUDIT_SUMMARY_MAX_KEYS keys, strings cut, credential-like keys dropped. Objects
 * (cell values, configs) are dropped rather than stored.
 */
export function sanitizeAuditValues(input: Record<string, unknown> | undefined): AuditValues {
  const out: AuditValues = {};
  if (!input) return out;
  let n = 0;
  for (const [key, value] of Object.entries(input)) {
    if (n >= AUDIT_SUMMARY_MAX_KEYS) break;
    if (key.length > 60 || SECRET_KEY.test(key)) continue;
    const clean = Array.isArray(value)
      ? value
          .slice(0, 20)
          .map(primitive)
          .filter((v) => v !== undefined)
      : primitive(value);
    if (clean === undefined) continue;
    out[key] = clean as AuditValue | AuditValue[];
    n++;
  }
  return out;
}

function primitive(value: unknown): AuditValue | undefined {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.slice(0, AUDIT_SUMMARY_MAX_CHARS);
  return undefined;
}

const timestamp = z.iso.datetime({ offset: true });
const auditValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const auditValues = z.record(z.string(), z.union([auditValue, z.array(auditValue)]));

export const AuditEventSchema = z.object({
  id: z.uuid(),
  at: timestamp,
  action: z.enum(AUDIT_ACTIONS),
  actor: z.object({
    kind: z.enum(AUDIT_ACTOR_KINDS),
    /** null for the system, and once the account is purged the id still names it. */
    userId: z.uuid().nullable(),
    /** The actor's email when it happened. */
    email: z.string().nullable(),
  }),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  target: z.object({
    type: z.string(),
    id: z.string().nullable(),
    /** Its name when it happened. */
    name: z.string().nullable(),
  }),
  summary: z.object({ before: auditValues.optional(), after: auditValues.optional() }),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/** Entries per page: the default and the cap. */
export const AUDIT_PAGE_DEFAULT = 50;
export const AUDIT_PAGE_MAX = 200;
/** Rows one export holds at most (newest first within the filter). */
export const AUDIT_EXPORT_MAX = 100_000;

const filters = {
  /** One action, or a category (`member`). */
  action: z
    .string()
    .max(60)
    .refine(
      (v) => (AUDIT_ACTIONS as readonly string[]).includes(v) || AUDIT_CATEGORIES.includes(v),
      'an audit action or category'
    )
    .optional(),
  actorId: z.uuid().optional(),
  /** Entries at or after / before these times. */
  from: timestamp.optional(),
  to: timestamp.optional(),
  /** Matches the target's id or name, or the actor's email (case-insensitive substring). */
  q: z.string().trim().max(200).optional(),
};

export const auditListQuerySchema = z.strictObject({
  ...filters,
  /** The last id of the previous page: entries older than it. */
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_MAX).default(AUDIT_PAGE_DEFAULT),
});
export type AuditListQuery = z.input<typeof auditListQuerySchema>;

export const auditExportQuerySchema = z.strictObject({
  ...filters,
  format: z.enum(['csv', 'json']).default('csv'),
});
export type AuditExportQuery = z.input<typeof auditExportQuerySchema>;

export const AuditListSchema = z.object({
  events: z.array(AuditEventSchema),
  /** Pass as `before` for the next page; null on the last one. */
  nextBefore: z.uuid().nullable(),
  /** How long entries are kept on the workspace's plan; null: indefinitely. */
  retentionDays: z.number().int().nullable(),
});
export type AuditList = z.infer<typeof AuditListSchema>;

/**
 * The SIEM stream: new entries POSTed in batches to an HTTPS endpoint, signed like
 * webhooks (`X-OpenRows-Signature`). The secret is shown once, when the stream is created or
 * rotated.
 */
export const AuditStreamSchema = z.object({
  url: z.string(),
  enabled: z.boolean(),
  lastDeliveryAt: timestamp.nullable(),
  /** The last failed delivery's reason (a status or "unreachable"), cleared by a success. */
  lastError: z.string().nullable(),
  failures: z.number().int().min(0),
  createdAt: timestamp,
});
export type AuditStream = z.infer<typeof AuditStreamSchema>;

export const AuditStreamStateSchema = z.object({ stream: AuditStreamSchema.nullable() });
export type AuditStreamState = z.infer<typeof AuditStreamStateSchema>;

export const auditStreamInputSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }).max(2048),
  enabled: z.boolean().default(true),
  /** A new secret (the old one stops working); always true when the stream is created. */
  rotateSecret: z.boolean().default(false),
});
export type AuditStreamInput = z.input<typeof auditStreamInputSchema>;

export const AuditStreamSavedSchema = z.object({
  stream: AuditStreamSchema,
  /** The signing secret, only when it was just made. */
  secret: z.string().nullable(),
});
export type AuditStreamSaved = z.infer<typeof AuditStreamSavedSchema>;

/** Entries per stream delivery at most. */
export const AUDIT_STREAM_BATCH = 100;
/** Consecutive failed deliveries after which the stream is turned off (the owners see why). */
export const AUDIT_STREAM_MAX_FAILURES = 50;
