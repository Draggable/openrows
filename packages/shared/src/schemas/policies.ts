import { z } from 'zod';
import { USER_ROLES } from '../constants/index.js';
import { ssoDomainSchema } from './sso.js';

/**
 * Workspace policies (the hosted admin console on Enterprise plans): what the workspace's
 * owners allow beyond the roles. The core stores and enforces them (`workspace_policies`, read by
 * `authz_resolve` and `share_resolve`); only the hosted edition serves the routes that change
 * them, so a self-hosted workspace has the defaults, which allow everything.
 */

/** At most this many email domains invitations may go to. */
export const POLICY_INVITE_DOMAINS_MAX = 50;

export const workspacePoliciesSchema = z.strictObject({
  /** Public share links of views and whole bases. Off: new ones are refused and the
   * existing ones stop opening (they come back when it's on again, unless revoked). */
  shareLinks: z.boolean(),
  /** Public form links, the same way. */
  publicForms: z.boolean(),
  /** Share links embedded on other sites: off, no link can be framed or get embed origins. */
  embeds: z.boolean(),
  /** Personal access tokens (the REST API, the SDK, MCP, n8n) on the workspace's data. */
  personalAccessTokens: z.boolean(),
  /** Invitations (to the workspace, a base or an interface) only to these domains; empty: any. */
  inviteDomains: z
    .array(ssoDomainSchema)
    .max(POLICY_INVITE_DOMAINS_MAX)
    .refine((d) => new Set(d).size === d.length, 'each domain once'),
});
export type WorkspacePolicies = z.infer<typeof workspacePoliciesSchema>;

/** What a workspace has without a stored policy: everything allowed. */
export const DEFAULT_WORKSPACE_POLICIES: WorkspacePolicies = Object.freeze({
  shareLinks: true,
  publicForms: true,
  embeds: true,
  personalAccessTokens: true,
  inviteDomains: [],
}) as WorkspacePolicies;

/** Whether `policies` allow everything (the defaults). */
export function isDefaultPolicies(policies: WorkspacePolicies): boolean {
  return (
    policies.shareLinks &&
    policies.publicForms &&
    policies.embeds &&
    policies.personalAccessTokens &&
    policies.inviteDomains.length === 0
  );
}

/** Whether an invitation to `email` is allowed by the invite domains (empty: any address). */
export function inviteDomainAllowed(domains: readonly string[], email: string): boolean {
  if (domains.length === 0) return true;
  const at = email.lastIndexOf('@');
  const domain = at < 0 ? '' : email.slice(at + 1).toLowerCase();
  return domains.includes(domain);
}

const timestamp = z.iso.datetime({ offset: true });

export const WorkspacePoliciesStateSchema = z.object({
  /** The plan has the admin console; without it only turning every restriction off is accepted. */
  available: z.boolean(),
  policies: workspacePoliciesSchema,
  /** "Require SSO" is set with the identity provider, on the single sign-on page. */
  sso: z.object({ configured: z.boolean(), enabled: z.boolean(), requireSso: z.boolean() }),
  scim: z.object({ configured: z.boolean() }),
  updatedAt: timestamp.nullable(),
});
export type WorkspacePoliciesState = z.infer<typeof WorkspacePoliciesStateSchema>;

/** At most this many people in the admin console's member list. */
export const ADMIN_MEMBERS_MAX = 5_000;
/** At most this many bases listed per person (`baseCount` counts them all). */
export const ADMIN_MEMBER_BASES_MAX = 20;

export const AdminMemberSchema = z.object({
  userId: z.uuid(),
  name: z.string().nullable(),
  email: z.string(),
  /** Null: a collaborator on some bases or interfaces only. */
  workspaceRole: z.enum(USER_ROLES).nullable(),
  bases: z.array(z.object({ id: z.uuid(), name: z.string(), role: z.enum(USER_ROLES) })),
  baseCount: z.number().int().min(0),
  interfaceCount: z.number().int().min(0),
  /** Their last request to the workspace's data (sessions and tokens), to the 10 minutes. */
  lastActiveAt: timestamp.nullable(),
  /** Managed by the identity provider over SCIM. */
  provisioned: z.boolean(),
});
export type AdminMember = z.infer<typeof AdminMemberSchema>;

export const AdminMembersSchema = z.object({
  members: z.array(AdminMemberSchema),
  truncated: z.boolean(),
});
export type AdminMembers = z.infer<typeof AdminMembersSchema>;
