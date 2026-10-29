import type {
  BillingInterval,
  BillingOffer,
  UpdateSubscription,
  WorkspaceBilling,
} from '@openrows/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CreditCardIcon } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { ApiError, api } from '../../api/client';
import { queryKeys } from '../../api/keys';
import { useWorkspaceBilling } from '../../api/queries';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Skeleton,
  toast,
} from '../../components/ui';
import { cn } from '../../lib/utils';
import {
  annualSavingText,
  intervalName,
  paymentAlert,
  perMonthText,
  priceText,
  renewalText,
  savingText,
  seatsText,
  subscriptionText,
} from './billing-model';

const section = 'rounded-lg border border-border bg-surface p-5 shadow-1';
/** How long the page checks for a checkout's or a change's confirmation. */
const CONFIRM_WAIT_MS = 60_000;

/** Where the browser goes for the provider's checkout or portal (the page is left). */
function go(url: string) {
  window.location.assign(url);
}

/** A fingerprint of what a change can alter, to notice when the provider's event arrived. */
const stateOf = (b: WorkspaceBilling | undefined) =>
  JSON.stringify(
    b?.subscription && [
      b.subscription.plan,
      b.subscription.interval,
      b.subscription.cancelAtPeriodEnd,
    ]
  );

/**
 * The workspace's Billing page, for its owners when the server sells plans: the
 * subscription (plan, status, interval, seats, next renewal) with the provider's portal
 * (invoices, payment method) and Cancel or Resume; the plans to switch to (prorated) or, without
 * a subscription, to buy through a checkout. Changes apply when the provider's signed event
 * arrives: the page checks again every few seconds until it has.
 */
