import { z } from 'zod';

/**
 * The error catalog: every error the API returns has one of these stable codes. Clients branch
 * on `code`, never on `title` or `detail`, so titles can be reworded without breaking anyone.
 * Add codes here rather than inventing them at the call site; never rename or reuse one.
 */
export const ERROR_CATALOG = {
  BAD_REQUEST: { status: 400, title: 'Bad request' },
  VALIDATION_FAILED: { status: 422, title: 'Validation failed' },
  /** A `typecast` write names select options that don't exist, without schema rights. */
  TYPECAST_FORBIDDEN: { status: 422, title: 'Cannot create select options' },
  /** A REST API `filterByFormula` that doesn't parse or uses what can't run as SQL. */
  INVALID_FILTER_BY_FORMULA: { status: 422, title: 'Invalid filter formula' },
  UNAUTHENTICATED: { status: 401, title: 'Authentication required' },
  FORBIDDEN: { status: 403, title: 'Forbidden' },
  /** A write a table or field permission doesn't allow this user; names the fields. */
  EDIT_RESTRICTED: { status: 403, title: 'Editing restricted' },
  /** A share link with a password: enter it first (`POST /api/shared/:token/unlock`). */
  SHARE_PASSWORD_REQUIRED: { status: 401, title: 'Password required' },
  /** The password given for a share link is wrong. */
  SHARE_PASSWORD_INCORRECT: { status: 401, title: 'Incorrect password' },
  /** A share link limited to email domains: sign in first. */
  SHARE_SIGN_IN_REQUIRED: { status: 401, title: 'Sign-in required' },
  /** A share link limited to email domains the signed-in user's verified email isn't at. */
  SHARE_DOMAIN_NOT_ALLOWED: { status: 403, title: 'Email domain not allowed' },
  /** A share link that doesn't allow downloading its data. */
  SHARE_DOWNLOAD_DISABLED: { status: 403, title: 'Downloads disabled' },
  /** A public form's CAPTCHA (Turnstile) answer is missing, wrong, expired or reused. */
  CAPTCHA_FAILED: { status: 403, title: 'CAPTCHA check failed' },
  /**
   * A plan limit: new data over a limit is refused (records per base, attachment storage,
   * editors; API calls answer 429), reading and editing never are. `limit` names the limit,
   * `used` and `max` say how far it is; nothing is deleted or hidden.
   */
  QUOTA_EXCEEDED: { status: 403, title: 'Plan limit reached' },
  /** A plan feature the workspace's plan doesn't include; `feature` names it. */
  PLAN_FEATURE_REQUIRED: { status: 403, title: 'Not included in this plan' },
  /** A workspace policy (share links, forms, embeds, tokens, invitations) refuses it. */
  POLICY_RESTRICTED: { status: 403, title: 'Restricted by workspace policy' },
  /** Deleting the account needs a recent sign-in: `/auth/login?reauth=1` first. */
  REAUTHENTICATION_REQUIRED: { status: 403, title: 'Sign in again' },
  /** The workspace is suspended: members can read, nothing changes. */
  WORKSPACE_SUSPENDED: { status: 403, title: 'Workspace suspended' },
  /** A system admin is viewing the app as this user: read-only. */
  IMPERSONATION_READ_ONLY: { status: 403, title: 'Read-only while impersonating' },
  NOT_FOUND: { status: 404, title: 'Not found' },
  METHOD_NOT_ALLOWED: { status: 405, title: 'Method not allowed' },
  CONFLICT: { status: 409, title: 'Conflict' },
  /** An uploaded file is still being checked for malware: try again shortly. */
  ATTACHMENT_SCANNING: { status: 409, title: 'File being scanned' },
  /** The malware scanner found something in this file: it is never served or used. */
  ATTACHMENT_QUARANTINED: { status: 403, title: 'File quarantined' },
  /** The account owns shared workspaces alone: transfer or delete them first. */
  /**
   * A region whose workspaces are created from the home region: `POST /api/workspaces`
   * is refused there.
   */
  WORKSPACE_CREATION_ELSEWHERE: { status: 403, title: 'Workspaces are created in the home region' },
  SOLE_OWNER: { status: 409, title: 'Only owner of shared workspaces' },
  /** Catch-up asked for events older than the outbox keeps: refetch instead. */
  EVENTS_EXPIRED: { status: 410, title: 'Events no longer available' },
  PAYLOAD_TOO_LARGE: { status: 413, title: 'Payload too large' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, title: 'Unsupported media type' },
  RATE_LIMITED: { status: 429, title: 'Too many requests' },
  INTERNAL_ERROR: { status: 500, title: 'Internal server error' },
  NOT_READY: { status: 503, title: 'Service not ready' },
  SERVICE_UNAVAILABLE: { status: 503, title: 'Service unavailable' },
} as const satisfies Record<string, { status: number; title: string }>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export const ERROR_CODES = Object.keys(ERROR_CATALOG) as ErrorCode[];

/** The media type of every OpenRows error response (RFC 9457). */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

const PROBLEM_TYPE_BASE = 'https://openrows.io/problems/';

/** The RFC 9457 `type` URI for a code, e.g. `https://openrows.io/problems/not-found`. */
export function problemType(code: ErrorCode): string {
  return PROBLEM_TYPE_BASE + code.toLowerCase().replaceAll('_', '-');
}

/** A field-level validation problem, listed under `errors` for VALIDATION_FAILED. */
export const ProblemFieldErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
});

/**
 * An RFC 9457 problem details body. `code` and `requestId` are OpenRows extension members; other
 * extensions (such as `errors` or `checks`) pass through.
 */
export const ProblemDetailsSchema = z.looseObject({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.enum(ERROR_CODES as [ErrorCode, ...ErrorCode[]]),
  requestId: z.string(),
  errors: z.array(ProblemFieldErrorSchema).optional(),
});

export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;
export type ProblemFieldError = z.infer<typeof ProblemFieldErrorSchema>;
