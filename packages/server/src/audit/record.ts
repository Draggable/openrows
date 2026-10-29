import { AUDIT_USER_AGENT_MAX } from '@openrows/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { Principal } from '../auth/sessions.js';
import { inScope } from '../authz/scope.js';
import type { Database, Transaction } from '../db/index.js';
import { workspaceMembers, workspaces } from '../db/schema.js';
import type { AuditActorInfo, AuditRecord, AuditSink } from '../edition/types.js';
import type { AppEnv } from '../lib/context.js';

/**
 * Recording the workspace audit log from the core: handlers call `audit(c, tx, ...)` in
 * the transaction of the change they describe, which hands the record to the edition's AuditSink
 * (nothing in the OSS edition). Account-level events (sign-in, personal access tokens) go to
 * every workspace the user is a member of, through `auditForUser`.
 */

/** Workspaces one account-level event is recorded in at most (the user's oldest memberships). */
export const AUDIT_FANOUT_MAX = 50;

/** What recording reads from a request: any handler's `c` fits. */
export interface AuditRequest {
  readonly var: Pick<AppEnv['Variables'], 'edition' | 'clientIp'> & {
    readonly principal?: Principal | null;
  };
  readonly req: { header(name: string): string | undefined };
}
type Entry = Omit<AuditRecord, 'actor'> & { actor?: AuditActorInfo };

/** Who made the request and from where, as the audit log records it. */
export function requestActor(c: AuditRequest, principal?: Principal | null): AuditActorInfo {
  const p = principal ?? c.var.principal ?? null;
  const userAgent = c.req.header('user-agent')?.slice(0, AUDIT_USER_AGENT_MAX) ?? null;
  const ip = c.var.clientIp ?? null;
  if (!p) return { kind: 'system', userId: null, email: null, ip, userAgent };
  if (p.impersonation) {
    return {
      kind: 'admin',
      userId: p.impersonation.adminId,
      email: p.impersonation.adminEmail,
      ip,
      userAgent,
    };
  }
  return {
    kind: p.token ? 'token' : 'user',
    userId: p.user.id,
    email: p.user.email ?? null,
    ip,
    userAgent,
  };
}

/** Records `entry` in `tx` (scoped to its workspace) with the request's actor. */
export async function audit(c: AuditRequest, tx: Transaction, entry: Entry): Promise<void> {
  const sink = c.var.edition.audit;
  if (!sink.enabled) return;
  await sink.record(tx, { ...entry, actor: entry.actor ?? requestActor(c) });
}

/** Records `entry` in `tx` with an explicit actor (jobs, flows without a request principal). */
export async function recordAudit(sink: AuditSink, tx: Transaction, entry: AuditRecord) {
  if (!sink.enabled) return;
  await sink.record(tx, entry);
}

/**
 * Records an account-level event in each live workspace `userId` is a member of (at most
 * AUDIT_FANOUT_MAX), each in a transaction of its own, scoped to that workspace. Failures are
 * the caller's to log: the action itself already happened.
 */
export async function auditForUser(
  db: Database,
  sink: AuditSink,
  userId: string,
  entry: Omit<AuditRecord, 'workspaceId'>
): Promise<number> {
  if (!sink.enabled) return 0;
  // No workspace in scope: RLS shows the user's own memberships (member_read).
  const ids = await inScope(db, { userId }, (tx) =>
    tx
      .select({ id: workspaces.id })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(and(eq(workspaceMembers.userId, userId), isNull(workspaces.deletedAt)))
      .orderBy(workspaceMembers.workspaceId)
      .limit(AUDIT_FANOUT_MAX)
  );
  for (const { id } of ids) {
    await inScope(db, { userId, workspaceId: id }, (tx) =>
      sink.record(tx, { ...entry, workspaceId: id })
    );
  }
  return ids.length;
}