export function BillingPanels({
  workspaceId,
  confirming,
}: {
  workspaceId: string;
  /** Back from a checkout (`?checkout=success`): the payment's confirmation is on its way. */
  confirming: boolean;
}) {
  const qc = useQueryClient();
  const [since] = useState(() => Date.now());
  // A change sent to the provider: the state before it and when it was sent.
  const [pending, setPending] = useState<{ before: string; at: number } | null>(null);
  const waitingCheckout = () => confirming && Date.now() - since < CONFIRM_WAIT_MS;
  const billing = useWorkspaceBilling(workspaceId, (entitled) =>
    pending ? Date.now() - pending.at < CONFIRM_WAIT_MS : !entitled && waitingCheckout()
  );
  const b = billing.data;
  const subscribed = !!b?.subscription?.entitled;
  useEffect(() => {
    // Confirmed: the plan's limits and features are new too.
    if (confirming && subscribed) {
      void qc.invalidateQueries({ queryKey: queryKeys.workspaces.usage(workspaceId) });
    }
  }, [confirming, subscribed, qc, workspaceId]);
  const current = stateOf(b);
  useEffect(() => {
    if (pending && current !== pending.before) {
      setPending(null);
      void qc.invalidateQueries({ queryKey: queryKeys.workspaces.usage(workspaceId) });
    }
  }, [pending, current, qc, workspaceId]);

  const failed = (err: unknown, what: string) =>
    toast.error(err instanceof ApiError ? err.message : `Couldn't ${what}`);
  const portal = useMutation({
    mutationFn: () => api.workspaces.portal({ params: { workspaceId } }),
    onSuccess: ({ url }) => go(url),
    onError: (err) => failed(err, 'open the billing portal'),
  });
  const change = useMutation({
    mutationFn: (body: UpdateSubscription) =>
      api.workspaces.updateSubscription({ params: { workspaceId }, body }),
    onSuccess: () => {
      setPending({ before: current, at: Date.now() });
      toast.success('Change requested. It shows here once Polar confirms it.');
    },
    onError: (err) => failed(err, 'change the subscription'),
  });

  if (billing.isError) {
    return (
      <p role="alert" className="text-text-2">
        Couldn't load this workspace's billing.
      </p>
    );
  }
  if (!b) return <Skeleton className="h-40" />;
  if (!b.enabled) {
    return (
      <section aria-labelledby="billing-off" className={section}>
        <h2 id="billing-off" className="text-heading font-semibold">
          {b.plan.name} plan
        </h2>
        <p className="mt-1 text-text-2">This server doesn't sell subscriptions.</p>
      </section>
    );
  }

  const sub = b.subscription;
  const planName = (id: string) => b.offers.find((o) => o.plan === id)?.name ?? id;
  const alert = paymentAlert(b);
  const seats = sub ? seatsText(sub, b.editors) : null;
  const renewal = sub ? renewalText(sub) : null;

  return (
    <>
      <section aria-labelledby="billing-heading" className={section}>
        <div className="flex items-start justify-between gap-3">
          <h2 id="billing-heading" className="text-heading font-semibold">
            Subscription
          </h2>
          {b.portal && (
            <Button
              size="sm"
              variant="secondary"
              disabled={portal.isPending}
              onClick={() => portal.mutate()}
            >
              <CreditCardIcon aria-hidden />
              Invoices and payment
            </Button>
          )}
        </div>
        {alert && (
          <div
            role="alert"
            data-level={alert.level}
            className={cn(
              'mt-3 rounded-sm border border-border border-t-2 bg-header px-3 py-2',
              alert.level === 'ended' ? 'border-t-danger' : 'border-t-warning'
            )}
          >
            <p className="font-[550]">{alert.title}</p>
            <p className="text-text-2">{alert.text}</p>
          </div>
        )}
        {confirming && !subscribed && (
          <p role="status" className="mt-2 text-text-2">
            {waitingCheckout()
              ? 'Thanks! Your plan changes as soon as the payment is confirmed. This usually takes a few seconds.'
              : "The payment isn't confirmed yet. Reload the page in a minute; you won't be charged twice."}
          </p>
        )}
        {pending && (
          <p role="status" className="mt-2 text-text-2">
            Change requested. It shows here once Polar confirms it.
          </p>
        )}
        {sub ? (
          <>
            <dl className="mt-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-1.5">
              <Row label="Plan">{planName(sub.plan)}</Row>
              <Row label="Status">{statusName(sub)}</Row>
              <Row label="Billing">{intervalName(sub.interval)}</Row>
              {seats && (
                <Row label="Seats">
                  {seats}
                  <span className="text-text-2">
                    {' '}
                    · {b.editors} billable {b.editors === 1 ? 'editor' : 'editors'}
                  </span>
                </Row>
              )}
              {renewal && <Row label="Next renewal">{renewal}</Row>}
            </dl>
            <p className="mt-2 text-small text-text-2">
              {!alert && subscriptionText(sub, planName(sub.plan))}
              {seats &&
                ' Seats follow the members with editor, creator or owner access; changes are prorated.'}
            </p>
            {b.manage && sub.entitled && (
              <div className="mt-3 flex flex-wrap gap-2">
                {sub.cancelAtPeriodEnd ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={change.isPending || !!pending}
                    onClick={() => change.mutate({ cancelAtPeriodEnd: false })}
                  >
                    Resume subscription
                  </Button>
                ) : (
                  <CancelSubscription
                    planName={planName(sub.plan)}
                    endsOn={renewal}
                    disabled={change.isPending || !!pending}
                    onConfirm={() => change.mutate({ cancelAtPeriodEnd: true })}
                  />
                )}
              </div>
            )}
          </>
        ) : (
          <p className="mt-1 text-text-2">
            {b.plan.name} plan, no subscription. Pick a plan below to upgrade.
          </p>
        )}
      </section>

      <Plans
        billing={b}
        disabled={change.isPending || !!pending}
        onSwitch={(plan, interval) => change.mutate({ plan, interval })}
        workspaceId={workspaceId}
      />
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-text-2">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function statusName(sub: NonNullable<WorkspaceBilling['subscription']>): string {
  if (sub.status === 'past_due')
    return sub.entitled ? 'Payment failed' : 'Payment failed: Free limits';
  if (!sub.entitled) return sub.status === 'canceled' ? 'Ended' : 'Inactive';
  if (sub.cancelAtPeriodEnd) return 'Canceled at the end of the period';
  return sub.status === 'trialing' ? 'Trial' : 'Active';
}

