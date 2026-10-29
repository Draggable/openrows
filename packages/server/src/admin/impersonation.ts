import { IMPERSONATION_MINUTES } from '@openrows/shared';
import { eq } from 'drizzle-orm';
import type { Database, Transaction } from '../db/index.js';
import { sessions } from '../db/schema.js';

/**
 * Read-only impersonation: the admin's own session views the app as the target user until
 * the returned time (SessionStore.resolve swaps the principal; requireSession refuses anything
 * but reads). The ops console (hosted edition) checks who may be impersonated and writes the audit entry.
 */
export async function startImpersonation(
  db: Database | Transaction,
  input: { sessionIdHash: string; targetUserId: string; now?: Date }
): Promise<Date> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + IMPERSONATION_MINUTES * 60_000);
  await db
    .update(sessions)
    .set({ impersonatedUserId: input.targetUserId, impersonationExpiresAt: expiresAt })
    .where(eq(sessions.idHash, input.sessionIdHash));
  return expiresAt;
}

/** Ends the session's impersonation, if any. */
export async function endImpersonation(
  db: Database | Transaction,
  sessionIdHash: string
): Promise<void> {
  await db
    .update(sessions)
    .set({ impersonatedUserId: null, impersonationExpiresAt: null })
    .where(eq(sessions.idHash, sessionIdHash));
}
