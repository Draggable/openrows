import { z } from 'zod';

/** `GET /api/me`: the signed-in user and their session. 401 problem+json when signed out. */
export const MeResponseSchema = z.object({
  user: z.object({
    id: z.uuid(),
    email: z.string().nullable(),
    name: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    isSystemAdmin: z.boolean(),
  }),
  session: z.object({
    createdAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    /** When the user last entered their credentials (the provider's `auth_time`). */
    authenticatedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  }),
  /**
   * A system admin viewing the app as this user: read-only until `expiresAt`. The app
   * shows the admin a banner with a way out. Null (or absent) otherwise.
   */
  impersonation: z
    .object({
      adminEmail: z.string().nullable(),
      expiresAt: z.iso.datetime({ offset: true }),
    })
    .nullable()
    .optional(),
});

export type MeResponse = z.infer<typeof MeResponseSchema>;

/**
 * Why a sign-in didn't complete. `/auth/callback` redirects to `/login?error=<code>` and the
 * client shows a message per code.
 */
export const AUTH_ERROR_CODES = [
  'not_configured',
  'login_expired',
  'state_mismatch',
  'access_denied',
  'login_failed',
  'email_unverified',
  /** The account was deleted. */
  'account_deleted',
  /** A system admin suspended the account. */
  'account_suspended',
  /** The address's domain signs in through its organization's single sign-on only. */
  'sso_required',
  /** No workspace has single sign-on for the address's domain. */
  'sso_not_found',
  /** The single sign-on provider vouched for an address outside its verified domains. */
  'sso_domain_mismatch',
] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];
