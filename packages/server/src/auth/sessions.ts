import { and, eq, lt, lte, or } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { sessions, users } from '../db/index.js';
import type { Logger } from '../lib/logger.js';
import { createCipher } from './crypto.js';
import { type IdentityClaims, type OidcClient, OidcRejectedError, type TokenSet } from './oidc.js';
import { generateSessionToken, hashSessionToken } from './session-token.js';
import type { TokenGrant } from './tokens.js';

/** ADR-006: sessions end after 7 days without use and 30 days after sign-in at the latest. */
export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
/** How often an active session re-checks the user with the provider (refresh token grant). */
export const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/** `last_seen_at` is written at most this often, not on every request. */
const TOUCH_INTERVAL_MS = 60 * 1000;

export type User = typeof users.$inferSelect;

/**
 * The signed-in user and their session, as `c.var.principal`. With a personal access token
 * `token` holds its scopes and grants, and `session` the token's dates (no cookie).
 */
export interface Principal {
  user: User;
  session: { idHash: string; expiresAt: Date; createdAt: Date; authenticatedAt?: Date | null };
  token?: TokenGrant;
  /**
   * A system admin's session viewing the app as `user`: read-only (requireSession refuses
   * every other method) until `expiresAt`. `session` is the admin's own.
   */
  impersonation?: { adminId: string; adminEmail: string | null; expiresAt: Date };
}

/** Users, sessions and refresh. All database access for authentication goes through here. */
export class SessionStore {
  readonly #cipher;

  constructor(
    private readonly db: Database,
    private readonly oidc: OidcClient | undefined,
    encryptionKey: string,
    private readonly now: () => number = Date.now
  ) {
    this.#cipher = createCipher(encryptionKey, 'session-tokens');
  }

