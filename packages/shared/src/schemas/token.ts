import { z } from 'zod';
import { TOKEN_SCOPES } from '../authz.js';

/**
 * Personal access tokens: `Authorization: Bearer or_pat_<publicId>_<secret>`. Only the
 * SHA-256 of the secret is stored; the whole token is shown once, when it is created.
 */
export const TOKEN_PREFIX = 'or_pat_';
/** Lifetime when none is given, and the longest allowed. */
export const DEFAULT_TOKEN_TTL_DAYS = 90;
export const MAX_TOKEN_TTL_DAYS = 365;
/** Live (unrevoked) tokens per user. */
export const MAX_TOKENS_PER_USER = 50;
/** Workspaces plus bases one token may be granted. */
export const MAX_TOKEN_GRANTS = 100;
export const MAX_TOKEN_NAME_LENGTH = 100;

const at = z.iso.datetime({ offset: true });

export const TokenScopeSchema = z.enum(TOKEN_SCOPES);

export const createAccessTokenSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(MAX_TOKEN_NAME_LENGTH),
    scopes: z
      .array(TokenScopeSchema)
      .min(1)
      .max(TOKEN_SCOPES.length)
      .transform((s) => [...new Set(s)]),
    /** Every current and future base of these workspaces. */
    workspaceIds: z
      .array(z.uuid())
      .max(MAX_TOKEN_GRANTS)
      .default([])
      .transform((s) => [...new Set(s)]),
    /** These bases only. */
    baseIds: z
      .array(z.uuid())
      .max(MAX_TOKEN_GRANTS)
      .default([])
      .transform((s) => [...new Set(s)]),
    /** Days until it expires: 90 by default, at most a year. */
    expiresInDays: z.int().min(1).max(MAX_TOKEN_TTL_DAYS).default(DEFAULT_TOKEN_TTL_DAYS),
  })
  .refine((v) => v.workspaceIds.length + v.baseIds.length > 0, {
    message: 'Grant the token at least one workspace or base.',
    path: ['workspaceIds'],
  })
  .refine((v) => v.workspaceIds.length + v.baseIds.length <= MAX_TOKEN_GRANTS, {
    message: `A token can be granted at most ${MAX_TOKEN_GRANTS} workspaces and bases.`,
    path: ['baseIds'],
  });
export type CreateAccessTokenInput = z.input<typeof createAccessTokenSchema>;

/** Days of request counts a token's listing shows; the server keeps 90. */
export const TOKEN_USAGE_DAYS = 7;

/** One UTC day's requests made with a token. */
export const TokenUsageDaySchema = z.object({ day: z.iso.date(), requests: z.number().int() });
export type TokenUsageDay = z.infer<typeof TokenUsageDaySchema>;

export const AccessTokenSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** `or_pat_<publicId>`: the public part, to recognise a token (never the secret). */
  prefix: z.string(),
  scopes: z.array(TokenScopeSchema),
  workspaceIds: z.array(z.uuid()),
  baseIds: z.array(z.uuid()),
  createdAt: at,
  expiresAt: at,
  lastUsedAt: at.nullable(),
  /** Requests per UTC day over the last `TOKEN_USAGE_DAYS` days, oldest first, today last. */
  usage: z.array(TokenUsageDaySchema),
});
export type AccessToken = z.infer<typeof AccessTokenSchema>;

export const AccessTokenListSchema = z.object({ tokens: z.array(AccessTokenSchema) });
export type AccessTokenList = z.infer<typeof AccessTokenListSchema>;

/** The new token, with its secret: the only time it is ever sent. */
export const CreatedAccessTokenSchema = AccessTokenSchema.extend({ token: z.string() });
export type CreatedAccessToken = z.infer<typeof CreatedAccessTokenSchema>;
