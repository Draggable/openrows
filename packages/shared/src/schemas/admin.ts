import { z } from 'zod';
import { planIdSchema, planOverridesSchema, WorkspaceUsageSchema } from './usage.js';

/**
 * The hosted ops console: system admins only (`users.is_system_admin`, never set through
 * the API). Its routes live in the hosted edition and answer 404 to everyone else; the core enforces what the
 * console sets (suspensions, read-only impersonation) and keeps the append-only audit log.
 */

/** The console needs a sign-in at the provider within this many minutes (`/auth/login?reauth=1`). */
export const ADMIN_REAUTH_MINUTES = 30;

/** How long an impersonation lasts. It is read-only throughout. */
export const IMPERSONATION_MINUTES = 15;

/** Rows per console list page: the default and the cap. */
export const ADMIN_PAGE_DEFAULT = 50;
export const ADMIN_PAGE_MAX = 100;

/** What the audit log records, one entry per console request. */
export const ADMIN_AUDIT_ACTIONS = [
  'workspaces.list',
  'workspace.view',
  'workspace.plan',
  'workspace.suspend',
  'workspace.unsuspend',
  'webhook.revoke',
  'users.list',
  'user.view',
  'user.suspend',
  'user.unsuspend',
  'token.revoke',
  'impersonation.start',
  'impersonation.end',
  'audit.list',
] as const;
export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];

const timestamp = z.iso.datetime({ offset: true });

export const adminListQuerySchema = z.strictObject({
  /** Name, email or id; case-insensitive substring. */
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(ADMIN_PAGE_MAX).default(ADMIN_PAGE_DEFAULT),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export type AdminListQuery = z.input<typeof adminListQuerySchema>;

export const AdminWorkspaceSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** The stored plan; null: the edition's default plan. */
  plan: z.string().nullable(),
  createdAt: timestamp,
  /** The latest activity of any member's session; null when none is known. */
  lastActiveAt: timestamp.nullable(),
  members: z.number().int().min(0),
  records: z.number().int().min(0),
  suspendedAt: timestamp.nullable(),
  suspendedReason: z.string().nullable(),
  deletedAt: timestamp.nullable(),
});
export type AdminWorkspaceSummary = z.infer<typeof AdminWorkspaceSummarySchema>;

export const AdminWorkspaceListSchema = z.object({
  workspaces: z.array(AdminWorkspaceSummarySchema),
  total: z.number().int().min(0),
});
export type AdminWorkspaceList = z.infer<typeof AdminWorkspaceListSchema>;

/** A personal access token as the console shows it (never its secret or public id). */
export const AdminTokenSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  userEmail: z.string().nullable(),
  name: z.string(),
  scopes: z.array(z.string()),
  createdAt: timestamp,
  expiresAt: timestamp,
  lastUsedAt: timestamp.nullable(),
  revokedAt: timestamp.nullable(),
});
export type AdminToken = z.infer<typeof AdminTokenSchema>;

/** A webhook as the console shows it: its URL's host only (paths and queries may hold secrets). */
export const AdminWebhookSchema = z.object({
  id: z.uuid(),
  baseId: z.uuid(),
  baseName: z.string(),
  host: z.string(),
  enabled: z.boolean(),
  createdBy: z.uuid().nullable(),
  createdAt: timestamp,
  lastDeliveryAt: timestamp.nullable(),
});
export type AdminWebhook = z.infer<typeof AdminWebhookSchema>;

export const AdminWorkspaceDetailSchema = z.object({
  workspace: AdminWorkspaceSummarySchema.extend({ planOverrides: planOverridesSchema }),
  usage: WorkspaceUsageSchema.omit({ upgradeUrl: true }),
  members: z.array(
    z.object({
      userId: z.uuid(),
      email: z.string().nullable(),
      name: z.string().nullable(),
      role: z.string(),
    })
  ),
  /** Tokens granted this workspace or one of its bases. */
  tokens: z.array(AdminTokenSchema),
  webhooks: z.array(AdminWebhookSchema),
});
export type AdminWorkspaceDetail = z.infer<typeof AdminWorkspaceDetailSchema>;

