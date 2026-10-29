import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { emailDomainAllowed } from '@openrows/shared';
import { AppError } from '../lib/errors.js';

/**
 * Access checks of share links beyond the token: an optional password and an optional list
 * of email domains.
 *
 * - Passwords are stored as argon2id PHC strings (salted; OWASP's m=19 MiB, t=2, p=1). A right
 *   password earns an unlock cookie, HMAC-signed with a key derived from ENCRYPTION_KEY, naming
 *   the share, its password version and an expiry (the share's, or 12 hours at most). Changing
 *   the password bumps the version, so every earlier cookie stops working.
 * - Domains: the viewer must be signed in, with a verified email whose domain is exactly one of
 *   the list (`emailDomainAllowed`).
 */

// `algorithm: 2` is Algorithm.Argon2id (an ambient const enum, which verbatimModuleSyntax can't read).
const ARGON2 = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export function hashSharePassword(password: string): Promise<string> {
  return hash(password, ARGON2);
}

/**
 * Whether `password` matches the stored hash. Only argon2id hashes are accepted (the column's
 * CHECK says the same); anything unreadable is a mismatch.
 */
export async function verifySharePassword(stored: string, password: string): Promise<boolean> {
  if (!stored.startsWith('$argon2id$')) return false;
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

/** The name of the unlock cookie; its path is the link's `/api/shared/<token>`. */
export const SHARE_ACCESS_COOKIE = 'openrows_share';
/** The longest an unlock lasts. */
export const SHARE_ACCESS_TTL_MS = 12 * 60 * 60 * 1000;

export interface ShareAccessGrant {
  shareId: string;
  version: number;
  /** Expiry, in milliseconds since the epoch. */
  expiresAt: number;
}

export interface ShareCookieSigner {
  sign(grant: ShareAccessGrant): string;
  /** Whether the cookie is intact, for this share and password version, and not expired. */
  verify(
    value: string | undefined,
    expect: { shareId: string; version: number; now?: number }
  ): boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function shareCookieSigner(secret: string): ShareCookieSigner {
  const key = Buffer.from(hkdfSync('sha256', secret, 'openrows', 'openrows:share-access', 32));
  const mac = (payload: string) =>
    createHmac('sha256', key).update(payload).digest().toString('base64url');
  return {
    sign({ shareId, version, expiresAt }) {
      const payload = `v1.${shareId}.${version}.${Math.floor(expiresAt / 1000)}`;
      return `${payload}.${mac(payload)}`;
    },
    verify(value, expect) {
      if (!value || value.length > 200) return false;
      const parts = value.split('.');
      if (parts.length !== 5) return false;
      const [v, shareId, version, exp, tag] = parts as [string, string, string, string, string];
      const payload = `${v}.${shareId}.${version}.${exp}`;
      const want = Buffer.from(mac(payload));
      const got = Buffer.from(tag);
      if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
      const digits = /^\d{1,12}$/;
      if (v !== 'v1' || !UUID.test(shareId) || !digits.test(version) || !digits.test(exp)) {
        return false;
      }
      return (
        shareId === expect.shareId &&
        Number(version) === expect.version &&
        Number(exp) * 1000 > (expect.now ?? Date.now())
      );
    },
  };
}

/** The unlock cookie's expiry: 12 hours, or the share's own expiry when that is sooner. */
export function shareAccessExpiry(shareExpiresAt: Date | null, now: number = Date.now()): number {
  const latest = now + SHARE_ACCESS_TTL_MS;
  return shareExpiresAt ? Math.min(latest, shareExpiresAt.getTime()) : latest;
}

/** What a request brings to a share link's checks. */
export interface ShareCredentials {
  /** The unlock cookie, if any. */
  cookie: string | undefined;
  /** The signed-in viewer, looked up only for links limited to email domains. */
  viewer: () => Promise<{ email: string | null; emailVerified: boolean } | null>;
  signer: ShareCookieSigner;
  /**
   * The Turnstile site key when the server checks a CAPTCHA on password attempts: named
   * in SHARE_PASSWORD_REQUIRED (and _INCORRECT), so the prompt shows the widget.
   */
  captchaSiteKey?: string | null;
}

/** The problem extensions of a password prompt. */
export function passwordPromptExtensions(creds: ShareCredentials): Record<string, unknown> {
  return creds.captchaSiteKey ? { captchaSiteKey: creds.captchaSiteKey } : {};
}

/** The access settings of a resolved share. */
export interface ShareLock {
  shareId: string;
  passwordHash: string | null;
  passwordVersion: number;
  allowedDomains: readonly string[];
}

/**
 * The domain check: a link limited to email domains needs a signed-in viewer (401
 * SHARE_SIGN_IN_REQUIRED) with a verified email at one of them (403 SHARE_DOMAIN_NOT_ALLOWED).
 */
export async function checkShareDomain(lock: ShareLock, creds: ShareCredentials): Promise<void> {
  if (lock.allowedDomains.length === 0) return;
  const viewer = await creds.viewer();
  if (!viewer) {
    throw new AppError('SHARE_SIGN_IN_REQUIRED', {
      detail: 'Sign in with an email address this link allows.',
    });
  }
  if (!emailDomainAllowed(viewer, lock.allowedDomains)) {
    throw new AppError('SHARE_DOMAIN_NOT_ALLOWED', {
      detail: 'Your account’s email address isn’t one this link allows.',
    });
  }
}

/**
 * Every check of a link before it answers data: domains first, then the password's unlock
 * cookie (401 SHARE_PASSWORD_REQUIRED when missing, forged, for another share, for an old
 * password or expired).
 */
export async function checkShareAccess(lock: ShareLock, creds: ShareCredentials): Promise<void> {
  await checkShareDomain(lock, creds);
  if (lock.passwordHash === null) return;
  const ok = creds.signer.verify(creds.cookie, {
    shareId: lock.shareId,
    version: lock.passwordVersion,
  });
  if (!ok) {
    throw new AppError('SHARE_PASSWORD_REQUIRED', {
      detail: 'This link needs a password.',
      extensions: passwordPromptExtensions(creds),
    });
  }
}
