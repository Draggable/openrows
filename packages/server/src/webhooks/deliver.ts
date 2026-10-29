import {
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_EVENT_TYPE_HEADER,
  WEBHOOK_RESPONSE_EXCERPT,
  WEBHOOK_SIGNATURE_HEADER,
  type WebhookPayload,
} from '@openrows/shared';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Cipher } from '../auth/crypto.js';
import { effectiveRole } from '../authz/policy.js';
import { resolveResource } from '../authz/resolve.js';
import {
  bases,
  type Database,
  outbox,
  type Transaction,
  users,
  webhookDeliveries,
  webhooks,
} from '../db/index.js';
import { webhookDisabledEmail } from '../email/templates.js';
import type { EmailTransport } from '../email/transport.js';
import { tenantJobData, withTenant } from '../jobs/tenant.js';
import type { Logger } from '../lib/logger.js';
import { type SafeFetch, SafeFetchError } from '../lib/safe-fetch/index.js';
import type { OutboundGate } from '../outbound/limits.js';
import { allFieldsVisible, type FieldVisibility } from '../realtime/projection.js';
import { buildWebhookPayload } from './payload.js';
import { signingSecrets, toDelivery, type WebhookRow } from './service.js';
import { signatureHeader } from './signature.js';

/** How long a receiver gets to answer, redirects not followed. */
export const WEBHOOK_TIMEOUT_MS = 10_000;
/** The most of a response the worker reads (the log keeps WEBHOOK_RESPONSE_EXCERPT of it). */
const RESPONSE_MAX_BYTES = 64 * 1024;

/**
 * When a failing webhook is turned off: after this many failed attempts in a row, once
 * the first of them is a day old, so a receiver that is down for an hour during a big import
 * isn't turned off, and one that has failed every retry of an event (~24 h) is.
 */
export const DEFAULT_FAILURE_LIMIT = { attempts: 10, windowMs: 24 * 3600 * 1000 };

export interface WebhookDeliveryDeps {
  /** openrows_app; every read and write runs in the webhook's tenant scope (`withTenant`). */
  db: Database;
  cipher: Cipher;
  http: SafeFetch;
  logger: Pick<Logger, 'info' | 'warn'>;
  /** The creator is told when their webhook is turned off; without it nothing is sent. */
  email?: EmailTransport | undefined;
  appUrl: string;
  visibility?: FieldVisibility;
  failureLimit?: { attempts: number; windowMs: number };
  /**
   * The workspace's outbound rate: a token per delivery, waiting up to `waitMs`, else
   * OutboundDeferred (the job is put back for later). None: unlimited.
   */
  outbound?: { gate: OutboundGate; waitMs: number } | undefined;
}

/** The longest a delivery waits for its workspace's next outbound token before it's deferred. */
export const WEBHOOK_OUTBOUND_WAIT_MS = 2_000;

export const webhookJobData = tenantJobData.extend({
  outboxId: z.number().int().positive(),
  subscriberId: z.uuid(),
  /**
   * A deferred delivery's: the event id receivers saw on earlier attempts (the first
   * job's id) and how many attempts were made before it.
   */
  eventId: z.uuid().optional(),
  priorAttempts: z.number().int().min(0).max(10_000).optional(),
});
export type WebhookJobData = z.infer<typeof webhookJobData>;

export interface SendResult {
  success: boolean;
  responseStatus: number | null;
  durationMs: number;
  responseBody: string | null;
  error: string | null;
}

