import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isV1Path, TOKEN_SCOPES, USER_ROLES, type UserRole } from '@openrows/shared';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_BASE_ID, FIXTURE_TOKEN } from '../../src/airtable/__fixtures__/fake.js';
import { storageKey } from '../../src/attachments/service.js';
import { createCipher } from '../../src/auth/crypto.js';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import type { RouteEntry } from '../../src/authz/routes.js';
import { inScope } from '../../src/authz/scope.js';
import { generateHookToken, hashHookToken } from '../../src/automations/secrets.js';
import { DEV_DEFAULTS } from '../../src/config.js';
import { qualified } from '../../src/data/columns.js';
import {
  attachments,
  automationRuns,
  automations,
  baseExtensions,
  baseMembers,
  baseScripts,
  baseSnapshots,
  bases,
  fields,
  formSubmissions,
  interfaceMembers,
  interfacePages,
  interfaces,
  legalNotices,
  notifications,
  oauthApps,
  oauthAuthorizations,
  outbox,
  personalAccessTokens,
  recordCommentReactions,
  recordComments,
  recordRevisions,
  shares,
  tableSyncRuns,
  tableSyncs,
  tables,
  viewSections,
  views,
  webhookDeliveries,
  webhooks,
  workspaceAiSettings,
  workspaceInvitations,
  workspaceMembers,
  workspaces,
} from '../../src/db/index.js';
import { createField } from '../../src/fields/service.js';
import { generateShareToken, hashShareToken } from '../../src/shares/service.js';
import { takeSnapshot } from '../../src/snapshots/writer.js';
import { generateInvitationToken, hashInvitationToken } from '../../src/workspaces/service.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import {
  addMember,
  createBase,
  createRecordsIn,
  createSession,
  createTableWithFields,
  createToken,
  createUser,
  createWorkspace,
} from '../helpers/factories.js';
import { MemoryObjectStore } from '../helpers/object-store.js';

/**
 * The cross-tenant authorization matrix (ADR-002): every route in the registry is called as
 * every kind of caller, each time against a fresh world, through the app connected as
 * openrows_app. A route without a case here fails the run, so new routes must state who may
 * call them. Refused writes must leave the data untouched.
 */

const CALLERS = [...USER_ROLES, 'otherTenant', 'anonymous'] as const;
type Caller = (typeof CALLERS)[number];

/**
 * Cross-base callers, run against every route too: a base-only editor of the world's base
 * (no workspace role), and a base-only creator of a sibling base in the same workspace.
 */
const CROSS_BASE_CALLERS = ['baseGuest', 'otherBaseCreator'] as const;
type CrossBaseCaller = (typeof CROSS_BASE_CALLERS)[number];

/**
 * Interface-only collaborators, run against every route too: an editor and a read-only
 * collaborator of the world's interface alone (no workspace or base role). On the interface's own
 * routes they answer as an editor and a read-only member; the base, its tables, fields, views,
 * other interfaces and the workspace are 404 to them; anything else answers as for another tenant.
 */
const INTERFACE_CALLERS = ['interfaceEditor', 'interfaceViewer'] as const;
type InterfaceCaller = (typeof INTERFACE_CALLERS)[number];

/**
 * Personal access token callers, run against every route too: the owner's and the
 * read-only member's tokens with every scope, granted the world's workspace; the owner's token
 * with only `webhook:manage` (the webhook routes' scope); and the owner's token granted only the other tenant's
 * workspace.
 */
const TOKEN_CALLERS = ['ownerToken', 'readOnlyToken', 'scopelessToken', 'elsewhereToken'] as const;
type TokenCaller = (typeof TOKEN_CALLERS)[number];

/** The ids of a world, by path parameter name. */
interface Params extends Record<string, string> {
  workspaceId: string;
  tokenId: string;
  /** The owner's OAuth app, its client id, and the owner's authorization of it. */
  appId: string;
  oauthClientId: string;
  authorizationId: string;
  fieldId: string;
  trashedBaseId: string;
  trashedTableId: string;
  trashedViewId: string;
  attachmentFieldId: string;
  linkFieldId: string;
  recordId: string;
  deletedRecordId: string;
  viewId: string;
  baseInvitationId: string;
  baseShareId: string;
  snapshotId: string;
  webhookId: string;
  deliveryId: string;
  automationId: string;
  hookAutomationId: string;
  failedRunId: string;
  hookToken: string;
  buttonFieldId: string;
  /** An AI field of the table, its prompt reading the primary field. */
  aiFieldId: string;
  interfaceId: string;
  pageId: string;
  /** A saved script of the base. */
  scriptId: string;
  /** An installed extension of the base. */
  extensionId: string;
  /** A table of the base synced from the world's table. */
  syncTableId: string;
  /** A form page of the interface. */
  formPageId: string;
  /** The interface's read-only interface-only collaborator, and a pending interface invitation. */
  interfaceMemberId: string;
  interfaceInvitationId: string;
  /** A billing provider's name: none in the OSS edition. */
  provider: string;
  /** A sync connector's id: none in the OSS edition. */
  connectorId: string;
}

/** A request body, or one built from the world's ids. */
type Body = Record<string, unknown> | ((params: Params) => Record<string, unknown>);

interface Case {
  /** Status per caller. */
  expect: Record<Caller, number>;
  body?: Body;
  /** A query string for the request, e.g. `?since=0`, or one built from the world's ids. */
  query?: string | ((params: Params) => string);
  /** Path parameters filled from another of the world's ids, e.g. a base invitation's. */
  params?: Record<string, keyof Params>;
  /** Cross-base statuses where they differ from `crossBaseDefault`. */
  crossBase?: Partial<Record<CrossBaseCaller, number>>;
  /** Interface-only statuses where they differ from `interfaceOnlyExpect`. */
  interfaceOnly?: Partial<Record<InterfaceCaller, number>>;
  /** Token caller statuses where they differ from `tokenExpect`. */
  tokens?: Partial<Record<TokenCaller, number>>;
  /** Extra request headers (the MCP endpoint's Accept). */
  headers?: Record<string, string>;
}

const BASE_SCOPED =
  /^\/api\/(bases|tables|fields|views|interfaces|v1\/:baseId|v1\/meta\/bases\/:baseId|v1\/bases\/:baseId)\//;
const WORKSPACE_SCOPED = /^\/api\/workspaces\/:workspaceId/;

/**
 * What a cross-base caller gets by default: inside the base (base, table, field and view routes)
 * the base-only editor is an editor and the other base's creator has no role (404); workspace
 * routes are 404 to both (no workspace role); anything else (public and session routes) answers
 * as for another tenant.
 */
function crossBaseExpect(path: string, c: Case, caller: CrossBaseCaller): number {
  const override = c.crossBase?.[caller];
  if (override !== undefined) return override;
  if (BASE_SCOPED.test(path)) return caller === 'baseGuest' ? c.expect.editor : 404;
  if (WORKSPACE_SCOPED.test(path)) return 404;
  return c.expect.otherTenant;
}

/** An interface's own routes, reached by its interface-only collaborators. */
const INTERFACE_SCOPED = /^\/api\/interfaces\/:interfaceId/;

function interfaceOnlyExpect(path: string, c: Case, caller: InterfaceCaller): number {
  const override = c.interfaceOnly?.[caller];
  if (override !== undefined) return override;
  if (INTERFACE_SCOPED.test(path)) {
    return c.expect[caller === 'interfaceEditor' ? 'editor' : 'read_only'];
  }
  if (BASE_SCOPED.test(path) || WORKSPACE_SCOPED.test(path)) return 404;
  return c.expect.otherTenant;
}

const every = (status: number) =>
  Object.fromEntries(CALLERS.map((c) => [c, status])) as Record<Caller, number>;

/** Anyone, signed in or not, gets `status`. */
const open = (status: number): Case => ({ expect: every(status) });

/** Signed-in users get `status`; anonymous callers 401. */
const signedIn = (status: number, body?: Body): Case => ({
  expect: { ...every(status), anonymous: 401 },
  body,
});

/**
 * `allowed` roles get `status`; other members 403; another tenant 404 (never 403, so ids don't
 * leak across tenants); anonymous callers 401.
 */
const roles = (status: number, allowed: readonly UserRole[], body?: Body): Case => ({
  expect: {
    ...(Object.fromEntries(
      USER_ROLES.map((r) => [r, allowed.includes(r) ? status : 403])
    ) as Record<UserRole, number>),
    otherTenant: 404,
    anonymous: 401,
  },
  body,
});

/**
 * Personal access tokens only: every token caller gets `status` (the MCP endpoint answers
 * any valid token; its tools are checked per call), cookie sessions and anonymous callers 401.
 */
const tokenOnly = (status: number, body?: Body): Case => ({
  expect: every(401),
  tokens: Object.fromEntries(TOKEN_CALLERS.map((c) => [c, status])),
  body,
  headers: { accept: 'application/json, text/event-stream' },
});

/** An MCP `initialize` request. */
const MCP_INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'authz-matrix', version: '0' },
  },
};

const ALL = USER_ROLES;
const CREATORS: UserRole[] = ['owner', 'creator'];
const EDITORS: UserRole[] = ['owner', 'creator', 'editor'];
const COMMENTERS: UserRole[] = ['owner', 'creator', 'editor', 'commenter'];

/** The REST API v1's table parameter, by the world's table id. */
const V1_TABLE = { tableIdOrName: 'tableId' } as const;

