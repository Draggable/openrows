import type {
  BillingInterval,
  BillingOffer,
  BillingSubscription,
  WorkspaceBilling,
} from '@openrows/shared';

/**
 * The workspace's Billing page: words for prices, subscriptions, seats and dunning.
 */

const money = (amount: number, currency: string) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
  }).format(amount);

/** The offer's price for the interval (the server's annual price, never 12 x monthly). */
const amountOf = (offer: BillingOffer, interval: BillingInterval) =>
  (interval === 'year' ? offer.price?.annual : offer.price?.amount) ?? null;

/** "$10 per editor / month", "$100 per editor / year", or null when there's no published price. */
export function priceText(offer: BillingOffer, interval: BillingInterval): string | null {
  const amount = amountOf(offer, interval);
  if (!offer.price || amount === null) return null;
  const who = offer.price.per === 'editor-month' ? 'per editor' : 'per workspace';
  return `${money(amount, offer.price.currency)} ${who} / ${interval}`;
}

/** Annual billing's discount on 12 monthly payments (0.1666… for 2 months free), else 0. */
function discountOf(offer: BillingOffer): number {
  const monthly = amountOf(offer, 'month');
  const annual = amountOf(offer, 'year');
  if (monthly === null || annual === null || monthly <= 0) return 0;
  return Math.max(0, 1 - annual / (monthly * 12));
}

/**
 * What annual billing saves against 12 monthly payments: "2 months free" when the annual price
 * is a whole number of monthly ones fewer (10 x monthly), else "Save 15%" (rounded down). Null
 * without a saving or a published price.
 */
export function savingText(offer: BillingOffer): string | null {
  const discount = discountOf(offer);
  const months = Math.round(discount * 12);
  // Within a cent a year of whole months: $9.99 x 10 doesn't divide exactly in floating point.
  if (months >= 1 && Math.abs(discount * 12 - months) * (offer.price?.amount ?? 0) < 0.01) {
    return `${months} ${months === 1 ? 'month' : 'months'} free`;
  }
  const percent = Math.floor(discount * 100);
  return percent >= 1 ? `Save ${percent}%` : null;
}

/**
 * The Annual option's note: the saving the annual offers share ("2 months free"), else the
 * largest ("Save up to 20%"). Null when annual billing saves nothing.
 */
export function annualSavingText(offers: readonly BillingOffer[]): string | null {
  const yearly = offers.filter((o) => o.intervals.includes('year'));
  const texts = new Set(yearly.map(savingText));
  if (texts.size <= 1) return [...texts][0] ?? null;
  const percent = Math.floor(Math.max(...yearly.map(discountOf)) * 100);
  return percent >= 1 ? `Save up to ${percent}%` : null;
}

/** An annual price as a month of it: "$8.33 / month", for the plan picker; null otherwise. */
export function perMonthText(offer: BillingOffer): string | null {
  const annual = amountOf(offer, 'year');
  if (!offer.price || annual === null || annual === 0) return null;
  return `${money(Math.round((annual / 12) * 100) / 100, offer.price.currency)} / month`;
}

const day = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(iso));

/** "Pro, billed monthly. Renews on Dec 1, 2026." and the like. */
export function subscriptionText(sub: BillingSubscription, planName: string): string {
  const billed = sub.interval === 'year' ? 'billed annually' : 'billed monthly';
  if (!sub.entitled) {
    return sub.status === 'canceled' || sub.status === 'incomplete_expired'
      ? `Your ${planName} subscription has ended.`
      : `Your ${planName} subscription is ${sub.status.replace('_', ' ')}: update the payment in "Invoices and payment".`;
  }
  const end = sub.currentPeriodEnd ? day(sub.currentPeriodEnd) : null;
  if (sub.cancelAtPeriodEnd) {
    return end ? `${planName}, ${billed}. Canceled: ends on ${end}.` : `${planName}, canceled.`;
  }
  if (sub.status === 'past_due') {
    const by = sub.graceEndsAt ? ` by ${day(sub.graceEndsAt)}` : '';
    return `${planName}, ${billed}. The last payment failed: update the payment method${by} to keep the plan.`;
  }
  return end ? `${planName}, ${billed}. Renews on ${end}.` : `${planName}, ${billed}.`;
}

/** Same-app links (the plan picker) open in place; others (a pricing page) in a new tab. */
export const isAppPath = (url: string) => url.startsWith('/') && !url.startsWith('//');

/** "Monthly" or "Annual". */
export const intervalName = (interval: BillingInterval) =>
  interval === 'year' ? 'Annual' : 'Monthly';

/** The renewal (or end) of the period: "Renews Dec 1, 2026", "Ends Dec 1, 2026", or null. */
export function renewalText(sub: BillingSubscription): string | null {
  if (!sub.currentPeriodEnd || !sub.entitled) return null;
  return `${sub.cancelAtPeriodEnd ? 'Ends' : 'Renews'} ${day(sub.currentPeriodEnd)}`;
}

/**
 * Seats: "3 seats", with a note while the billed seats haven't caught up with the
 * billable editors (the sync runs a minute after a membership change). Null: not per seat.
 */
export function seatsText(sub: BillingSubscription, editors: number): string | null {
  if (sub.seats === null) return null;
  const seats = `${sub.seats} ${sub.seats === 1 ? 'seat' : 'seats'}`;
  const target = Math.max(1, editors);
  if (!sub.entitled || sub.seats === target) return seats;
  return `${seats} (updating to ${target})`;
}

/**
 * The payment-failed alert for the workspace's owners: in the grace period (the plan
 * stays until `graceEndsAt`), or after it (the default plan's limits apply). Null otherwise.
 */
export function paymentAlert(
  billing: Pick<WorkspaceBilling, 'subscription' | 'offers'> | undefined
): { level: 'grace' | 'ended'; title: string; text: string } | null {
  const sub = billing?.subscription;
  if (!billing || sub?.status !== 'past_due' || !sub.graceEndsAt) return null;
  const plan = billing.offers.find((o) => o.plan === sub.plan)?.name ?? sub.plan;
  const until = day(sub.graceEndsAt);
  if (sub.entitled) {
    return {
      level: 'grace',
      title: 'The last payment failed',
      text: `Update the payment method by ${until} to keep the ${plan} plan.`,
    };
  }
  return {
    level: 'ended',
    title: `The payment didn't go through by ${until}`,
    text: `The workspace has Free limits until it's paid. Nothing was deleted: everything can still be read and edited.`,
  };
}