/** POSTs the signed body once. Never throws: a refusal or timeout is a failed result. */
export async function sendSigned(
  http: SafeFetch,
  url: string,
  secrets: string | readonly string[],
  payload: WebhookPayload
): Promise<SendResult> {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const started = performance.now();
  try {
    const res = await http(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [WEBHOOK_SIGNATURE_HEADER]: signatureHeader(secrets, timestamp, body),
        [WEBHOOK_EVENT_ID_HEADER]: payload.id,
        [WEBHOOK_EVENT_TYPE_HEADER]: payload.type,
      },
      body,
      // A redirect isn't followed (POST would turn into GET): it counts as a failure.
      maxRedirects: 0,
      maxBytes: RESPONSE_MAX_BYTES,
      timeoutMs: WEBHOOK_TIMEOUT_MS,
    });
    return {
      success: res.status >= 200 && res.status < 300,
      responseStatus: res.status,
      durationMs: Math.round(performance.now() - started),
      responseBody: res.text().slice(0, WEBHOOK_RESPONSE_EXCERPT),
      error: null,
    };
  } catch (err) {
    return {
      success: false,
      responseStatus: null,
      durationMs: Math.round(performance.now() - started),
      responseBody: null,
      error:
        err instanceof SafeFetchError
          ? err.code === 'TOO_MANY_REDIRECTS'
            ? 'The receiver answered with a redirect; redirects are not followed'
            : err.message
          : 'The request failed',
    };
  }
}

/** Writes one attempt to the delivery log. */
export async function logDelivery(
  tx: Transaction,
  webhook: Pick<WebhookRow, 'id' | 'workspaceId'>,
  attempt: {
    eventId: string;
    eventType: string;
    outboxId: number | null;
    attempt: number;
  },
  result: SendResult
) {
  const [row] = await tx
    .insert(webhookDeliveries)
    .values({
      workspaceId: webhook.workspaceId,
      webhookId: webhook.id,
      eventId: attempt.eventId,
      eventType: attempt.eventType,
      outboxId: attempt.outboxId,
      attempt: attempt.attempt,
      ...result,
    })
    .returning();
  if (!row) throw new Error('delivery insert returned nothing');
  return toDelivery(row);
}

async function disable(tx: Transaction, id: string, reason: 'failures' | 'creator_access') {
  await tx
    .update(webhooks)
    .set({ enabled: false, disabledReason: reason })
    .where(eq(webhooks.id, id));
}

/** Thrown to make pg-boss retry the job; the message is safe to log. */
export class DeliveryFailed extends Error {
  override name = 'DeliveryFailed';
}

export type DeliveryOutcome =
  | { skipped: 'disabled' | 'creator_access' | 'event_gone' | 'filtered' }
  | { delivered: true; status: number | null };

type Prepared =
  | { skipped: 'disabled' | 'creator_access' | 'event_gone' | 'filtered' }
  | { webhook: WebhookRow; payload: WebhookPayload; secrets: string[] };

/**
 * The `webhooks.deliver` job: one outbox event to one webhook, one attempt per run.
 * 1. In the tenant's scope: the webhook (still enabled), its creator's access to the base (none
 *    left: the webhook is turned off), the event (of the webhook's own base), the payload as the
 *    creator may see it, and the secret.
 * 2. Outside any transaction: the signed POST through the SSRF-safe client.
 * 3. In the tenant's scope again: the attempt in the log, the failure count, and the switch-off
 *    after too many failures (the creator gets an email).
 * A failed attempt throws, so pg-boss retries it with backoff (JOB_QUEUES['webhooks.deliver']).
 */
