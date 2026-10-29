import { createHash, randomBytes } from 'node:crypto';
import type {
  Invitation,
  InvitationPreview,
  InvitationStatus,
  Member,
  UserRole,
  Workspace,
} from '@openrows/shared';
import {
  INTERFACE_ROLES,
  type InterfaceRole,
  MAX_BASE_INVITATIONS,
  MAX_INTERFACE_COLLABORATORS,
  MAX_INTERFACE_INVITATIONS,
} from '@openrows/shared';
import { and, asc, eq, isNull, type SQL, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { effectiveRole, higherRole } from '../authz/policy.js';
import { setScope } from '../authz/scope.js';
import { emitAccessChange } from '../data/outbox.js';
import {
  baseMembers,
  bases,
  type Database,
  interfaceMembers,
  interfaces,
  type Transaction,
  users,
  workspaceInvitations,
  workspaceMembers,
  workspaces,
} from '../db/index.js';
import { invitationEmail } from '../email/templates.js';
import type { EmailTransport } from '../email/transport.js';
import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { assertInviteAllowed } from '../policies/repo.js';

type WorkspaceRow = typeof workspaces.$inferSelect;
type UserRow = typeof users.$inferSelect;
type InvitationRow = typeof workspaceInvitations.$inferSelect;

/** How long an emailed invitation link works. Resending starts a new period. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function toWorkspace(w: WorkspaceRow, role: UserRole | null): Workspace {
  return {
    id: w.id,
    name: w.name,
    role,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}

/** The name of a new user's personal workspace. */
export function personalWorkspaceName(name: string | null): string {
  const first = name?.trim().split(/\s+/)[0];
  return first ? `${first}'s workspace` : 'My workspace';
}

/**
 * Creates the user's personal workspace on their first sign-in, owned by them. Idempotent
 * and race-free: the user's row is locked, and `users.personal_workspace_id` is set once, so a
 * personal workspace that was renamed or deleted isn't created again. Returns its id.
 */
export async function ensurePersonalWorkspace(db: Database, user: UserRow): Promise<string> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: users.personalWorkspaceId })
      .from(users)
      .where(eq(users.id, user.id))
      .for('update');
    if (!row) throw new Error('ensurePersonalWorkspace: no such user');
    if (row.id) return row.id;
    const workspaceId = uuidv7();
    await setScope(tx, { userId: user.id, workspaceId });
    await tx.insert(workspaces).values({ id: workspaceId, name: personalWorkspaceName(user.name) });
    await tx.insert(workspaceMembers).values({ workspaceId, userId: user.id, role: 'owner' });
    await tx.update(users).set({ personalWorkspaceId: workspaceId }).where(eq(users.id, user.id));
    return workspaceId;
  });
}

// ---------------------------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------------------------

/**
 * Who may change a membership (legacy let admins make owners, claude-review H6): granting,
 * changing or removing `owner` needs an owner. `from`/`to` are null for an invitation or a
 * removal.
 */
export function assertMayChangeRole(actor: UserRole, from: UserRole | null, to: UserRole | null) {
  if (actor !== 'owner' && (from === 'owner' || to === 'owner')) {
    throw new AppError('FORBIDDEN', {
      detail: 'Only owners can grant, change or remove the owner role.',
    });
  }
}

function toMember(m: typeof workspaceMembers.$inferSelect, u: UserRow): Member {
  return {
    userId: u.id,
    email: u.email,
    name: u.name,
    avatarUrl: u.avatarUrl,
    role: m.role,
    joinedAt: m.createdAt.toISOString(),
  };
}

export async function listMembers(tx: Transaction, workspaceId: string): Promise<Member[]> {
  const rows = await tx
    .select({ member: workspaceMembers, user: users })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(asc(workspaceMembers.createdAt), asc(users.email));
  return rows.map((r) => toMember(r.member, r.user));
}

