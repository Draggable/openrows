import { z } from 'zod';
import { TOKEN_SCOPES, type TokenScope } from '../authz.js';
import { MAX_TOKEN_GRANTS, TokenScopeSchema } from './token.js';

/**
 * OAuth apps: integrations registered by a user (client id and secret, exact redirect
 * URIs) that ask other people for access with the authorization code flow and PKCE (S256). The
 * person picks workspaces or bases on the consent screen for the scopes the app asks for (the
 * personal access token scopes); the app gets an hour-long access token (`or_oat_…`, used like a
 * personal access token) and a 60-day refresh token (`or_ort_…`), rotated on every use.
 */
export const OAUTH_CLIENT_ID_PREFIX = 'or_app_';
export const OAUTH_SECRET_PREFIX = 'or_secret_';
export const OAUTH_ACCESS_TOKEN_PREFIX = 'or_oat_';
export const OAUTH_REFRESH_TOKEN_PREFIX = 'or_ort_';
/** An access token's lifetime (Airtable's: an hour). */
export const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
/** A refresh token's lifetime; each refresh starts a new one. */
export const OAUTH_REFRESH_TOKEN_TTL_DAYS = 60;
/** An authorization code's lifetime. */
export const OAUTH_CODE_TTL_SECONDS = 10 * 60;
/** Apps one user may register. */
export const MAX_OAUTH_APPS_PER_USER = 20;
export const MAX_OAUTH_REDIRECT_URIS = 10;
export const MAX_OAUTH_URL_LENGTH = 2000;
export const MAX_OAUTH_APP_NAME = 100;
export const MAX_OAUTH_APP_DESCRIPTION = 500;
/** The OAuth `state` round-tripped to the app. */
export const MAX_OAUTH_STATE = 1000;

const at = z.iso.datetime({ offset: true });

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Why a redirect URI can't be registered, or null: `https` (or `http` on a loopback host, for
 * desktop and command-line apps, RFC 8252), no credentials, no fragment.
 */
export function redirectUriProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Not a URL.';
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    return 'Use https (or http on localhost).';
  }
  if (url.username || url.password) return 'No user name or password in the URL.';
  if (raw.includes('#')) return 'No fragment (#) in a redirect URI.';
  return null;
}

