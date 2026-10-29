import { z } from 'zod';
import { planIdSchema } from './usage.js';

/**
 * Subscriptions and checkout. The core stores a workspace's subscriptions and turns the
 * billing provider's signed events into its plan; the provider (Polar, in the hosted edition) sells the plans.
 * The OSS edition has no billing: `enabled: false`, nothing to buy.
 */

/** How often a subscription is billed. */
export const BILLING_INTERVALS = ['month', 'year'] as const;
export const billingIntervalSchema = z.enum(BILLING_INTERVALS);
export type BillingInterval = z.infer<typeof billingIntervalSchema>;

/**
 * Dunning: a `past_due` subscription keeps its plan this many days after the payment
 * failed, while the provider retries it and the owners are emailed; then the workspace falls back
 * to the default (Free) plan's limits as soft blocks (nothing is deleted) until it's paid.
 */
export const BILLING_GRACE_DAYS = 14;

/**
 * A subscription's state as the provider reports it (Polar's statuses; `canceled`: ended).
 */
export const SUBSCRIPTION_STATUSES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
] as const;
export const subscriptionStatusSchema = z.enum(SUBSCRIPTION_STATUSES);
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

/** A plan the workspace's owners can buy, and how often it can be billed. */
export const BillingOfferSchema = z.object({
  plan: planIdSchema,
  name: z.string(),
  intervals: z.array(billingIntervalSchema),
  /** The plan's price, for people; null: not published. */
  price: z
    .object({
      /** Per editor (or workspace) and month, billed monthly; null: custom. */
      amount: z.number().nullable(),
      /**
       * Per editor (or workspace) and year, billed annually (hosted: 2 months free, 10 x
       * `amount`). The server's price, never computed by clients; null: custom.
       */
      annual: z.number().nullable(),
      currency: z.string(),
      /** `editor-month` or `workspace-month`: whom `amount` is for. */
      per: z.string(),
    })
    .nullable(),
});
export type BillingOffer = z.infer<typeof BillingOfferSchema>;

export const BillingSubscriptionSchema = z.object({
  plan: z.string(),
  interval: billingIntervalSchema,
  status: subscriptionStatusSchema,
  /** Whether it grants its plan now. */
  entitled: z.boolean(),
  /** Canceled, running until `currentPeriodEnd`. */
  cancelAtPeriodEnd: z.boolean(),
  currentPeriodEnd: z.string().nullable(),
  /** Seats billed (billable editors, synced after membership changes); null: not per seat. */
  seats: z.number().int().min(0).nullable(),
  /**
   * While `past_due`: when the grace period ends (or ended), after which the default
   * plan's limits apply until the payment goes through. Null otherwise.
   */
  graceEndsAt: z.string().nullable(),
});
export type BillingSubscription = z.infer<typeof BillingSubscriptionSchema>;

/** `GET /api/workspaces/:workspaceId/billing` (owners). */
export const WorkspaceBillingSchema = z.object({
  workspaceId: z.uuid(),
  /** Whether this server sells subscriptions (false in the OSS edition). */
  enabled: z.boolean(),
  plan: z.object({ id: z.string(), name: z.string() }),
  /** The subscription that grants the plan, else the latest one; null without any. */
  subscription: BillingSubscriptionSchema.nullable(),
  /** What can be bought; empty without billing. */
  offers: z.array(BillingOfferSchema),
  /** Whether "Manage subscription" (the provider's customer portal) is available. */
  portal: z.boolean(),
  /** Billable editors now: what the seats follow. */
  editors: z.number().int().min(0),
  /**
   * Whether the subscription can be changed in the app (plan, interval, cancel, resume);
   * otherwise only in the portal.
   */
  manage: z.boolean(),
});
export type WorkspaceBilling = z.infer<typeof WorkspaceBillingSchema>;

export const createCheckoutSchema = z
  .object({ plan: planIdSchema, interval: billingIntervalSchema })
  .strict();
export type CreateCheckout = z.infer<typeof createCheckoutSchema>;

/** Where the browser goes next (the provider's checkout or customer portal). */
export const BillingRedirectSchema = z.object({ url: z.url({ protocol: /^https?$/ }) });
export type BillingRedirect = z.infer<typeof BillingRedirectSchema>;

/**
 * `PATCH /api/workspaces/:workspaceId/billing/subscription` (owners): switch the
 * subscription to another plan or interval (prorated by the provider), or cancel it at the end of
 * the period (`cancelAtPeriodEnd: true`) or take the cancellation back (`false`). The stored
 * subscription and the plan change only when the provider's signed event arrives.
 */
export const updateSubscriptionSchema = z.union([
  z.object({ plan: planIdSchema, interval: billingIntervalSchema }).strict(),
  z.object({ cancelAtPeriodEnd: z.boolean() }).strict(),
]);
export type UpdateSubscription = z.infer<typeof updateSubscriptionSchema>;