/** The member row, locked; 404 when the user isn't a member. */
async function lockMember(tx: Transaction, workspaceId: string, userId: string) {
  const [member] = await tx
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .for('update');
  if (!member) throw new AppError('NOT_FOUND', { detail: 'No such member.' });
  return member;
}

/** Refuses to leave a workspace without an owner. Owner rows are locked to serialize this. */
async function assertAnotherOwner(tx: Transaction, workspaceId: string) {
  const owners = await tx
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, 'owner')))
    .for('update');
  if (owners.length <= 1) {
    throw new AppError('CONFLICT', { detail: 'A workspace needs at least one owner.' });
  }
}

export async function updateMemberRole(
  tx: Transaction,
  workspaceId: string,
  actor: UserRole,
  userId: string,
  role: UserRole
): Promise<Member> {
  const member = await lockMember(tx, workspaceId, userId);
  assertMayChangeRole(actor, member.role, role);
  if (member.role === 'owner' && role !== 'owner') await assertAnotherOwner(tx, workspaceId);
  const [updated] = await tx
    .update(workspaceMembers)
    .set({ role, updatedAt: new Date() })
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .returning();
  const [user] = await tx.select().from(users).where(eq(users.id, userId));
  if (!updated || !user) throw new Error('updateMemberRole: member vanished');
  return toMember(updated, user);
}

/**
 * Removes a member and their base-level roles in the workspace. Access ends at once: every
 * request resolves the caller's role afresh (authz_resolve), nothing is cached.
 */
export async function removeMember(
  tx: Transaction,
  workspaceId: string,
  actor: UserRole,
  userId: string
): Promise<void> {
  const member = await lockMember(tx, workspaceId, userId);
  assertMayChangeRole(actor, member.role, null);
  if (member.role === 'owner') await assertAnotherOwner(tx, workspaceId);
  await tx
    .delete(baseMembers)
    .where(and(eq(baseMembers.workspaceId, workspaceId), eq(baseMembers.userId, userId)));
  await tx
    .delete(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
}

// ---------------------------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------------------------

/** A new random 256-bit invitation token (base64url, 43 characters). Only the email holds it. */
export function generateInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What `workspace_invitations.token_hash` stores: the token's SHA-256, hex. */
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function invitationStatus(i: InvitationRow, now: Date): InvitationStatus {
  if (i.revokedAt) return 'revoked';
  if (i.acceptedAt) return 'accepted';
  if (i.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'pending';
}

function toInvitation(i: InvitationRow, invitedByName: string | null): Invitation {
  return {
    id: i.id,
    workspaceId: i.workspaceId,
    baseId: i.baseId,
    interfaceId: i.interfaceId,
    email: i.email,
    role: i.role,
    invitedByName,
    expiresAt: i.expiresAt.toISOString(),
    sentAt: i.sentAt.toISOString(),
    createdAt: i.createdAt.toISOString(),
  };
}

const displayName = (u: Pick<UserRow, 'name' | 'email'> | null | undefined) =>
  u?.name ?? u?.email ?? null;

/** Workspace invitations (`baseId` null), one base's or one interface's. */
const invitationScope = (baseId: string | null, interfaceId: string | null = null): SQL =>
  interfaceId !== null
    ? eq(workspaceInvitations.interfaceId, interfaceId)
    : baseId === null
      ? isNull(workspaceInvitations.baseId)
      : (and(eq(workspaceInvitations.baseId, baseId), isNull(workspaceInvitations.interfaceId)) ??
        sql`false`);

/**
 * Pending invitations (expired ones included, so they can be resent), newest first: the
 * workspace's own, or with `baseId` that base's.
 */
export async function listInvitations(
  tx: Transaction,
  workspaceId: string,
  baseId: string | null = null,
  interfaceId: string | null = null
): Promise<Invitation[]> {
  const rows = await tx
    .select({ invitation: workspaceInvitations, inviter: users })
    .from(workspaceInvitations)
    .leftJoin(users, eq(users.id, workspaceInvitations.invitedBy))
    .where(
      and(
        eq(workspaceInvitations.workspaceId, workspaceId),
        invitationScope(baseId, interfaceId),
        isNull(workspaceInvitations.acceptedAt),
        isNull(workspaceInvitations.revokedAt)
      )
    )
    .orderBy(sql`${workspaceInvitations.sentAt} DESC`);
  return rows.map((r) => toInvitation(r.invitation, displayName(r.inviter)));
}

export interface InviteContext {
  tx: Transaction;
  workspaceId: string;
  /** A base invitation: the invitee joins this base only. Null for the workspace. */
  baseId: string | null;
  /** An interface invitation (with its `baseId`): the invitee gets that interface only. */
  interfaceId?: string | null;
  actor: UserRow;
  actorRole: UserRole;
  appUrl: string;
  email: EmailTransport;
  logger: Logger;
}

/** Emails the accept link. A failed send is logged and reported, not fatal: resend retries. */
async function sendInvitation(ctx: InviteContext, invitation: InvitationRow, token: string) {
  const [workspace] = await ctx.tx
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId));
  const [base] = ctx.baseId
    ? await ctx.tx.select({ name: bases.name }).from(bases).where(eq(bases.id, ctx.baseId))
    : [];
  const [iface] = ctx.interfaceId
    ? await ctx.tx
        .select({ name: interfaces.name })
        .from(interfaces)
        .where(eq(interfaces.id, ctx.interfaceId))
    : [];
  const content = invitationEmail({
    inviterName: displayName(ctx.actor) ?? 'Someone',
    workspaceName: workspace?.name ?? 'a workspace',
    baseName: base?.name,
    interfaceName: iface?.name,
    acceptUrl: `${ctx.appUrl}/invite/${token}`,
  });
  try {
    await ctx.email.send({ to: invitation.email, ...content });
    return ctx.email.delivers !== false;
  } catch (err) {
    ctx.logger.warn({ err, invitationId: invitation.id }, 'invitation email failed');
    return false;
  }
}

