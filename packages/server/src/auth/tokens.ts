import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { TOKEN_PREFIX, TOKEN_SCOPES, type TokenScope } from '@openrows/shared';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { users } from '../db/index.js';
import type { Principal } from './sessions.js';

/**
 * Personal access tokens: `or_pat_<publicId>_<secret>`. The public id (12 lowercase
 * base32 characters) finds the row and makes a leaked token greppable; the secret is 32 random
 * bytes (base64url), of which only the SHA-256 is stored.
 */
const PUBLIC_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const PUBLIC_ID_LENGTH = 12;
const TOKEN_PATTERN = new RegExp(
  `^${TOKEN_PREFIX}([a-z2-7]{${PUBLIC_ID_LENGTH}})_([A-Za-z0-9_-]{43})$`
);

/** What a bearer token may reach: its scopes and grants. The role is read live per request. */
export interface TokenGrant {
  id: string;
  scopes: readonly TokenScope[];
  /** Every current and future base of these workspaces. */
  workspaceIds: readonly string[];
  /** These bases only. */
  baseIds: readonly string[];
  /** An OAuth app's access token: the app; `id` is then its authorization's. */
  oauthApp?: { id: string; name: string };
}

export function generatePublicId(): string {
  const bytes = randomBytes(PUBLIC_ID_LENGTH);
  let id = '';
  for (const b of bytes) id += PUBLIC_ID_ALPHABET[b & 31];
  return id;
}

/** A new token: the whole string (shown once), its public id and the hash to store. */
export function generateToken(): { token: string; publicId: string; secretHash: string } {
  const publicId = generatePublicId();
  const secret = randomBytes(32).toString('base64url');
  return {
    token: `${TOKEN_PREFIX}${publicId}_${secret}`,
    publicId,
    secretHash: hashSecret(secret),
  };
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** The public id and secret of a well-formed token, else null. */
export function parseToken(raw: string): { publicId: string; secret: string } | null {
  const m = TOKEN_PATTERN.exec(raw);
  return m?.[1] && m[2] ? { publicId: m[1], secret: m[2] } : null;
}

/** `or_pat_<publicId>`: how a token is shown after creation. */
export function tokenPrefix(publicId: string): string {
  return `${TOKEN_PREFIX}${publicId}`;
}

/** The bearer credential of a request, if its `Authorization` header is `Bearer …`. */
export function bearerOf(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m?.[1] ?? null;
}

// A hash to compare against when the public id is unknown, so the answer takes as long.
const DUMMY_HASH = hashSecret('openrows-no-such-token');

interface LookupRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  secret_hash: string;
  scopes: string[];
  workspace_ids: string[];
  base_ids: string[];
  expires_at: Date | string;
  revoked_at: Date | string | null;
  created_at: Date | string;
}

/**
 * The principal of a bearer token, or null when it is malformed, unknown, revoked or expired
 * (the caller answers 401 alike, without saying which). The secret's hash is compared in
 * constant time; a matching token's request is counted for today and its `last_used_at`
 * recorded (at most once a minute).
 */
export async function resolveToken(
  db: Database,
  raw: string,
  now: () => number = Date.now
): Promise<Principal | null> {
  const parsed = parseToken(raw);
  if (!parsed) return null;
  const { rows } = await db.execute<LookupRow>(sql`SELECT * FROM pat_lookup(${parsed.publicId})`);
  const row = rows[0];
  const given = Buffer.from(hashSecret(parsed.secret), 'hex');
  const stored = Buffer.from(row?.secret_hash ?? DUMMY_HASH, 'hex');
  const matches = stored.length === given.length && timingSafeEqual(stored, given);
  if (!row || !matches) return null;
  const expiresAt = new Date(row.expires_at);
  if (row.revoked_at !== null || expiresAt.getTime() <= now()) return null;

  const [user] = await db.select().from(users).where(eq(users.id, row.user_id));
  // A suspended account's tokens are refused until it is lifted.
  if (!user || user.suspendedAt !== null) return null;
  await db.execute(sql`SELECT pat_use(${row.id}::uuid)`);
  const known: readonly string[] = TOKEN_SCOPES;
  return {
    user,
    session: { idHash: '', expiresAt, createdAt: new Date(row.created_at) },
    token: {
      id: row.id,
      scopes: row.scopes.filter((s): s is TokenScope => known.includes(s)),
      workspaceIds: row.workspace_ids,
      baseIds: row.base_ids,
    },
  };
}
