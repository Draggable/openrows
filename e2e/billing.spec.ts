import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { IDS, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// Billing against the mocked API: an owner's Billing page (/w/:id/billing), the
// plans by interval, a checkout at Polar (a stub page here), the confirmation after coming back,
// the subscription's plan, seats, interval and renewal, Polar's portal, switching plans and
// canceling (applied when the mock's "event" arrives), and the payment-failed banners of the
// grace period and after it. Needs only the built client.

const PERIOD = { start: '2026-11-01', end: '2026-12-01' };
const CHECKOUT = 'https://sandbox.polar.sh/checkout/polar_c_test';
const PORTAL = 'https://sandbox.polar.sh/portal/polar_cst_test';
const USAGE_PAGE = `/w/${IDS.workspace}/usage`;
const BILLING_PAGE = `/w/${IDS.workspace}/billing`;

const usage = (plan: { id: string; name: string }) => ({
  workspaceId: IDS.workspace,
  plan,
  period: PERIOD,
  bases: [{ baseId: IDS.base, name: 'Product Roadmap', records: 12, limit: 1000 }],
  attachmentBytes: { used: 0, limit: 1024 ** 3 },
  automationRuns: { used: 0, limit: 250 },
  apiCalls: { used: 0, limit: 2000 },
  editors: { used: 1, limit: 5 },
  aiCredits: null,
  revisionHistoryDays: 14,
  features: {
    removeBranding: false,
    personalViews: false,
    lockedViews: false,
    editPermissions: false,
    sso: false,
    scim: false,
    auditLogExport: false,
    adminConsole: false,
    dataResidency: false,
  },
  upgradeUrl: `${BILLING_PAGE}#plans`,
});

const offers = [
  {
    plan: 'pro',
    name: 'Pro',
    intervals: ['month', 'year'],
    price: { amount: 10, annual: 100, currency: 'USD', per: 'editor-month' },
  },
  {
    plan: 'business',
    name: 'Business',
    intervals: ['month'],
    price: { amount: 24, annual: 240, currency: 'USD', per: 'editor-month' },
  },
];

interface State {
  subscribed: boolean;
  plan?: 'pro' | 'business';
  interval?: 'month' | 'year';
  canceled?: boolean;
  /** past due in the grace period, or after it. */
  pastDue?: 'grace' | 'ended';
}

const billing = (state: State) => {
  const plan = state.plan ?? 'pro';
  return {
    workspaceId: IDS.workspace,
    enabled: true,
    plan:
      state.subscribed && state.pastDue !== 'ended'
        ? { id: plan, name: plan === 'pro' ? 'Pro' : 'Business' }
        : { id: 'free', name: 'Free' },
    subscription: state.subscribed
      ? {
          plan,
          interval: state.interval ?? 'year',
          status: state.pastDue ? 'past_due' : 'active',
          entitled: state.pastDue !== 'ended',
          cancelAtPeriodEnd: state.canceled === true,
          currentPeriodEnd: '2027-11-01T10:00:00Z',
          seats: 3,
          graceEndsAt: state.pastDue ? '2026-11-15T00:00:00Z' : null,
        }
      : null,
    offers,
    portal: state.subscribed,
    editors: 3,
    manage: state.subscribed,
  };
};

async function json(page: Page, path: string, body: () => unknown, method = 'GET') {
  await page.route(`**${path}`, (route) =>
    route.request().method() === method
      ? route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(body()),
        })
      : route.fallback()
  );
}

async function owner(page: Page, state: State) {
  await mockApi(page, { rows: 1 });
  await json(page, `/api/workspaces/${IDS.workspace}`, () => ({
    id: IDS.workspace,
    name: 'Ada',
    role: 'owner',
    createdAt: '2026-10-25T10:00:00.000Z',
    updatedAt: '2026-10-25T10:00:00.000Z',
  }));
  await json(page, `/api/workspaces/${IDS.workspace}/usage`, () =>
    usage(state.subscribed ? { id: 'pro', name: 'Pro' } : { id: 'free', name: 'Free' })
  );
  await json(page, `/api/workspaces/${IDS.workspace}/billing`, () => billing(state));
  // Polar's pages, stubbed: the browser leaves the app for them.
  await page.route('https://sandbox.polar.sh/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html lang="en"><title>Polar</title><h1>Polar</h1></html>',
    })
  );
}

async function expectAxeClean(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    results.violations
      .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
      .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))
  ).toEqual([]);
}

