import {
  ACTION_SCOPES,
  ACTIONS,
  type Action,
  type BaseRole,
  type InterfaceRole,
  type ResourceKind,
  roleAllows,
  scopesAllow,
  type TokenScope,
  USER_ROLES,
  type UserRole,
} from '@openrows/shared';
import type { Principal } from '../auth/sessions.js';
import type { TokenGrant } from '../auth/tokens.js';
import { AppError } from '../lib/errors.js';

/** A resource with its tenant and the requesting user's roles, from `resolveResource`. */
export interface ResolvedResource<K extends ResourceKind = ResourceKind> {
  kind: K;
  id: string;
  workspaceId: string;
  /** Null for a workspace. */
  baseId: string | null;
  workspaceRole: UserRole | null;
  baseRole: BaseRole | null;
  /**
   * An interface's own role (`interface_members`): only on an `interface` resource, where
   * it counts beside the workspace and base roles. Nothing else ever sees it.
   */
  interfaceRole?: InterfaceRole | null;
  /** The workspace is suspended: only what a read-only member may do is allowed. */
  suspended?: boolean;
  /**
   * The workspace's policy allows personal access tokens (`workspace_policies`); absent:
   * allowed. A token is refused on everything of a workspace that turned them off.
   */
  tokensAllowed?: boolean;
  /** When the user last used the workspace (the admin console); null: never recorded. */
  lastActiveAt?: Date | null;
}

/** A resource the principal may act on, with their effective role. */
export interface AuthorizedResource<K extends ResourceKind = ResourceKind>
  extends ResolvedResource<K> {
  role: UserRole;
}

export type Decision =
  | { allowed: true; role: UserRole }
  | {
      allowed: false;
      reason: 'unauthenticated' | 'not_found' | 'forbidden' | 'suspended' | 'policy';
    };

/** The higher of two roles (null is no role). */
export function higherRole(a: UserRole | null, b: UserRole | null): UserRole | null {
  if (a === null) return b;
  if (b === null) return a;
  return USER_ROLES.indexOf(a) <= USER_ROLES.indexOf(b) ? a : b;
}

/**
 * The user's role on a resource. Inside a base, it is the higher of the workspace role and the
 * base role (as in Airtable: a base role can raise a workspace member's access there, never
 * lower it), so workspace owners are owners everywhere. Base roles don't apply to the workspace
 * itself. Null means no access at all. On an interface, its interface-only role counts
 * too, there and nowhere else.
 */
export function effectiveRole(r: ResolvedResource): UserRole | null {
  if (r.kind === 'workspace') return r.workspaceRole;
  const role = higherRole(r.workspaceRole, r.baseRole);
  return r.kind === 'interface' ? higherRole(role, r.interfaceRole ?? null) : role;
}

/**
 * Whether the user reaches the resource only through an interface's own role: an
 * interface-only collaborator, who has no access to the base itself.
 */
export function interfaceOnly(r: ResolvedResource): boolean {
  return (
    r.kind === 'interface' &&
    higherRole(r.workspaceRole, r.baseRole) === null &&
    (r.interfaceRole ?? null) !== null
  );
}

/** Whether a token's grants reach the resource: its workspace, or (inside a base) that base. */
export function tokenReaches(token: TokenGrant, r: ResolvedResource): boolean {
  if (token.workspaceIds.includes(r.workspaceId)) return true;
  return r.kind !== 'workspace' && r.baseId !== null && token.baseIds.includes(r.baseId);
}

/**
 * The single authorization decision every route goes through (ADR-002). `resource` is null when
 * it doesn't exist. Someone with no role on an existing resource gets `not_found`, never
 * `forbidden`, so ids from another tenant don't reveal that they exist (claude-review L2).
 * Being a system admin grants nothing here: admin endpoints have their own path (ADR-002 §7).
 *
 * With a personal access token the access is the user's role ∩ the token's scopes ∩ its
 * grants: a resource outside the grants is `not_found` as well, and an action whose `scope`
 * (from `ACTION_SCOPES`, or the route's narrower rule) the token lacks, or that needs a session
 * (null), is `forbidden`. The role is the user's current one, never stored with the token.
 */
export function authorize(
  principal: Principal | null,
  action: Action,
  resource: ResolvedResource | null,
  scope: TokenScope | null = ACTION_SCOPES[action]
): Decision {
  if (!principal) return { allowed: false, reason: 'unauthenticated' };
  if (!resource) return { allowed: false, reason: 'not_found' };
  if (ACTIONS[action].on !== resource.kind) {
    // A wiring bug, not a user error: fail loudly.
    throw new Error(
      `authorize: ${action} is checked on a ${ACTIONS[action].on}, not a ${resource.kind}`
    );
  }
  const role = effectiveRole(resource);
  if (!role) return { allowed: false, reason: 'not_found' };
  const { token } = principal;
  if (token && !tokenReaches(token, resource)) return { allowed: false, reason: 'not_found' };
  if (token && resource.tokensAllowed === false) return { allowed: false, reason: 'policy' };
  if (!roleAllows(role, action)) return { allowed: false, reason: 'forbidden' };
  if (token && !scopesAllow(token.scopes, action, scope)) {
    return { allowed: false, reason: 'forbidden' };
  }
  if (resource.suspended && ACTIONS[action].minRole !== 'read_only') {
    return { allowed: false, reason: 'suspended' };
  }
  return { allowed: true, role };
}

/**
 * Whether the principal may do `action` with `role` (a check inside a handler, after the route's
 * own `authorize`): the role allows it and, for a token, its scopes do too.
 */
export function principalMay(principal: Principal, role: UserRole, action: Action): boolean {
  if (!roleAllows(role, action)) return false;
  return !principal.token || scopesAllow(principal.token.scopes, action);
}

/** 403 for a personal access token: `what` needs a signed-in session. */
export function assertSession(principal: Principal, what: string): void {
  if (principal.token) {
    throw new AppError('FORBIDDEN', {
      detail: `${what} needs a signed-in session; personal access tokens can't do it.`,
    });
  }
}

const DENIAL_CODES = {
  unauthenticated: 'UNAUTHENTICATED',
  not_found: 'NOT_FOUND',
  forbidden: 'FORBIDDEN',
  suspended: 'WORKSPACE_SUSPENDED',
  policy: 'POLICY_RESTRICTED',
} as const;

/** Throws the problem+json error for a refusal (401, 404 or 403); returns the role otherwise. */
export function assertAllowed(decision: Decision): UserRole {
  if (decision.allowed) return decision.role;
  if (decision.reason === 'policy') {
    throw new AppError('POLICY_RESTRICTED', {
      detail: "This workspace's policy doesn't allow personal access tokens.",
    });
  }
  throw new AppError(DENIAL_CODES[decision.reason]);
}
