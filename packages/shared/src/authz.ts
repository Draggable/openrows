import { USER_ROLES, type UserRole } from './constants/index.js';

/**
 * The authorization vocabulary shared by server and client. The server enforces it
 * (packages/server/src/authz); the client may use `roleAllows` to hide what a user can't do,
 * which is a convenience only.
 */

/** Resources an action targets. Records, comments and fields are reached through their table. */
export const RESOURCE_KINDS = ['workspace', 'base', 'table', 'field', 'view', 'interface'] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/**
 * Every action, the resource kind it is checked against, and the lowest role allowed to do it.
 * Creating a child is checked against the parent (`base:create` on the workspace).
 */
export const ACTIONS = {
  'workspace:read': { on: 'workspace', minRole: 'read_only' },
  'workspace:update': { on: 'workspace', minRole: 'owner' },
  'workspace:delete': { on: 'workspace', minRole: 'owner' },
  // The workspace's subscription: checkout and the provider's customer portal.
  'workspace:manage_billing': { on: 'workspace', minRole: 'owner' },
  // The workspace's own AI provider and key.
  'workspace:manage_ai': { on: 'workspace', minRole: 'owner' },
  // The workspace's audit log, its export and SIEM stream (hosted Enterprise).
  'workspace:manage_audit': { on: 'workspace', minRole: 'owner' },
  // Single sign-on: the identity provider, its domains, "require SSO".
  'workspace:manage_sso': { on: 'workspace', minRole: 'owner' },
  // SCIM provisioning: its token, default role and groups' roles.
  'workspace:manage_scim': { on: 'workspace', minRole: 'owner' },
  // The admin console: the policies and the member list across bases.
  'workspace:manage_policies': { on: 'workspace', minRole: 'owner' },
  // Creators may invite and manage members up to creator; owner changes need an owner.
  'workspace:manage_members': { on: 'workspace', minRole: 'creator' },
  'base:create': { on: 'workspace', minRole: 'creator' },
  // The workspace's trash of bases: a trashed base resolves through its workspace only.
  'workspace:read_trash': { on: 'workspace', minRole: 'creator' },
  'base:restore': { on: 'workspace', minRole: 'creator' },
  'base:purge': { on: 'workspace', minRole: 'creator' },

  'base:read': { on: 'base', minRole: 'read_only' },
  'base:update': { on: 'base', minRole: 'creator' },
  'base:delete': { on: 'base', minRole: 'creator' },
  'base:manage_members': { on: 'base', minRole: 'creator' },
  /** Making, listing, changing and revoking a whole base's public share links. */
  'base:share': { on: 'base', minRole: 'creator' },
  /** Listing, taking, restoring and deleting a base's snapshots. */
  'base:snapshot': { on: 'base', minRole: 'creator' },
  /** Duplicating a base; the copy also needs `base:create` in the target workspace. */
  'base:duplicate': { on: 'base', minRole: 'creator' },
  /** Creating, changing, deleting and testing a base's webhooks, and reading their log. */
  'base:manage_webhooks': { on: 'base', minRole: 'creator' },
  /** Creating, changing, turning on and off and deleting automations, and reading runs. */
  'base:manage_automations': { on: 'base', minRole: 'creator' },
  /** The REST API v1's automations: listing them and reading their runs. */
  'base:read_automations': { on: 'base', minRole: 'creator' },
  /** Turning an automation on or off through the REST API v1. */
  'base:toggle_automations': { on: 'base', minRole: 'creator' },
  /** Triggering a webhook-received or button-clicked automation through the REST API v1. */
  'base:run_automations': { on: 'base', minRole: 'creator' },
  /** Building interfaces: pages, their drafts and publishing. Viewers use `base:read`. */
  'base:manage_interfaces': { on: 'base', minRole: 'creator' },
  /** A base's saved scripts: editors and up read and run them in the browser sandbox. */
  'base:read_scripts': { on: 'base', minRole: 'editor' },
  /** Creating, changing and deleting a base's saved scripts. */
  'base:manage_scripts': { on: 'base', minRole: 'creator' },
  /** A base's extension panel: anyone on the base sees it (data per their own role). */
  'base:read_extensions': { on: 'base', minRole: 'read_only' },
  /** Installing, arranging and removing a base's extensions. */
  'base:manage_extensions': { on: 'base', minRole: 'creator' },
  /** Changing an installed extension's settings. */
  'base:configure_extensions': { on: 'base', minRole: 'editor' },
  /** The base's plan-limit warnings: creators and owners see the banner. */
  'base:read_usage': { on: 'base', minRole: 'creator' },
  /** The AI assistant: change plans for the base, applied on confirm. */
  'base:ai_assistant': { on: 'base', minRole: 'creator' },
  'table:create': { on: 'base', minRole: 'creator' },
  // The base's trash: editors see it (they delete records and views), creators purge.
  'base:read_trash': { on: 'base', minRole: 'editor' },
  'table:restore': { on: 'base', minRole: 'creator' },
  'table:purge': { on: 'base', minRole: 'creator' },

  'table:read': { on: 'table', minRole: 'read_only' },
  'table:update': { on: 'table', minRole: 'creator' },
  'table:delete': { on: 'table', minRole: 'creator' },
  'table:duplicate': { on: 'table', minRole: 'creator' },
  /** Synced tables: a new table synced from another table or view the creator can read. */
  'table:create_sync': { on: 'base', minRole: 'creator' },
  /** A synced table's sync: its source, schedule and run history. */
  'table:read_sync': { on: 'table', minRole: 'read_only' },
  /** "Sync now" on a synced table. */
  'table:run_sync': { on: 'table', minRole: 'editor' },
  /** Changing the schedule, pausing, resuming or removing a table's sync. */
  'table:manage_sync': { on: 'table', minRole: 'creator' },
  'field:create': { on: 'table', minRole: 'creator' },
  'field:restore': { on: 'table', minRole: 'creator' },
  'field:purge': { on: 'table', minRole: 'creator' },
  'record:read_trash': { on: 'table', minRole: 'editor' },
  'record:purge': { on: 'table', minRole: 'creator' },
  'view:restore': { on: 'table', minRole: 'editor' },
  'view:purge': { on: 'table', minRole: 'creator' },
  'view:create': { on: 'table', minRole: 'editor' },
  // Sidebar sections (folders) of a table's views.
  'viewSection:create': { on: 'table', minRole: 'editor' },
  'viewSection:update': { on: 'table', minRole: 'editor' },
  'viewSection:delete': { on: 'table', minRole: 'editor' },
  'record:read': { on: 'table', minRole: 'read_only' },
  'record:create': { on: 'table', minRole: 'editor' },
  'record:update': { on: 'table', minRole: 'editor' },
  'record:delete': { on: 'table', minRole: 'editor' },
  // Uploading a file into an attachment cell; downloading needs `record:read`.
  'attachment:create': { on: 'table', minRole: 'editor' },
  'comment:read': { on: 'table', minRole: 'read_only' },
  // Commenting, reacting and editing or deleting your own comments.
  'comment:create': { on: 'table', minRole: 'commenter' },
  /** Deleting anyone's comment, checked in the comment service. */
  'comment:moderate': { on: 'table', minRole: 'creator' },

  'field:update': { on: 'field', minRole: 'creator' },
  'field:delete': { on: 'field', minRole: 'creator' },
  /** The link picker: the linked table is in the same base, so the same role reads it. */
  'field:link_candidates': { on: 'field', minRole: 'read_only' },
  /** An AI field's generation state per record. */
  'field:ai_status': { on: 'field', minRole: 'read_only' },
  /**
   * Generating an AI field's records again, or stopping it: editors name records, creators
   * the whole field (checked in the handler).
   */
  'field:ai_generate': { on: 'field', minRole: 'editor' },

  'view:read': { on: 'view', minRole: 'read_only' },
  'view:update': { on: 'view', minRole: 'editor' },
  'view:delete': { on: 'view', minRole: 'editor' },
  'view:duplicate': { on: 'view', minRole: 'editor' },
  /** Locking a view, and changing a locked view's configuration. */
  'view:lock': { on: 'view', minRole: 'creator' },
  /** Making, listing and revoking a view's public share links. */
  'view:share': { on: 'view', minRole: 'creator' },

  /**
   * An interface, reached by the people of its base and by its interface-only
   * collaborators (`interface_members`), whose role reaches no other resource: reading its
   * published pages, their records and numbers as the pages show them.
   */
  'interface:read': { on: 'interface', minRole: 'read_only' },
  /** Editing the fields a page makes editable and submitting a form page, through the page. */
  'interface:write': { on: 'interface', minRole: 'editor' },
  /** Inviting and removing an interface's interface-only collaborators. */
  'interface:manage_members': { on: 'interface', minRole: 'creator' },
} as const satisfies Record<string, { on: ResourceKind; minRole: UserRole }>;