test('an owner picks a plan and interval and goes to the Polar checkout', async ({ page }) => {
  await owner(page, { subscribed: false });
  let checkout: unknown;
  await page.route(`**/api/workspaces/${IDS.workspace}/billing/checkout`, (route) => {
    checkout = route.request().postDataJSON();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ url: CHECKOUT }),
    });
  });
  // The Usage page's owners go to the Billing page: the plan picker replaces the pricing page.
  await page.goto(USAGE_PAGE);
  await expect(page.getByRole('link', { name: 'Upgrade' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Plan and billing' }).click();
  await expect(page).toHaveURL(BILLING_PAGE);
  await expect(page.getByRole('heading', { name: 'Ada · Billing' })).toBeVisible();
  await expect(page.getByText('Free plan, no subscription.')).toBeVisible();
  const plans = page.getByRole('region', { name: 'Plans' });
  await expect(plans.getByText('$10 per editor / month')).toBeVisible();
  await expect(plans.getByText('$24 per editor / month')).toBeVisible();
  await expectAxeClean(page);

  // Annual billing: 2 months free, from the server's prices.
  await expect(plans.getByText('Annual')).toContainText('2 months free');
  await plans.getByText('Annual').click();
  await expect(plans.getByText('$100 per editor / year')).toContainText('$8.33 / month');
  await expect(plans.getByText('$120 per editor / year')).toHaveCount(0);
  // Business is sold monthly only.
  await expect(plans.getByRole('button', { name: 'Upgrade to Business' })).toHaveCount(0);
  await plans.getByRole('button', { name: 'Upgrade to Pro' }).click();
  await expect(page).toHaveURL(CHECKOUT);
  expect(checkout).toEqual({ plan: 'pro', interval: 'year' });
});

test('back from checkout, the page waits for the confirmation, then manages the subscription', async ({
  page,
}) => {
  const state = { subscribed: false };
  await owner(page, state);
  await page.route(`**/api/workspaces/${IDS.workspace}/billing/portal`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ url: PORTAL }),
    })
  );
  await page.goto(`${BILLING_PAGE}?checkout=success`);
  const subscription = page.getByRole('region', { name: 'Subscription' });
  await expect(subscription.getByRole('status')).toContainText(
    'Your plan changes as soon as the payment'
  );
  // Polar's signed event arrives: the next check sees the subscription.
  state.subscribed = true;
  await expect(subscription).toContainText('Pro, billed annually. Renews on Nov 1, 2027.', {
    timeout: 10_000,
  });
  // Plan, status, interval, seats and the next renewal.
  const details = subscription.getByRole('definition');
  await expect(details).toHaveText([
    'Pro',
    'Active',
    'Annual',
    '3 seats · 3 billable editors',
    'Renews Nov 1, 2027',
  ]);
  await expect(page.getByRole('button', { name: /Upgrade to/ })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Change plan' })).toBeVisible();
  await expectAxeClean(page);
  await subscription.getByRole('button', { name: 'Invoices and payment' }).click();
  await expect(page).toHaveURL(PORTAL);
});

test('an owner switches plans and cancels, applied when Polar confirms', async ({ page }) => {
  const state: State = { subscribed: true };
  await owner(page, state);
  const sent: unknown[] = [];
  await page.route(`**/api/workspaces/${IDS.workspace}/billing/subscription`, (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
    // Polar's event arrives a moment later.
    setTimeout(() => {
      if ('plan' in body) {
        state.plan = body['plan'] as State['plan'];
        state.interval = body['interval'] as State['interval'];
      } else state.canceled = body['cancelAtPeriodEnd'] === true;
    }, 500);
    return route.fulfill({ status: 204 });
  });
  await page.goto(BILLING_PAGE);
  const change = page.getByRole('region', { name: 'Change plan' });
  // The current interval is selected: Pro annual is the current plan.
  await expect(change.getByRole('button', { name: 'Current plan' })).toBeDisabled();
  await expect(change.getByText('$100 per editor / year')).toBeVisible();
  await change.getByText('Monthly').click();
  await change.getByRole('button', { name: 'Switch to Business' }).click();
  const confirm = page.getByRole('dialog', { name: 'Switch to Business, billed monthly?' });
  await expect(confirm).toContainText('$24 per editor / month');
  await expectAxeClean(page);
  await confirm.getByRole('button', { name: 'Switch plan' }).click();
  const subscription = page.getByRole('region', { name: 'Subscription' });
  await expect(subscription.getByRole('definition').first()).toHaveText('Business', {
    timeout: 10_000,
  });
  await expect(subscription.getByRole('status')).toHaveCount(0);
  expect(sent).toEqual([{ plan: 'business', interval: 'month' }]);

  await subscription.getByRole('button', { name: 'Cancel subscription' }).click();
  const cancel = page.getByRole('dialog', { name: 'Cancel the Business subscription?' });
  await expect(cancel).toContainText('Nothing is deleted');
  await cancel.getByRole('button', { name: 'Cancel subscription' }).click();
  await expect(subscription.getByRole('button', { name: 'Resume subscription' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(subscription).toContainText('Ends Nov 1, 2027');
  await subscription.getByRole('button', { name: 'Resume subscription' }).click();
  await expect(subscription.getByRole('button', { name: 'Cancel subscription' })).toBeVisible({
    timeout: 10_000,
  });
  expect(sent.slice(1)).toEqual([{ cancelAtPeriodEnd: true }, { cancelAtPeriodEnd: false }]);
});

test('a failed payment: the grace period banner, then Free limits after it', async ({ page }) => {
  const state: State = { subscribed: true, pastDue: 'grace' };
  await owner(page, state);
  await page.goto(`/w/${IDS.workspace}`);
  const banner = page.getByTestId('payment-banner');
  await expect(banner).toHaveAttribute('data-level', 'grace');
  await expect(banner).toContainText('The last payment failed');
  await expect(banner).toContainText(
    'Update the payment method by Nov 15, 2026 to keep the Pro plan.'
  );
  await expectAxeClean(page);
  await banner.getByRole('link', { name: 'Update payment' }).click();
  await expect(page).toHaveURL(BILLING_PAGE);
  const subscription = page.getByRole('region', { name: 'Subscription' });
  await expect(subscription.getByRole('alert')).toContainText('The last payment failed');
  await expect(subscription.getByRole('definition').nth(1)).toHaveText('Payment failed');

  // Past the grace period: Free limits, nothing deleted.
  state.pastDue = 'ended';
  await page.goto(`/w/${IDS.workspace}`);
  await expect(banner).toHaveAttribute('data-level', 'ended');
  await expect(banner).toContainText("The payment didn't go through by Nov 15, 2026");
  await expect(banner).toContainText('Free limits');
  await expect(banner).toContainText('Nothing was deleted');
  await expectAxeClean(page);
});