const CASES: Record<string, Case> = {
  'GET /health': open(200),
  'GET /ready': open(200),
  // Sign-in isn't configured in this app: login answers 503, the callback redirects to /login.
  'GET /auth/login': open(503),
  'GET /auth/signup': open(503),
  'GET /auth/providers': open(200),
  'GET /auth/callback': open(302),
  'POST /auth/logout': open(303),
  'GET /api/me': signedIn(200),
  // The docs index for AI agents.
  'GET /llms.txt': open(200),
  // The remote MCP endpoint: tokens only; stateless, so GET and DELETE are 405.
  'POST /mcp': tokenOnly(200, MCP_INITIALIZE),
  'GET /mcp': tokenOnly(405),
  'DELETE /mcp': tokenOnly(405),
  // Deleting your account: only your own (no id in the path), sessions only, and never
  // without a recent sign-in (the matrix's sessions have none, so nobody is deleted here).
  'GET /api/me/deletion': signedIn(200),
  'POST /api/me/delete': signedIn(403, { confirmEmail: 'nobody@example.test' }),
  // The account side of the ops console: your own support access list, and ending an
  // impersonation (nothing to end for these callers).
  'GET /api/me/support-access': signedIn(200),
  'DELETE /api/me/impersonation': signedIn(204),
  // Personal access tokens: your own, granting only what you can reach.
  'GET /api/me/tokens': signedIn(200),
  'POST /api/me/tokens': {
    expect: { ...every(201), otherTenant: 422, anonymous: 401 },
    body: (p) => ({ name: 'CI', scopes: ['data.records:read'], workspaceIds: [p.workspaceId] }),
    crossBase: { baseGuest: 422, otherBaseCreator: 422 },
  },
  // :tokenId is the owner's.
  'DELETE /api/me/tokens/:tokenId': {
    expect: { ...every(404), owner: 204, anonymous: 401 },
  },
  // OAuth apps: the apps you registered and the apps you authorized (the world's app and
  // authorization are the owner's); the consent screen's check and answer (a decline, so no
  // grants); the apps' own endpoints answer anyone, their client credentials checked inside.
  'GET /api/me/oauth-apps': signedIn(200),
  'POST /api/me/oauth-apps': signedIn(201, {
    name: 'New app',
    redirectUris: ['https://new.example.test/cb'],
  }),
  'PATCH /api/me/oauth-apps/:appId': {
    expect: { ...every(404), owner: 200, anonymous: 401 },
    body: { name: 'Renamed' },
  },
  'DELETE /api/me/oauth-apps/:appId': { expect: { ...every(404), owner: 204, anonymous: 401 } },
  'GET /api/me/authorizations': signedIn(200),
  'DELETE /api/me/authorizations/:authorizationId': {
    expect: { ...every(404), owner: 204, anonymous: 401 },
  },
  'GET /api/oauth/authorize': {
    ...signedIn(200),
    query: (p) =>
      `?response_type=code&client_id=${p.oauthClientId}&scope=data.records:read&code_challenge=${'a'.repeat(43)}&code_challenge_method=S256`,
  },
  'POST /api/oauth/authorize': signedIn(200, (p) => ({
    clientId: p.oauthClientId,
    redirectUri: 'https://matrix.example.test/cb',
    scope: 'data.records:read',
    codeChallenge: 'a'.repeat(43),
    codeChallengeMethod: 'S256',
    decision: 'deny',
  })),
  // No body: RFC 6749's invalid_request (the client credentials are checked in oauth.test.ts).
  'POST /oauth/token': open(400),
  'POST /oauth/revoke': open(400),
  'GET /.well-known/oauth-authorization-server': open(200),
  // The API description is public, like any API's docs.
  'GET /api/openapi.json': open(200),
  'GET /api/workspaces': signedIn(200),
  'POST /api/workspaces': signedIn(201, { name: 'New workspace' }),
  // Data residency: the OSS edition lists its one region and has no other to create in;
  // the hosted edition's two regions are its own tests'.
  'GET /api/regions': signedIn(200),
  'POST /api/regions/:regionId/workspaces': signedIn(404, { name: 'Elsewhere' }),
  'GET /api/workspaces/:workspaceId': roles(200, ALL),
  'PATCH /api/workspaces/:workspaceId': roles(200, ['owner'], { name: 'Renamed' }),
  'DELETE /api/workspaces/:workspaceId': roles(204, ['owner']),
  'GET /api/workspaces/:workspaceId/members': roles(200, ALL),
  // Base-only collaborators get their bases' people (collaborators.test.ts).
  'GET /api/workspaces/:workspaceId/collaborators': {
    ...roles(200, ALL),
    crossBase: { baseGuest: 200, otherBaseCreator: 200 },
  },
  // :userId is the editor; creators may manage members below owner.
  'PATCH /api/workspaces/:workspaceId/members/:userId': roles(200, CREATORS, { role: 'commenter' }),
  'DELETE /api/workspaces/:workspaceId/members/:userId': roles(204, CREATORS),
  'GET /api/workspaces/:workspaceId/invitations': roles(200, CREATORS),
  'POST /api/workspaces/:workspaceId/invitations': roles(201, CREATORS, {
    email: 'new-person@example.test',
    role: 'editor',
  }),
  'POST /api/workspaces/:workspaceId/invitations/:invitationId/resend': roles(200, CREATORS),
  'DELETE /api/workspaces/:workspaceId/invitations/:invitationId': roles(204, CREATORS),
  // The token is the credential: any signed-in user may read it, only the invitee may accept
  // (the world's invitation is for an address none of the callers has).
  'GET /api/invitations/:token': signedIn(200),
  'POST /api/invitations/:token/accept': signedIn(403),
  // A base-only collaborator lists their own bases.
  'GET /api/workspaces/:workspaceId/bases': {
    ...roles(200, ALL),
    crossBase: { baseGuest: 200, otherBaseCreator: 200 },
  },
  'POST /api/workspaces/:workspaceId/bases': roles(201, ['owner', 'creator'], { name: 'New base' }),
  // Templates: the static gallery for anyone signed in; installs need base:create;
  // "Save as template" copies what a duplicate does (creators of the base).
  'GET /api/templates': signedIn(200),
  'GET /api/templates/:slug': signedIn(200),
  'POST /api/workspaces/:workspaceId/templates': roles(201, ['owner', 'creator'], { slug: 'okrs' }),
  'GET /api/bases/:baseId/template.json': roles(200, CREATORS),
  // Airtable imports: workspace creators, sessions only, against the recorded fake.
  'POST /api/workspaces/:workspaceId/airtable/bases': roles(200, CREATORS, {
    token: FIXTURE_TOKEN,
  }),
  'POST /api/workspaces/:workspaceId/airtable/imports': roles(201, CREATORS, {
    token: FIXTURE_TOKEN,
    baseIds: [FIXTURE_BASE_ID],
  }),
  'GET /api/workspaces/:workspaceId/airtable/imports': roles(200, CREATORS),
  // Only who started an import reads it; the world has none.
  'GET /api/workspaces/:workspaceId/airtable/imports/:importId': roles(404, CREATORS),
  'POST /api/workspaces/:workspaceId/airtable/imports/:importId/cancel': roles(404, CREATORS),
  'GET /api/bases/:baseId': roles(200, ALL),
  // Realtime catch-up. A `since` far ahead is never past retention: an empty page.
  'GET /api/bases/:baseId/events': {
    ...roles(200, ALL),
    query: `?since=${Number.MAX_SAFE_INTEGER}`,
  },
  'PATCH /api/bases/:baseId': roles(200, CREATORS, { name: 'Renamed' }),
  // Base collaborators and invitations: creators and up of the base. :userId is the
  // editor, who has a base role (editor) in the world.
  'GET /api/bases/:baseId/collaborators': roles(200, CREATORS),
  'PATCH /api/bases/:baseId/collaborators/:userId': roles(200, CREATORS, { role: 'creator' }),
  'DELETE /api/bases/:baseId/collaborators/:userId': roles(204, CREATORS),
  'GET /api/bases/:baseId/invitations': roles(200, CREATORS),
  'POST /api/bases/:baseId/invitations': roles(201, CREATORS, {
    email: 'base-person@example.test',
    role: 'editor',
  }),
  'POST /api/bases/:baseId/invitations/:invitationId/resend': {
    ...roles(200, CREATORS),
    params: { invitationId: 'baseInvitationId' },
  },
  'DELETE /api/bases/:baseId/invitations/:invitationId': {
    ...roles(204, CREATORS),
    params: { invitationId: 'baseInvitationId' },
  },
  // Duplicate a base: creators of the base who are creators of the target workspace too
  // (the world's own; duplicate.test.ts covers another workspace). Only who started one reads it.
  'POST /api/bases/:baseId/duplicate': roles(201, CREATORS, { withRecords: true }),
  'GET /api/bases/:baseId/duplicates/:duplicateId': roles(404, CREATORS),
  'DELETE /api/bases/:baseId': roles(204, CREATORS),
  // Base snapshots: creators of the base; a restore also needs a creator of the workspace
  // (the base-only editor gets 403 as an editor would). Owners set the retention.
  // Automations: the base's creators, sessions only (the REST API v1's are below).
  'GET /api/bases/:baseId/usage-warnings': roles(200, CREATORS),
  'GET /api/bases/:baseId/automations': roles(200, CREATORS),
  'POST /api/bases/:baseId/automations': roles(201, CREATORS, (p) => ({
    name: 'New',
    trigger: { type: 'recordCreated', tableId: p['tableId'] },
  })),
  'GET /api/bases/:baseId/automations/:automationId': roles(200, CREATORS),
  'PATCH /api/bases/:baseId/automations/:automationId': roles(200, CREATORS, { name: 'Renamed' }),
  'DELETE /api/bases/:baseId/automations/:automationId': roles(204, CREATORS),
  'GET /api/bases/:baseId/automations/:automationId/runs': roles(200, CREATORS),
  // the base's failed runs not retried yet (the world's failed run).
  'GET /api/bases/:baseId/automation-runs/failed': roles(200, CREATORS),
  // a test run and a retry run the actions for real, as the caller: the webhook-received
  // automation's test uses its stored sample, the retry its failed run (a record with no cells).
  'POST /api/bases/:baseId/automations/:automationId/test': {
    ...roles(200, CREATORS, {}),
    params: { automationId: 'hookAutomationId' },
  },
  'POST /api/bases/:baseId/automations/:automationId/runs/:runId/retry': {
    ...roles(200, CREATORS),
    params: { automationId: 'hookAutomationId', runId: 'failedRunId' },
  },
  // a webhook-received trigger's new URL (creators); a button click (editors who may
  // edit the record; the world's button runs no automation, so nothing starts); the webhook
  // URL itself is public, its token the credential (automation-actions.test.ts).
  'POST /api/bases/:baseId/automations/:automationId/webhook-url': {
    ...roles(200, CREATORS),
    params: { automationId: 'hookAutomationId' },
  },
  'POST /api/tables/:tableId/records/:recordId/buttons/:fieldId': {
    ...roles(200, EDITORS),
    params: { fieldId: 'buttonFieldId' },
  },
  'POST /hooks/a/:hookToken': { ...open(200), body: { hello: 'world' } },
  // AI fields: everyone on the base reads the generation state; editors regenerate named
  // records and stop (creators the whole field: ai-fields.test.ts).
  'GET /api/fields/:fieldId/ai': { ...roles(200, ALL), params: { fieldId: 'aiFieldId' } },
  'POST /api/fields/:fieldId/ai/generate': {
    ...roles(200, EDITORS, (p) => ({ recordIds: [p.recordId] })),
    params: { fieldId: 'aiFieldId' },
  },
  'POST /api/fields/:fieldId/ai/cancel': {
    ...roles(200, EDITORS),
    params: { fieldId: 'aiFieldId' },
  },
  // Interfaces: everyone on the base lists them and reads published pages (a page never
  // published is a 404 below creators: interfaces.test.ts). Creators build and publish.
  'GET /api/bases/:baseId/interfaces': roles(200, ALL),
  // Saved scripts: editors and up read (and run them in the browser), creators write.
  'GET /api/bases/:baseId/scripts': roles(200, EDITORS),
  'POST /api/bases/:baseId/scripts': roles(201, CREATORS, { name: 'New', code: 'output.text(1);' }),
  'GET /api/bases/:baseId/scripts/:scriptId': roles(200, EDITORS),
  'PATCH /api/bases/:baseId/scripts/:scriptId': roles(200, CREATORS, { code: '// changed' }),
  'DELETE /api/bases/:baseId/scripts/:scriptId': roles(204, CREATORS),
  // Synced tables: creators add them (sessions only), anyone reads a sync's status,
  // editors sync now, creators change, pause or remove it.
  'POST /api/bases/:baseId/syncs': roles(201, CREATORS, (p) => ({
    source: { baseId: p['baseId'], tableId: p['tableId'] },
    schedule: 'manual',
  })),
  // the matrix's server refuses loopback sources (no network), so creators get a 422.
  'POST /api/bases/:baseId/syncs/preview': roles(422, CREATORS, {
    source: { kind: 'csv', url: 'https://127.0.0.1/people.csv' },
  }),
  // Sync connectors: the OSS edition has none, so the picker is a 422 for creators and
  // the account routes a 404 for everyone signed in (sync-connectors.test.ts runs them with one).
  'POST /api/bases/:baseId/syncs/browse': roles(422, CREATORS, {
    connector: 'google-sheets',
    path: [],
  }),
  'GET /api/me/sync-connectors': signedIn(200),
  'DELETE /api/me/sync-connectors/:connectorId': signedIn(404),
  'GET /api/me/sync-connectors/:connectorId/connect': signedIn(404),
  'GET /api/me/sync-connectors/:connectorId/callback': signedIn(404),
  'GET /api/tables/:tableId/sync': { ...roles(200, ALL), params: { tableId: 'syncTableId' } },
  'PATCH /api/tables/:tableId/sync': {
    ...roles(200, CREATORS, { schedule: 'daily' }),
    params: { tableId: 'syncTableId' },
  },
  'POST /api/tables/:tableId/sync/run': {
    ...roles(200, EDITORS),
    params: { tableId: 'syncTableId' },
  },
  'DELETE /api/tables/:tableId/sync': {
    ...roles(204, CREATORS),
    params: { tableId: 'syncTableId' },
  },
  // The scripts' sandbox document: static, holds no data.
  'GET /sandbox/script': open(200),
  // The base's extension panel: everyone on the base sees it, creators install, arrange
  // and remove extensions (third-party bundles by creators by default), editors change settings.
  'GET /api/bases/:baseId/extensions': roles(200, ALL),
  'POST /api/bases/:baseId/extensions': roles(201, CREATORS, {
    manifest: { manifestVersion: 1, name: 'Matrix', scopes: ['records:read'] },
    bundle: { html: '<p>hi</p>', js: '' },
  }),
  'GET /api/bases/:baseId/extensions/:extensionId/bundle': roles(200, ALL),
  'PATCH /api/bases/:baseId/extensions/:extensionId': roles(200, CREATORS, { size: 'large' }),
  'PUT /api/bases/:baseId/extensions/order': {
    ...roles(200, CREATORS),
    body: (p) => ({ ids: [p.extensionId] }),
  },
  'PUT /api/bases/:baseId/extensions/:extensionId/settings': roles(200, EDITORS, {
    settings: { tableId: 'x' },
  }),
  'DELETE /api/bases/:baseId/extensions/:extensionId': roles(204, CREATORS),
  // The extensions' sandbox document: static, holds no data.
  'GET /sandbox/extension': open(200),
  'POST /api/bases/:baseId/interfaces': roles(201, CREATORS, { name: 'New' }),
  'PATCH /api/bases/:baseId/interfaces/:interfaceId': roles(200, CREATORS, { name: 'Renamed' }),
  'DELETE /api/bases/:baseId/interfaces/:interfaceId': roles(204, CREATORS),
  'POST /api/bases/:baseId/interfaces/:interfaceId/pages': roles(201, CREATORS, (p) => ({
    name: 'Review',
    layout: 'recordReview',
    tableId: p['tableId'],
  })),
  'GET /api/bases/:baseId/interfaces/:interfaceId/pages/:pageId': roles(200, ALL),
  'PATCH /api/bases/:baseId/interfaces/:interfaceId/pages/:pageId': roles(200, CREATORS, {
    name: 'Renamed',
  }),
  'DELETE /api/bases/:baseId/interfaces/:interfaceId/pages/:pageId': roles(204, CREATORS),
  'POST /api/bases/:baseId/interfaces/:interfaceId/pages/:pageId/publish': roles(200, CREATORS),
  'POST /api/bases/:baseId/interfaces/:interfaceId/pages/:pageId/unpublish': roles(200, CREATORS),
  // The interface itself: its viewers (the base's people and its interface-only
  // collaborators) read published pages, their records and numbers; editors edit through a
  // page and submit form pages; creators manage the interface-only collaborators.
  'GET /api/interfaces/:interfaceId': roles(200, ALL),
  'GET /api/me/interfaces': signedIn(200),
  'POST /api/interfaces/:interfaceId/pages/:pageId/records': roles(200, ALL, {}),
  'PATCH /api/interfaces/:interfaceId/pages/:pageId/records/:recordId': roles(204, EDITORS, {
    fields: {},
  }),
  'POST /api/interfaces/:interfaceId/pages/:pageId/submissions': {
    ...roles(201, EDITORS, { fields: {} }),
    params: { pageId: 'formPageId' },
  },
  // A published page's numbers and charts.
  'POST /api/interfaces/:interfaceId/pages/:pageId/data': roles(200, ALL, {}),
  'GET /api/interfaces/:interfaceId/collaborators': roles(200, CREATORS),
  'POST /api/interfaces/:interfaceId/collaborators': roles(201, CREATORS, {
    email: 'interface-guest@example.test',
    role: 'read_only',
  }),
  'PATCH /api/interfaces/:interfaceId/collaborators/:userId': {
    ...roles(200, CREATORS, { role: 'editor' }),
    params: { userId: 'interfaceMemberId' },
  },
  'DELETE /api/interfaces/:interfaceId/collaborators/:userId': {
    ...roles(204, CREATORS),
    params: { userId: 'interfaceMemberId' },
  },
  'DELETE /api/interfaces/:interfaceId/invitations/:invitationId': {
    ...roles(204, CREATORS),
    params: { invitationId: 'interfaceInvitationId' },
  },
  'GET /api/bases/:baseId/snapshots': roles(200, CREATORS),
  'POST /api/bases/:baseId/snapshots': roles(201, CREATORS),
  'POST /api/bases/:baseId/snapshots/:snapshotId/restore': roles(201, CREATORS, {}),
  // Only who started a restore reads it; the world has none: allowed roles get the 404 of
  // a missing one (jobs-background.test.ts reads real ones, and someone else's).
  'GET /api/bases/:baseId/snapshot-restores/:restoreId': roles(404, CREATORS),
  'DELETE /api/bases/:baseId/snapshots/:snapshotId': roles(204, CREATORS),
  // Data export: a base for anyone who can read it (exports.test.ts checks what is in it),
  // and the caller's own account data.
  'GET /api/bases/:baseId/export.zip': roles(200, ALL),
  'GET /api/me/export.zip': signedIn(200),
  'PATCH /api/workspaces/:workspaceId/snapshot-settings': roles(200, ['owner'], {
    retentionDays: 14,
  }),
  // The trash: bases through their workspace, tables through their base, fields, views
  // and records through their table. Editors see a base's trash; creators purge.
  'GET /api/workspaces/:workspaceId/trash': roles(200, CREATORS),
  'POST /api/workspaces/:workspaceId/trash/bases/:trashedBaseId/restore': roles(200, CREATORS),
  'DELETE /api/workspaces/:workspaceId/trash/bases/:trashedBaseId': roles(204, CREATORS),
  'GET /api/bases/:baseId/trash': roles(200, EDITORS),
  'POST /api/bases/:baseId/trash/tables/:trashedTableId/restore': roles(200, CREATORS),
  'DELETE /api/bases/:baseId/trash/tables/:trashedTableId': roles(204, CREATORS),
  'DELETE /api/tables/:tableId/trash/fields/:trashedFieldId': {
    ...roles(204, CREATORS),
    params: { trashedFieldId: 'deletedFieldId' },
  },
  'POST /api/tables/:tableId/trash/views/:trashedViewId/restore': roles(200, EDITORS),
  'DELETE /api/tables/:tableId/trash/views/:trashedViewId': roles(204, CREATORS),
  'GET /api/tables/:tableId/trash/records': roles(200, EDITORS),
  'POST /api/tables/:tableId/trash/records/purge': roles(200, CREATORS, (p) => ({
    recordIds: [p.deletedRecordId],
  })),
  'GET /api/bases/:baseId/tables': roles(200, ALL),
  'POST /api/bases/:baseId/tables': roles(201, CREATORS, { name: 'New table' }),
  'GET /api/tables/:tableId': roles(200, ALL),
  'PATCH /api/tables/:tableId': roles(200, CREATORS, { name: 'Renamed' }),
  'DELETE /api/tables/:tableId': roles(204, CREATORS),
  'POST /api/tables/:tableId/duplicate': roles(201, CREATORS, { includeRecords: true }),
  'POST /api/tables/:tableId/fields': roles(201, CREATORS, { name: 'Estimate', type: 'number' }),
  'GET /api/tables/:tableId/fields/trash': roles(200, ALL),
  'POST /api/tables/:tableId/fields/:deletedFieldId/restore': roles(200, CREATORS),
  'PATCH /api/fields/:fieldId': roles(200, CREATORS, { name: 'Renamed' }),
  'DELETE /api/fields/:fieldId': roles(204, CREATORS),
  // The link picker lists records of the linked table, in the same base.
  'GET /api/fields/:linkFieldId/link-candidates': roles(200, ALL),
  'GET /api/tables/:tableId/records': roles(200, ALL),
  'POST /api/tables/:tableId/records': roles(201, EDITORS, (p) => ({
    records: [{ fields: { [p.fieldId]: 'New' } }],
  })),
  'PATCH /api/tables/:tableId/records': roles(200, EDITORS, (p) => ({
    records: [{ id: p.recordId, fields: { [p.fieldId]: 'Changed' } }],
  })),
  'POST /api/tables/:tableId/records/query': roles(200, ALL, (p) => ({
    query: { filter: { conditions: [{ fieldId: p.fieldId, operator: 'contains', value: 'a' }] } },
    offset: 0,
    limit: 10,
  })),
  'POST /api/tables/:tableId/records/delete': roles(200, EDITORS, (p) => ({
    recordIds: [p.recordId],
  })),
  'POST /api/tables/:tableId/records/restore': roles(200, EDITORS, (p) => ({
    recordIds: [p.deletedRecordId],
  })),
  'GET /api/tables/:tableId/records/:recordId': roles(200, ALL),
  'PATCH /api/tables/:tableId/records/:recordId': roles(200, EDITORS, (p) => ({
    fields: { [p.fieldId]: 'Changed' },
  })),
  'DELETE /api/tables/:tableId/records/:recordId': roles(204, EDITORS),
  // Comments. The world's comment is the commenter's: only they edit it; creators and
  // owners may also delete it.
  'GET /api/tables/:tableId/records/:recordId/comments': roles(200, ALL),
  'POST /api/tables/:tableId/records/:recordId/comments': roles(201, COMMENTERS, {
    body: 'Looks good',
  }),
  'PATCH /api/tables/:tableId/records/:recordId/comments/:commentId': roles(200, ['commenter'], {
    body: 'Edited',
  }),
  'DELETE /api/tables/:tableId/records/:recordId/comments/:commentId': roles(204, [
    'owner',
    'creator',
    'commenter',
  ]),
  'PUT /api/tables/:tableId/records/:recordId/comments/:commentId/reactions/:reaction': roles(
    200,
    COMMENTERS
  ),
  'DELETE /api/tables/:tableId/records/:recordId/comments/:commentId/reactions/:reaction': roles(
    200,
    COMMENTERS
  ),
  'GET /api/tables/:tableId/comment-counts': roles(200, ALL),
  'GET /api/tables/:tableId/mentionable-users': roles(200, COMMENTERS),
  // Revision history: read like records; a restore is a record update.
  'GET /api/tables/:tableId/records/:recordId/revisions': roles(200, ALL),
  // Notifications: the caller's own (RLS: recipients only).
  'GET /api/notifications': signedIn(200),
  'GET /api/notifications/unread': signedIn(200),
  'POST /api/notifications/read': signedIn(200),
  'POST /api/notifications/:notificationId/read': {
    expect: { ...every(404), editor: 200, anonymous: 401 },
  },
  // Service notices: a notice to everyone, which each caller sees and dismisses for themselves.
  'GET /api/me/notices': signedIn(200),
  'POST /api/me/notices/:noticeId/dismiss': signedIn(204),
  'GET /api/me/notification-preferences': signedIn(200),
  'PUT /api/me/notification-preferences': signedIn(200, { email: 'mentions' }),
  // The unsubscribe link is public but needs its signed token: none here.
  'GET /email/unsubscribe': open(400),
  'POST /email/unsubscribe': open(400),
  'POST /api/tables/:tableId/records/:recordId/revisions/:revisionId/restore': roles(
    200,
    EDITORS,
    {}
  ),
  // CSV import and export. New fields need field:create; this one maps to Notes only.
  'POST /api/tables/:tableId/imports': roles(201, EDITORS, (p) => ({
    csv: 'Notes\nImported\n',
    columns: [{ index: 0, fieldId: p.fieldId }],
  })),
  // Only who started an import reads it; the world has none: allowed roles get the 404
  // of a missing import (imports.test.ts reads real ones, jobs-background.test.ts someone else's).
  'GET /api/tables/:tableId/imports/:importId': roles(404, EDITORS),
  'GET /api/tables/:tableId/export.csv': roles(200, ALL),
  // Attachments, against an in-memory object store. The world's file is a ready PNG, so
  // confirming it again is a no-op 200, and its thumbnail falls back to the image.
  'POST /api/tables/:tableId/attachments': roles(201, EDITORS, (p) => ({
    fieldId: p.attachmentFieldId,
    filename: 'photo.png',
    type: 'image/png',
    size: 3,
  })),
  'POST /api/tables/:tableId/attachments/:attachmentId/confirm': roles(200, EDITORS),
  'GET /api/tables/:tableId/attachments/:attachmentId': roles(302, ALL),
  'GET /api/tables/:tableId/attachments/:attachmentId/thumbnail': roles(302, ALL),
  'GET /api/workspaces/:workspaceId/storage': roles(200, ALL),
  'GET /api/workspaces/:workspaceId/usage': roles(200, ALL),
  // Billing, owners only. The OSS edition sells nothing: checkout and portal are 404 for
  // owners (billing.test.ts runs them with a provider), and so is the provider's webhook.
  'GET /api/workspaces/:workspaceId/billing': roles(200, ['owner']),
  'POST /api/workspaces/:workspaceId/billing/checkout': roles(404, ['owner'], {
    plan: 'pro',
    interval: 'month',
  }),
  'POST /api/workspaces/:workspaceId/billing/portal': roles(404, ['owner']),
  // plan changes and cancellation in the app, owners only (404 for them in OSS too).
  'PATCH /api/workspaces/:workspaceId/billing/subscription': roles(404, ['owner'], {
    cancelAtPeriodEnd: true,
  }),
  'POST /api/billing/:provider/webhooks': open(404),
  // AI settings: members see whether AI is on, owners manage the workspace's own key. The
  // URL is a public IP literal (no DNS); the world has no provider, so a test is a 409.
  'GET /api/workspaces/:workspaceId/ai': roles(200, ALL),
  'GET /api/workspaces/:workspaceId/ai/settings': roles(200, ['owner']),
  'PUT /api/workspaces/:workspaceId/ai/settings': roles(200, ['owner'], {
    baseUrl: 'https://1.1.1.1/v1',
    model: 'gpt-4.1-mini',
    apiKey: 'sk-matrix-0123456789',
  }),
  'DELETE /api/workspaces/:workspaceId/ai/settings': roles(200, ['owner']),
  'POST /api/workspaces/:workspaceId/ai/settings/test': roles(409, ['owner']),
  // The AI assistant: creators, sessions only. No provider in the matrix's app: a plan is
  // a 409 after authorization (ai-assistant.test.ts asks a fake one); an empty plan applies.
  'POST /api/workspaces/:workspaceId/assistant/plan': roles(409, CREATORS, { prompt: 'A CRM' }),
  'POST /api/workspaces/:workspaceId/assistant/apply': roles(201, CREATORS, {
    name: 'Described',
    plan: { summary: '', baseName: 'Described', operations: [] },
  }),
  'POST /api/bases/:baseId/assistant/plan': roles(409, CREATORS, { prompt: 'Add a field' }),
  'POST /api/bases/:baseId/assistant/apply': roles(200, CREATORS, {
    plan: { summary: '', baseName: null, operations: [] },
  }),
  'GET /api/tables/:tableId/views': roles(200, ALL),
  'POST /api/tables/:tableId/views': roles(201, EDITORS, { name: 'New view' }),
  'GET /api/views/:viewId': roles(200, ALL),
  'PATCH /api/views/:viewId': roles(200, EDITORS, { name: 'Renamed' }),
  'DELETE /api/views/:viewId': roles(204, EDITORS),
  'POST /api/views/:viewId/duplicate': roles(201, EDITORS, {}),
  'POST /api/views/:viewId/order': roles(204, EDITORS, (p) => ({
    recordId: p.recordId,
    afterId: null,
  })),
  'POST /api/tables/:tableId/view-sections': roles(201, EDITORS, { name: 'Team views' }),
  'PATCH /api/tables/:tableId/view-sections/:sectionId': roles(200, EDITORS, { name: 'Renamed' }),
  'DELETE /api/tables/:tableId/view-sections/:sectionId': roles(204, EDITORS),
  // View share links: creators and owners manage them; the token is the only credential
  // of the public side, which answers the same to everyone (shares.test.ts covers its rules).
  'GET /api/views/:viewId/shares': roles(200, CREATORS),
  'POST /api/views/:viewId/shares': roles(201, CREATORS, {}),
  'PATCH /api/views/:viewId/shares/:shareId': roles(200, CREATORS, { allowCopy: false }),
  'DELETE /api/views/:viewId/shares/:shareId': roles(204, CREATORS),
  // Whole-base share links: the same, on the base.
  'GET /api/bases/:baseId/shares': roles(200, CREATORS),
  'POST /api/bases/:baseId/shares': roles(201, CREATORS, {}),
  'PATCH /api/bases/:baseId/shares/:shareId': {
    ...roles(200, CREATORS, { allowCopy: false }),
    params: { shareId: 'baseShareId' },
  },
  'DELETE /api/bases/:baseId/shares/:shareId': {
    ...roles(204, CREATORS),
    params: { shareId: 'baseShareId' },
  },
  'GET /api/shared/:shareToken': open(200),
  // The world's link has no password: nothing to unlock, no cookie.
  'POST /api/shared/:shareToken/unlock': { ...open(204), body: { password: 'anything' } },
  'GET /api/shared/:shareToken/views/:viewId': open(200),
  'GET /api/shared/:shareToken/views/:viewId/records': open(200),
  // The world's file is in the shared view's record.
  'GET /api/shared/:shareToken/views/:viewId/attachments/:attachmentId': open(302),
  'GET /api/shared/:shareToken/views/:viewId/attachments/:attachmentId/thumbnail': open(302),
  // The world's link allows downloads.
  'GET /api/shared/:shareToken/views/:viewId/export.csv': open(200),
  // The embed page: the client's index.html, framed per link (shares.test.ts).
  'GET /embed/:shareToken': open(200),
  // Public forms: the form link's token is the credential, the same for everyone
  // (public-forms.test.ts covers the allowlist, CAPTCHA, limits and uploads).
  'GET /api/forms/:formToken': open(200),
  'POST /api/forms/:formToken/submissions': {
    ...open(201),
    body: (p) => ({ submissionId: uuidv7(), fields: { [p.fieldId]: 'From the form' } }),
  },
  'POST /api/forms/:formToken/attachments': {
    ...open(201),
    body: (p) => ({ fieldId: p.attachmentFieldId, filename: 'a.txt', type: 'text/plain', size: 3 }),
  },
  // A link field's picker: the world's form offers its self-link from the Board view.
  'GET /api/forms/:formToken/fields/:fieldId/records': {
    ...open(200),
    params: { fieldId: 'linkFieldId' },
  },
  'POST /api/forms/:formToken/attachments/:attachmentId/confirm': {
    ...open(200),
    params: { attachmentId: 'formUploadId' },
  },
  'GET /api/forms/:formToken/images/:image': open(302),
  // The REST API v1: resource routes on the base in the path, then the table action on
  // the table it names (here by id; by name and across bases in v1.test.ts).
  'GET /api/v1/meta/bases': signedIn(200),
  // Webhooks: the base's creators, and tokens with `webhook:manage` (the scopeless token's
  // one scope). The world's webhook points at a private address, so a ping fails at once.
  'GET /api/v1/bases/:baseId/webhooks': {
    ...roles(200, CREATORS),
    tokens: { scopelessToken: 200 },
  },
  'POST /api/v1/bases/:baseId/webhooks': {
    ...roles(201, CREATORS, { url: 'https://1.1.1.1/hook', events: ['record.created'] }),
    tokens: { scopelessToken: 201 },
  },
  'PATCH /api/v1/bases/:baseId/webhooks/:webhookId': {
    ...roles(200, CREATORS, { enabled: false }),
    tokens: { scopelessToken: 200 },
  },
  'DELETE /api/v1/bases/:baseId/webhooks/:webhookId': {
    ...roles(204, CREATORS),
    tokens: { scopelessToken: 204 },
  },
  'GET /api/v1/bases/:baseId/webhooks/:webhookId/deliveries': {
    ...roles(200, CREATORS),
    tokens: { scopelessToken: 200 },
  },
  'POST /api/v1/bases/:baseId/webhooks/:webhookId/ping': {
    ...roles(200, CREATORS),
    tokens: { scopelessToken: 200 },
  },
  // queued again for the worker (a singleton per event, so every role's call answers 200).
  'POST /api/v1/bases/:baseId/webhooks/:webhookId/deliveries/:deliveryId/redeliver': {
    ...roles(200, CREATORS),
    tokens: { scopelessToken: 200 },
  },
  // Automations: the base's creators, and tokens with `automations:read`, `:manage` and
  // `:run` (the owner's token has every scope; the scopeless one only `webhook:manage`).
  'GET /api/v1/bases/:baseId/automations': roles(200, CREATORS),
  'GET /api/v1/bases/:baseId/automations/:automationId': roles(200, CREATORS),
  'PATCH /api/v1/bases/:baseId/automations/:automationId': roles(200, CREATORS, {
    enabled: false,
  }),
  'GET /api/v1/bases/:baseId/automations/:automationId/runs': roles(200, CREATORS),
  'POST /api/v1/bases/:baseId/automations/:automationId/trigger': {
    ...roles(200, CREATORS, { body: { hello: 'api' } }),
    params: { automationId: 'hookAutomationId' },
  },
  'GET /api/v1/meta/bases/:baseId/tables': roles(200, ALL),
  'POST /api/v1/meta/bases/:baseId/tables': roles(200, CREATORS, {
    name: 'Via the API',
    fields: [{ name: 'Title', type: 'singleLineText' }],
  }),
  'POST /api/v1/meta/bases/:baseId/tables/:tableIdOrName/fields': {
    ...roles(200, CREATORS, { name: 'Estimate', type: 'number' }),
    params: { tableIdOrName: 'tableId' },
  },
  'PATCH /api/v1/meta/bases/:baseId/tables/:tableIdOrName/fields/:fieldId': {
    ...roles(200, CREATORS, { name: 'Renamed' }),
    params: { tableIdOrName: 'tableId' },
  },
  'GET /api/v1/:baseId/:tableIdOrName': { ...roles(200, ALL), params: V1_TABLE },
  'POST /api/v1/:baseId/:tableIdOrName/listRecords': {
    ...roles(200, ALL, { pageSize: 10 }),
    params: V1_TABLE,
  },
  'POST /api/v1/:baseId/:tableIdOrName': {
    ...roles(200, EDITORS, { records: [{ fields: { Notes: 'New' } }] }),
    params: V1_TABLE,
  },
  'PATCH /api/v1/:baseId/:tableIdOrName': {
    ...roles(200, EDITORS, (p) => ({
      records: [{ id: p.recordId, fields: { Notes: 'Changed' } }],
    })),
    params: V1_TABLE,
  },
  'PUT /api/v1/:baseId/:tableIdOrName': {
    ...roles(200, EDITORS, (p) => ({
      records: [{ id: p.recordId, fields: { Notes: 'Changed' } }],
    })),
    params: V1_TABLE,
  },
  'DELETE /api/v1/:baseId/:tableIdOrName': {
    ...roles(200, EDITORS),
    params: V1_TABLE,
    query: (p) => `?records%5B%5D=${p.recordId}`,
  },
  'GET /api/v1/:baseId/:tableIdOrName/:recordId': { ...roles(200, ALL), params: V1_TABLE },
  'PATCH /api/v1/:baseId/:tableIdOrName/:recordId': {
    ...roles(200, EDITORS, { fields: { Notes: 'Changed' } }),
    params: V1_TABLE,
  },
  'PUT /api/v1/:baseId/:tableIdOrName/:recordId': {
    ...roles(200, EDITORS, { fields: { Notes: 'Changed' } }),
    params: V1_TABLE,
  },
  'DELETE /api/v1/:baseId/:tableIdOrName/:recordId': { ...roles(200, EDITORS), params: V1_TABLE },
  'GET /api/v1/:baseId/:tableIdOrName/:recordId/comments': {
    ...roles(200, ALL),
    params: V1_TABLE,
  },
  'POST /api/v1/:baseId/:tableIdOrName/:recordId/comments': {
    ...roles(200, COMMENTERS, { text: 'Looks good' }),
    params: V1_TABLE,
  },
};

