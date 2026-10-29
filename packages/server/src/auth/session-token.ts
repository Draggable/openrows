import { createHash, randomBytes } from 'node:crypto';

/** The session cookie (ADR-006). HttpOnly, Secure and SameSite=Lax are set by the auth module. */
export const SESSION_COOKIE = 'openrows_session';

/** A new random 256-bit session token, base64url-encoded. Only the browser ever sees it. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The value stored in `sessions.id_hash`: the SHA-256 of the token, hex-encoded. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