/** The workspace and base roles of the user with this (lowercased) email, if any. */
async function rolesByEmail(tx: Transaction, workspaceId: string, baseId: string, email: string) {
  const [row] = await tx
    .select({ workspaceRole: workspaceMembers.role, baseRole: baseMembers.role })
    .from(users)
    .leftJoin(
      workspaceMembers,
      and(eq(workspaceMembers.userId, users.id), eq(workspaceMembers.workspaceId, workspaceId))
    )
    .leftJoin(baseMembers, and(eq(baseMembers.userId, users.id), eq(baseMembers.baseId, baseId)))
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  return row;
}

/**
 * Refuses a base invitation for someone who already has the role on the base, through a
 * base role or the workspace, and a new one past `MAX_BASE_INVITATIONS` pending.
 */
async function assertBaseInvitable(
  ctx: InviteContext & { baseId: string },
  input: { email: string; role: UserRole }
) {
  const { tx, workspaceId, baseId } = ctx;
  const roles = await rolesByEmail(tx, workspaceId, baseId, input.email);
  if (roles?.baseRole) {
    throw new AppError('CONFLICT', {
      detail: 'That person is already a collaborator on this base. Change their role instead.',
    });
  }
  // Workspace owners are owners of every base; otherwise the base role must raise the access.
  const workspaceRole = roles?.workspaceRole ?? null;
  if (workspaceRole && higherRole(workspaceRole, input.role) === workspaceRole) {
    throw new AppError('CONFLICT', {
      detail: 'That person already has this access through the workspace.',
    });
  }
  const [pending] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(workspaceInvitations)
    .where(
      and(
        eq(workspaceInvitations.baseId, baseId),
        isNull(workspaceInvitations.acceptedAt),
        isNull(workspaceInvitations.revokedAt),
        sql`${workspaceInvitations.email} <> ${input.email}`
      )
    );
  if ((pending?.n ?? 0) >= MAX_BASE_INVITATIONS) {
    throw new AppError('CONFLICT', {
      detail: `A base can have at most ${MAX_BASE_INVITATIONS} pending invitations.`,
    });
  }
}

