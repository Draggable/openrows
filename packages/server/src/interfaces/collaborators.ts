import type { InterfaceCollaborator, InterfaceRole } from '@openrows/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { interfaceMembers, type Transaction, users } from '../db/index.js';
import { AppError } from '../lib/errors.js';

/**
 * Interface-only collaborators: people given one interface (`interface_members`) and not
 * its base. New ones come through an interface invitation (`createInvitation` with an
 * `interfaceId`); these change or remove the role of someone who accepted one.
 */

export async function listInterfaceCollaborators(
  tx: Transaction,
  interfaceId: string
): Promise<InterfaceCollaborator[]> {
  const rows = await tx
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      avatarUrl: users.avatarUrl,
      role: interfaceMembers.role,
    })
    .from(interfaceMembers)
    .innerJoin(users, eq(users.id, interfaceMembers.userId))
    .where(eq(interfaceMembers.interfaceId, interfaceId))
    .orderBy(sql`lower(coalesce(${users.name}, ${users.email}, ''))`, asc(users.id));
  return rows;
}

export async function setInterfaceRole(
  tx: Transaction,
  interfaceId: string,
  userId: string,
  role: InterfaceRole
): Promise<InterfaceCollaborator> {
  const [updated] = await tx
    .update(interfaceMembers)
    .set({ role, updatedAt: new Date() })
    .where(and(eq(interfaceMembers.interfaceId, interfaceId), eq(interfaceMembers.userId, userId)))
    .returning({ userId: interfaceMembers.userId });
  if (!updated) {
    throw new AppError('NOT_FOUND', { detail: 'No such collaborator on this interface.' });
  }
  const found = (await listInterfaceCollaborators(tx, interfaceId)).find(
    (c) => c.userId === userId
  );
  if (!found) throw new Error('setInterfaceRole: collaborator vanished');
  return found;
}

/** Removes the role: they lose the interface on their next request (roles resolve afresh). */
export async function removeInterfaceRole(
  tx: Transaction,
  interfaceId: string,
  userId: string
): Promise<void> {
  const deleted = await tx
    .delete(interfaceMembers)
    .where(and(eq(interfaceMembers.interfaceId, interfaceId), eq(interfaceMembers.userId, userId)))
    .returning({ userId: interfaceMembers.userId });
  if (deleted.length === 0) {
    throw new AppError('NOT_FOUND', { detail: 'No such collaborator on this interface.' });
  }
}