export type Action = keyof typeof ACTIONS;

/** The actions checked against resource kind `K`. */
export type ActionOn<K extends ResourceKind> = {
  [A in Action]: (typeof ACTIONS)[A]['on'] extends K ? A : never;
}[Action];

/** 0 for `owner`, increasing down the ladder. */
function rank(role: UserRole): number {
  return USER_ROLES.indexOf(role);
}

/** Whether `role` may perform `action`. */
export function roleAllows(role: UserRole, action: Action): boolean {
  return rank(role) <= rank(ACTIONS[action].minRole);
}

/**
 * Personal access token scopes, named as Airtable's. A token's effective access is the
 * user's role ∩ the token's scopes ∩ its grants (workspaces or bases), checked in `authorize`.
 */
export const TOKEN_SCOPES = [
  'data.records:read',
  'data.records:write',
  'data.recordComments:read',
  'data.recordComments:write',
  'schema.bases:read',
  'schema.bases:write',
  'webhook:manage',
  'automations:read',
  'automations:manage',
  'automations:run',
  'user.email:read',
] as const;

export type TokenScope = (typeof TOKEN_SCOPES)[number];

/** What each scope allows, for the token form. */
export const TOKEN_SCOPE_DESCRIPTIONS: Record<TokenScope, string> = {
  'data.records:read': 'See records, their attachments and revisions',
  'data.records:write': 'Create, edit and delete records, upload attachments',
  'data.recordComments:read': 'See comments on records',
  'data.recordComments:write': 'Comment on records, edit and delete comments',
  'schema.bases:read': 'See workspaces, bases, tables, fields and views',
  'schema.bases:write': 'Create and change bases, tables, fields and views',
  'webhook:manage': "Create, change and delete a base's webhooks and read their delivery log",
  'automations:read': "See a base's automations and their run history",
  'automations:manage': 'Turn automations on and off',
  'automations:run': 'Trigger webhook and button automations',
  'user.email:read': "See the token owner's profile and email address",
};