/**
 * Refuses an interface invitation for someone with access to the base (they see its
 * interfaces already) or to the interface, a role that isn't an interface role, and new ones
 * past the interface's collaborators or pending invitations.
 */
async function assertInterfaceInvitable(
  ctx: InviteContext & { baseId: string; interfaceId: string },
  input: { email: string; role: UserRole }
) {
  const { tx, workspaceId, baseId, interfaceId } = ctx;
  if (!(INTERFACE_ROLES as readonly string[]).includes(input.role)) {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'An interface role is editor or read-only.',
    });
  }
  const roles = await rolesByEmail(tx, workspaceId, baseId, input.email);
  if (roles?.workspaceRole || roles?.baseRole) {
    throw new AppError('CONFLICT', {
      detail: 'That person has access to the base already, and sees its interfaces.',
    });
  }
  const [member] = await tx
    .select({ userId: interfaceMembers.userId })
    .from(interfaceMembers)
    .innerJoin(users, eq(users.id, interfaceMembers.userId))
    .where(
      and(
        eq(interfaceMembers.interfaceId, interfaceId),
        sql`lower(${users.email}) = ${input.email}`
      )
    );
  if (member) {
    throw new AppError('CONFLICT', {
      detail: 'That person is already a collaborator on this interface. Change their role instead.',
    });
  }
  const [members] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(interfaceMembers)
    .where(eq(interfaceMembers.interfaceId, interfaceId));
  if ((members?.n ?? 0) >= MAX_INTERFACE_COLLABORATORS) {
    throw new AppError('CONFLICT', {
      detail: `An interface can have at most ${MAX_INTERFACE_COLLABORATORS} collaborators.`,
    });
  }
  const [pending] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(workspaceInvitations)
    .where(
      and(
        eq(workspaceInvitations.interfaceId, interfaceId),
        isNull(workspaceInvitations.acceptedAt),
        isNull(workspaceInvitations.revokedAt),
        sql`${workspaceInvitations.email} <> ${input.email}`
      )
    );
  if ((pending?.n ?? 0) >= MAX_INTERFACE_INVITATIONS) {
    throw new AppError('CONFLICT', {
      detail: `An interface can have at most ${MAX_INTERFACE_INVITATIONS} pending invitations.`,
    });
  }
}

/**
 * Invites `email` with `role` and emails the link: to the workspace, or with `ctx.baseId` to that
 * base only (a base role). Inviting an address that already has a pending invitation
 * re-issues that one (new token, role and expiry); inviting a member is a conflict.
 */