/** Only `who` gets `status`; every other signed-in caller 404 (the view doesn't resolve). */
const onlyFor = (who: UserRole, status: number, body?: Body): Case => ({
  expect: {
    ...(Object.fromEntries(USER_ROLES.map((r) => [r, r === who ? status : 404])) as Record<
      UserRole,
      number
    >),
    otherTenant: 404,
    anonymous: 401,
  },
  body,
});

/**
 * Personal and locked views: the routes of a view, called on the world's second view after
 * it was made the editor's personal view, or locked.
 */
const VIEW_STATE_CASES: { state: 'personal' | 'locked'; route: string; case: Case }[] = [
  { state: 'personal', route: 'GET /api/views/:viewId', case: onlyFor('editor', 200) },
  {
    state: 'personal',
    route: 'PATCH /api/views/:viewId',
    case: onlyFor('editor', 200, { name: 'Mine' }),
  },
  { state: 'personal', route: 'DELETE /api/views/:viewId', case: onlyFor('editor', 204) },
  {
    state: 'personal',
    route: 'POST /api/views/:viewId/duplicate',
    case: onlyFor('editor', 201, {}),
  },
  {
    state: 'personal',
    route: 'POST /api/views/:viewId/order',
    case: onlyFor('editor', 204, (p) => ({ recordId: p.recordId, afterId: null })),
  },
  {
    state: 'personal',
    route: 'POST /api/tables/:tableId/records/query',
    // A personal view of someone else is "no such view in this table".
    case: onlyFor('editor', 200, (p) => ({ viewId: p.viewId })),
  },
  {
    state: 'personal',
    route: 'GET /api/tables/:tableId/export.csv?viewId=:viewId',
    case: onlyFor('editor', 200),
  },
  // A locked view's name and configuration: creators and owners only.
  {
    state: 'locked',
    route: 'PATCH /api/views/:viewId',
    case: roles(200, CREATORS, { name: 'Renamed' }),
  },
  {
    state: 'locked',
    route: 'PATCH /api/views/:viewId',
    case: roles(200, CREATORS, { grid: { rowHeight: 'tall' } }),
  },
  {
    state: 'locked',
    route: 'PATCH /api/views/:viewId',
    case: roles(200, CREATORS, { locked: false }),
  },
  { state: 'locked', route: 'DELETE /api/views/:viewId', case: roles(204, CREATORS) },
  {
    state: 'locked',
    route: 'POST /api/views/:viewId/order',
    case: roles(204, CREATORS, (p) => ({ recordId: p.recordId, afterId: null })),
  },
  // Its place in the sidebar and copies of it stay open to editors.
  {
    state: 'locked',
    route: 'PATCH /api/views/:viewId',
    case: roles(200, EDITORS, { position: 9 }),
  },
  { state: 'locked', route: 'POST /api/views/:viewId/duplicate', case: roles(201, EDITORS, {}) },
];

