import type { contracts, EndpointBody, EndpointInput } from '@openrows/shared';

/** Query string of the record list, as the caller writes it. */
export type ListQuery = NonNullable<EndpointInput<typeof contracts.records.list>['query']>;
/** Body of a view query, as the caller writes it. */
export type QueryBody = EndpointBody<typeof contracts.records.query>;

/**
 * Query keys, one factory for the whole client, so invalidation can target a resource at any
 * level: `queryKeys.records.table(id)` covers every list, query and record of that table.
 */
export const queryKeys = {
  me: () => ['me'] as const,
  /** What deleting the account would do. */
  accountDeletion: () => ['me', 'deletion'] as const,
  /** When staff viewed the account as the user. */
  supportAccess: () => ['me', 'support-access'] as const,
  /** The hosted ops console, system admins only. */
  admin: {
    all: () => ['admin'] as const,
    workspaces: (q: string, offset: number) => ['admin', 'workspaces', q, offset] as const,
    workspace: (workspaceId: string) => ['admin', 'workspace', workspaceId] as const,
    users: (q: string, offset: number) => ['admin', 'users', q, offset] as const,
    user: (userId: string) => ['admin', 'user', userId] as const,
    audit: (before: string | null) => ['admin', 'audit', before] as const,
  },
  /** The built-in templates: static, so cached for the session. */
  templates: {
    list: () => ['templates', 'list'] as const,
    detail: (slug: string) => ['templates', 'detail', slug] as const,
  },
  workspaces: {
    all: () => ['workspaces'] as const,
    list: () => ['workspaces', 'list'] as const,
    detail: (workspaceId: string) => ['workspaces', 'detail', workspaceId] as const,
    members: (workspaceId: string) => ['workspaces', 'members', workspaceId] as const,
    invitations: (workspaceId: string) => ['workspaces', 'invitations', workspaceId] as const,
    /** The plan, its limits and what the workspace uses. */
    usage: (workspaceId: string) => ['workspaces', 'usage', workspaceId] as const,
    /** The subscription and the plans to buy (owners). */
    billing: (workspaceId: string) => ['workspaces', 'billing', workspaceId] as const,
    /** Whether AI features are on (members) and the owners' AI settings. */
    ai: (workspaceId: string) => ['workspaces', 'ai', workspaceId] as const,
    aiSettings: (workspaceId: string) => ['workspaces', 'ai', workspaceId, 'settings'] as const,
    /** The audit log: its pages per filter, and its SIEM stream. */
    auditLog: (workspaceId: string, filters?: Record<string, string>) =>
      filters
        ? (['workspaces', 'audit', workspaceId, 'log', filters] as const)
        : (['workspaces', 'audit', workspaceId, 'log'] as const),
    auditStream: (workspaceId: string) => ['workspaces', 'audit', workspaceId, 'stream'] as const,
    /** Single sign-on: the provider, the domains and the service provider's URLs. */
    sso: (workspaceId: string) => ['workspaces', 'sso', workspaceId] as const,
    scim: (workspaceId: string) => ['workspaces', 'scim', workspaceId] as const,
    /** The admin console: the policies and the member list across bases. */
    policies: (workspaceId: string) => ['workspaces', 'policies', workspaceId] as const,
    adminMembers: (workspaceId: string) => ['workspaces', 'admin-members', workspaceId] as const,
    /** The collaborator directory; under `all`, so membership changes refresh it. */
    collaborators: (workspaceId: string) => ['workspaces', 'collaborators', workspaceId] as const,
  },
  invitations: {
    preview: (token: string) => ['invitations', token] as const,
  },
  bases: {
    all: () => ['bases'] as const,
    list: (workspaceId: string) => ['bases', 'list', workspaceId] as const,
    detail: (baseId: string) => ['bases', 'detail', baseId] as const,
    /** Who has access to a base. */
    collaborators: (baseId: string) => ['bases', 'collaborators', baseId] as const,
    invitations: (baseId: string) => ['bases', 'invitations', baseId] as const,
    /** The base banner's plan-limit warnings. */
    usageWarnings: (baseId: string) => ['bases', 'usage-warnings', baseId] as const,
  },
  /** A base duplicate running in the worker; outside `bases`, which it invalidates. */
  duplicates: {
    detail: (duplicateId: string) => ['duplicates', duplicateId] as const,
  },
  tables: {
    all: () => ['tables'] as const,
    list: (baseId: string) => ['tables', 'list', baseId] as const,
    /** A table with its fields (fields live in the table detail). */
    detail: (tableId: string) => ['tables', 'detail', tableId] as const,
  },
  imports: {
    detail: (importId: string) => ['imports', importId] as const,
  },
  /** A synced table's sync: top-level, as its polling invalidates the table and records. */
  syncs: {
    detail: (tableId: string) => ['syncs', tableId] as const,
  },
  /** Sync connectors and the caller's connected accounts. */
  syncConnectors: {
    list: () => ['sync-connectors'] as const,
    items: (baseId: string, connector: string, path: readonly string[], search: string) =>
      ['sync-connectors', 'items', baseId, connector, ...path, `?${search}`] as const,
  },
  views: {
    all: () => ['views'] as const,
    list: (tableId: string) => ['views', 'list', tableId] as const,
    detail: (viewId: string) => ['views', 'detail', viewId] as const,
  },
  /** Record comments: apart from `records`, so record refetches leave them alone. */
  comments: {
    all: () => ['comments'] as const,
    record: (tableId: string, recordId: string) =>
      ['comments', tableId, 'record', recordId] as const,
    counts: (tableId: string) => ['comments', tableId, 'counts'] as const,
    mentionable: (tableId: string) => ['comments', tableId, 'mentionable'] as const,
  },
  /** Record revision history, apart from `records` like comments. */
  revisions: {
    all: () => ['revisions'] as const,
    record: (tableId: string, recordId: string) =>
      ['revisions', tableId, 'record', recordId] as const,
  },
  /** The signed-in user's notifications: the inbox, the bell's count, email preference. */
  notifications: {
    all: () => ['notifications'] as const,
    list: () => ['notifications', 'list'] as const,
    unread: () => ['notifications', 'unread'] as const,
    preferences: () => ['notifications', 'preferences'] as const,
  },
  /** Data residency: the regions a workspace can live in. */
  regions: {
    list: () => ['regions'] as const,
  },
  /** Service notices: the banner's undismissed notices. */
  notices: {
    list: () => ['notices'] as const,
  },
  /** The trash: a base's tables, fields and views, a table's records, a workspace's bases. */
  trash: {
    all: () => ['trash'] as const,
    base: (baseId: string) => ['trash', 'base', baseId] as const,
    records: (tableId: string) => ['trash', 'records', tableId] as const,
    workspace: (workspaceId: string) => ['trash', 'workspace', workspaceId] as const,
  },
  /** The signed-in user's personal access tokens. */
  tokens: {
    list: () => ['tokens'] as const,
  },
  /** OAuth apps: the ones you registered, the ones you authorized, a consent request. */
  oauth: {
    apps: () => ['oauth', 'apps'] as const,
    authorizations: () => ['oauth', 'authorizations'] as const,
    request: (query: string) => ['oauth', 'request', query] as const,
  },
  /** The server's OpenAPI document, for the API reference. */
  openApi: () => ['openapi'] as const,
  /** A base's webhooks and their delivery logs. */
  webhooks: {
    base: (baseId: string) => ['webhooks', baseId] as const,
    deliveries: (baseId: string, webhookId: string) =>
      ['webhooks', baseId, webhookId, 'deliveries'] as const,
  },
  /** A base's interfaces and their pages. */
  interfaces: {
    base: (baseId: string) => ['interfaces', baseId] as const,
    /** A page's numbers and charts: under the base, so saving a draft refetches them. */
    data: (baseId: string, pageId: string, input?: unknown) =>
      input === undefined
        ? (['interfaces', baseId, 'data', pageId] as const)
        : (['interfaces', baseId, 'data', pageId, input] as const),
    /** A page's records, under the base too: a saved draft refetches them. */
    records: (baseId: string, pageId: string, input?: unknown) =>
      input === undefined
        ? (['interfaces', baseId, 'records', pageId] as const)
        : (['interfaces', baseId, 'records', pageId, input] as const),
    /** One interface as the viewer reaches it. */
    access: (interfaceId: string) => ['interfaceAccess', interfaceId] as const,
    /** The interfaces shared with the viewer alone. */
    sharedWithMe: () => ['interfacesSharedWithMe'] as const,
    /** An interface's interface-only collaborators and invitations. */
    collaborators: (interfaceId: string) => ['interfaceCollaborators', interfaceId] as const,
  },
  /** A base's saved scripts. */
  scripts: (baseId: string) => ['scripts', baseId] as const,
  /** A base's extension panel and an installation's bundle. */
  extensions: (baseId: string) => ['extensions', baseId] as const,
  extensionBundle: (baseId: string, extensionId: string) =>
    ['extensions', baseId, 'bundle', extensionId] as const,
  /** A base's automations and their runs. */
  automations: {
    base: (baseId: string) => ['automations', baseId] as const,
    failed: (baseId: string) => ['automations', baseId, 'failed'] as const,
    runs: (baseId: string, automationId: string, status?: string) =>
      ['automations', baseId, automationId, 'runs', status ?? 'all'] as const,
  },
  /** Airtable imports a person started in a workspace. */
  airtableImports: (workspaceId: string) => ['airtableImports', workspaceId] as const,
  /** Imports started in this browser, watched for the toast when they end. */
  airtableWatch: (ids: readonly string[]) => ['airtableWatch', ...ids] as const,
  /** A base's snapshots. */
  snapshots: {
    base: (baseId: string) => ['snapshots', baseId] as const,
    /** A restore running in the worker. */
    restore: (restoreId: string) => ['snapshots', 'restores', restoreId] as const,
  },
  /** A view's or a base's share links. */
  shares: {
    list: (viewId: string) => ['shares', 'view', viewId] as const,
    listBase: (baseId: string) => ['shares', 'base', baseId] as const,
  },
  /** A share link's public page, by token: its summary, then each view it opens. */
  /** Public forms, by their link's token. */
  forms: {
    form: (token: string) => ['form', token] as const,
    /** A link field's picker on the public form. */
    linkRecords: (token: string, fieldId: string, search: string) =>
      ['form', token, 'links', fieldId, search] as const,
  },
  shared: {
    all: (token: string) => ['shared', token] as const,
    share: (token: string) => ['shared', token, 'share'] as const,
    view: (token: string, viewId: string) => ['shared', token, 'view', viewId] as const,
    records: (token: string, viewId: string, offset: number, limit: number) =>
      ['shared', token, 'view', viewId, 'records', offset, limit] as const,
    /** Every record a shared layout shows, in a date window or all. */
    layout: (token: string, viewId: string, from: string | null, to: string | null) =>
      ['shared', token, 'view', viewId, 'layout', from, to] as const,
  },
  fields: {
    trash: (tableId: string) => ['fields', 'trash', tableId] as const,
  },
  /** An AI field's generation state, polled while cells are pending: a key of its own. */
  aiFields: {
    status: (fieldId: string) => ['aiFields', fieldId] as const,
  },
  records: {
    /** Every table's records (and the link picker's searches). */
    all: () => ['records'] as const,
    /** Records a link field can link to, for the picker. */
    linkCandidates: (fieldId: string, search: string) =>
      ['records', 'link-candidates', fieldId, search] as const,
    /** Records a link filter can pick: every record of the linked table, paged. */
    filterCandidates: (fieldId: string, search: string) =>
      ['records', 'link-candidates', fieldId, 'filter', search] as const,
    /** The names of the records a link filter names by id. */
    linkedNames: (fieldId: string, ids: readonly string[]) =>
      ['records', 'link-candidates', fieldId, 'ids', ...ids] as const,
    /** Everything cached for one table's records. */
    table: (tableId: string) => ['records', tableId] as const,
    list: (tableId: string, query: ListQuery = {}) => ['records', tableId, 'list', query] as const,
    queries: (tableId: string) => ['records', tableId, 'query'] as const,
    query: (tableId: string, input: QueryBody = {}) =>
      ['records', tableId, 'query', input] as const,
    detail: (tableId: string, recordId: string) =>
      ['records', tableId, 'detail', recordId] as const,
  },
};
