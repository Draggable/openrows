import { contracts, type WebhookPayload } from '@openrows/shared';
import { and, eq, max } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import { audit } from '../audit/record.js';
import type { Cipher } from '../auth/crypto.js';
import type { RouteRegistry } from '../authz/routes.js';
import { bases, outbox, webhookDeliveries } from '../db/index.js';
import { namedJobId } from '../jobs/ids.js';
import type { Jobs } from '../jobs/send.js';
import { AppError } from '../lib/errors.js';
import type { SafeFetch } from '../lib/safe-fetch/index.js';
import { logDelivery, sendSigned, type WebhookJobData } from './deliver.js';
import {
  createWebhook,
  deleteWebhook,
  listDeliveries,
  listWebhooks,
  loadWebhook,
  signingSecrets,
  type UrlCheck,
  updateWebhook,
  type WebhookContext,
} from './service.js';
import { WEBHOOK_QUEUE } from './subscriber.js';

export interface WebhookRouteDeps {
  cipher: Cipher;
  checkUrl: UrlCheck;
  http: SafeFetch;
  /** Redeliveries go to the worker's `webhooks.deliver` queue. */
  jobs: Jobs;
}

/**
 * Webhook management under the REST API v1: a base's creators (and personal access
 * tokens with `webhook:manage`) list, create, change, delete and test its webhooks and read the
 * delivery log. Every route is a resource route on the base in its path, so ids of other bases
 * and tenants are 404s. Secrets are only ever in the answer to a creation or a rotation.
 */