export async function createInvitation(
  ctx: InviteContext,
  input: { email: string; role: UserRole }
): Promise<Invitation> {
  const { tx, workspaceId, baseId } = ctx;
  const interfaceId = ctx.interfaceId ?? null;
  assertMayChangeRole(ctx.actorRole, null, input.role);
  await assertInviteAllowed(tx, workspaceId, input.email);
  if (interfaceId !== null) {
    if (baseId === null)
      throw new Error('createInvitation: an interface invitation needs its base');
    await assertInterfaceInvitable({ ...ctx, baseId, interfaceId }, input);
  } else if (baseId !== null) {
    if (input.role === 'owner') {
      throw new AppError('VALIDATION_FAILED', { detail: 'A base role is at most creator.' });
    }
    await assertBaseInvitable({ ...ctx, baseId }, input);
  } else {
    const [member] = await tx
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          sql`lower(${users.email}) = ${input.email}`
        )
      );
    if (member) {
      throw new AppError('CONFLICT', { detail: 'That person is already a member.' });
    }
  }
  const token = generateInvitationToken();
  const now = new Date();
  const values = {
    role: input.role,
    tokenHash: hashInvitationToken(token),
    invitedBy: ctx.actor.id,
    expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
    sentAt: now,
    updatedAt: now,
  };
  const [row] = await tx
    .insert(workspaceInvitations)
    .values({ workspaceId, baseId, interfaceId, email: input.email, ...values })
    .onConflictDoUpdate(
      interfaceId !== null
        ? {
            target: [workspaceInvitations.interfaceId, workspaceInvitations.email],
            targetWhere: sql`accepted_at IS NULL AND revoked_at IS NULL AND interface_id IS NOT NULL`,
            set: values,
          }
        : baseId === null
          ? {
              target: [workspaceInvitations.workspaceId, workspaceInvitations.email],
              targetWhere: sql`accepted_at IS NULL AND revoked_at IS NULL AND base_id IS NULL`,
              set: values,
            }
          : {
              target: [workspaceInvitations.baseId, workspaceInvitations.email],
              targetWhere: sql`accepted_at IS NULL AND revoked_at IS NULL AND base_id IS NOT NULL AND interface_id IS NULL`,
              set: values,
            }
    )
    .returning();
  if (!row) throw new Error('createInvitation: no row returned');
  const emailSent = await sendInvitation(ctx, row, token);
  return { ...toInvitation(row, displayName(ctx.actor)), emailSent };
}

async function lockPendingInvitation(
  tx: Transaction,
  workspaceId: string,
  baseId: string | null,
  id: string,
  interfaceId: string | null = null
) {
  const [row] = await tx
    .select()
    .from(workspaceInvitations)
    .where(
      and(
        eq(workspaceInvitations.workspaceId, workspaceId),
        invitationScope(baseId, interfaceId),
        eq(workspaceInvitations.id, id),
        isNull(workspaceInvitations.acceptedAt),
        isNull(workspaceInvitations.revokedAt)
      )
    )
    .for('update');
  if (!row) throw new AppError('NOT_FOUND', { detail: 'No such invitation.' });
  return row;
}

/** Sends a pending invitation again, with a new token (the old link stops working). */
export async function resendInvitation(ctx: InviteContext, id: string): Promise<Invitation> {
  const current = await lockPendingInvitation(
    ctx.tx,
    ctx.workspaceId,
    ctx.baseId,
    id,
    ctx.interfaceId ?? null
  );
  assertMayChangeRole(ctx.actorRole, null, current.role);
  await assertInviteAllowed(ctx.tx, ctx.workspaceId, current.email);
  const token = generateInvitationToken();
  const now = new Date();
  const [row] = await ctx.tx
    .update(workspaceInvitations)
    .set({
      tokenHash: hashInvitationToken(token),
      expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
      sentAt: now,
      invitedBy: ctx.actor.id,
      updatedAt: now,
    })
    .where(eq(workspaceInvitations.id, id))
    .returning();
  if (!row) throw new Error('resendInvitation: invitation vanished');
  const emailSent = await sendInvitation(ctx, row, token);
  return { ...toInvitation(row, displayName(ctx.actor)), emailSent };
}

export async function revokeInvitation(
  tx: Transaction,
  workspaceId: string,
  actorRole: UserRole,
  id: string,
  baseId: string | null = null,
  interfaceId: string | null = null
): Promise<void> {
  const current = await lockPendingInvitation(tx, workspaceId, baseId, id, interfaceId);
  assertMayChangeRole(actorRole, null, current.role);
  await tx
    .update(workspaceInvitations)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(workspaceInvitations.id, id));
}

/**
 * Finds the invitation for an emailed token and narrows the transaction to its workspace (the
 * invitee isn't a member yet, so only the token grants this). 404 for an unknown token. For a
 * base invitation, also the base and the user's base role.
 */
