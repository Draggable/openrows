import { randomUUID } from 'node:crypto';
import { TOKEN_SCOPES, type TokenScope, type UserRole } from '@openrows/shared';
import { uuidv7 } from 'uuidv7';
import {
  generateSessionToken,
  hashSessionToken,
  SESSION_COOKIE,
} from '../../src/auth/session-token.js';
import { generateToken } from '../../src/auth/tokens.js';
import { inScope } from '../../src/authz/scope.js';
import {
  aiCreditCounts,
  aiFieldCells,
  airtableImportRecords,
  apiCallCounts,
  attachments,
  automationEmailCounts,
  automationMatches,
  automationRunCounts,
  automationRuns,
  automations,
  baseExtensions,
  baseMembers,
  baseScripts,
  baseSnapshots,
  bases,
  billingSubscriptions,
  type Database,
  fields,
  formSubmissions,
  interfaceMembers,
  interfacePages,
  interfaces,
  jobs,
  notifications,
  outbox,
  personalAccessTokens,
  recordCommentReactions,
  recordComments,
  recordRevisions,
  sessions,
  shares,
  storageGarbage,
  type Transaction,
  tableRecordCounts,
  tableSyncRuns,
  tableSyncs,
  tables,
  usageWarningsSent,
  users,
  viewRecordPositions,
  viewSections,
  views,
  webhookDeliveries,
  webhooks,
  workspaceAiSettings,
  workspaceAuditEvents,
  workspaceAuditStreams,
  workspaceInvitations,
  workspaceMemberActivity,
  workspaceMembers,
  workspacePolicies,
  workspaceScimGroupMembers,
  workspaceScimGroups,
  workspaceScimSettings,
  workspaceScimUsers,
  workspaceSsoConnections,
  workspaceSsoDomains,
  workspaces,
} from '../../src/db/index.js';
import { unlimitedEntitlements } from '../../src/edition/oss.js';
import { type EmailTransport, memoryTransport } from '../../src/email/transport.js';
import { createField, deleteField } from '../../src/fields/service.js';
import type { FieldVisibility } from '../../src/realtime/projection.js';
import { createRecords, deleteRecords } from '../../src/records/service.js';
import { createTable, loadField, loadTable } from '../../src/tables/service.js';
import { testApp } from './app.js';
import type { TestDb } from './db.js';

export const TEST_ISSUER = 'http://keycloak.test/realms/openrows';

type User = typeof users.$inferSelect;
type Workspace = typeof workspaces.$inferSelect;
type Base = typeof bases.$inferSelect;

const hex = () => randomUUID().replaceAll('-', '');

/** Inserts a user as if they had signed in through OIDC. */
export async function createUser(
  db: Database,
  overrides: Partial<typeof users.$inferInsert> = {}
): Promise<User> {
  const subject = overrides.oidcSubject ?? randomUUID();
  const [user] = await db
    .insert(users)
    .values({
      oidcIssuer: TEST_ISSUER,
      oidcSubject: subject,
      email: `user-${subject.slice(0, 8)}@example.test`,
      emailVerified: true,
      name: 'Test User',
      ...overrides,
    })
    .returning();
  if (!user) throw new Error('createUser: insert returned no row');
  return user;
}

/** Inserts a workspace, with `owner` (created if omitted) as its owner member. */
export async function createWorkspace(
  db: Database,
  opts: { owner?: User; name?: string } = {}
): Promise<{ workspace: Workspace; owner: User }> {
  const owner = opts.owner ?? (await createUser(db));
  const [workspace] = await db
    .insert(workspaces)
    .values({ name: opts.name ?? 'Test workspace' })
    .returning();
  if (!workspace) throw new Error('createWorkspace: insert returned no row');
  await db.insert(workspaceMembers).values({
    workspaceId: workspace.id,
    userId: owner.id,
    role: 'owner',
  });
  return { workspace, owner };
}

/** Adds `user` (created if omitted) to the workspace with `role`. */
export async function addMember(
  db: Database,
  workspaceId: string,
  role: UserRole,
  user?: User
): Promise<User> {
  const member = user ?? (await createUser(db));
  await db.insert(workspaceMembers).values({ workspaceId, userId: member.id, role });
  return member;
}

