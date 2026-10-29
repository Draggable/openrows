import {
  type createWebhookSchema,
  MAX_WEBHOOKS_PER_BASE,
  type updateWebhookSchema,
  WEBHOOK_SECRET_GRACE_HOURS,
  type Webhook,
  type WebhookDelivery,
  type WebhookEventType,
  type WebhookWithSecret,
} from '@openrows/shared';
import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Cipher } from '../auth/crypto.js';
import { fields, type Transaction, tables, webhookDeliveries, webhooks } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import { SafeFetchError } from '../lib/safe-fetch/index.js';
import { generateWebhookSecret } from './signature.js';

export type WebhookRow = typeof webhooks.$inferSelect;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;

/** Checks a URL against the outbound rules without connecting (safe-fetch's createUrlCheck). */
export type UrlCheck = (url: string) => Promise<void>;

export interface WebhookContext {
  tx: Transaction;
  workspaceId: string;
  baseId: string;
  userId: string;
  cipher: Cipher;
  checkUrl: UrlCheck;
}

export function toWebhook(row: WebhookRow): Webhook {
  return {
    id: row.id,
    baseId: row.baseId,
    url: row.url,
    description: row.description,
    events: row.events as WebhookEventType[],
    tableIds: row.tableIds,
    fieldIds: row.fieldIds,
    enabled: row.enabled,
    disabledReason:
      row.disabledReason === null ? null : (row.disabledReason as Webhook['disabledReason']),
    consecutiveFailures: row.consecutiveFailures,
    lastDeliveryAt: row.lastDeliveryAt?.toISOString() ?? null,
    lastSuccess: row.lastSuccess,
    previousSecretExpiresAt: previousSecretValid(row)
      ? (row.previousSecretExpiresAt?.toISOString() ?? null)
      : null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The previous secret is still in its grace period. */
export function previousSecretValid(
  row: Pick<WebhookRow, 'previousSecretEncrypted' | 'previousSecretExpiresAt'>,
  now = Date.now()
): boolean {
  return (
    row.previousSecretEncrypted !== null &&
    row.previousSecretExpiresAt !== null &&
    row.previousSecretExpiresAt.getTime() > now
  );
}

/**
 * The secrets that sign a delivery, current first: the previous one too while its grace
 * period lasts. Throws when the current one can't be decrypted (ENCRYPTION_KEY changed); an
 * unreadable previous one is left out.
 */
export function signingSecrets(row: WebhookRow, cipher: Cipher): string[] {
  const current = cipher.decrypt(row.secretEncrypted);
  if (current === undefined) throw new Error('webhook secret unreadable (ENCRYPTION_KEY changed?)');
  const previous =
    previousSecretValid(row) && row.previousSecretEncrypted
      ? cipher.decrypt(row.previousSecretEncrypted)
      : undefined;
  return previous === undefined ? [current] : [current, previous];
}

export function toDelivery(row: WebhookDeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    eventId: row.eventId,
    eventType: row.eventType,
    attempt: row.attempt,
    success: row.success,
    responseStatus: row.responseStatus,
    durationMs: row.durationMs,
    responseBody: row.responseBody,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

function invalid(path: string, message: string): never {
  throw new AppError('VALIDATION_FAILED', {
    detail: message,
    extensions: { errors: [{ path, message }] },
  });
}

/** The URL must pass the safe client's rules now; they are checked again on every delivery. */
async function checkUrl(ctx: WebhookContext, url: string) {
  try {
    await ctx.checkUrl(url);
  } catch (err) {
    if (err instanceof SafeFetchError) invalid('url', `This URL can't be used: ${err.message}.`);
    throw err;
  }
}

/** Table and field filters must name live tables of this base and fields of them. */
async function checkFilters(
  ctx: WebhookContext,
  tableIds: readonly string[] | null,
  fieldIds: readonly string[] | null
) {
  if (tableIds?.length) {
    const found = await ctx.tx
      .select({ id: tables.id })
      .from(tables)
      .where(
        and(
          eq(tables.baseId, ctx.baseId),
          inArray(tables.id, [...tableIds]),
          isNull(tables.deletedAt)
        )
      );
    if (found.length !== tableIds.length) invalid('tableIds', 'A table is not in this base.');
  }
  if (fieldIds?.length) {
    const found = await ctx.tx
      .select({ id: fields.id, tableId: fields.tableId })
      .from(fields)
      .innerJoin(tables, eq(tables.id, fields.tableId))
      .where(
        and(
          eq(tables.baseId, ctx.baseId),
          inArray(fields.id, [...fieldIds]),
          isNull(fields.deletedAt),
          isNull(tables.deletedAt)
        )
      );
    if (found.length !== fieldIds.length) invalid('fieldIds', 'A field is not in this base.');
    if (tableIds?.length && found.some((f) => !tableIds.includes(f.tableId))) {
      invalid('fieldIds', "A field is not in the webhook's tables.");
    }
  }
}

export async function listWebhooks(tx: Transaction, baseId: string): Promise<Webhook[]> {
  const rows = await tx
    .select()
    .from(webhooks)
    .where(eq(webhooks.baseId, baseId))
    .orderBy(webhooks.createdAt);
  return rows.map(toWebhook);
}

/** The webhook of this base, or 404 (ids of other bases and tenants never match). */
export async function loadWebhook(
  tx: Transaction,
  baseId: string,
  webhookId: string
): Promise<WebhookRow> {
  const [row] = await tx
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.id, webhookId), eq(webhooks.baseId, baseId)));
  if (!row) throw new AppError('NOT_FOUND', { detail: 'No such webhook.' });
  return row;
}

