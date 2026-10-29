import { contracts } from '@openrows/shared';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { clientIp } from '../auth/client-ip.js';
import { rateLimit } from '../auth/rate-limit.js';
import type { RouteRegistry } from '../authz/routes.js';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import { BillingUnavailableError, BillingWebhookError } from '../edition/types.js';
import { AppError } from '../lib/errors.js';
import { billableEditors } from '../usage/service.js';
import { seatTarget } from './seats.js';
import {
  applyBillingEvent,
  currentSubscription,
  hasEnded,
  workspaceSubscriptions,
} from './store.js';

/** A webhook delivery's body is at most this (Polar's subscription events are a few KB). */
export const MAX_BILLING_WEBHOOK_BYTES = 256 * 1024;
/** Deliveries per client IP and minute, before any signature check. */
export const BILLING_WEBHOOK_IP_LIMIT_PER_MINUTE = 300;

const NOT_ENABLED = () =>
  new AppError('NOT_FOUND', { detail: "Billing isn't enabled on this server." });
const UNAVAILABLE = () =>
  new AppError('SERVICE_UNAVAILABLE', {
    detail: "The billing provider can't be reached right now. Try again in a minute.",
  });
const BAD_SIGNATURE =
  'The webhook signature headers are missing, malformed, expired or do not match.';

/** The Standard Webhooks headers the providers sign with. */
const SIGNED_HEADERS = ['webhook-id', 'webhook-timestamp', 'webhook-signature'] as const;

/**
 * Billing: the workspace's subscription and checkout for its owners, and the provider's
 * signed webhooks. The plan changes only from those events, never from a browser coming back
 * from checkout.
 * - `GET /api/workspaces/:workspaceId/billing`, `POST .../billing/checkout` and
 *   `POST .../billing/portal`: owners (`workspace:manage_billing`), sessions only. Without
 *   billing (the OSS edition) checkout and portal are 404.
 * - `PATCH .../billing/subscription`: plan, interval, cancel or resume at the provider,
 *   for owners; the stored subscription follows the provider's event.
 * - `POST /api/billing/:provider/webhooks`: public, authenticated by the provider's signature on
 *   the raw body (BillingWebhooks.verify: Standard Webhooks, a 5-minute timestamp window); a bad
 *   or stale one is 400 and nothing is recorded. Each event id is applied once.
 */
