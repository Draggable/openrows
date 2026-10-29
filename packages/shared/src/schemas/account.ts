import { z } from 'zod';

/**
 * Deleting your account. It needs a recent sign-in: the provider's `auth_time` within
 * ACCOUNT_REAUTH_MINUTES (`/auth/login?reauth=1` asks for the password again).
 */
export const ACCOUNT_REAUTH_MINUTES = 10;

/**
 * What happens to a workspace you own when your account goes: `delete` (nobody else is in it:
 * deleted with everything in it), `leave` (another owner keeps it), `blocked` (you're its only
 * owner and others are in it: make someone else owner or delete the workspace first).
 */
export const ACCOUNT_WORKSPACE_OUTCOMES = ['delete', 'leave', 'blocked'] as const;

export const AccountWorkspaceSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  outcome: z.enum(ACCOUNT_WORKSPACE_OUTCOMES),
  /** Other members and base collaborators. */
  others: z.number().int().nonnegative(),
});
export type AccountWorkspace = z.infer<typeof AccountWorkspaceSchema>;

/** `GET /api/me/deletion`: what deleting the account would do, and whether it can now. */
export const AccountDeletionSchema = z.object({
  /** Type this to confirm. */
  email: z.string().nullable(),
  /** The workspaces you own (others you're a member of are simply left). */
  workspaces: z.array(AccountWorkspaceSchema),
  /** Until when the current sign-in is recent enough; null: sign in again first. */
  reauthenticatedUntil: z.iso.datetime({ offset: true }).nullable(),
});
export type AccountDeletion = z.infer<typeof AccountDeletionSchema>;

/** `POST /api/me/delete`: the account's email, typed again (case-insensitive). */
export const deleteAccountSchema = z.strictObject({
  confirmEmail: z.string().trim().min(1).max(320),
});
export type DeleteAccountInput = z.infer<typeof deleteAccountSchema>;

export const DeletedAccountSchema = z.object({
  /** When the data is gone at the latest (the Privacy Policy's 30 days). */
  purgeBy: z.iso.datetime({ offset: true }),
  /** The workspaces deleted with the account. */
  workspaces: z.number().int().nonnegative(),
});
export type DeletedAccount = z.infer<typeof DeletedAccountSchema>;
