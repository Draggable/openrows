import { z } from 'zod';
import { SSO_JIT_ROLES } from './sso.js';

/**
 * SCIM 2.0 provisioning (RFC 7643/7644): a workspace's identity provider (Okta, Microsoft
 * Entra ID, ...) creates, updates and deactivates the workspace's people and groups through
 * `/scim/v2` with the workspace's bearer token. A provisioned person on one of the workspace's
 * verified single sign-on domains is a member while active, with the highest role of
 * their groups that the owners mapped to one (or the default role); deactivating them removes the
 * membership and ends their sessions. Only the hosted edition serves it, on
 * plans with `scim`; these are the owners' settings.
 */

/** The roles provisioning gives: never owner (owners are managed in OpenRows). */
export const SCIM_ROLES = SSO_JIT_ROLES;
export type ScimRole = (typeof SCIM_ROLES)[number];

/** Where the identity provider sends its requests, after the app's URL. */
export const SCIM_BASE_PATH = '/scim/v2';
/** Tokens start with this, so a leaked one is recognisable. */
export const SCIM_TOKEN_PREFIX = 'or_scim_';

/** Caps: users and groups per workspace, a page of a list, a request's body. */
export const SCIM_USERS_MAX = 10_000;
export const SCIM_GROUPS_MAX = 1_000;
export const SCIM_PAGE_DEFAULT = 100;
export const SCIM_PAGE_MAX = 200;
export const SCIM_BODY_MAX_BYTES = 1024 * 1024;
/** PATCH operations per request. */
export const SCIM_PATCH_OPS_MAX = 1_000;

const timestamp = z.iso.datetime({ offset: true });

export const ScimGroupSummarySchema = z.object({
  id: z.uuid(),
  displayName: z.string(),
  externalId: z.string().nullable(),
  /** The role members get from this group; null: none (the default role applies). */
  role: z.enum(SCIM_ROLES).nullable(),
  members: z.number().int().min(0),
});
export type ScimGroupSummary = z.infer<typeof ScimGroupSummarySchema>;

export const ScimStateSchema = z.object({
  /** The SCIM base URL to enter at the identity provider. */
  baseUrl: z.string(),
  /** The token in use (never the token itself), or null when there is none. */
  token: z
    .object({ hint: z.string(), createdAt: timestamp, lastUsedAt: timestamp.nullable() })
    .nullable(),
  defaultRole: z.enum(SCIM_ROLES),
  /** The workspace's verified single sign-on domains: provisioned addresses must be on one. */
  verifiedDomains: z.array(z.string()),
  users: z.object({
    total: z.number().int().min(0),
    active: z.number().int().min(0),
    /** Active ones whose OpenRows account exists (the others join at their first sign-in). */
    linked: z.number().int().min(0),
  }),
  groups: z.array(ScimGroupSummarySchema),
});
export type ScimState = z.infer<typeof ScimStateSchema>;

export const ScimTokenCreatedSchema = z.object({
  /** Shown once: only its SHA-256 is stored. */
  token: z.string(),
  state: ScimStateSchema,
});
export type ScimTokenCreated = z.infer<typeof ScimTokenCreatedSchema>;

export const scimSettingsInputSchema = z.strictObject({ defaultRole: z.enum(SCIM_ROLES) });
export type ScimSettingsInput = z.infer<typeof scimSettingsInputSchema>;

export const scimGroupRoleInputSchema = z.strictObject({ role: z.enum(SCIM_ROLES).nullable() });
export type ScimGroupRoleInput = z.infer<typeof scimGroupRoleInputSchema>;