export async function createWebhook(
  ctx: WebhookContext,
  input: z.output<typeof createWebhookSchema>
): Promise<WebhookWithSecret> {
  // One creation at a time per base, so the cap holds under concurrent requests.
  await ctx.tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`webhooks:${ctx.baseId}`}, 0))`
  );
  const [existing] = await ctx.tx
    .select({ n: count() })
    .from(webhooks)
    .where(eq(webhooks.baseId, ctx.baseId));
  if ((existing?.n ?? 0) >= MAX_WEBHOOKS_PER_BASE) {
    throw new AppError('CONFLICT', {
      detail: `A base can have at most ${MAX_WEBHOOKS_PER_BASE} webhooks.`,
    });
  }
  await checkUrl(ctx, input.url);
  await checkFilters(ctx, input.tableIds, input.fieldIds);
  const secret = generateWebhookSecret();
  const [row] = await ctx.tx
    .insert(webhooks)
    .values({
      workspaceId: ctx.workspaceId,
      baseId: ctx.baseId,
      url: input.url,
      description: input.description,
      events: input.events,
      tableIds: input.tableIds,
      fieldIds: input.fieldIds,
      enabled: input.enabled,
      secretEncrypted: ctx.cipher.encrypt(secret),
      createdBy: ctx.userId,
    })
    .returning();
  if (!row) throw new Error('webhook insert returned nothing');
  return { ...toWebhook(row), secret };
}

export async function updateWebhook(
  ctx: WebhookContext,
  webhookId: string,
  input: z.output<typeof updateWebhookSchema>
): Promise<WebhookWithSecret> {
  const row = await loadWebhook(ctx.tx, ctx.baseId, webhookId);
  if (input.url !== undefined && input.url !== row.url) await checkUrl(ctx, input.url);
  const tableIds = input.tableIds !== undefined ? input.tableIds : row.tableIds;
  const fieldIds = input.fieldIds !== undefined ? input.fieldIds : row.fieldIds;
  if (input.tableIds !== undefined || input.fieldIds !== undefined) {
    await checkFilters(ctx, tableIds, fieldIds);
  }
  const secret = input.rotateSecret ? generateWebhookSecret() : undefined;
  const enabling = input.enabled === true && !row.enabled;
  const [updated] = await ctx.tx
    .update(webhooks)
    .set({
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.events !== undefined ? { events: [...new Set(input.events)] } : {}),
      ...(input.tableIds !== undefined ? { tableIds } : {}),
      ...(input.fieldIds !== undefined ? { fieldIds } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled, disabledReason: null } : {}),
      // Turned on again: a fresh start, and payloads honour whoever turned it on.
      ...(enabling ? { consecutiveFailures: 0, failingSince: null, createdBy: ctx.userId } : {}),
      // Rotated: the old secret keeps signing for the grace period, as the only previous
      // one (a second rotation within it drops the oldest). Unless the grace is ended now.
      ...(secret
        ? {
            secretEncrypted: ctx.cipher.encrypt(secret),
            previousSecretEncrypted: input.expirePreviousSecret ? null : row.secretEncrypted,
            previousSecretExpiresAt: input.expirePreviousSecret
              ? null
              : sql`now() + make_interval(hours => ${WEBHOOK_SECRET_GRACE_HOURS})`,
          }
        : input.expirePreviousSecret
          ? { previousSecretEncrypted: null, previousSecretExpiresAt: null }
          : {}),
    })
    .where(eq(webhooks.id, row.id))
    .returning();
  if (!updated) throw new Error('webhook update returned nothing');
  return { ...toWebhook(updated), ...(secret ? { secret } : {}) };
}

export async function deleteWebhook(tx: Transaction, baseId: string, webhookId: string) {
  const row = await loadWebhook(tx, baseId, webhookId);
  await tx.delete(webhooks).where(eq(webhooks.id, row.id));
}

export async function listDeliveries(
  tx: Transaction,
  baseId: string,
  webhookId: string,
  limit: number
): Promise<WebhookDelivery[]> {
  const row = await loadWebhook(tx, baseId, webhookId);
  const rows = await tx
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.webhookId, row.id))
    .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
    .limit(limit);
  return rows.map(toDelivery);
}
