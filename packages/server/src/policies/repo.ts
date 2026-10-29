import {
  DEFAULT_WORKSPACE_POLICIES,
  inviteDomainAllowed,
  type WorkspacePolicies,
} from '@openrows/shared';
import { eq } from 'drizzle-orm';
import type { Transaction } from '../db/index.js';
import { workspacePolicies } from '../db/schema.js';
import { AppError } from '../lib/errors.js';

/**
 * Workspace policies: stored by the hosted admin console, enforced here in
 * the core for every edition. Personal access tokens are refused in `authorize()` (through
 * `authz_resolve`), share links and form links stop resolving in `share_resolve`; these are the
 * checks of the writes: new links, embed origins, token grants and invitations.
 */

/** The workspace's policies (the defaults without a row). `tx` is scoped to the workspace. */
export async function readWorkspacePolicies(
  tx: Transaction,
  workspaceId: string
): Promise<WorkspacePolicies & { updatedAt: Date | null }> {
  const [row] = await tx
    .select()
    .from(workspacePolicies)
    .where(eq(workspacePolicies.workspaceId, workspaceId));
  if (!row) return { ...DEFAULT_WORKSPACE_POLICIES, inviteDomains: [], updatedAt: null };
  return {
    shareLinks: row.shareLinks,
    publicForms: row.publicForms,
    embeds: row.embeds,
    personalAccessTokens: row.personalAccessTokens,
    inviteDomains: row.inviteDomains,
    updatedAt: row.updatedAt,
  };
}

function restricted(detail: string): AppError {
  return new AppError('POLICY_RESTRICTED', { detail });
}

/** A new share link of `kind`, and its embed origins, as the policies allow (403 otherwise). */
export async function assertShareAllowed(
  tx: Transaction,
  workspaceId: string,
  link: { kind: 'view' | 'base' | 'form' | null; embedOrigins?: readonly string[] | undefined }
): Promise<void> {
  const p = await readWorkspacePolicies(tx, workspaceId);
  if (link.kind === 'form' && !p.publicForms) {
    throw restricted("This workspace's policy doesn't allow public forms.");
  }
  if ((link.kind === 'view' || link.kind === 'base') && !p.shareLinks) {
    throw restricted("This workspace's policy doesn't allow public share links.");
  }
  if (link.embedOrigins?.length && !p.embeds) {
    throw restricted("This workspace's policy doesn't allow embedding share links on other sites.");
  }
}

/** An invitation to `email` (to the workspace, a base or an interface) as the policies allow. */
export async function assertInviteAllowed(
  tx: Transaction,
  workspaceId: string,
  email: string
): Promise<void> {
  const { inviteDomains } = await readWorkspacePolicies(tx, workspaceId);
  if (!inviteDomainAllowed(inviteDomains, email)) {
    throw restricted(
      `This workspace's policy only allows invitations to addresses at ${inviteDomains.join(', ')}.`
    );
  }
}
