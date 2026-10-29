import type { BillingOffer, BillingSubscription } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import {
  annualSavingText,
  isAppPath,
  paymentAlert,
  perMonthText,
  priceText,
  renewalText,
  savingText,
  seatsText,
  subscriptionText,
} from './billing-model';

const pro: BillingOffer = {
  plan: 'pro',
  name: 'Pro',
  intervals: ['month', 'year'],
  price: { amount: 10, annual: 100, currency: 'USD', per: 'editor-month' },
};
const business: BillingOffer = {
  plan: 'business',
  name: 'Business',
  intervals: ['month', 'year'],
  price: { amount: 24, annual: 240, currency: 'USD', per: 'editor-month' },
};
const priced = (amount: number | null, annual: number | null): BillingOffer => ({
  ...pro,
  price: { amount, annual, currency: 'USD', per: 'editor-month' },
});
const sub = (over: Partial<BillingSubscription> = {}): BillingSubscription => ({
  plan: 'pro',
  interval: 'month',
  status: 'active',
  entitled: true,
  cancelAtPeriodEnd: false,
  currentPeriodEnd: '2026-12-01T10:00:00Z',
  seats: 3,
  graceEndsAt: null,
  ...over,
});

describe('billing words', () => {
  it('prices per editor and interval', () => {
    expect(priceText(pro, 'month')).toBe('$10 per editor / month');
    // The server's annual price (2 months free), not 12 x monthly.
    expect(priceText(pro, 'year')).toBe('$100 per editor / year');
    expect(priceText(business, 'month')).toBe('$24 per editor / month');
    expect(priceText(business, 'year')).toBe('$240 per editor / year');
    expect(priceText(priced(9.99, 99.9), 'year')).toBe('$99.90 per editor / year');
    expect(
      priceText(
        { ...pro, price: { ...priced(50, 500).price, per: 'workspace-month' } } as BillingOffer,
        'year'
      )
    ).toBe('$500 per workspace / year');
    expect(priceText({ ...pro, price: null }, 'month')).toBeNull();
    expect(priceText(priced(null, null), 'month')).toBeNull();
    expect(priceText(priced(null, null), 'year')).toBeNull();
  });

  it("annual billing's saving, from the prices", () => {
    expect(savingText(pro)).toBe('2 months free');
    expect(savingText(business)).toBe('2 months free');
    expect(savingText(priced(10, 110))).toBe('1 month free');
    expect(savingText(priced(9.99, 99.9))).toBe('2 months free');
    expect(savingText(priced(10, 102))).toBe('Save 15%');
    expect(savingText(priced(10, 120))).toBeNull();
    expect(savingText(priced(0, 0))).toBeNull();
    expect(savingText(priced(null, null))).toBeNull();
    expect(savingText({ ...pro, price: null })).toBeNull();
  });

  it("the Annual option's note: the shared saving, else the largest", () => {
    expect(annualSavingText([pro, business])).toBe('2 months free');
    expect(annualSavingText([pro, priced(10, 120)])).toBe('Save up to 16%');
    expect(annualSavingText([priced(10, 120)])).toBeNull();
    // Offers sold monthly only don't count.
    expect(annualSavingText([priced(10, 120), { ...business, intervals: ['month'] }])).toBeNull();
    expect(annualSavingText([])).toBeNull();
  });

  it('an annual price a month', () => {
    expect(perMonthText(pro)).toBe('$8.33 / month');
    expect(perMonthText(business)).toBe('$20 / month');
    expect(perMonthText(priced(0, 0))).toBeNull();
    expect(perMonthText(priced(null, null))).toBeNull();
  });

  it('subscriptions', () => {
    expect(subscriptionText(sub(), 'Pro')).toBe('Pro, billed monthly. Renews on Dec 1, 2026.');
    expect(subscriptionText(sub({ interval: 'year', cancelAtPeriodEnd: true }), 'Pro')).toBe(
      'Pro, billed annually. Canceled: ends on Dec 1, 2026.'
    );
    expect(subscriptionText(sub({ status: 'past_due' }), 'Pro')).toMatch(/payment failed/);
    expect(
      subscriptionText(sub({ status: 'past_due', graceEndsAt: '2026-11-15T00:00:00Z' }), 'Pro')
    ).toMatch(/by Nov 15, 2026 to keep the plan/);
    expect(subscriptionText(sub({ status: 'canceled', entitled: false }), 'Pro')).toBe(
      'Your Pro subscription has ended.'
    );
  });

  it('tells app paths from other links', () => {
    expect(isAppPath('/w/1/usage#plans')).toBe(true);
    expect(isAppPath('//evil.example')).toBe(false);
    expect(isAppPath('https://openrows.io/pricing')).toBe(false);
  });

  it('renewals and seats (#132)', () => {
    expect(renewalText(sub())).toBe('Renews Dec 1, 2026');
    expect(renewalText(sub({ cancelAtPeriodEnd: true }))).toBe('Ends Dec 1, 2026');
    expect(renewalText(sub({ entitled: false, status: 'canceled' }))).toBeNull();
    expect(seatsText(sub(), 3)).toBe('3 seats');
    expect(seatsText(sub({ seats: 1 }), 0)).toBe('1 seat');
    expect(seatsText(sub(), 4)).toBe('3 seats (updating to 4)');
    expect(seatsText(sub({ seats: null }), 4)).toBeNull();
  });

  it('payment alerts in and after the grace period (#132)', () => {
    const billing = (over: Partial<BillingSubscription>) => ({
      subscription: sub(over),
      offers: [pro],
    });
    expect(paymentAlert(billing({}))).toBeNull();
    expect(paymentAlert(undefined)).toBeNull();
    expect(
      paymentAlert(billing({ status: 'past_due', graceEndsAt: '2026-11-15T00:00:00Z' }))
    ).toEqual({
      level: 'grace',
      title: 'The last payment failed',
      text: 'Update the payment method by Nov 15, 2026 to keep the Pro plan.',
    });
    expect(
      paymentAlert(
        billing({ status: 'past_due', entitled: false, graceEndsAt: '2026-11-15T00:00:00Z' })
      )
    ).toMatchObject({
      level: 'ended',
      text: expect.stringMatching(/Free limits.*Nothing was deleted/),
    });
  });
});