export async function deliverWebhook(
  deps: WebhookDeliveryDeps,
  data: WebhookJobData,
  eventId: string,
  attempt: number
): Promise<DeliveryOutcome> {
  const { db } = deps;
  const prepared = await withTenant(db, data.workspaceId, async (tx): Promise<Prepared> => {
    const [webhook] = await tx.select().from(webhooks).where(eq(webhooks.id, data.subscriberId));
    if (!webhook?.enabled) return { skipped: 'disabled' };
    const resolved = webhook.createdBy
      ? await resolveResource(tx, 'base', webhook.baseId, webhook.createdBy)
      : null;
    const role = resolved ? effectiveRole(resolved) : null;
    if (!webhook.createdBy || !role) {
      await disable(tx, webhook.id, 'creator_access');
      deps.logger.info({ webhookId: webhook.id }, 'webhook disabled: its creator lost access');
      return { skipped: 'creator_access' };
    }
    const [event] = await tx.select().from(outbox).where(eq(outbox.id, data.outboxId));
    // A webhook never delivers another base's events, whatever the job says.
    if (!event || event.baseId !== webhook.baseId) return { skipped: 'event_gone' };
    if (event.createdAt < webhook.createdAt) return { skipped: 'filtered' };
    const payload = await buildWebhookPayload(tx, {
      webhook,
      event,
      eventId,
      viewer: { userId: webhook.createdBy, role },
      visibility: deps.visibility ?? allFieldsVisible,
    });
    if (!payload) return { skipped: 'filtered' };
    return { webhook, payload, secrets: signingSecrets(webhook, deps.cipher) };
  });
  if ('skipped' in prepared) return prepared;

  const { webhook, payload, secrets } = prepared;
  // Over the workspace's outbound rate: throws OutboundDeferred, before anything is sent.
  await deps.outbound?.gate.acquire(data.workspaceId, deps.outbound.waitMs);
  const result = await sendSigned(deps.http, webhook.url, secrets, payload);
  const limit = deps.failureLimit ?? DEFAULT_FAILURE_LIMIT;
  const turnedOff = await withTenant(db, data.workspaceId, async (tx) => {
    await logDelivery(
      tx,
      webhook,
      { eventId, eventType: payload.type, outboxId: data.outboxId, attempt },
      result
    );
    const [row] = await tx
      .update(webhooks)
      .set(
        result.success
          ? {
              consecutiveFailures: 0,
              failingSince: null,
              lastSuccess: true,
              lastDeliveryAt: sql`now()`,
            }
          : {
              consecutiveFailures: sql`${webhooks.consecutiveFailures} + 1`,
              failingSince: sql`coalesce(${webhooks.failingSince}, now())`,
              lastSuccess: false,
              lastDeliveryAt: sql`now()`,
            }
      )
      .where(eq(webhooks.id, webhook.id))
      .returning();
    if (
      !result.success &&
      row?.enabled &&
      row.consecutiveFailures >= limit.attempts &&
      row.failingSince &&
      Date.now() - row.failingSince.getTime() >= limit.windowMs
    ) {
      await disable(tx, webhook.id, 'failures');
      return row;
    }
    return undefined;
  });

  if (turnedOff) {
    deps.logger.info({ webhookId: webhook.id }, 'webhook disabled after repeated failures');
    await notifyDisabled(deps, turnedOff, result).catch((err: unknown) =>
      deps.logger.warn({ err, webhookId: webhook.id }, 'webhook disabled email failed')
    );
    return { delivered: true, status: result.responseStatus };
  }
  if (!result.success) {
    throw new DeliveryFailed(
      `webhook delivery failed: ${result.responseStatus ?? result.error ?? 'no response'}`
    );
  }
  return { delivered: true, status: result.responseStatus };
}

/** The URL without its query string or fragment, which may carry a token. */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '';
  }
}

async function notifyDisabled(deps: WebhookDeliveryDeps, webhook: WebhookRow, result: SendResult) {
  if (!deps.email || !webhook.createdBy) return;
  const createdBy = webhook.createdBy;
  const found = await withTenant(deps.db, webhook.workspaceId, async (tx) => {
    const [user] = await tx
      .select({ email: users.email, verified: users.emailVerified })
      .from(users)
      .where(eq(users.id, createdBy));
    const [base] = await tx
      .select({ name: bases.name })
      .from(bases)
      .where(and(eq(bases.id, webhook.baseId)));
    return { user, base };
  });
  if (!found.user?.email || !found.user.verified || !found.base) return;
  const content = webhookDisabledEmail({
    baseName: found.base.name,
    url: displayUrl(webhook.url),
    failures: webhook.consecutiveFailures,
    lastError: result.responseStatus
      ? `HTTP ${result.responseStatus}`
      : (result.error ?? 'no response'),
    baseUrl: `${deps.appUrl}/b/${webhook.baseId}`,
  });
  await deps.email.send({ to: found.user.email, ...content });
}
