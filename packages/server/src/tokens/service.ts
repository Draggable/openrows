import {
  type AccessToken,
  type CreatedAccessToken,
  type createAccessTokenSchema,
  MAX_TOKENS_PER_USER,
  TOKEN_SCOPES,
  TOKEN_USAGE_DAYS,
  type TokenScope,
  type TokenUsageDay,
} from '@openrows/shared';
import { and, count, desc, eq, gte, inArray, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { z } from 'zod';
import { generateToken, tokenPrefix } from '../auth/tokens.js';
import { resolveResource } from '../authz/resolve.js';
import type { Transaction } from '../db/index.js';
import { personalAccessTokens, personalAccessTokenUsage } from '../db/index.js';
import { AppError } from '../lib/errors.js';

type Row = typeof personalAccessTokens.$inferSelect;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The last `TOKEN_USAGE_DAYS` UTC days, oldest first, as `YYYY-MM-DD`. */
export function usageDays(now: number): string[] {
  return Array.from({ length: TOKEN_USAGE_DAYS }, (_, i) =>
    new Date(now - (TOKEN_USAGE_DAYS - 1 - i) * DAY_MS).toISOString().slice(0, 10)
  );
}

function toToken(row: Row, usage: TokenUsageDay[]): AccessToken {
  const known: readonly string[] = TOKEN_SCOPES;
  return {
    id: row.id,
    name: row.name,
    prefix: tokenPrefix(row.publicId),
    scopes: row.scopes.filter((s): s is TokenScope => known.includes(s)),
    workspaceIds: row.workspaceIds,
    baseIds: row.baseIds,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    usage,
  };
}

/**
 * The user's live tokens, newest first (revoked ones are gone from the list; expired ones stay
 * until revoked, so their owner sees why an integration stopped). `tx` is in the user's scope:
 * RLS shows nobody else's.
 */
export async function listTokens(
  tx: Transaction,
  userId: string,
  now: () => number = Date.now
): Promise<AccessToken[]> {
  const rows = await tx
    .select()
    .from(personalAccessTokens)
    .where(and(eq(personalAccessTokens.userId, userId), isNull(personalAccessTokens.revokedAt)))
    .orderBy(desc(personalAccessTokens.createdAt));
  const days = usageDays(now());
  const counted =
    rows.length === 0
      ? []
      : await tx
          .select()
          .from(personalAccessTokenUsage)
          .where(
            and(
              inArray(
                personalAccessTokenUsage.tokenId,
                rows.map((r) => r.id)
              ),
              gte(personalAccessTokenUsage.day, days[0] ?? '')
            )
          );
  const byKey = new Map(counted.map((u) => [`${u.tokenId}/${u.day}`, u.requests]));
  return rows.map((row) =>
    toToken(
      row,
      days.map((day) => ({ day, requests: byKey.get(`${row.id}/${day}`) ?? 0 }))
    )
  );
}

/**
 * Creates a token and returns it with its secret, the only time that is sent. Every granted
 * workspace and base must be one the user can reach now (422 otherwise, the same answer for a
 * missing one and one of another tenant); what it reaches later still follows their role.
 */
export async function createToken(
  tx: Transaction,
  userId: string,
  input: z.output<typeof createAccessTokenSchema>,
  now: () => number = Date.now
): Promise<CreatedAccessToken> {
  const [live] = await tx
    .select({ n: count() })
    .from(personalAccessTokens)
    .where(and(eq(personalAccessTokens.userId, userId), isNull(personalAccessTokens.revokedAt)));
  if ((live?.n ?? 0) >= MAX_TOKENS_PER_USER) {
    throw new AppError('CONFLICT', {
      detail: `You can have at most ${MAX_TOKENS_PER_USER} personal access tokens. Revoke one first.`,
    });
  }
  await assertGrantable(tx, userId, input);
  const { token, publicId, secretHash } = generateToken();
  const at = now();
  const [row] = await tx
    .insert(personalAccessTokens)
    .values({
      id: uuidv7(),
      userId,
      name: input.name,
      publicId,
      secretHash,
      scopes: input.scopes,
      workspaceIds: input.workspaceIds,
      baseIds: input.baseIds,
      expiresAt: new Date(at + input.expiresInDays * DAY_MS),
      createdAt: new Date(at),
    })
    .returning();
  if (!row) throw new Error('createToken: no row returned');
  return {
    ...toToken(
      row,
      usageDays(at).map((day) => ({ day, requests: 0 }))
    ),
    token,
  };
}

/**
 * Every workspace and base of a grant (a token's, or an OAuth app's) is one the user can
 * reach now (422 otherwise, the same answer for a missing one and one of another tenant), in a
 * workspace whose policy allows tokens.
 */
export async function assertGrantable(
  tx: Transaction,
  userId: string,
  grant: { workspaceIds: readonly string[]; baseIds: readonly string[] }
): Promise<void> {
  for (const id of grant.workspaceIds) {
    const r = await resolveResource(tx, 'workspace', id, userId);
    if (!r?.workspaceRole) throw unreachable('workspaceIds');
    if (r.tokensAllowed === false) throw tokensRestricted();
  }
  for (const id of grant.baseIds) {
    const r = await resolveResource(tx, 'base', id, userId);
    if (!r || (r.workspaceRole === null && r.baseRole === null)) throw unreachable('baseIds');
    if (r.tokensAllowed === false) throw tokensRestricted();
  }
}

/** A grant in a workspace whose policy turned personal access tokens off. */
function tokensRestricted(): AppError {
  return new AppError('POLICY_RESTRICTED', {
    detail: "A workspace you picked doesn't allow personal access tokens (its policy).",
  });
}

function unreachable(path: string) {
  return new AppError('VALIDATION_FAILED', {
    detail: 'Only workspaces and bases you have access to can be granted.',
    extensions: { errors: [{ path, message: 'No such workspace or base.' }] },
  });
}

/** Revokes one of the user's tokens; 404 for anyone else's (RLS hides it) or a revoked one. */
export async function revokeToken(
  tx: Transaction,
  userId: string,
  tokenId: string,
  now: () => number = Date.now
): Promise<void> {
  const revoked = await tx
    .update(personalAccessTokens)
    .set({ revokedAt: new Date(now()) })
    .where(
      and(
        eq(personalAccessTokens.id, tokenId),
        eq(personalAccessTokens.userId, userId),
        isNull(personalAccessTokens.revokedAt)
      )
    )
    .returning({ id: personalAccessTokens.id });
  if (revoked.length === 0) throw new AppError('NOT_FOUND', { detail: 'No such token.' });
}