export const redirectUriSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_OAUTH_URL_LENGTH)
  .superRefine((v, ctx) => {
    const problem = redirectUriProblem(v);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

const homepageSchema = z
  .string()
  .trim()
  .max(MAX_OAUTH_URL_LENGTH)
  .refine((v) => /^https?:\/\//i.test(v) && URL.canParse(v), 'An http(s) URL.')
  .nullable();

const redirectUrisSchema = z
  .array(redirectUriSchema)
  .min(1, 'Add at least one redirect URI.')
  .max(MAX_OAUTH_REDIRECT_URIS)
  .transform((s) => [...new Set(s)]);

export const createOAuthAppSchema = z.strictObject({
  name: z.string().trim().min(1).max(MAX_OAUTH_APP_NAME),
  description: z.string().trim().max(MAX_OAUTH_APP_DESCRIPTION).default(''),
  homepageUrl: homepageSchema.default(null),
  redirectUris: redirectUrisSchema,
});
export type CreateOAuthAppInput = z.input<typeof createOAuthAppSchema>;

export const updateOAuthAppSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(MAX_OAUTH_APP_NAME).optional(),
    description: z.string().trim().max(MAX_OAUTH_APP_DESCRIPTION).optional(),
    homepageUrl: homepageSchema.optional(),
    redirectUris: redirectUrisSchema.optional(),
    /** A new client secret, answered once; the old one stops working at once. */
    rotateSecret: z.literal(true).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' });
export type UpdateOAuthAppInput = z.input<typeof updateOAuthAppSchema>;

export const OAuthAppSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string(),
  homepageUrl: z.string().nullable(),
  clientId: z.string(),
  redirectUris: z.array(z.string()),
  createdAt: at,
  updatedAt: at,
});
export type OAuthApp = z.infer<typeof OAuthAppSchema>;

export const OAuthAppListSchema = z.object({ apps: z.array(OAuthAppSchema) });
export type OAuthAppList = z.infer<typeof OAuthAppListSchema>;

/** An app as created or rotated: `clientSecret` is shown only this once. */
export const OAuthAppWithSecretSchema = OAuthAppSchema.extend({
  clientSecret: z.string().nullable(),
});
export type OAuthAppWithSecret = z.infer<typeof OAuthAppWithSecretSchema>;

/** An app the caller authorized (Settings → Integrations). */
export const OAuthAuthorizationSchema = z.object({
  id: z.uuid(),
  app: z.object({ id: z.uuid(), name: z.string(), homepageUrl: z.string().nullable() }),
  scopes: z.array(TokenScopeSchema),
  workspaceIds: z.array(z.uuid()),
  baseIds: z.array(z.uuid()),
  createdAt: at,
  updatedAt: at,
  lastUsedAt: at.nullable(),
});
export type OAuthAuthorization = z.infer<typeof OAuthAuthorizationSchema>;

export const OAuthAuthorizationListSchema = z.object({
  authorizations: z.array(OAuthAuthorizationSchema),
});
export type OAuthAuthorizationList = z.infer<typeof OAuthAuthorizationListSchema>;

/** The scopes of an OAuth `scope` parameter (space-separated), or null when one is unknown. */
export function parseOAuthScope(scope: string): TokenScope[] | null {
  const known: readonly string[] = TOKEN_SCOPES;
  const parts = scope.split(' ').filter((s) => s !== '');
  if (parts.length === 0 || parts.some((p) => !known.includes(p))) return null;
  return [...new Set(parts as TokenScope[])];
}

/** A PKCE S256 challenge: base64url of a SHA-256, unpadded. */
export const OAUTH_PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/**
 * The authorization request as the app sent it (the consent page's query string, RFC 6749
 * §4.1.1 and RFC 7636). Strings only: the server answers what is wrong with it.
 */
export const oauthAuthorizeQuerySchema = z.looseObject({
  response_type: z.string().max(100).optional(),
  client_id: z.string().max(100).optional(),
  redirect_uri: z.string().max(MAX_OAUTH_URL_LENGTH).optional(),
  scope: z.string().max(1000).optional(),
  state: z.string().max(MAX_OAUTH_STATE).optional(),
  code_challenge: z.string().max(200).optional(),
  code_challenge_method: z.string().max(20).optional(),
});
export type OAuthAuthorizeQuery = z.infer<typeof oauthAuthorizeQuerySchema>;

/** What the consent screen shows: the app, where it sends you back and what it asks for. */
export const OAuthAuthorizeInfoSchema = z.object({
  app: z.object({
    name: z.string(),
    description: z.string(),
    homepageUrl: z.string().nullable(),
  }),
  clientId: z.string(),
  redirectUri: z.string(),
  scopes: z.array(TokenScopeSchema),
  /** What the person granted it last time, when they authorized it before. */
  current: z.object({ workspaceIds: z.array(z.uuid()), baseIds: z.array(z.uuid()) }).nullable(),
});
export type OAuthAuthorizeInfo = z.infer<typeof OAuthAuthorizeInfoSchema>;

/** The person's answer on the consent screen, with the request it answers. */
export const oauthAuthorizeDecisionSchema = z
  .strictObject({
    clientId: z.string().min(1).max(100),
    redirectUri: z.string().min(1).max(MAX_OAUTH_URL_LENGTH),
    scope: z.string().min(1).max(1000),
    state: z.string().max(MAX_OAUTH_STATE).optional(),
    codeChallenge: z.string().regex(OAUTH_PKCE_CHALLENGE, 'A base64url SHA-256 (43 characters).'),
    codeChallengeMethod: z.literal('S256'),
    decision: z.enum(['allow', 'deny']),
    workspaceIds: z
      .array(z.uuid())
      .max(MAX_TOKEN_GRANTS)
      .default([])
      .transform((s) => [...new Set(s)]),
    baseIds: z
      .array(z.uuid())
      .max(MAX_TOKEN_GRANTS)
      .default([])
      .transform((s) => [...new Set(s)]),
  })
  .refine((v) => v.decision === 'deny' || v.workspaceIds.length + v.baseIds.length > 0, {
    message: 'Pick at least one workspace or base.',
    path: ['workspaceIds'],
  })
  .refine((v) => v.workspaceIds.length + v.baseIds.length <= MAX_TOKEN_GRANTS, {
    message: `At most ${MAX_TOKEN_GRANTS} workspaces and bases.`,
    path: ['baseIds'],
  });
export type OAuthAuthorizeDecision = z.input<typeof oauthAuthorizeDecisionSchema>;

/** Where the browser goes next: the app's redirect URI with a code (or an error) and the state. */
export const OAuthRedirectSchema = z.object({ redirectTo: z.string() });
export type OAuthRedirect = z.infer<typeof OAuthRedirectSchema>;