/** Inserts a base (metadata only; no physical schema). */
export async function createBase(
  db: Database,
  workspaceId: string,
  overrides: Partial<typeof bases.$inferInsert> = {}
): Promise<Base> {
  const [base] = await db
    .insert(bases)
    .values({ workspaceId, name: 'Test base', dbSchema: `b_${hex()}`, ...overrides })
    .returning();
  if (!base) throw new Error('createBase: insert returned no row');
  return base;
}

/**
 * A workspace with one row in every tenant table: owner, base, base override (for `owner`),
 * table, field, view, outbox event and attachment (metadata only: no physical schema). RLS and resolver tests use two of these as two tenants.
 */
export async function createTenant(db: Database) {
  const { workspace, owner } = await createWorkspace(db);
  const base = await createBase(db, workspace.id);
  const collaborator = await createUser(db);
  await db.insert(baseMembers).values({
    workspaceId: workspace.id,
    baseId: base.id,
    userId: collaborator.id,
    role: 'editor',
  });
  const [table] = await db
    .insert(tables)
    .values({
      workspaceId: workspace.id,
      baseId: base.id,
      name: 'Table',
      dbSchema: base.dbSchema,
      dbTable: `t_${hex()}`,
    })
    .returning();
  if (!table) throw new Error('createTenant: no table');
  const [field] = await db
    .insert(fields)
    .values({
      workspaceId: workspace.id,
      tableId: table.id,
      name: 'Name',
      type: 'singleLineText',
      dbColumn: `f_${hex()}`,
    })
    .returning();
  const [view] = await db
    .insert(views)
    .values({ workspaceId: workspace.id, tableId: table.id, name: 'Grid' })
    .returning();
  if (!field || !view) throw new Error('createTenant: no field or view');
  await db
    .insert(outbox)
    .values({ workspaceId: workspace.id, baseId: base.id, kind: 'base.created', payload: {} });
  await db.insert(attachments).values({
    workspaceId: workspace.id,
    baseId: base.id,
    tableId: table.id,
    fieldId: field.id,
    storageKey: `ws/${workspace.id}/${hex()}`,
    filename: 'file.txt',
    contentType: 'text/plain',
    size: 1,
  });
  await db
    .insert(viewRecordPositions)
    .values({ workspaceId: workspace.id, viewId: view.id, recordId: uuidv7(), position: 1024 });
  await db
    .insert(viewSections)
    .values({ workspaceId: workspace.id, tableId: table.id, name: 'Section', position: 1 });
  const [comment] = await db
    .insert(recordComments)
    .values({
      workspaceId: workspace.id,
      baseId: base.id,
      tableId: table.id,
      recordId: uuidv7(),
      authorId: owner.id,
      body: 'A comment',
    })
    .returning();
  if (!comment) throw new Error('createTenant: no comment');
  await db.insert(recordCommentReactions).values({
    workspaceId: workspace.id,
    commentId: comment.id,
    userId: owner.id,
    reaction: 'heart',
  });
  await db.insert(recordRevisions).values({
    workspaceId: workspace.id,
    baseId: base.id,
    tableId: table.id,
    recordId: uuidv7(),
    actorId: owner.id,
    kind: 'created',
  });
  // A notification for the collaborator, whose RLS is per recipient.
  await db.insert(notifications).values({
    workspaceId: workspace.id,
    userId: collaborator.id,
    actorId: owner.id,
    kind: 'mention',
    baseId: base.id,
    tableId: table.id,
    recordId: uuidv7(),
    commentId: comment.id,
  });
  // A share link of the view; the hash of no real token.
  const [share] = await db
    .insert(shares)
    .values({
      workspaceId: workspace.id,
      baseId: base.id,
      kind: 'view',
      viewId: view.id,
      tokenHash: hex() + hex(),
      createdBy: owner.id,
    })
    .returning();
  if (!share) throw new Error('createTenant: no share');
  // A form submission (the share kind doesn't matter to RLS).
  await db.insert(formSubmissions).values({
    workspaceId: workspace.id,
    baseId: base.id,
    shareId: share.id,
    tableId: table.id,
    recordId: uuidv7(),
    submissionId: uuidv7(),
  });
  // A base snapshot's row (no object needed for RLS).
  await db.insert(baseSnapshots).values({
    workspaceId: workspace.id,
    baseId: base.id,
    baseName: base.name,
    kind: 'manual',
    storageKey: `snapshots/ws/${workspace.id}/b/${base.id}/${uuidv7()}.jsonl.gz`,
    size: 0,
    tableCount: 1,
    recordCount: 0,
  });
  // A webhook and one delivery attempt (the secret is never read here).
  const [webhook] = await db
    .insert(webhooks)
    .values({
      workspaceId: workspace.id,
      baseId: base.id,
      url: 'https://hooks.example.test/in',
      events: ['record.created'],
      secretEncrypted: Buffer.from('not a real ciphertext'),
      createdBy: owner.id,
    })
    .returning();
  if (!webhook) throw new Error('createTenant: no webhook');
  await db.insert(webhookDeliveries).values({
    workspaceId: workspace.id,
    webhookId: webhook.id,
    eventId: uuidv7(),
    eventType: 'record.created',
    attempt: 1,
    success: true,
    responseStatus: 204,
    durationMs: 12,
  });
  // An automation with a run, a match and the month's run count.
  const [automation] = await db
    .insert(automations)
    .values({
      workspaceId: workspace.id,
      baseId: base.id,
      name: 'Tenant automation',
      trigger: { type: 'recordCreated', tableId: table.id },
      triggerType: 'recordCreated',
      tableId: table.id,
      createdBy: owner.id,
    })
    .returning();
  if (!automation) throw new Error('createTenant: no automation');
  await db.insert(automationRuns).values({
    workspaceId: workspace.id,
    automationId: automation.id,
    idempotencyKey: 'tenant',
    status: 'succeeded',
    depth: 1,
  });
  await db.insert(automationMatches).values({
    workspaceId: workspace.id,
    automationId: automation.id,
    recordId: uuidv7(),
  });
  await db
    .insert(automationRunCounts)
    .values({ workspaceId: workspace.id, month: '2026-10-01', runs: 1 });
  // An interface with a published page.
  const [iface] = await db
    .insert(interfaces)
    .values({ workspaceId: workspace.id, baseId: base.id, name: 'Tenant interface' })
    .returning();
  if (!iface) throw new Error('createTenant: no interface');
  const pageConfig = {
    layout: 'recordList',
    tableId: table.id,
    sorts: [],
    fields: [],
    elements: [],
  };
  await db.insert(interfacePages).values({
    workspaceId: workspace.id,
    interfaceId: iface.id,
    name: 'Tenant page',
    draft: pageConfig,
    published: pageConfig,
    publishedAt: new Date(),
  });
  // An interface-only collaborator of it.
  const interfaceGuest = await createUser(db);
  await db.insert(interfaceMembers).values({
    workspaceId: workspace.id,
    interfaceId: iface.id,
    userId: interfaceGuest.id,
    role: 'read_only',
  });
  // The plan's counters: the table's live records and the month's API calls.
  await db
    .insert(tableRecordCounts)
    .values({ workspaceId: workspace.id, baseId: base.id, tableId: table.id, records: 1 });
  await db
    .insert(apiCallCounts)
    .values({ workspaceId: workspace.id, month: '2026-10-01', calls: 1 });
  // The month's AI credits, as the owner writes them (the app role only through the
  // function).
  await db
    .insert(aiCreditCounts)
    .values({ workspaceId: workspace.id, month: '2026-10-01', credits: 1, requests: 1, tokens: 9 });
  // A plan-limit warning emailed to its owners.
  await db.insert(usageWarningsSent).values({
    workspaceId: workspace.id,
    metric: 'recordsPerBase',
    subject: base.id,
    level: 'near',
    month: '2026-10-01',
  });
  // The workspace's own AI provider; the key's bytes don't matter here.
  await db.insert(workspaceAiSettings).values({
    workspaceId: workspace.id,
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    apiKeyEncrypted: Buffer.from('not-a-real-ciphertext'),
  });
  // An audit log entry and SIEM stream; the stream's secret bytes don't matter here.
  await db.insert(workspaceAuditEvents).values({
    workspaceId: workspace.id,
    action: 'workspace.update',
    actorKind: 'user',
    actorId: owner.id,
    targetType: 'workspace',
    targetId: workspace.id,
  });
  await db.insert(workspaceAuditStreams).values({
    workspaceId: workspace.id,
    url: 'https://siem.example.test/ingest',
    secretEncrypted: Buffer.from('not-a-real-ciphertext'),
  });
  // Single sign-on: a connection and an unverified domain of the workspace's own.
  await db.insert(workspaceSsoConnections).values({
    workspaceId: workspace.id,
    alias: `ws-${workspace.id}`,
    protocol: 'oidc',
    displayName: 'Tenant IdP',
    config: { issuer: 'https://idp.example.test', clientId: 'openrows' },
  });
  await db.insert(workspaceSsoDomains).values({
    id: uuidv7(),
    workspaceId: workspace.id,
    domain: `${workspace.id}.example.test`,
    token: 'tenant-token',
  });
  // The admin console: the workspace's policies and the owner's last activity.
  await db.insert(workspacePolicies).values({ workspaceId: workspace.id });
  await db.insert(workspaceMemberActivity).values({ workspaceId: workspace.id, userId: owner.id });
  // SCIM provisioning: settings, a user in a group of the workspace's own.
  await db
    .insert(workspaceScimSettings)
    .values({ workspaceId: workspace.id, tokenHash: `tenant-${workspace.id}` });
  const scimUserId = uuidv7();
  const scimGroupId = uuidv7();
  await db.insert(workspaceScimUsers).values({
    id: scimUserId,
    workspaceId: workspace.id,
    userName: 'tenant@example.test',
    email: 'tenant@example.test',
  });
  await db
    .insert(workspaceScimGroups)
    .values({ id: scimGroupId, workspaceId: workspace.id, displayName: 'Tenant group' });
  await db
    .insert(workspaceScimGroupMembers)
    .values({ workspaceId: workspace.id, groupId: scimGroupId, scimUserId });
  // A saved script of the base.
  await db.insert(baseScripts).values({
    workspaceId: workspace.id,
    baseId: base.id,
    name: 'Tenant script',
    code: "output.text('hi');",
  });
  // An installed extension of the base.
  await db.insert(baseExtensions).values({
    workspaceId: workspace.id,
    baseId: base.id,
    builtIn: 'chart',
    name: 'Chart',
    manifest: { manifestVersion: 1, name: 'Chart', description: '', version: '1.0.0', scopes: [] },
    position: 0,
  });
  // A synced table's sync and one of its runs, from the table itself.
  const [sync] = await db
    .insert(tableSyncs)
    .values({
      workspaceId: workspace.id,
      baseId: base.id,
      tableId: table.id,
      sourceWorkspaceId: workspace.id,
      sourceBaseId: base.id,
      sourceTableId: table.id,
      sourceFieldId: field.id,
      schedule: 'manual',
    })
    .returning();
  if (sync) {
    await db
      .insert(tableSyncRuns)
      .values({ workspaceId: workspace.id, syncId: sync.id, trigger: 'manual' });
  }
  // An AI field cell's generation state.
  await db
    .insert(aiFieldCells)
    .values({ workspaceId: workspace.id, fieldId: field.id, recordId: uuidv7(), status: 'done' });
  // A subscription at the billing provider.
  await db.insert(billingSubscriptions).values({
    workspaceId: workspace.id,
    provider: 'polar',
    subscriptionId: `sub_${workspace.id}`,
    customerId: `cus_${workspace.id}`,
    plan: 'pro',
    interval: 'month',
    status: 'active',
    entitled: true,
    changedAt: new Date('2026-10-01T00:00:00Z'),
  });
  // Automation emails of a day.
  await db
    .insert(automationEmailCounts)
    .values({ workspaceId: workspace.id, day: '2026-10-27', sent: 1 });
  // A background job's state and a stored object's key waiting for the GC.
  const [job] = await db
    .insert(jobs)
    .values({
      workspaceId: workspace.id,
      baseId: base.id,
      tableId: table.id,
      kind: 'import',
      createdBy: owner.id,
      progress: { totalRows: 1, processedRows: 0, skippedCells: 0, createdFieldIds: [] },
    })
    .returning();
  // An Airtable import's record map.
  await db.insert(airtableImportRecords).values({
    jobId: job?.id ?? '',
    workspaceId: workspace.id,
    airtableId: 'recFactory0000001',
    tableId: table.id,
    recordId: uuidv7(),
  });
  await db.insert(storageGarbage).values({
    workspaceId: workspace.id,
    storageKey: `ws/${workspace.id}/b/${base.id}/gone`,
    kind: 'file',
  });
  await db.insert(workspaceInvitations).values({
    workspaceId: workspace.id,
    email: `invitee-${hex().slice(0, 8)}@example.test`,
    role: 'editor',
    tokenHash: hex(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return { workspace, owner, base, collaborator, table, field, view };
}

/** Creates a session for `user` and returns the raw cookie token. */
export async function createSession(db: Database, user: User): Promise<string> {
  const token = generateSessionToken();
  await db.insert(sessions).values({
    idHash: hashSessionToken(token),
    userId: user.id,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });
  return token;
}

/**
 * A personal access token of `user`, inserted directly (no grant checks), returning the
 * bearer string. All scopes by default; grant workspaces and/or bases.
 */
export async function createToken(
  db: Database,
  user: User,
  opts: {
    scopes?: readonly TokenScope[];
    workspaceIds?: string[];
    baseIds?: string[];
    expiresAt?: Date;
    revokedAt?: Date;
  } = {}
): Promise<{ id: string; token: string }> {
  const { token, publicId, secretHash } = generateToken();
  const id = uuidv7();
  await db.insert(personalAccessTokens).values({
    id,
    userId: user.id,
    name: 'Test token',
    publicId,
    secretHash,
    scopes: [...(opts.scopes ?? TOKEN_SCOPES)],
    workspaceIds: opts.workspaceIds ?? [],
    baseIds: opts.baseIds ?? [],
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000),
    revokedAt: opts.revokedAt ?? null,
  });
  return { id, token };
}

/**
 * An in-process client for the app (connected as openrows_app) that sends `user`'s session
 * cookie on every request.
 */
export async function authedClient(
  t: Pick<TestDb, 'db' | 'appDb'>,
  user: User,
  opts: { email?: EmailTransport; visibility?: FieldVisibility } = {}
) {
  const email = memoryTransport();
  const { app } = testApp({
    db: t.appDb,
    email: opts.email ?? email,
    visibility: opts.visibility,
  });
  const token = await createSession(t.db, user);
  return {
    token,
    /** The mail this client's app sent (empty when `opts.email` replaces the transport). */
    email,
    request(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      headers.append('cookie', `${SESSION_COOKIE}=${token}`);
      return app.request(path, { ...init, headers });
    },
  };
}

/**
 * A real table (physical schema and record table) in `base`, created through the schema service
 * as `owner`: the default fields, plus a field moved to the trash. `field` is Notes (not primary).
 */
export async function createTableWithFields(db: Database, owner: User, base: Base, name = 'Tasks') {
  const ctxFor = (tx: Transaction) => ({ tx, workspaceId: base.workspaceId, userId: owner.id });
  return inScope(db, { userId: owner.id, workspaceId: base.workspaceId }, async (tx) => {
    const ctx = ctxFor(tx);
    const created = await createTable(ctx, base, { name });
    const table = await loadTable(tx, created.id);
    const deleted = await createField(ctx, table, { name: 'Old', type: 'number' });
    await deleteField(ctx, deleted);
    const notes = created.fields.find((f) => f.name === 'Notes');
    if (!notes) throw new Error('createTableWithFields: no Notes field');
    return { table, field: await loadField(tx, notes.id), deletedField: deleted };
  });
}

/** Two records in `table` through the RecordService as `owner`, the second one deleted. */
export async function createRecordsIn(
  db: Database,
  owner: User,
  table: typeof tables.$inferSelect
) {
  return inScope(db, { userId: owner.id, workspaceId: table.workspaceId }, async (tx) => {
    const ctx = {
      tx,
      workspaceId: table.workspaceId,
      userId: owner.id,
      role: 'owner' as const,
      entitlements: unlimitedEntitlements(),
      table,
    };
    const [record, deletedRecord] = await createRecords(ctx, [{}, {}]);
    if (!record || !deletedRecord) throw new Error('createRecordsIn: no records');
    await deleteRecords(ctx, [deletedRecord.id]);
    return { record, deletedRecord };
  });
}

/**
 * A confirmed (ready) attachment row of `field`, metadata only (no object in storage), for tests
 * that write attachment cells (cells take only ready files of the same base).
 */
export async function createReadyAttachment(
  db: Database,
  at: { workspaceId: string; baseId: string; tableId: string; fieldId: string },
  file: { filename: string; type: string; size: number }
) {
  const id = uuidv7();
  await db.insert(attachments).values({
    ...at,
    id,
    storageKey: `ws/${at.workspaceId}/b/${at.baseId}/t/${at.tableId}/${id}`,
    filename: file.filename,
    contentType: file.type,
    size: file.size,
    status: 'ready',
  });
  return { id, ...file };
}
