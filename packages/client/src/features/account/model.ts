import type { AccountDeletion, AccountWorkspace } from '@openrows/shared';

/** `/settings?delete-account=1` opens the dialog (where the password prompt returns to). */
export const OPEN_PARAM = 'delete-account';

/** The provider asks for the password again, then sends the browser back to the dialog. */
export function reauthHref(): string {
  const params = new URLSearchParams({ reauth: '1', returnTo: `/settings?${OPEN_PARAM}=1` });
  return `/auth/login?${params.toString()}`;
}

/** The typed confirmation matches the account's email (case and outer spaces ignored). */
export function emailMatches(email: string | null, typed: string): boolean {
  return email !== null && typed.trim().toLowerCase() === email.toLowerCase();
}

/** The account can't go while it's the only owner of a workspace others are in. */
export function deletionBlocked(d: AccountDeletion): boolean {
  return d.workspaces.some((w) => w.outcome === 'blocked');
}

const people = (n: number) => (n === 1 ? '1 other person' : `${n} other people`);

/** What deleting the account does to a workspace it owns. */
export function workspaceOutcome(w: AccountWorkspace): string {
  switch (w.outcome) {
    case 'delete':
      return 'Deleted with your account, with all its bases.';
    case 'leave':
      return 'Stays with its other owners.';
    case 'blocked':
      return `You're its only owner and ${people(w.others)} use it: make someone else an owner or delete the workspace first.`;
  }
}