/**
 * The scope a token needs for each action; null means a signed-in session only: account
 * and workspace settings, members, sharing, permissions, locking, snapshots and permanent
 * deletion are never done with a token. A route can narrow this further (`token` in its access
 * rule), never widen it past the user's role.
 */
export const ACTION_SCOPES = {
  'workspace:read': 'schema.bases:read',
  'workspace:update': null,
  'workspace:delete': null,
  'workspace:manage_billing': null,
  'workspace:manage_ai': null,
  'workspace:manage_audit': null,
  'workspace:manage_sso': null,
  'workspace:manage_scim': null,
  'workspace:manage_policies': null,
  'workspace:manage_members': null,
  'base:create': 'schema.bases:write',
  'workspace:read_trash': 'schema.bases:read',
  'base:restore': 'schema.bases:write',
  'base:purge': null,

  'base:read': 'schema.bases:read',
  'base:update': 'schema.bases:write',
  'base:delete': null,
  'base:manage_members': null,
  'base:share': null,
  'base:snapshot': null,
  'base:duplicate': null,
  'base:manage_webhooks': 'webhook:manage',
  // Building automations stays in the app; the REST API v1 lists, switches and
  // triggers them.
  'base:manage_automations': null,
  'base:read_automations': 'automations:read',
  'base:toggle_automations': 'automations:manage',
  'base:run_automations': 'automations:run',
  'base:manage_interfaces': null,
  // Scripts run in the app's sandbox with the signed-in session: no token access.
  'base:read_scripts': null,
  'base:manage_scripts': null,
  // Extensions run in the app's sandbox with the signed-in session: no token access.
  'base:read_extensions': null,
  'base:manage_extensions': null,
  'base:configure_extensions': null,
  'base:read_usage': null,
  'base:ai_assistant': null,
  'table:create': 'schema.bases:write',
  'base:read_trash': 'schema.bases:read',
  'table:restore': 'schema.bases:write',
  'table:purge': null,

  'table:read': 'schema.bases:read',
  'table:update': 'schema.bases:write',
  'table:delete': 'schema.bases:write',
  'table:duplicate': 'schema.bases:write',
  // A sync reads other bases as its creator: sessions only.
  'table:create_sync': null,
  'table:read_sync': 'schema.bases:read',
  'table:run_sync': null,
  'table:manage_sync': null,
  'field:create': 'schema.bases:write',
  'field:restore': 'schema.bases:write',
  'field:purge': null,
  'record:read_trash': 'data.records:read',
  'record:purge': null,
  'view:restore': 'schema.bases:write',
  'view:purge': null,
  'view:create': 'schema.bases:write',
  'viewSection:create': 'schema.bases:write',
  'viewSection:update': 'schema.bases:write',
  'viewSection:delete': 'schema.bases:write',
  'record:read': 'data.records:read',
  'record:create': 'data.records:write',
  'record:update': 'data.records:write',
  'record:delete': 'data.records:write',
  'attachment:create': 'data.records:write',
  'comment:read': 'data.recordComments:read',
  'comment:create': 'data.recordComments:write',
  'comment:moderate': 'data.recordComments:write',

  'field:update': 'schema.bases:write',
  'field:delete': 'schema.bases:write',
  'field:link_candidates': 'data.records:read',
  'field:ai_status': 'data.records:read',
  'field:ai_generate': 'data.records:write',

  'view:read': 'schema.bases:read',
  'view:update': 'schema.bases:write',
  'view:delete': 'schema.bases:write',
  'view:duplicate': 'schema.bases:write',
  'view:lock': null,
  'view:share': null,

  'interface:read': null,
  'interface:write': null,
  'interface:manage_members': null,
} as const satisfies Record<Action, TokenScope | null>;

/** The token-side half of the check: whether a token with `scopes` may do `action` at all. */
export function scopesAllow(
  scopes: readonly TokenScope[],
  action: Action,
  scope: TokenScope | null = ACTION_SCOPES[action]
): boolean {
  return scope !== null && scopes.includes(scope);
}