async function invitationForToken(tx: Transaction, user: UserRow, token: string) {
  const found = await tx.execute<{ id: string; workspace_id: string }>(
    sql`SELECT id, workspace_id FROM invitation_by_token(${hashInvitationToken(token)})`
  );
  const ref = found.rows[0];
  if (!ref) throw new AppError('NOT_FOUND', { detail: 'This invitation link is not valid.' });
  await setScope(tx, { userId: user.id, workspaceId: ref.workspace_id });
  const [row] = await tx
    .select({
      invitation: workspaceInvitations,
      workspace: workspaces,
      base: bases,
      iface: interfaces,
    })
    .from(workspaceInvitations)
    .innerJoin(workspaces, eq(workspaces.id, workspaceInvitations.workspaceId))
    .leftJoin(bases, eq(bases.id, workspaceInvitations.baseId))
    .leftJoin(interfaces, eq(interfaces.id, workspaceInvitations.interfaceId))
    .where(eq(workspaceInvitations.id, ref.id))
    .for('update', { of: workspaceInvitations });
  if (!row) throw new AppError('NOT_FOUND', { detail: 'This invitation link is not valid.' });
  const [member] = await tx
    .select()
    .from(workspaceMembers)
    .where(
      and(eq(workspaceMembers.workspaceId, ref.workspace_id), eq(workspaceMembers.userId, user.id))
    );
  const baseId = row.invitation.baseId;
  const [baseMember] = baseId
    ? await tx
        .select()
        .from(baseMembers)
        .where(and(eq(baseMembers.baseId, baseId), eq(baseMembers.userId, user.id)))
    : [];
  const interfaceId = row.invitation.interfaceId;
  const [interfaceMember] = interfaceId
    ? await tx
        .select()
        .from(interfaceMembers)
        .where(
          and(eq(interfaceMembers.interfaceId, interfaceId), eq(interfaceMembers.userId, user.id))
        )
    : [];
  // A base (or interface) invitation is already used up when the user has that role or a
  // higher one there.
  const current = baseId
    ? effectiveRole({
        kind: interfaceId ? 'interface' : 'base',
        id: interfaceId ?? baseId,
        workspaceId: ref.workspace_id,
        baseId,
        workspaceRole: member?.role ?? null,
        baseRole: baseMember?.role ?? null,
        interfaceRole: interfaceMember?.role ?? null,
      })
    : (member?.role ?? null);
  const hasAccess =
    current !== null && (!baseId || higherRole(current, row.invitation.role) === current);
  return { ...row, member, baseMember, interfaceMember, hasAccess };
}

/** H6: only a verified address that is the invited one may accept. */
const emailMatches = (user: UserRow, invitation: InvitationRow) =>
  user.emailVerified && user.email?.toLowerCase() === invitation.email;

export async function previewInvitation(
  db: Database,
  user: UserRow,
  token: string
): Promise<InvitationPreview> {
  return db.transaction(async (tx) => {
    await setScope(tx, { userId: user.id });
    const { invitation, workspace, base, iface, hasAccess } = await invitationForToken(
      tx,
      user,
      token
    );
    const [inviter] = invitation.invitedBy
      ? await tx.select().from(users).where(eq(users.id, invitation.invitedBy))
      : [];
    return {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      baseId: base?.id ?? null,
      baseName: base?.name ?? null,
      interfaceId: iface?.id ?? null,
      interfaceName: iface?.name ?? null,
      inviterName: displayName(inviter),
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt.toISOString(),
      status: invitationStatus(invitation, new Date()),
      emailMatches: emailMatches(user, invitation),
      alreadyMember: hasAccess,
    };
  });
}

const NOT_PENDING: Record<Exclude<InvitationStatus, 'pending'>, string> = {
  expired: 'This invitation has expired. Ask for a new one.',
  revoked: 'This invitation was revoked.',
  accepted: 'This invitation has already been used.',
};

/**
 * Accepts an invitation as `user`: they become a member with the invited role (an existing
 * member keeps their role), or for a base invitation a collaborator of that base (an
 * existing base role is raised to the invited one, never lowered). Returns the workspace with
 * the caller's workspace role (null for a base-only collaborator).
 */