  #enc(value: string | undefined) {
    return value === undefined ? null : this.#cipher.encrypt(value);
  }

  #dec(value: Buffer | null) {
    return value === null ? undefined : this.#cipher.decrypt(value);
  }

  /**
   * Creates or updates the user for an (issuer, subject) identity from fresh ID-token claims.
   * `systemAdmins` (lowercased emails, `OPENROWS_SYSTEM_ADMINS`) sets `is_system_admin`: true
   * only for a verified email on the list, false otherwise. With an empty list the flag
   * is left as it is, so operators can set it by hand in the database.
   */
  async upsertUser(claims: IdentityClaims, systemAdmins: readonly string[] = []): Promise<User> {
    const email = claims.email ?? null;
    const profile = {
      email,
      emailVerified: claims.emailVerified,
      name: claims.name ?? null,
      avatarUrl: claims.picture ?? null,
      ...(systemAdmins.length > 0
        ? {
            isSystemAdmin:
              claims.emailVerified && email !== null && systemAdmins.includes(email.toLowerCase()),
          }
        : {}),
    };
    const [user] = await this.db
      .insert(users)
      .values({ oidcIssuer: claims.issuer, oidcSubject: claims.subject, ...profile })
      .onConflictDoUpdate({
        target: [users.oidcIssuer, users.oidcSubject],
        set: { ...profile, updatedAt: new Date(this.now()) },
      })
      .returning();
    if (!user) throw new Error('upsertUser: no row returned');
    return user;
  }

  /** Starts a session and returns the raw cookie token (only its hash is stored). */
  async create(
    user: User,
    tokens: TokenSet,
    meta: { userAgent: string | undefined; ip: string | undefined }
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = generateSessionToken();
    const now = new Date(this.now());
    const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_MS);
    await this.db.insert(sessions).values({
      idHash: hashSessionToken(token),
      userId: user.id,
      expiresAt,
      lastSeenAt: now,
      tokensRefreshedAt: now,
      oidcSid: tokens.claims.sid ?? null,
      refreshTokenEnc: this.#enc(tokens.refreshToken),
      idTokenEnc: this.#enc(tokens.idToken),
      userAgent: meta.userAgent?.slice(0, 512) ?? null,
      ip: meta.ip ?? null,
      authenticatedAt: tokens.claims.authTime ?? null,
      createdAt: now,
    });
    return { token, expiresAt };
  }

  /**
   * Looks up the session for a cookie token. Expired sessions are deleted. Every
   * REFRESH_INTERVAL_MS the refresh token is used; if the provider rejects it (user disabled,
   * signed out elsewhere, session revoked) the session ends. If the provider is merely
   * unreachable, the session carries on and the refresh is retried next interval.
   */
  async resolve(token: string, log: Logger): Promise<Principal | null> {
    const idHash = hashSessionToken(token);
    const [row] = await this.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.idHash, idHash));
    if (!row) return null;

    const now = this.now();
    const { session } = row;
    if (
      session.expiresAt.getTime() <= now ||
      session.lastSeenAt.getTime() + SESSION_IDLE_MS <= now ||
      row.user.deletedAt !== null ||
      row.user.suspendedAt !== null
    ) {
      await this.db.delete(sessions).where(eq(sessions.idHash, idHash));
      return null;
    }

    if (this.oidc && session.tokensRefreshedAt.getTime() + REFRESH_INTERVAL_MS <= now) {
      const alive = await this.#refresh(idHash, now, log);
      if (!alive) return null;
    }

    if (session.lastSeenAt.getTime() + TOUCH_INTERVAL_MS <= now) {
      await this.db
        .update(sessions)
        .set({ lastSeenAt: new Date(now) })
        .where(eq(sessions.idHash, idHash));
    }

    const principal: Principal = {
      user: row.user,
      session: {
        idHash,
        expiresAt: session.expiresAt,
        createdAt: session.createdAt,
        authenticatedAt: session.authenticatedAt,
      },
    };
    if (session.impersonatedUserId === null) return principal;
    return this.#impersonated(principal, session, now);
  }

  /**
   * The principal of an admin session that impersonates someone: the target user, read
   * only, while the impersonation lasts, the admin is still a system admin and the target is
   * neither deleted nor suspended. Otherwise the impersonation is cleared and the admin is
   * themselves again.
   */
  async #impersonated(
    admin: Principal,
    session: typeof sessions.$inferSelect,
    now: number
  ): Promise<Principal> {
    const expiresAt = session.impersonationExpiresAt;
    const targetId = session.impersonatedUserId;
    if (targetId && expiresAt && expiresAt.getTime() > now && admin.user.isSystemAdmin) {
      const [target] = await this.db.select().from(users).where(eq(users.id, targetId));
      if (target && target.deletedAt === null && target.suspendedAt === null) {
        return {
          ...admin,
          user: target,
          impersonation: { adminId: admin.user.id, adminEmail: admin.user.email, expiresAt },
        };
      }
    }
    await this.db
      .update(sessions)
      .set({ impersonatedUserId: null, impersonationExpiresAt: null })
      .where(eq(sessions.idHash, admin.session.idHash));
    return admin;
  }

  /** Returns false when the session was ended because the provider rejected the refresh. */
  async #refresh(idHash: string, now: number, log: Logger): Promise<boolean> {
    const oidc = this.oidc;
    if (!oidc) return true;
    // Claim the refresh atomically: with refresh-token rotation, two concurrent requests using
    // the same token would make the provider revoke it. Only the winner refreshes.
    const [claimed] = await this.db
      .update(sessions)
      .set({ tokensRefreshedAt: new Date(now) })
      .where(
        and(
          eq(sessions.idHash, idHash),
          lt(sessions.tokensRefreshedAt, new Date(now - REFRESH_INTERVAL_MS + 1))
        )
      )
      .returning({ refreshTokenEnc: sessions.refreshTokenEnc });
    if (!claimed) return true;

    const refreshToken = this.#dec(claimed.refreshTokenEnc);
    if (!refreshToken) return true; // The provider gave none; nothing to re-check.
    try {
      const tokens = await oidc.refresh(refreshToken);
      await this.db
        .update(sessions)
        .set({
          refreshTokenEnc: this.#enc(tokens.refreshToken),
          ...(tokens.idToken ? { idTokenEnc: this.#enc(tokens.idToken) } : {}),
        })
        .where(eq(sessions.idHash, idHash));
      return true;
    } catch (err) {
      if (err instanceof OidcRejectedError) {
        log.info({ reason: err.message }, 'provider rejected the refresh token, ending session');
        await this.db.delete(sessions).where(eq(sessions.idHash, idHash));
        return false;
      }
      log.warn({ err }, 'token refresh failed, keeping the session');
      return true;
    }
  }

  /** Deletes the session and returns its ID token (for the logout hint), if any. */
  async end(token: string): Promise<{ idToken: string | undefined } | undefined> {
    const [row] = await this.db
      .delete(sessions)
      .where(eq(sessions.idHash, hashSessionToken(token)))
      .returning({ idTokenEnc: sessions.idTokenEnc });
    return row ? { idToken: this.#dec(row.idTokenEnc) } : undefined;
  }

  /** Housekeeping: removes sessions past their absolute or idle expiry. */
  deleteExpired(): Promise<number> {
    return deleteExpiredSessions(this.db, this.now());
  }
}

/**
 * Removes sessions past their absolute or idle expiry; the worker's hourly `sessions.sweep`
 * (it was a timer in every API process). An expired session is refused anyway: this only
 * keeps the table small.
 */
export async function deleteExpiredSessions(db: Database, nowMs = Date.now()): Promise<number> {
  const now = new Date(nowMs);
  const idle = new Date(now.getTime() - SESSION_IDLE_MS);
  const deleted = await db
    .delete(sessions)
    .where(or(lte(sessions.expiresAt, now), lte(sessions.lastSeenAt, idle)))
    .returning({ idHash: sessions.idHash });
  return deleted.length;
}