export function webhookRoutes(routes: RouteRegistry, deps: WebhookRouteDeps) {
  const w = contracts.v1Webhooks;
  const access = { resource: 'base', action: 'base:manage_webhooks' } as const;

  const context = (c: {
    var: {
      tx: WebhookContext['tx'];
      resource: { id: string; workspaceId: string };
      principal: { user: { id: string } };
    };
  }): WebhookContext => ({
    tx: c.var.tx,
    workspaceId: c.var.resource.workspaceId,
    baseId: c.var.resource.id,
    userId: c.var.principal.user.id,
    cipher: deps.cipher,
    checkUrl: deps.checkUrl,
  });

  routes.endpoint(w.list, access, async (c) => ({
    webhooks: await listWebhooks(c.var.tx, c.var.resource.id),
  }));

  routes.endpoint(w.create, access, async (c, { body }) => {
    const created = await createWebhook(context(c), body);
    c.var.logger.info({ webhookId: created.id }, 'webhook created');
    await audit(c, c.var.tx, {
      workspaceId: c.var.resource.workspaceId,
      action: 'webhook.create',
      target: { type: 'webhook', id: created.id, name: hostOf(body.url) },
      summary: {
        after: { baseId: c.var.resource.id, events: body.events, enabled: body.enabled ?? true },
      },
    });
    return created;
  });

  routes.endpoint(w.update, access, async (c, { params, body }) => {
    const updated = await updateWebhook(context(c), params.webhookId, body);
    if (body.rotateSecret) c.var.logger.info({ webhookId: updated.id }, 'webhook secret rotated');
    // Hosts only: a webhook URL's path or query may hold a credential.
    await audit(c, c.var.tx, {
      workspaceId: c.var.resource.workspaceId,
      action: 'webhook.update',
      target: { type: 'webhook', id: updated.id, name: hostOf(updated.url) },
      summary: {
        after: {
          ...(body.url !== undefined ? { host: hostOf(body.url) } : {}),
          ...(body.events !== undefined ? { events: body.events } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.rotateSecret ? { secretRotated: true } : {}),
        },
      },
    });
    return updated;
  });

  routes.endpoint(w.delete, access, async (c, { params }) => {
    await deleteWebhook(c.var.tx, c.var.resource.id, params.webhookId);
    c.var.logger.info({ webhookId: params.webhookId }, 'webhook deleted');
    await audit(c, c.var.tx, {
      workspaceId: c.var.resource.workspaceId,
      action: 'webhook.delete',
      target: { type: 'webhook', id: params.webhookId },
      summary: { before: { baseId: c.var.resource.id } },
    });
    return null;
  });

  routes.endpoint(w.deliveries, access, async (c, { params, query }) => ({
    deliveries: await listDeliveries(c.var.tx, c.var.resource.id, params.webhookId, query.limit),
  }));

  // A logged event again: queued for the worker like the relay's job, with the event id
  // receivers saw and the next attempt number, so it honours the creator's access, the outbound
  // limits and the failure count. Ping tests can't be redelivered (send a new one).
  routes.endpoint(w.redeliver, access, async (c, { params }) => {
    const { tx, resource } = c.var;
    const webhook = await loadWebhook(tx, resource.id, params.webhookId);
    const [delivery] = await tx
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.id, params.deliveryId),
          eq(webhookDeliveries.webhookId, webhook.id)
        )
      );
    if (!delivery) throw new AppError('NOT_FOUND', { detail: 'No such delivery.' });
    // Event ids are the relay's job ids (UUIDs); anything else was never a queued event.
    if (delivery.outboxId === null || !z.uuid().safeParse(delivery.eventId).success) {
      throw new AppError('CONFLICT', { detail: 'A test ping can’t be redelivered.' });
    }
    if (!webhook.enabled) {
      throw new AppError('CONFLICT', { detail: 'Turn the webhook on to redeliver its events.' });
    }
    const [event] = await tx
      .select({ id: outbox.id })
      .from(outbox)
      .where(and(eq(outbox.id, delivery.outboxId), eq(outbox.baseId, resource.id)));
    if (!event) {
      throw new AppError('CONFLICT', { detail: 'The event is no longer kept; it can’t be sent.' });
    }
    const [tries] = await tx
      .select({ n: max(webhookDeliveries.attempt) })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.webhookId, webhook.id),
          eq(webhookDeliveries.eventId, delivery.eventId)
        )
      );
    const data: WebhookJobData = {
      workspaceId: resource.workspaceId,
      outboxId: event.id,
      subscriberId: webhook.id,
      eventId: delivery.eventId,
      priorAttempts: tries?.n ?? delivery.attempt,
    };
    // One queued redelivery per event and attempt: a second click while it waits is a no-op
    // (the same job id); once its attempt is logged, the next click queues the next one.
    await deps.jobs.send(tx, WEBHOOK_QUEUE, data, {
      id: namedJobId(
        `openrows:webhook-redeliver:${webhook.id}:${delivery.eventId}:${data.priorAttempts}`
      ),
    });
    c.var.logger.info({ webhookId: webhook.id, deliveryId: delivery.id }, 'webhook redelivery');
    return { queued: true as const, eventId: delivery.eventId };
  });

  // A signed `ping` now, to the URL as saved (disabled webhooks too, to test a fix). It goes to
  // the log; the failure count is left alone.
  routes.endpoint(w.ping, access, async (c, { params }) => {
    const { tx, resource, principal } = c.var;
    const webhook = await loadWebhook(tx, resource.id, params.webhookId);
    const secrets = signingSecrets(webhook, deps.cipher);
    const [base] = await tx
      .select({ id: bases.id, name: bases.name })
      .from(bases)
      .where(eq(bases.id, resource.id));
    if (!base) throw new AppError('NOT_FOUND', { detail: 'No such base.' });
    const payload: WebhookPayload = {
      id: uuidv7(),
      type: 'ping',
      timestamp: new Date().toISOString(),
      webhookId: webhook.id,
      base,
      table: null,
      actor: { id: principal.user.id, name: principal.user.name ?? '' },
    };
    const result = await sendSigned(deps.http, webhook.url, secrets, payload);
    return logDelivery(
      tx,
      webhook,
      { eventId: payload.id, eventType: 'ping', outboxId: null, attempt: 1 },
      result
    );
  });
}

/** A URL's host, for the audit log. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