export async function acceptInvitation(
  db: Database,
  user: UserRow,
  token: string,
  /** Runs in the transaction, scoped to the workspace, once access was granted (audit). */
  onJoined?: (
    tx: Transaction,
    joined: { workspaceId: string; baseId: string | null; interfaceId: string | null; role: string }
  ) => Promise<void>
): Promise<Workspace> {
  return db.transaction(async (tx) => {
    await setScope(tx, { userId: user.id });
    const found = await invitationForToken(tx, user, token);
    const { invitation, workspace, member, baseMember, hasAccess } = found;
    const status = invitationStatus(invitation, new Date());
    if (status !== 'pending') throw new AppError('CONFLICT', { detail: NOT_PENDING[status] });
    if (!emailMatches(user, invitation)) {
      throw new AppError('FORBIDDEN', {
        detail: `This invitation was sent to ${invitation.email}. Sign in with that address to accept it.`,
      });
    }
    // An invitation sent before the workspace limited invitations to some domains.
    if (!hasAccess) await assertInviteAllowed(tx, workspace.id, invitation.email);
    const baseId = invitation.baseId;
    const interfaceId = invitation.interfaceId;
    const role = invitation.role;
    if (interfaceId && baseId) {
      // An interface invitation: the interface only; no access event (an interface-only
      // collaborator subscribes to nothing live).
      if (!hasAccess) {
        if (!(INTERFACE_ROLES as readonly string[]).includes(role)) {
          throw new Error('acceptInvitation: an interface invitation for a base role');
        }
        const interfaceRole = role as InterfaceRole;
        await tx
          .insert(interfaceMembers)
          .values({
            workspaceId: workspace.id,
            interfaceId,
            userId: user.id,
            role: interfaceRole,
            invitedBy: invitation.invitedBy,
          })
          .onConflictDoUpdate({
            target: [interfaceMembers.interfaceId, interfaceMembers.userId],
            set: { role: interfaceRole, updatedAt: new Date() },
          });
      }
      await tx
        .update(workspaceInvitations)
        .set({ acceptedAt: new Date(), acceptedBy: user.id, updatedAt: new Date() })
        .where(eq(workspaceInvitations.id, invitation.id));
      if (!hasAccess && onJoined) {
        await setScope(tx, { userId: user.id, workspaceId: workspace.id });
        await onJoined(tx, { workspaceId: workspace.id, baseId, interfaceId, role });
      }
      return toWorkspace(workspace, member?.role ?? null);
    }
    if (baseId && !hasAccess) {
      if (role === 'owner') throw new Error('acceptInvitation: a base invitation for owner');
      await tx
        .insert(baseMembers)
        .values({ workspaceId: workspace.id, baseId, userId: user.id, role })
        .onConflictDoUpdate({
          target: [baseMembers.baseId, baseMembers.userId],
          set: { role, updatedAt: new Date() },
        });
    } else if (!baseId && !member) {
      await tx
        .insert(workspaceMembers)
        .values({ workspaceId: workspace.id, userId: user.id, role });
    }
    await tx
      .update(workspaceInvitations)
      .set({ acceptedAt: new Date(), acceptedBy: user.id, updatedAt: new Date() })
      .where(eq(workspaceInvitations.id, invitation.id));
    if (!hasAccess) {
      await setScope(tx, { userId: user.id, workspaceId: workspace.id });
      await emitAccessChange(tx, {
        workspaceId: workspace.id,
        kind: baseId ? (baseMember ? 'baseMember.updated' : 'baseMember.added') : 'member.added',
        payload: baseId ? { userId: user.id, baseId, role } : { userId: user.id, role },
        actorId: user.id,
      });
      await onJoined?.(tx, { workspaceId: workspace.id, baseId, interfaceId: null, role });
    }
    return toWorkspace(workspace, member?.role ?? (baseId ? null : role));
  });
}