export const adminSetPlanSchema = z.strictObject({
  /** null: back to the edition's default plan. */
  plan: planIdSchema.nullable(),
  overrides: planOverridesSchema,
});
export type AdminSetPlan = z.infer<typeof adminSetPlanSchema>;

export const adminSuspensionSchema = z
  .strictObject({
    suspended: z.boolean(),
    /** Why, for the audit log and other admins; required when suspending. */
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => !v.suspended || (v.reason ?? '') !== '', {
    path: ['reason'],
    message: 'Say why it is suspended.',
  });
export type AdminSuspension = z.infer<typeof adminSuspensionSchema>;

export const AdminUserSummarySchema = z.object({
  id: z.uuid(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  createdAt: timestamp,
  lastActiveAt: timestamp.nullable(),
  workspaces: z.number().int().min(0),
  isSystemAdmin: z.boolean(),
  suspendedAt: timestamp.nullable(),
  suspendedReason: z.string().nullable(),
  deletedAt: timestamp.nullable(),
});
export type AdminUserSummary = z.infer<typeof AdminUserSummarySchema>;

export const AdminUserListSchema = z.object({
  users: z.array(AdminUserSummarySchema),
  total: z.number().int().min(0),
});
export type AdminUserList = z.infer<typeof AdminUserListSchema>;

export const AdminUserDetailSchema = z.object({
  user: AdminUserSummarySchema,
  memberships: z.array(
    z.object({ workspaceId: z.uuid(), workspaceName: z.string(), role: z.string() })
  ),
  tokens: z.array(AdminTokenSchema),
});
export type AdminUserDetail = z.infer<typeof AdminUserDetailSchema>;

export const ImpersonationStartedSchema = z.object({
  userId: z.uuid(),
  expiresAt: timestamp,
});
export type ImpersonationStarted = z.infer<typeof ImpersonationStartedSchema>;

export const adminAuditQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(ADMIN_PAGE_MAX).default(ADMIN_PAGE_DEFAULT),
  /** The `nextBefore` of the previous page: entries older than this id. */
  before: z.uuid().optional(),
  userId: z.uuid().optional(),
  workspaceId: z.uuid().optional(),
});
export type AdminAuditQuery = z.input<typeof adminAuditQuerySchema>;

export const AdminAuditEntrySchema = z.object({
  id: z.uuid(),
  adminId: z.uuid(),
  adminEmail: z.string().nullable(),
  action: z.enum(ADMIN_AUDIT_ACTIONS),
  targetUserId: z.uuid().nullable(),
  targetWorkspaceId: z.uuid().nullable(),
  detail: z.record(z.string(), z.unknown()),
  createdAt: timestamp,
});
export type AdminAuditEntry = z.infer<typeof AdminAuditEntrySchema>;

export const AdminAuditListSchema = z.object({
  entries: z.array(AdminAuditEntrySchema),
  nextBefore: z.uuid().nullable(),
});
export type AdminAuditList = z.infer<typeof AdminAuditListSchema>;

/**
 * `GET /api/me/support-access`: when OpenRows staff viewed the account as the user (read-only
 * impersonation), newest first. The staff member isn't named.
 */
export const SupportAccessListSchema = z.object({
  entries: z.array(
    z.object({
      startedAt: timestamp,
      expiresAt: timestamp,
      reason: z.string().nullable(),
    })
  ),
});
export type SupportAccessList = z.infer<typeof SupportAccessListSchema>;

export const impersonateSchema = z.strictObject({
  /** Why (a support ticket), for the audit log and the user's account activity. */
  reason: z.string().trim().min(1).max(500),
});
export type Impersonate = z.infer<typeof impersonateSchema>;