function CancelSubscription({
  planName,
  endsOn,
  disabled,
  onConfirm,
}: {
  planName: string;
  endsOn: string | null;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setOpen(true)}>
        Cancel subscription
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel the {planName} subscription?</DialogTitle>
            <DialogDescription>
              The workspace keeps {planName} until the end of the period
              {endsOn ? ` (${endsOn.replace('Renews', 'on')})` : ''}, then moves to Free limits.
              Nothing is deleted, and you can resume before then.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Keep subscription
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              Cancel subscription
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The plans by interval: with a subscription that can be changed, "Switch to …" (confirmed,
 * prorated by the provider); without one, "Upgrade to …" through a checkout.
 */
function Plans({
  billing: b,
  disabled,
  onSwitch,
  workspaceId,
}: {
  billing: WorkspaceBilling;
  disabled: boolean;
  onSwitch: (plan: string, interval: BillingInterval) => void;
  workspaceId: string;
}) {
  // A past-due subscription is changed or paid, never bought a second time.
  const sub =
    b.subscription?.entitled || b.subscription?.status === 'past_due' ? b.subscription : null;
  const [interval, setBillingInterval] = useState<BillingInterval>(sub?.interval ?? 'month');
  const [confirm, setConfirm] = useState<BillingOffer | null>(null);
  const checkout = useMutation({
    mutationFn: (plan: string) =>
      api.workspaces.checkout({ params: { workspaceId }, body: { plan, interval } }),
    onSuccess: ({ url }) => go(url),
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Couldn't open the checkout"),
  });
  // A subscription that can't be changed here (another provider): only its portal.
  if (sub && !b.manage) {
    return (
      <p className="text-small text-text-2">
        Change plan, switch to annual billing or cancel in "Invoices and payment".
      </p>
    );
  }
  const offers = b.offers.filter((o) => o.intervals.includes(interval));
  // Annual billing's saving, from the server's prices ("2 months free", "Save up to 20%").
  const annualSaving = annualSavingText(b.offers);
  /** Under an annual price: what it is a month, and its saving unless the toggle says it. */
  const annualNote = (offer: BillingOffer) => {
    const saving = savingText(offer);
    return [perMonthText(offer), saving === annualSaving ? null : saving]
      .filter(Boolean)
      .join(', ');
  };
  /** "$100 per editor / year, 2 months free" in the switch's confirmation. */
  const confirmPrice = (offer: BillingOffer) => {
    const saving = interval === 'year' ? savingText(offer) : null;
    return [priceText(offer, interval), saving].filter(Boolean).join(', ');
  };
  return (
    <section id="plans" aria-labelledby="plans-heading" className={section}>
      <h2 id="plans-heading" className="text-heading font-semibold">
        {sub ? 'Change plan' : 'Plans'}
      </h2>
      <fieldset className="mt-3 flex gap-1" aria-label="Billing interval">
        {(['month', 'year'] as const).map((value) => (
          <label
            key={value}
            className={cn(
              'cursor-pointer rounded-sm border border-border px-2.5 py-1 text-small has-focus-visible:outline-2 has-focus-visible:outline-brand',
              interval === value
                ? 'border-primary bg-selected font-[550] text-primary'
                : 'text-text-2 hover:bg-hover'
            )}
          >
            <input
              type="radio"
              name="billing-interval"
              value={value}
              checked={interval === value}
              onChange={() => setBillingInterval(value)}
              className="sr-only"
            />
            {intervalName(value)}
            {value === 'year' && annualSaving && (
              <span className="ml-1.5 font-normal text-text-2">{annualSaving}</span>
            )}
          </label>
        ))}
      </fieldset>
      <ul className="mt-3 divide-y divide-border">
        {offers.map((offer) => {
          const isCurrent = sub
            ? offer.plan === sub.plan && interval === sub.interval
            : offer.plan === b.plan.id;
          const price = priceText(offer, interval);
          const note = price && interval === 'year' ? annualNote(offer) : '';
          return (
            <li key={offer.plan} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <div className="font-[550]">{offer.name}</div>
                <div className="text-small text-text-2">
                  {price ?? 'Price shown at checkout'}
                  {note && ` · ${note}`}
                </div>
              </div>
              <Button
                size="sm"
                variant={sub ? 'secondary' : 'default'}
                disabled={isCurrent || disabled || checkout.isPending}
                onClick={() => (sub ? setConfirm(offer) : checkout.mutate(offer.plan))}
              >
                {isCurrent
                  ? 'Current plan'
                  : sub
                    ? `Switch to ${offer.name}`
                    : `Upgrade to ${offer.name}`}
              </Button>
            </li>
          );
        })}
        {offers.length === 0 && (
          <li className="py-2 text-text-2">No plan is sold with this billing interval.</li>
        )}
      </ul>
      <p className="mt-2 text-small text-text-2">
        {sub
          ? 'Plan and interval changes are prorated: the difference is on the next invoice.'
          : 'Payment, taxes and invoices are handled by Polar, our merchant of record. Your plan changes once the payment is confirmed.'}
      </p>
      <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Switch to {confirm?.name}, billed {interval === 'year' ? 'annually' : 'monthly'}?
            </DialogTitle>
            <DialogDescription>
              {confirm && priceText(confirm, interval) ? `${confirmPrice(confirm)}. ` : ''}
              Polar prorates the change: the difference is on the next invoice.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              Keep current plan
            </Button>
            <Button
              onClick={() => {
                if (confirm) onSwitch(confirm.plan, interval);
                setConfirm(null);
              }}
            >
              Switch plan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