const key = (e: RouteEntry) => `${e.method} ${e.path}`;
// The registry is static: build it once without a database to enumerate the routes.

/**
 * What a token caller gets by default: public routes answer as for anyone (the bearer header is
 * ignored there); routes kept to sessions (`token: null`) and routes whose scope the token lacks
 * are 403; resource routes outside the grants are 404; otherwise the user's own status.
 */
function tokenExpect(entry: RouteEntry, c: Case, caller: TokenCaller): number {
  const override = c.tokens?.[caller];
  if (override !== undefined) return override;
  const { access } = entry;
  if (access.kind === 'public') return c.expect.anonymous;
  if (access.kind === 'token') throw new Error(`authz matrix: give ${key(entry)} tokenOnly()`);
  // The ops console only exists in the hosted edition; its own matrix covers it.
  if (access.kind === 'admin') return 404;
  const asUser = c.expect[caller === 'readOnlyToken' ? 'read_only' : 'owner'];
  if (caller === 'elsewhereToken') {
    if (access.kind === 'resource') return 404;
    if (access.token === null) return 403;
    return WORKSPACE_SCOPED.test(entry.path) ? 404 : asUser;
  }
  if (access.kind === 'resource' && asUser === 403) return 403;
  if (access.token === null || caller === 'scopelessToken') return 403;
  return asUser;
}