export function billingRoutes(routes: RouteRegistry, deps: { db: Database; config: Config }) {
  const { db, config } = deps;
  // Checkout and portal come back to the workspace's Billing page.
  const billingPage = (workspaceId: string) => `${config.appUrl}/w/${workspaceId}/billing`;

  routes.endpoint(
    contracts.workspaces.billing,
    { resource: 'workspace', action: 'workspace:manage_billing' },
    async (c) => {
      const workspaceId = c.var.resource.id;
      const { billing } = c.var.edition;
      const entitlements = await c.var.edition.entitlements.forWorkspace(workspaceId, c.var.tx);
      const subscriptions = billing.enabled
        ? await workspaceSubscriptions(c.var.tx, workspaceId)
        : [];
      const shown = currentSubscription(subscriptions);
      return {
        workspaceId,
        enabled: billing.enabled,
        plan: { id: entitlements.plan, name: entitlements.planName },
        subscription: shown && {
          plan: shown.plan,
          interval: shown.interval,
          status: shown.status,
          entitled: shown.entitled,
          cancelAtPeriodEnd: shown.cancelAtPeriodEnd,
          currentPeriodEnd: shown.currentPeriodEnd,
          seats: shown.seats,
          graceEndsAt: shown.status === 'past_due' ? shown.graceEndsAt : null,
        },
        offers: billing.enabled ? [...billing.offers()] : [],
        portal: Boolean(billing.enabled && billing.portal && shown),
        editors: await billableEditors(c.var.tx, workspaceId),
        manage: Boolean(
          billing.enabled && billing.updateSubscription && shown && !hasEnded(shown.status)
        ),
      };
    }
  );

  routes.endpoint(
    contracts.workspaces.checkout,
    { resource: 'workspace', action: 'workspace:manage_billing' },
    async (c, { body }) => {
      const workspaceId = c.var.resource.id;
      const { billing } = c.var.edition;
      if (!billing.enabled || !billing.checkout) throw NOT_ENABLED();
      const offer = billing.offers().find((o) => o.plan === body.plan);
      if (!offer?.intervals.includes(body.interval)) {
        throw new AppError('VALIDATION_FAILED', {
          detail: "That plan can't be bought with that billing interval.",
        });
      }
      const subscriptions = await workspaceSubscriptions(c.var.tx, workspaceId);
      if (subscriptions.some((s) => s.entitled)) {
        throw new AppError('CONFLICT', {
          detail:
            'This workspace already has a subscription: change or cancel it on the Billing page.',
        });
      }
      // past due (also after the grace period): update the payment, don't buy a second one.
      if (subscriptions.some((s) => s.status === 'past_due')) {
        throw new AppError('CONFLICT', {
          detail:
            "This workspace's subscription has a failed payment: update the payment method instead.",
        });
      }
      try {
        return await billing.checkout({
          workspaceId,
          userId: c.var.principal.user.id,
          plan: body.plan,
          interval: body.interval,
          seats: seatTarget(await billableEditors(c.var.tx, workspaceId)),
          successUrl: `${billingPage(workspaceId)}?checkout=success`,
          returnUrl: billingPage(workspaceId),
        });
      } catch (err) {
        if (err instanceof BillingUnavailableError) {
          c.var.logger.warn({ err: err.message, detail: err.detail }, 'billing: checkout failed');
          throw UNAVAILABLE();
        }
        throw err;
      }
    }
  );

  routes.endpoint(
    contracts.workspaces.portal,
    { resource: 'workspace', action: 'workspace:manage_billing' },
    async (c) => {
      const workspaceId = c.var.resource.id;
      const { billing } = c.var.edition;
      if (!billing.enabled || !billing.portal) throw NOT_ENABLED();
      const shown = currentSubscription(await workspaceSubscriptions(c.var.tx, workspaceId));
      if (!shown) {
        throw new AppError('CONFLICT', { detail: 'This workspace has no subscription yet.' });
      }
      try {
        return await billing.portal({
          workspaceId,
          customerId: shown.customerId,
          returnUrl: billingPage(workspaceId),
        });
      } catch (err) {
        if (err instanceof BillingUnavailableError) {
          c.var.logger.warn({ err: err.message, detail: err.detail }, 'billing: portal failed');
          throw UNAVAILABLE();
        }
        throw err;
      }
    }
  );

  // plan or interval changes and cancellation in the app, applied by the provider's event.
  routes.endpoint(
    contracts.workspaces.updateSubscription,
    { resource: 'workspace', action: 'workspace:manage_billing' },
    async (c, { body }) => {
      const workspaceId = c.var.resource.id;
      const { billing } = c.var.edition;
      if (!billing.enabled || !billing.updateSubscription) throw NOT_ENABLED();
      const shown = currentSubscription(await workspaceSubscriptions(c.var.tx, workspaceId));
      if (!shown || hasEnded(shown.status)) {
        throw new AppError('CONFLICT', {
          detail: 'This workspace has no subscription to change. Choose a plan to start one.',
        });
      }
      if ('plan' in body) {
        const offer = billing.offers().find((o) => o.plan === body.plan);
        if (!offer?.intervals.includes(body.interval)) {
          throw new AppError('VALIDATION_FAILED', {
            detail: "That plan can't be bought with that billing interval.",
          });
        }
        if (body.plan === shown.plan && body.interval === shown.interval) {
          throw new AppError('CONFLICT', { detail: 'The subscription is already on that plan.' });
        }
      } else if (body.cancelAtPeriodEnd === shown.cancelAtPeriodEnd) {
        throw new AppError('CONFLICT', {
          detail: body.cancelAtPeriodEnd
            ? 'The subscription is already canceled at the end of the period.'
            : "The subscription isn't canceled.",
        });
      }
      try {
        await billing.updateSubscription({ subscriptionId: shown.subscriptionId, change: body });
      } catch (err) {
        if (err instanceof BillingUnavailableError) {
          c.var.logger.warn(
            { err: err.message, detail: err.detail },
            'billing: subscription change failed'
          );
          throw UNAVAILABLE();
        }
        throw err;
      }
      c.var.logger.info(
        {
          workspaceId,
          change:
            'plan' in body ? `${body.plan}/${body.interval}` : { cancel: body.cancelAtPeriodEnd },
        },
        'billing: subscription change requested'
      );
      return null;
    }
  );

  const ip = (c: Context) =>
    clientIp(c, { trustProxy: config.trustProxy, hops: config.trustProxyHops }) ?? 'unknown';
  const path = '/api/billing/:provider/webhooks';
  routes.use(
    path,
    rateLimit({
      limit: BILLING_WEBHOOK_IP_LIMIT_PER_MINUTE,
      windowMs: 60_000,
      key: (c) => `billing-webhook:${ip(c)}`,
    })
  );
  routes.use(
    path,
    bodyLimit({
      maxSize: MAX_BILLING_WEBHOOK_BYTES,
      onError: () => {
        throw new AppError('PAYLOAD_TOO_LARGE', { detail: 'A webhook body is at most 256 KB.' });
      },
    })
  );
  routes.public('POST', path, async (c) => {
    const webhooks = c.var.edition.billing.webhooks;
    if (
      !c.var.edition.billing.enabled ||
      !webhooks ||
      webhooks.provider !== c.req.param('provider')
    ) {
      throw new AppError('NOT_FOUND');
    }
    const body = new Uint8Array(await c.req.arrayBuffer());
    const headers: Record<string, string> = {};
    for (const name of SIGNED_HEADERS) headers[name] = c.req.header(name) ?? '';
    let event: Awaited<ReturnType<typeof webhooks.verify>>;
    try {
      event = await webhooks.verify(body, headers);
    } catch (err) {
      if (err instanceof BillingWebhookError) {
        c.var.logger.warn({ provider: webhooks.provider }, 'billing webhook: refused');
        throw new AppError('BAD_REQUEST', { detail: BAD_SIGNATURE });
      }
      throw err;
    }
    const result = await applyBillingEvent(db, webhooks, event);
    const line = {
      provider: webhooks.provider,
      eventId: event.id,
      eventType: event.type,
      outcome: result.outcome,
      workspaceId: result.workspaceId,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.planChange ? { planChange: result.planChange } : {}),
    };
    if (result.outcome === 'unmatched') c.var.logger.error(line, 'billing webhook: unmatched');
    else c.var.logger.info(line, 'billing webhook: event');
    return c.json({ received: true, duplicate: result.outcome === 'duplicate' }, 202);
  });
}
