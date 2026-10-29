import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAUTH_CLIENT_ID_PREFIX,
  OAUTH_REFRESH_TOKEN_PREFIX,
  OAUTH_SECRET_PREFIX,
} from '@openrows/shared';
import { generatePublicId, hashSecret } from '../auth/tokens.js';

/**
 * The OAuth apps' credentials. Client ids are public (`or_app_<20 base32>`); client
 * secrets (`or_secret_<43 base64url>`), authorization codes and tokens carry 32 random bytes of
 * which only the SHA-256 is stored. Tokens are `or_oat_` (access) or `or_ort_` (refresh), a
 * 12-character public id that finds the row, and the secret: greppable, like personal access
 * tokens.
 */
export type OAuthTokenKind = 'access' | 'refresh';

const PREFIX: Record<OAuthTokenKind, string> = {
  access: OAUTH_ACCESS_TOKEN_PREFIX,
  refresh: OAUTH_REFRESH_TOKEN_PREFIX,
};
const SECRET = '[A-Za-z0-9_-]{43}';
const TOKEN_RE: Record<OAuthTokenKind, RegExp> = {
  access: new RegExp(`^${OAUTH_ACCESS_TOKEN_PREFIX}([a-z2-7]{12})_(${SECRET})$`),
  refresh: new RegExp(`^${OAUTH_REFRESH_TOKEN_PREFIX}([a-z2-7]{12})_(${SECRET})$`),
};
const SECRET_RE = new RegExp(`^${OAUTH_SECRET_PREFIX}(${SECRET})$`);
const CODE_RE = new RegExp(`^${SECRET}$`);

const secret = () => randomBytes(32).toString('base64url');

export function generateClientId(): string {
  return `${OAUTH_CLIENT_ID_PREFIX}${generatePublicId()}${generatePublicId().slice(0, 8)}`;
}

/** A new client secret (shown once) and the hash to store. */
export function generateClientSecret(): { secret: string; hash: string } {
  const s = secret();
  return { secret: `${OAUTH_SECRET_PREFIX}${s}`, hash: hashSecret(s) };
}

/** The hash of a well-formed client secret, else null. */
export function clientSecretHash(raw: string): string | null {
  const m = SECRET_RE.exec(raw);
  return m?.[1] ? hashSecret(m[1]) : null;
}

export function generateCode(): { code: string; hash: string } {
  const code = secret();
  return { code, hash: hashSecret(code) };
}

/** The hash of a well-formed authorization code, else null. */
export function codeHash(raw: string): string | null {
  return CODE_RE.test(raw) ? hashSecret(raw) : null;
}

/** A new access or refresh token: the whole string (sent once), its public id and hash. */
export function generateOAuthToken(kind: OAuthTokenKind): {
  token: string;
  publicId: string;
  secretHash: string;
} {
  const publicId = generatePublicId();
  const s = secret();
  return { token: `${PREFIX[kind]}${publicId}_${s}`, publicId, secretHash: hashSecret(s) };
}

/** The public id and the secret's hash of a well-formed token of `kind`, else null. */
export function parseOAuthToken(
  kind: OAuthTokenKind,
  raw: string
): { publicId: string; secretHash: string } | null {
  const m = TOKEN_RE[kind].exec(raw);
  return m?.[1] && m[2] ? { publicId: m[1], secretHash: hashSecret(m[2]) } : null;
}

/** Which kind of OAuth token `raw` looks like, by its prefix. */
export function oauthTokenKind(raw: string): OAuthTokenKind | null {
  if (raw.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) return 'access';
  if (raw.startsWith(OAUTH_REFRESH_TOKEN_PREFIX)) return 'refresh';
  return null;
}

/** Constant-time comparison of two hex hashes (a missing one never matches). */
export function sameHash(stored: string | null | undefined, given: string): boolean {
  const a = Buffer.from(stored ?? DUMMY, 'hex');
  const b = Buffer.from(given, 'hex');
  return a.length === b.length && timingSafeEqual(a, b) && stored != null;
}
const DUMMY = hashSecret('openrows-no-such-oauth-secret');

/** RFC 7636 S256: whether `verifier` (43–128 unreserved characters) hashes to `challenge`. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const computed = createHash('sha256').update(verifier).digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}