const ENTRIES = testApp().routes.entries;

describe('cross-tenant authorization matrix', () => {
  const t = useTestDb();
  let app: ReturnType<typeof testApp>['app'];
  let appUrl: string;
  const files = new MemoryObjectStore();

  // A built client, for the embed page.
  const clientDir = mkdtempSync(join(tmpdir(), 'openrows-matrix-'));
  writeFileSync(join(clientDir, 'index.html'), '<!doctype html><title>OpenRows</title>');
  afterAll(() => rmSync(clientDir, { recursive: true, force: true }));

  beforeAll(() => {
    const built = testApp({
      db: t.appDb,
      env: { AUTH_RATE_LIMIT: '100000', CLIENT_DIR: clientDir },
      objectStore: files,
    });
    app = built.app;
    appUrl = built.config.appUrl;
  });

  /** A workspace with one member per role and a base, plus another tenant with its own. */
  async function createWorld() {
    const { workspace, owner } = await createWorkspace(t.db);
    const users = { owner } as Record<
      UserRole | 'otherTenant' | CrossBaseCaller | InterfaceCaller,
      typeof owner
    >;
    for (const role of USER_ROLES) {
      if (role !== 'owner') users[role] = await addMember(t.db, workspace.id, role);
    }
    const base = await createBase(t.db, workspace.id);
    const sibling = await createBase(t.db, workspace.id, { name: 'Sibling' });
    users.baseGuest = await createUser(t.db);
    users.otherBaseCreator = await createUser(t.db);
    await t.db.insert(baseMembers).values([
      { workspaceId: workspace.id, baseId: base.id, userId: users.baseGuest.id, role: 'editor' },
      { workspaceId: workspace.id, baseId: base.id, userId: users.editor.id, role: 'editor' },
      {
        workspaceId: workspace.id,
        baseId: sibling.id,
        userId: users.otherBaseCreator.id,
        role: 'creator',
      },
    ]);
    const { table, field, deletedField } = await createTableWithFields(t.db, owner, base);
    const { record, deletedRecord } = await createRecordsIn(t.db, owner, table);
    // A second view, so deleting one is allowed (a table keeps at least one view).
    const [view] = await t.db
      .insert(views)
      .values({ workspaceId: workspace.id, tableId: table.id, name: 'Board', position: 2 })
      .returning();
    if (!view) throw new Error('authz matrix: no view');
    // The trash: a deleted view, table and base.
    const [trashedView] = await t.db
      .insert(views)
      .values({
        workspaceId: workspace.id,
        tableId: table.id,
        name: 'Old view',
        position: 4,
        deletedAt: new Date(),
        deletedBy: owner.id,
      })
      .returning();
    if (!trashedView) throw new Error('authz matrix: no trashed view');
    const { table: trashedTable } = await createTableWithFields(t.db, owner, base, 'Archive');
    await t.db
      .update(tables)
      .set({ deletedAt: new Date(), deletedBy: owner.id })
      .where(sql`${tables.id} = ${trashedTable.id}`);
    const trashedBase = await createBase(t.db, workspace.id, {
      name: 'Old base',
      deletedAt: new Date(),
      deletedBy: owner.id,
    });
    const [section] = await t.db
      .insert(viewSections)
      .values({ workspaceId: workspace.id, tableId: table.id, name: 'Planning', position: 1 })
      .returning();
    if (!section) throw new Error('authz matrix: no view section');
    const token = generateInvitationToken();
    const [invitation] = await t.db
      .insert(workspaceInvitations)
      .values({
        workspaceId: workspace.id,
        email: 'invitee@example.test',
        role: 'editor',
        tokenHash: hashInvitationToken(token),
        invitedBy: owner.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .returning();
    if (!invitation) throw new Error('authz matrix: no invitation');
    const [baseInvitation] = await t.db
      .insert(workspaceInvitations)
      .values({
        workspaceId: workspace.id,
        baseId: base.id,
        email: 'base-invitee@example.test',
        role: 'editor',
        tokenHash: hashInvitationToken(generateInvitationToken()),
        invitedBy: owner.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .returning();
    if (!baseInvitation) throw new Error('authz matrix: no base invitation');
    const attachmentField = await inScope(
      t.db,
      { userId: owner.id, workspaceId: workspace.id },
      async (tx) =>
        createField({ tx, workspaceId: workspace.id, userId: owner.id }, table, {
          name: 'Files',
          type: 'attachment',
        })
    );
    if (!attachmentField) throw new Error('authz matrix: no attachment field');
    const linkField = await inScope(
      t.db,
      { userId: owner.id, workspaceId: workspace.id },
      async (tx) =>
        createField({ tx, workspaceId: workspace.id, userId: owner.id }, table, {
          name: 'Related',
          type: 'link',
          options: { linkedTableId: table.id },
        })
    );
    const buttonField = await inScope(
      t.db,
      { userId: owner.id, workspaceId: workspace.id },
      async (tx) =>
        createField({ tx, workspaceId: workspace.id, userId: owner.id }, table, {
          name: 'Run',
          type: 'button',
          options: { label: 'Run', action: 'runAutomation' },
        })
    );
    // AI fields with the workspace's own provider (never reached: the worker answers).
    await t.db.insert(workspaceAiSettings).values({
      workspaceId: workspace.id,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4.1-mini',
      apiKeyEncrypted: Buffer.from('not-a-real-ciphertext'),
    });
    const aiField = await inScope(
      t.db,
      { userId: owner.id, workspaceId: workspace.id },
      async (tx) =>
        createField({ tx, workspaceId: workspace.id, userId: owner.id }, table, {
          name: 'Summary',
          type: 'ai',
          options: { prompt: `Summarize {${field.id}}` },
        })
    );
    const ids = { workspaceId: workspace.id, baseId: base.id, tableId: table.id };
    const attachmentId = uuidv7();
    const key = storageKey({ ...ids, id: attachmentId });
    const [attachment] = await t.db
      .insert(attachments)
      .values({
        ...ids,
        id: attachmentId,
        fieldId: attachmentField.id,
        storageKey: key,
        filename: 'photo.png',
        contentType: 'image/png',
        size: 3,
        status: 'ready',
        createdBy: owner.id,
      })
      .returning();
    if (!attachment) throw new Error('authz matrix: no attachment');
    await files.put(key, new Uint8Array([1, 2, 3]));
    // The file in the record's cell, so the share link may download it.
    await t.db.execute(
      sql`UPDATE ${qualified(table)} SET ${sql.identifier(attachmentField.dbColumn)} = ${JSON.stringify(
        [{ id: attachmentId, filename: 'photo.png', size: 3, type: 'image/png' }]
      )}::jsonb WHERE id = ${record.id}`
    );
    // A share link of the second view, by the owner.
    const shareToken = generateShareToken();
    const [share] = await t.db
      .insert(shares)
      .values({
        workspaceId: workspace.id,
        baseId: base.id,
        kind: 'view',
        viewId: view.id,
        tokenHash: hashShareToken(shareToken),
        createdBy: owner.id,
        allowDownload: true,
        embedOrigins: ['https://embed.example'],
      })
      .returning();
    if (!share) throw new Error('authz matrix: no share');
    // A whole-base link.
    const [baseShare] = await t.db
      .insert(shares)
      .values({
        workspaceId: workspace.id,
        baseId: base.id,
        kind: 'base',
        tokenHash: hashShareToken(generateShareToken()),
        createdBy: owner.id,
      })
      .returning();
    if (!baseShare) throw new Error('authz matrix: no base share');
    // A form view with its public form link, a cover image and a submitter's pending
    // upload (in the store, so its confirm succeeds).
    const coverId = uuidv7();
    const [formView] = await t.db
      .insert(views)
      .values({
        workspaceId: workspace.id,
        tableId: table.id,
        name: 'Intake',
        type: 'form',
        position: 3,
        config: {
          form: {
            fields: [
              { fieldId: field.id },
              { fieldId: attachmentField.id },
              { fieldId: linkField.id, viewIdForRecordSelection: view.id },
            ],
            coverAttachmentId: coverId,
          },
        },
      })
      .returning();
    if (!formView) throw new Error('authz matrix: no form view');
    const coverKey = storageKey({ ...ids, id: coverId });
    await t.db.insert(attachments).values({
      ...ids,
      id: coverId,
      viewId: formView.id,
      storageKey: coverKey,
      filename: 'cover.png',
      contentType: 'image/png',
      size: 3,
      status: 'ready',
      createdBy: owner.id,
    });
    await files.put(coverKey, new Uint8Array([1, 2, 3]));
    const formToken = generateShareToken();
    const [formShare] = await t.db
      .insert(shares)
      .values({
        workspaceId: workspace.id,
        baseId: base.id,
        kind: 'form',
        viewId: formView.id,
        tokenHash: hashShareToken(formToken),
        createdBy: owner.id,
      })
      .returning();
    if (!formShare) throw new Error('authz matrix: no form share');
    const formUploadId = uuidv7();
    const formUploadKey = storageKey({ ...ids, id: formUploadId });
    await t.db.insert(attachments).values({
      ...ids,
      id: formUploadId,
      fieldId: attachmentField.id,
      shareId: formShare.id,
      storageKey: formUploadKey,
      filename: 'answer.txt',
      contentType: 'text/plain',
      size: 3,
    });
    await files.put(formUploadKey, new Uint8Array([1, 2, 3]));
    const [comment] = await t.db
      .insert(recordComments)
      .values({
        ...ids,
        recordId: record.id,
        authorId: users.commenter.id,
        body: 'First!',
      })
      .returning();
    if (!comment) throw new Error('authz matrix: no comment');
    // A revision whose restore sets Notes, so a refused restore would change something.
    const [revision] = await t.db
      .insert(recordRevisions)
      .values({
        ...ids,
        recordId: record.id,
        actorId: owner.id,
        kind: 'updated',
        changes: { [field.id]: { type: field.type, before: null, after: 'Restored' } },
      })
      .returning();
    if (!revision) throw new Error('authz matrix: no revision');
    // The editor's notification: only the recipient may mark it read.
    const notificationId = uuidv7();
    await t.db.insert(notifications).values({
      ...ids,
      id: notificationId,
      userId: users.editor.id,
      actorId: users.commenter.id,
      kind: 'mention',
      recordId: record.id,
      commentId: comment.id,
    });
    // A live service notice to every account.
    const noticeId = uuidv7();
    await t.db.insert(legalNotices).values({
      id: noticeId,
      kind: 'terms',
      audience: 'everyone',
      title: 'Terms update',
      summary: 'New terms.',
      url: 'https://openrows.io/terms',
      effectiveAt: new Date(Date.now() + 20 * 86_400_000),
    });
    // A reaction of the owner's, so taking one back changes something.
    await t.db.insert(recordCommentReactions).values({
      workspaceId: workspace.id,
      commentId: comment.id,
      userId: owner.id,
      reaction: 'heart',
    });
    // A snapshot of the base, taken last so it holds everything above.
    const baseSnapshot = await takeSnapshot(t.db, files, {
      workspaceId: workspace.id,
      baseId: base.id,
      userId: owner.id,
      kind: 'manual',
    });
    const other = await createWorkspace(t.db);
    await createBase(t.db, other.workspace.id);
    users.otherTenant = other.owner;
    // A personal access token of the owner, for the revoke route.
    const ownerToken = await createToken(t.db, owner, { workspaceIds: [workspace.id] });
    // An OAuth app the owner registered, and the owner's authorization of it.
    const [oauthApp] = await t.db
      .insert(oauthApps)
      .values({
        ownerId: owner.id,
        name: 'Matrix app',
        clientId: `or_app_${uuidv7().replace(/-/g, '').slice(0, 20)}`,
        secretHash: 'h',
        redirectUris: ['https://matrix.example.test/cb'],
      })
      .returning();
    if (!oauthApp) throw new Error('matrix: no OAuth app');
    const [oauthAuthorization] = await t.db
      .insert(oauthAuthorizations)
      .values({
        userId: owner.id,
        appId: oauthApp.id,
        scopes: ['data.records:read'],
        workspaceIds: [workspace.id],
      })
      .returning();
    if (!oauthAuthorization) throw new Error('matrix: no OAuth authorization');
    // A webhook of the base, to a private address: never reached.
    const [webhook] = await t.db
      .insert(webhooks)
      .values({
        workspaceId: workspace.id,
        baseId: base.id,
        url: 'https://10.0.0.1/hook',
        events: ['record.updated'],
        secretEncrypted: createCipher(DEV_DEFAULTS.ENCRYPTION_KEY, 'webhook-secret').encrypt(
          'whsec_matrix'
        ),
        createdBy: owner.id,
      })
      .returning();
    if (!webhook) throw new Error('matrix: no webhook');
    // A failed delivery of one of the base's events: redelivered, it's only queued.
    const [lastEvent] = await t.db
      .select({ id: outbox.id })
      .from(outbox)
      .where(eq(outbox.baseId, base.id))
      .orderBy(desc(outbox.id))
      .limit(1);
    if (!lastEvent) throw new Error('matrix: no outbox event');
    const [delivery] = await t.db
      .insert(webhookDeliveries)
      .values({
        workspaceId: workspace.id,
        webhookId: webhook.id,
        eventId: '01900000-0000-7000-8000-0000000000de',
        eventType: 'record.updated',
        outboxId: lastEvent.id,
        attempt: 1,
        success: false,
        responseStatus: 500,
        durationMs: 5,
      })
      .returning();
    if (!delivery) throw new Error('matrix: no webhook delivery');
    // An automation of the base, off, with one run.
    const [automation] = await t.db
      .insert(automations)
      .values({
        workspaceId: workspace.id,
        baseId: base.id,
        name: 'Matrix',
        trigger: { type: 'recordCreated', tableId: table.id },
        triggerType: 'recordCreated',
        tableId: table.id,
        createdBy: owner.id,
      })
      .returning();
    if (!automation) throw new Error('matrix: no automation');
    // A webhook-received automation, on, with its URL token.
    const hookToken = generateHookToken();
    const [hookAutomation] = await t.db
      .insert(automations)
      .values({
        workspaceId: workspace.id,
        baseId: base.id,
        name: 'Matrix hook',
        enabled: true,
        trigger: { type: 'webhookReceived' },
        actions: [{ type: 'createRecord', tableId: table.id, fields: {} }],
        triggerType: 'webhookReceived',
        hookTokenHash: hashHookToken(hookToken),
        hookTokenEncrypted: createCipher(DEV_DEFAULTS.ENCRYPTION_KEY, 'automation-secret').encrypt(
          hookToken
        ),
        hookSample: { hello: 'sample' },
        hookSampleAt: new Date(),
        createdBy: owner.id,
      })
      .returning();
    if (!hookAutomation) throw new Error('matrix: no hook automation');
    // A failed run of it, to retry.
    const [failedRun] = await t.db
      .insert(automationRuns)
      .values({
        workspaceId: workspace.id,
        automationId: hookAutomation.id,
        idempotencyKey: 'matrix-failed',
        status: 'failed',
        depth: 1,
        trigger: { type: 'webhookReceived', receivedAt: new Date().toISOString(), body: {} },
        error: 'Step 1 failed: matrix',
      })
      .returning();
    if (!failedRun) throw new Error('matrix: no failed run');
    await t.db.insert(automationRuns).values({
      workspaceId: workspace.id,
      automationId: automation.id,
      idempotencyKey: 'matrix',
      status: 'succeeded',
      depth: 1,
    });
    // An interface with a published page and a page never published.
    const [iface] = await t.db
      .insert(interfaces)
      .values({ workspaceId: workspace.id, baseId: base.id, name: 'Matrix' })
      .returning();
    if (!iface) throw new Error('matrix: no interface');
    const pageConfig = {
      layout: 'recordReview',
      tableId: table.id,
      sorts: [],
      fields: [],
      elements: [],
    };
    const [page, draftPage] = await t.db
      .insert(interfacePages)
      .values([
        {
          workspaceId: workspace.id,
          interfaceId: iface.id,
          name: 'Published',
          draft: pageConfig,
          published: pageConfig,
          publishedAt: new Date(),
        },
        { workspaceId: workspace.id, interfaceId: iface.id, name: 'Draft', draft: pageConfig },
      ])
      .returning();
    if (!page || !draftPage) throw new Error('matrix: no interface pages');
    // A published form page and the interface's interface-only collaborators.
    const formConfig = { layout: 'form', tableId: table.id, sorts: [], fields: [], elements: [] };
    const [formPage] = await t.db
      .insert(interfacePages)
      .values({
        workspaceId: workspace.id,
        interfaceId: iface.id,
        name: 'Form',
        draft: formConfig,
        published: formConfig,
        publishedAt: new Date(),
      })
      .returning();
    if (!formPage) throw new Error('matrix: no form page');
    users.interfaceEditor = await createUser(t.db);
    users.interfaceViewer = await createUser(t.db);
    await t.db.insert(interfaceMembers).values([
      {
        workspaceId: workspace.id,
        interfaceId: iface.id,
        userId: users.interfaceEditor.id,
        role: 'editor',
      },
      {
        workspaceId: workspace.id,
        interfaceId: iface.id,
        userId: users.interfaceViewer.id,
        role: 'read_only',
      },
    ]);
    const [interfaceInvitation] = await t.db
      .insert(workspaceInvitations)
      .values({
        workspaceId: workspace.id,
        baseId: base.id,
        interfaceId: iface.id,
        email: 'pending-interface@example.test',
        role: 'read_only',
        tokenHash: hashInvitationToken(generateInvitationToken()),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .returning();
    if (!interfaceInvitation) throw new Error('matrix: no interface invitation');
    const [script] = await t.db
      .insert(baseScripts)
      .values({ workspaceId: workspace.id, baseId: base.id, name: 'Matrix script', code: '' })
      .returning();
    if (!script) throw new Error('matrix: no script');
    const [extension] = await t.db
      .insert(baseExtensions)
      .values({
        workspaceId: workspace.id,
        baseId: base.id,
        builtIn: 'chart',
        name: 'Matrix chart',
        manifest: { manifestVersion: 1, name: 'Chart', scopes: ['records:read'] },
        position: 0,
      })
      .returning();
    if (!extension) throw new Error('matrix: no extension');
    // A table synced from the world's table, with a run.
    const { table: mirror, field: mirrorField } = await createTableWithFields(
      t.db,
      owner,
      base,
      'Mirror'
    );
    await t.db.update(tables).set({ synced: true }).where(eq(tables.id, mirror.id));
    const [mirrorSync] = await t.db
      .insert(tableSyncs)
      .values({
        workspaceId: workspace.id,
        baseId: base.id,
        tableId: mirror.id,
        sourceWorkspaceId: workspace.id,
        sourceBaseId: base.id,
        sourceTableId: table.id,
        sourceFieldId: mirrorField.id,
        schedule: 'manual',
        createdBy: owner.id,
      })
      .returning();
    if (!mirrorSync) throw new Error('matrix: no sync');
    const params: Params = {
      workspaceId: workspace.id,
      baseId: base.id,
      tableId: table.id,
      fieldId: field.id,
      deletedFieldId: deletedField.id,
      trashedBaseId: trashedBase.id,
      trashedTableId: trashedTable.id,
      trashedViewId: trashedView.id,
      recordId: record.id,
      deletedRecordId: deletedRecord.id,
      viewId: view.id,
      sectionId: section.id,
      userId: users.editor.id,
      invitationId: invitation.id,
      baseInvitationId: baseInvitation.id,
      token,
      importId: '01900000-0000-7000-8000-000000000000',
      restoreId: '01900000-0000-7000-8000-000000000001',
      duplicateId: '01900000-0000-7000-8000-000000000002',
      slug: 'crm',
      attachmentFieldId: attachmentField.id,
      linkFieldId: linkField.id,
      attachmentId: attachment.id,
      commentId: comment.id,
      reaction: 'heart',
      revisionId: revision.id,
      notificationId,
      noticeId,
      // Data residency: the OSS edition's one region creates nothing elsewhere.
      regionId: 'us',
      shareToken,
      shareId: share.id,
      baseShareId: baseShare.id,
      formToken,
      formUploadId,
      image: 'cover',
      tokenId: ownerToken.id,
      appId: oauthApp.id,
      oauthClientId: oauthApp.clientId,
      authorizationId: oauthAuthorization.id,
      snapshotId: baseSnapshot.id,
      webhookId: webhook.id,
      deliveryId: delivery.id,
      automationId: automation.id,
      hookAutomationId: hookAutomation.id,
      failedRunId: failedRun.id,
      hookToken,
      buttonFieldId: buttonField.id,
      aiFieldId: aiField.id,
      interfaceId: iface.id,
      pageId: page.id,
      scriptId: script.id,
      extensionId: extension.id,
      syncTableId: mirror.id,
      formPageId: formPage.id,
      interfaceMemberId: users.interfaceViewer.id,
      interfaceInvitationId: interfaceInvitation.id,
      provider: 'polar',
      connectorId: 'google-sheets',
    };
    return { workspace, other: other.workspace, base, table, users, params };
  }
  type World = Awaited<ReturnType<typeof createWorld>>;

  /** Every tenant row of both workspaces, to prove refused calls changed nothing. */
  async function snapshot(w: World) {
    // Every list in a stable order: the selects have none, and the plan (seq or index scan) can
    // change between the two snapshots.
    const sorted = <T extends Record<string, unknown[]>>(lists: T): T =>
      Object.fromEntries(
        Object.entries(lists).map(([k, rows]) => [
          k,
          rows
            .map((r) => [JSON.stringify(r), r] as const)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([, r]) => r),
        ])
      ) as T;
    return sorted(await rawSnapshot(w));
  }

  async function rawSnapshot(w: World) {
    const ids = [w.workspace.id, w.other.id];
    return {
      workspaces: await t.db.select().from(workspaces).where(inArray(workspaces.id, ids)),
      members: await t.db
        .select()
        .from(workspaceMembers)
        .where(inArray(workspaceMembers.workspaceId, ids)),
      bases: await t.db.select().from(bases).where(inArray(bases.workspaceId, ids)),
      baseMembers: await t.db
        .select()
        .from(baseMembers)
        .where(inArray(baseMembers.workspaceId, ids)),
      tables: await t.db.select().from(tables).where(inArray(tables.workspaceId, ids)),
      fields: await t.db.select().from(fields).where(inArray(fields.workspaceId, ids)),
      views: await t.db.select().from(views).where(inArray(views.workspaceId, ids)),
      viewSections: await t.db
        .select()
        .from(viewSections)
        .where(inArray(viewSections.workspaceId, ids)),
      outbox: await t.db.select().from(outbox).where(inArray(outbox.workspaceId, ids)),
      invitations: await t.db
        .select()
        .from(workspaceInvitations)
        .where(inArray(workspaceInvitations.workspaceId, ids)),
      attachments: await t.db
        .select()
        .from(attachments)
        .where(inArray(attachments.workspaceId, ids)),
      comments: await t.db
        .select()
        .from(recordComments)
        .where(inArray(recordComments.workspaceId, ids)),
      reactions: await t.db
        .select()
        .from(recordCommentReactions)
        .where(inArray(recordCommentReactions.workspaceId, ids)),
      revisions: await t.db
        .select()
        .from(recordRevisions)
        .where(inArray(recordRevisions.workspaceId, ids)),
      notifications: await t.db
        .select()
        .from(notifications)
        .where(inArray(notifications.workspaceId, ids)),
      shares: await t.db.select().from(shares).where(inArray(shares.workspaceId, ids)),
      tokens: await t.db
        .select()
        .from(personalAccessTokens)
        .where(sql`${personalAccessTokens.id} = ${w.params.tokenId}`),
      baseSnapshots: await t.db
        .select()
        .from(baseSnapshots)
        .where(inArray(baseSnapshots.workspaceId, ids)),
      formSubmissions: await t.db
        .select()
        .from(formSubmissions)
        .where(inArray(formSubmissions.workspaceId, ids)),
      webhooks: await t.db.select().from(webhooks).where(inArray(webhooks.workspaceId, ids)),
      webhookDeliveries: await t.db
        .select()
        .from(webhookDeliveries)
        .where(inArray(webhookDeliveries.workspaceId, ids)),
      automations: await t.db
        .select()
        .from(automations)
        .where(inArray(automations.workspaceId, ids)),
      automationRuns: await t.db
        .select()
        .from(automationRuns)
        .where(inArray(automationRuns.workspaceId, ids)),
      baseScripts: await t.db
        .select()
        .from(baseScripts)
        .where(inArray(baseScripts.workspaceId, ids)),
      baseExtensions: await t.db
        .select()
        .from(baseExtensions)
        .where(inArray(baseExtensions.workspaceId, ids)),
      tableSyncs: await t.db.select().from(tableSyncs).where(inArray(tableSyncs.workspaceId, ids)),
      tableSyncRuns: await t.db
        .select()
        .from(tableSyncRuns)
        .where(inArray(tableSyncRuns.workspaceId, ids)),
      interfaces: await t.db.select().from(interfaces).where(inArray(interfaces.workspaceId, ids)),
      interfacePages: await t.db
        .select()
        .from(interfacePages)
        .where(inArray(interfacePages.workspaceId, ids)),
      interfaceMembers: await t.db
        .select()
        .from(interfaceMembers)
        .where(inArray(interfaceMembers.workspaceId, ids)),
      records: (await t.db.execute(sql`SELECT * FROM ${qualified(w.table)} ORDER BY id`)).rows,
    };
  }

  function pathFor(entry: Pick<RouteEntry, 'path'>, w: World, c?: Case): string {
    return entry.path.replace(/:(\w+)/g, (_, name: string) => {
      const value = w.params[c?.params?.[name] ?? name];
      if (!value) throw new Error(`authz matrix: add a value for :${name} to createWorld().params`);
      return value;
    });
  }

  function queryFor(w: World, c: Case): string {
    return typeof c.query === 'function' ? c.query(w.params) : (c.query ?? '');
  }

  /** A refusal's media type: problem+json, or the REST API v1's Airtable-style JSON. */
  function refusalType(entry: Pick<RouteEntry, 'path'>): string {
    return isV1Path(entry.path) ? 'application/json; charset=UTF-8' : 'application/problem+json';
  }

  it('has a case for every registered route, and none for routes that are gone', () => {
    expect(Object.keys(CASES).sort()).toEqual(ENTRIES.map(key).sort());
  });

  describe.each(ENTRIES.map((e) => [key(e), e] as const))('%s', (name, entry) => {
    it.each(CALLERS)('as %s', async (caller) => {
      const c = CASES[name];
      if (!c) throw new Error(`authz matrix: no case for ${name}`);
      const w = await createWorld();
      const headers = new Headers({ origin: appUrl });
      if (caller !== 'anonymous') {
        headers.set('cookie', `${SESSION_COOKIE}=${await createSession(t.db, w.users[caller])}`);
      }
      const body = typeof c.body === 'function' ? c.body(w.params) : c.body;
      if (body !== undefined) headers.set('content-type', 'application/json');
      for (const [name, value] of Object.entries(c.headers ?? {})) headers.set(name, value);
      const before = await snapshot(w);

      const res = await app.request(pathFor(entry, w, c) + queryFor(w, c), {
        method: entry.method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

      const expected = c.expect[caller];
      expect(res.status, `${name} as ${caller}`).toBe(expected);
      if ([401, 403, 404].includes(expected)) {
        expect(res.headers.get('content-type')).toBe(refusalType(entry));
        expect(await snapshot(w), 'a refused call must not change data').toEqual(before);
      }
    });
  });

  describe.each(ENTRIES.map((e) => [key(e), e] as const))('%s (token)', (name, entry) => {
    it.each(TOKEN_CALLERS)('as %s', async (caller) => {
      const c = CASES[name];
      if (!c) throw new Error(`authz matrix: no case for ${name}`);
      const w = await createWorld();
      const user = caller === 'readOnlyToken' ? w.users.read_only : w.users.owner;
      const { token } = await createToken(t.db, user, {
        // Only webhook:manage: the webhook routes are the only ones it reaches.
        scopes: caller === 'scopelessToken' ? ['webhook:manage'] : TOKEN_SCOPES,
        workspaceIds: [caller === 'elsewhereToken' ? w.other.id : w.workspace.id],
      });
      const headers = new Headers({ origin: appUrl, authorization: `Bearer ${token}` });
      const body = typeof c.body === 'function' ? c.body(w.params) : c.body;
      if (body !== undefined) headers.set('content-type', 'application/json');
      for (const [name, value] of Object.entries(c.headers ?? {})) headers.set(name, value);
      const before = await snapshot(w);

      const res = await app.request(pathFor(entry, w, c) + queryFor(w, c), {
        method: entry.method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

      const expected = tokenExpect(entry, c, caller);
      expect(res.status, `${name} as ${caller}`).toBe(expected);
      if (entry.access.kind !== 'public') {
        expect(res.headers.get('set-cookie'), 'bearer requests set no cookies').toBeNull();
      }
      if ([401, 403, 404].includes(expected)) {
        expect(res.headers.get('content-type')).toBe(refusalType(entry));
        expect(await snapshot(w), 'a refused call must not change data').toEqual(before);
      }
    });
  });

  describe.each(ENTRIES.map((e) => [key(e), e] as const))('%s (cross-base)', (name, entry) => {
    it.each(CROSS_BASE_CALLERS)('as %s', async (caller) => {
      const c = CASES[name];
      if (!c) throw new Error(`authz matrix: no case for ${name}`);
      const w = await createWorld();
      const headers = new Headers({ origin: appUrl });
      headers.set('cookie', `${SESSION_COOKIE}=${await createSession(t.db, w.users[caller])}`);
      const body = typeof c.body === 'function' ? c.body(w.params) : c.body;
      if (body !== undefined) headers.set('content-type', 'application/json');
      for (const [name, value] of Object.entries(c.headers ?? {})) headers.set(name, value);
      const before = await snapshot(w);

      const res = await app.request(pathFor(entry, w, c) + queryFor(w, c), {
        method: entry.method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

      const expected = crossBaseExpect(entry.path, c, caller);
      expect(res.status, `${name} as ${caller}`).toBe(expected);
      if ([401, 403, 404].includes(expected)) {
        expect(res.headers.get('content-type')).toBe(refusalType(entry));
        expect(await snapshot(w), 'a refused call must not change data').toEqual(before);
      }
    });
  });

  describe.each(ENTRIES.map((e) => [key(e), e] as const))('%s (interface-only)', (name, entry) => {
    it.each(INTERFACE_CALLERS)('as %s', async (caller) => {
      const c = CASES[name];
      if (!c) throw new Error(`authz matrix: no case for ${name}`);
      const w = await createWorld();
      const headers = new Headers({ origin: appUrl });
      headers.set('cookie', `${SESSION_COOKIE}=${await createSession(t.db, w.users[caller])}`);
      const body = typeof c.body === 'function' ? c.body(w.params) : c.body;
      if (body !== undefined) headers.set('content-type', 'application/json');
      for (const [name, value] of Object.entries(c.headers ?? {})) headers.set(name, value);
      const before = await snapshot(w);

      const res = await app.request(pathFor(entry, w, c) + queryFor(w, c), {
        method: entry.method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

      const expected = interfaceOnlyExpect(entry.path, c, caller);
      expect(res.status, `${name} as ${caller}`).toBe(expected);
      if ([401, 403, 404].includes(expected)) {
        expect(res.headers.get('content-type')).toBe(refusalType(entry));
        expect(await snapshot(w), 'a refused call must not change data').toEqual(before);
      }
    });
  });

  describe.each(
    VIEW_STATE_CASES.map((c) => {
      const body = typeof c.case.body === 'object' ? ` ${JSON.stringify(c.case.body)}` : '';
      return [`${c.state} view: ${c.route}${body}`, c] as const;
    })
  )('%s', (_name, c) => {
    it.each(CALLERS)('as %s', async (caller) => {
      const w = await createWorld();
      const changes =
        c.state === 'personal'
          ? { personal: true, createdBy: w.users.editor.id }
          : { locked: true, createdBy: w.users.owner.id };
      await t.db.update(views).set(changes).where(sql`${views.id} = ${w.params.viewId}`);
      const [method = '', path = ''] = c.route.split(' ');
      const headers = new Headers({ origin: appUrl });
      if (caller !== 'anonymous') {
        headers.set('cookie', `${SESSION_COOKIE}=${await createSession(t.db, w.users[caller])}`);
      }
      const body = typeof c.case.body === 'function' ? c.case.body(w.params) : c.case.body;
      if (body !== undefined) headers.set('content-type', 'application/json');
      const before = await snapshot(w);

      const res = await app.request(pathFor({ path }, w), {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

      const expected = c.case.expect[caller];
      expect(res.status, `${c.route} as ${caller}`).toBe(expected);
      if ([401, 403, 404].includes(expected)) {
        expect(await snapshot(w), 'a refused call must not change data').toEqual(before);
      }
    });
  });

  it("matches nothing for link filter or picker ids of another tenant's records (#82)", async () => {
    const w = await createWorld();
    const otherBase = await createBase(t.db, w.other.id);
    const theirs = await createTableWithFields(t.db, w.users.otherTenant, otherBase);
    const { record: foreign } = await createRecordsIn(t.db, w.users.otherTenant, theirs.table);
    const as = async (caller: Exclude<Caller, 'anonymous'>, path: string, body?: unknown) => {
      const headers = new Headers({ origin: appUrl });
      headers.set('cookie', `${SESSION_COOKIE}=${await createSession(t.db, w.users[caller])}`);
      if (body !== undefined) headers.set('content-type', 'application/json');
      return app.request(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    };
    const { linkFieldId, recordId } = w.params;
    // The world's record links itself (a self-link), so a real id does match.
    const linked = await app.request(`/api/tables/${w.table.id}/records/${recordId}`, {
      method: 'PATCH',
      headers: {
        origin: appUrl,
        'content-type': 'application/json',
        cookie: `${SESSION_COOKIE}=${await createSession(t.db, w.users.owner)}`,
      },
      body: JSON.stringify({ fields: { [linkFieldId]: [recordId] } }),
    });
    expect(linked.status).toBe(200);
    const query = (operator: string, value: string[]) => ({
      query: { filter: { conditions: [{ fieldId: linkFieldId, operator, value }] } },
      count: true,
    });
    const queryPath = `/api/tables/${w.table.id}/records/query`;
    for (const caller of USER_ROLES) {
      const total = async (operator: string, value: string[]) => {
        const res = await as(caller, queryPath, query(operator, value));
        expect(res.status, `${operator} as ${caller}`).toBe(200);
        return ((await res.json()) as { total: number }).total;
      };
      expect(await total('hasAnyOf', [foreign.id]), caller).toBe(0);
      expect(await total('hasAnyOf', [foreign.id, recordId]), caller).toBe(1);
      expect(await total('hasNoneOf', [foreign.id]), caller).toBe(1);
      const picked = await as(
        caller,
        `/api/fields/${linkFieldId}/link-candidates?ids=${foreign.id},${recordId}`
      );
      expect(picked.status).toBe(200);
      const { records } = (await picked.json()) as { records: { id: string }[] };
      expect(
        records.map((r) => r.id),
        caller
      ).toEqual([recordId]);
    }
    // The other tenant can't query this table at all, with or without its own ids.
    expect((await as('otherTenant', queryPath, query('hasAnyOf', [foreign.id]))).status).toBe(404);
    const theirPick = await as(
      'otherTenant',
      `/api/fields/${linkFieldId}/link-candidates?ids=${foreign.id}`
    );
    expect(theirPick.status).toBe(404);
  });

  it("lists another user's personal view only to them", async () => {
    const w = await createWorld();
    await t.db
      .update(views)
      .set({ personal: true, createdBy: w.users.editor.id })
      .where(sql`${views.id} = ${w.params.viewId}`);
    for (const caller of USER_ROLES) {
      const res = await app.request(`/api/tables/${w.table.id}/views`, {
        headers: { cookie: `${SESSION_COOKIE}=${await createSession(t.db, w.users[caller])}` },
      });
      const { views: listed } = (await res.json()) as { views: { id: string }[] };
      expect(
        listed.some((v) => v.id === w.params.viewId),
        caller
      ).toBe(caller === 'editor');
    }
  });
});
