import { createHmac } from 'node:crypto';
import type { BillingRedirect, WorkspaceBilling, WorkspaceUsage } from '@openrows/shared';
import { sql } from 'drizzle-orm';
import type { JobInsert } from 'pg-boss';
import { uuidv7 } from 'uuidv7';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { checkDunning, runDunning } from '../../src/billing/dunning.js';
import { SEAT_SYNC_DELAY_SECONDS, seatSubscriber, syncSeats } from '../../src/billing/seats.js';
import {
  BillingUnavailableError,
  BillingWebhookError,
  CountingUsageMeter,
  readWorkspacePlan,
  resolveEdition,
  setWorkspacePlan,
} from '../../src/edition/index.js';
import type {
  BillingEvent,
  BillingProvider,
  CheckoutInput,
  Edition,
  SubscriptionChange,
  SubscriptionStatus,
} from '../../src/edition/types.js';
import type { EmailMessage } from '../../src/email/transport.js';
import type { RelayJobData } from '../../src/jobs/relay.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, createSession, createWorkspace } from '../helpers/factories.js';
import { relayAll } from '../helpers/outbox.js';
import { entitlementsOf } from '../helpers/plans.js';

/**
 * Billing: checkout for owners, and the provider's signed webhooks turned into the
 * workspace's plan in one transaction, end to end against real Postgres. The provider here is a
 * Polar-shaped fake that signs and verifies with Standard Webhooks (HMAC-SHA256 over
 * `id.timestamp.body`, a 5-minute window), as the hosted edition's Polar provider does with
 * the SDK (whose own tests cover Polar's payloads and signatures).
 */
const SECRET = 'whsec_test_billing_secret';
const PRODUCTS: Record<string, { plan: string; interval: 'month' | 'year' }> = {
  'prod-pro-month': { plan: 'pro', interval: 'month' },
  'prod-pro-year': { plan: 'pro', interval: 'year' },
  'prod-business-month': { plan: 'business', interval: 'month' },
};
const RANK: Record<string, number> = { pro: 1, business: 2 };
const ENTITLED = new Set<SubscriptionStatus>(['active', 'trialing', 'past_due']);

function sign(id: string, timestamp: number, body: string, secret = SECRET) {
  const mac = createHmac('sha256', secret).update(`${id}.${timestamp}.${body}`).digest('base64');
  return {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': `v1,${mac}`,
  };
}

function fakeProvider() {
  const checkouts: CheckoutInput[] = [];
  const seatCalls: { subscriptionId: string; seats: number }[] = [];
  const changes: { subscriptionId: string; change: SubscriptionChange }[] = [];
  const state: { down: boolean; detail?: string } = { down: false };
  const provider: BillingProvider = {
    id: 'fake',
    enabled: true,
    upgradeUrl: async (workspaceId) => `http://localhost:5173/w/${workspaceId}/usage`,
    offers: () => [
      { plan: 'pro', name: 'Pro', intervals: ['month', 'year'], price: null },
      { plan: 'business', name: 'Business', intervals: ['month'], price: null },
    ],
    async checkout(input) {
      if (state.down) throw new BillingUnavailableError('down');
      checkouts.push(input);
      return { url: `https://checkout.example.test/${checkouts.length}` };
    },
    async portal(input) {
      if (state.down) throw new BillingUnavailableError('down', state.detail);
      return { url: `https://portal.example.test/${input.customerId}` };
    },
    async updateSeats(input) {
      if (state.down) throw new BillingUnavailableError('down');
      seatCalls.push(input);
    },
    async updateSubscription(input) {
      if (state.down) throw new BillingUnavailableError('down');
      changes.push(input);
    },
    webhooks: {
      provider: 'fake',
      async verify(body, headers) {
        const text = new TextDecoder().decode(body);
        const id = headers['webhook-id'] ?? '';
        const ts = Number(headers['webhook-timestamp']);
        if (!id || !Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
          throw new BillingWebhookError('stale or missing');
        }
        const expected = sign(id, ts, text)['webhook-signature'];
        if (headers['webhook-signature'] !== expected) throw new BillingWebhookError('bad');
        const payload = JSON.parse(text) as { type: string; data: Record<string, unknown> };
        const event: BillingEvent = { id, type: payload.type, subscription: null };
        if (!payload.type.startsWith('subscription.')) return event;
        const d = payload.data as {
          id: string;
          customer_id: string;
          product_id: string;
          status: SubscriptionStatus;
          cancel_at_period_end?: boolean;
          current_period_end?: string | null;
          modified_at: string;
          seats?: number | null;
          metadata?: { workspace_id?: string };
        };
        const product = PRODUCTS[d.product_id];
        if (!product) return event;
        event.subscription = {
          id: d.id,
          customerId: d.customer_id,
          workspaceId: d.metadata?.workspace_id ?? null,
          plan: product.plan,
          interval: product.interval,
          status: d.status,
          entitled: ENTITLED.has(d.status),
          cancelAtPeriodEnd: d.cancel_at_period_end === true,
          currentPeriodEnd: d.current_period_end ?? null,
          changedAt: d.modified_at,
          ...(d.seats !== undefined ? { seats: d.seats } : {}),
        };
        return event;
      },
      planFor(subscriptions) {
        const plans = subscriptions.filter((s) => s.entitled).map((s) => s.plan);
        plans.sort((a, b) => (RANK[b] ?? 0) - (RANK[a] ?? 0));
        return plans[0] ?? null;
      },
    },
  };
  return { provider, checkouts, seatCalls, changes, state };
}

describe('billing', () => {
  const t = useTestDb();
  const fake = fakeProvider();
  let app: ReturnType<typeof testApp>;
  let oss: ReturnType<typeof testApp>;
  let edition: Edition;

  beforeAll(() => {
    // The stored plan decides the entitlements, as the hosted catalog does: free by default.
    edition = resolveEdition('cloud', {
      entitlements: {
        id: 'stored-plan',
        async forWorkspace(workspaceId, tx) {
          const stored = await readWorkspacePlan(tx, workspaceId);
          const plan = stored?.plan ?? 'free';
          return entitlementsOf({ features: { personalViews: plan !== 'free' } }, plan);
        },
      },
      billing: fake.provider,
      usage: new CountingUsageMeter(),
    });
    app = testApp({ db: t.appDb, edition });
    oss = testApp({ db: t.appDb });
  });
  beforeEach(() => {
    fake.state.down = false;
    fake.checkouts.length = 0;
    fake.seatCalls.length = 0;
    fake.changes.length = 0;
  });

  const request = (
    target: ReturnType<typeof testApp>,
    method: string,
    path: string,
    opts: { cookie?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {}
  ) => {
    const headers: Record<string, string> = { origin: target.config.appUrl, ...opts.headers };
    if (opts.cookie) headers['cookie'] = `${SESSION_COOKIE}=${opts.cookie}`;
    const body = opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
    if (body !== undefined) headers['content-type'] = 'application/json';
    return Promise.resolve(target.app.request(path, { method, headers, body }));
  };
  async function ok<T>(res: Promise<Response>, status = 200): Promise<T> {
    const r = await res;
    if (r.status !== status) throw new Error(`${r.status}: ${await r.text()}`);
    return (await r.json()) as T;
  }

  let seq = 0;
  /** A Polar-shaped subscription event, signed now (or at `at`, seconds). */
  function delivery(
    type: string,
    data: Record<string, unknown>,
    opts: { id?: string; at?: number; secret?: string } = {}
  ) {
    const id = opts.id ?? `evt_${++seq}_${uuidv7()}`;
    const raw = JSON.stringify({ type, timestamp: new Date().toISOString(), data });
    const headers = sign(id, opts.at ?? Math.floor(Date.now() / 1000), raw, opts.secret);
    return { id, raw, headers };
  }
  const post = (d: { raw: string; headers: Record<string, string> }, provider = 'fake') =>
    request(app, 'POST', `/api/billing/${provider}/webhooks`, { raw: d.raw, headers: d.headers });

  const subscription = (workspaceId: string | null, over: Record<string, unknown> = {}) => ({
    id: 'sub_1',
    customer_id: 'cus_1',
    product_id: 'prod-pro-month',
    status: 'active',
    cancel_at_period_end: false,
    current_period_end: '2026-12-01T00:00:00Z',
    modified_at: '2026-11-01T10:00:00.000001Z',
    ...(workspaceId ? { metadata: { workspace_id: workspaceId } } : {}),
    ...over,
  });

  async function storedPlan(workspaceId: string) {
    const { rows } = await t.db.execute<{ plan: string | null; plan_overrides: unknown }>(
      sql`SELECT plan, plan_overrides FROM workspaces WHERE id = ${workspaceId}::uuid`
    );
    return rows[0];
  }
  async function eventCount() {
    const { rows } = await t.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM billing_events`
    );
    return rows[0]?.n ?? 0;
  }
  async function tenant() {
    const { owner, workspace } = await createWorkspace(t.db);
    return { workspace, owner, cookie: await createSession(t.db, owner) };
  }

  it('has nothing to sell in the OSS edition', async () => {
    const { workspace, cookie } = await tenant();
    const billing = await ok<WorkspaceBilling>(
      request(oss, 'GET', `/api/workspaces/${workspace.id}/billing`, { cookie })
    );
    expect(billing).toMatchObject({
      enabled: false,
      offers: [],
      subscription: null,
      portal: false,
    });
    const checkout = await request(
      oss,
      'POST',
      `/api/workspaces/${workspace.id}/billing/checkout`,
      {
        cookie,
        body: { plan: 'pro', interval: 'month' },
      }
    );
    expect(checkout.status).toBe(404);
    const hook = delivery('subscription.created', subscription(workspace.id));
    const res = await request(oss, 'POST', '/api/billing/fake/webhooks', {
      raw: hook.raw,
      headers: hook.headers,
    });
    expect(res.status).toBe(404);
  });

  it('starts a checkout for owners only, with the workspace id and the return URLs', async () => {
    const { workspace, cookie } = await tenant();
    const creator = await addMember(t.db, workspace.id, 'creator');
    const redirect = await ok<BillingRedirect>(
      request(app, 'POST', `/api/workspaces/${workspace.id}/billing/checkout`, {
        cookie,
        body: { plan: 'pro', interval: 'year' },
      })
    );
    expect(redirect.url).toBe('https://checkout.example.test/1');
    expect(fake.checkouts[0]).toMatchObject({
      workspaceId: workspace.id,
      plan: 'pro',
      interval: 'year',
      // the seats start at the billable editors (the owner and the creator).
      seats: 2,
      successUrl: `${app.config.appUrl}/w/${workspace.id}/billing?checkout=success`,
      returnUrl: `${app.config.appUrl}/w/${workspace.id}/billing`,
    });
    // Nothing changes until the provider's event: the redirect grants nothing.
    expect((await storedPlan(workspace.id))?.plan).toBeNull();

    const creatorCookie = await createSession(t.db, creator);
    const refused = await request(app, 'POST', `/api/workspaces/${workspace.id}/billing/checkout`, {
      cookie: creatorCookie,
      body: { plan: 'pro', interval: 'month' },
    });
    expect(refused.status).toBe(403);
    expect(
      (
        await request(app, 'GET', `/api/workspaces/${workspace.id}/billing`, {
          cookie: creatorCookie,
        })
      ).status
    ).toBe(403);

    for (const body of [
      { plan: 'business', interval: 'year' },
      { plan: 'enterprise', interval: 'month' },
      { plan: 'pro', interval: 'week' },
      { plan: 'pro', interval: 'month', extra: 1 },
    ]) {
      const bad = await request(app, 'POST', `/api/workspaces/${workspace.id}/billing/checkout`, {
        cookie,
        body,
      });
      expect(bad.status, JSON.stringify(body)).toBe(422);
    }

    fake.state.down = true;
    const down = await request(app, 'POST', `/api/workspaces/${workspace.id}/billing/checkout`, {
      cookie,
      body: { plan: 'pro', interval: 'month' },
    });
    expect(down.status).toBe(503);
  });

  it('upgrades on a signed subscription event and downgrades when it is revoked', async () => {
    const { workspace, cookie } = await tenant();
    await setWorkspacePlan(t.db, workspace.id, {
      plan: null,
      overrides: { limits: { recordsPerBase: 7 } },
    });
    const usage = () =>
      ok<WorkspaceUsage>(request(app, 'GET', `/api/workspaces/${workspace.id}/usage`, { cookie }));
    expect((await usage()).plan.id).toBe('free');

    const sub = { id: `sub_${uuidv7()}`, customer_id: `cus_${uuidv7()}` };
    const created = delivery('subscription.created', subscription(workspace.id, sub));
    const res = await post(created);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ received: true, duplicate: false });
    expect(await storedPlan(workspace.id)).toEqual({
      plan: 'pro',
      plan_overrides: { limits: { recordsPerBase: 7 } },
    });
    expect((await usage()).plan.id).toBe('pro');
    expect((await usage()).features.personalViews).toBe(true);

    const billing = await ok<WorkspaceBilling>(
      request(app, 'GET', `/api/workspaces/${workspace.id}/billing`, { cookie })
    );
    expect(billing).toMatchObject({
      enabled: true,
      plan: { id: 'pro' },
      portal: true,
      subscription: { plan: 'pro', interval: 'month', status: 'active', entitled: true },
    });
    expect(billing.offers.map((o) => o.plan)).toEqual(['pro', 'business']);

    // With a subscription, plan changes and cancellation go through the provider's portal.
    const again = await request(app, 'POST', `/api/workspaces/${workspace.id}/billing/checkout`, {
      cookie,
      body: { plan: 'business', interval: 'month' },
    });
    expect(again.status).toBe(409);
    const portal = await ok<BillingRedirect>(
      request(app, 'POST', `/api/workspaces/${workspace.id}/billing/portal`, { cookie })
    );
    expect(portal.url).toBe(`https://portal.example.test/${sub.customer_id}`);

    // The provider's refusal: its detail goes to the server's log only, never to the client.
    fake.state.down = true;
    fake.state.detail = 'body.member_id: member_id is required for team customers.';
    const refusedPortal = await request(
      app,
      'POST',
      `/api/workspaces/${workspace.id}/billing/portal`,
      {
        cookie,
      }
    );
    expect(refusedPortal.status).toBe(503);
    expect(await refusedPortal.text()).not.toContain('member_id');
    expect(app.logs).toContainEqual(
      expect.objectContaining({
        msg: 'billing: portal failed',
        err: 'down',
        detail: fake.state.detail,
      })
    );
    fake.state.down = false;
    fake.state.detail = undefined;

    // Changed to Business in the portal.
    await ok(
      post(
        delivery(
          'subscription.updated',
          subscription(workspace.id, {
            ...sub,
            product_id: 'prod-business-month',
            modified_at: '2026-11-02T10:00:00Z',
          })
        )
      ),
      202
    );
    expect((await storedPlan(workspace.id))?.plan).toBe('business');

    // Canceled at the period's end: still Business until then.
    await ok(
      post(
        delivery(
          'subscription.canceled',
          subscription(workspace.id, {
            ...sub,
            product_id: 'prod-business-month',
            cancel_at_period_end: true,
            modified_at: '2026-11-03T10:00:00Z',
          })
        )
      ),
      202
    );
    expect((await storedPlan(workspace.id))?.plan).toBe('business');
    const canceling = await ok<WorkspaceBilling>(
      request(app, 'GET', `/api/workspaces/${workspace.id}/billing`, { cookie })
    );
    expect(canceling.subscription).toMatchObject({ cancelAtPeriodEnd: true, entitled: true });

    // Revoked at the period's end: back to the default plan, the overrides kept.
    await ok(
      post(
        delivery(
          'subscription.revoked',
          subscription(workspace.id, {
            ...sub,
            product_id: 'prod-business-month',
            status: 'canceled',
            modified_at: '2026-12-01T00:00:01Z',
          })
        )
      ),
      202
    );
    expect(await storedPlan(workspace.id)).toEqual({
      plan: null,
      plan_overrides: { limits: { recordsPerBase: 7 } },
    });
    expect((await usage()).plan.id).toBe('free');
    expect((await usage()).features.personalViews).toBe(false);

    // A late event of the canceled subscription never revives it.
    const late = await post(
      delivery(
        'subscription.updated',
        subscription(workspace.id, {
          ...sub,
          status: 'active',
          modified_at: '2026-12-02T00:00:00Z',
        })
      )
    );
    expect(late.status).toBe(202);
    expect((await storedPlan(workspace.id))?.plan).toBeNull();

    // A new checkout is allowed again.
    const renewed = await request(app, 'POST', `/api/workspaces/${workspace.id}/billing/checkout`, {
      cookie,
      body: { plan: 'pro', interval: 'month' },
    });
    expect(renewed.status).toBe(200);
  });

  it('refuses forged, stale and unsigned deliveries without recording them', async () => {
    const { workspace } = await tenant();
    const before = await eventCount();
    const now = Math.floor(Date.now() / 1000);
    const forged = delivery('subscription.created', subscription(workspace.id, { id: 'sub_f' }), {
      secret: 'whsec_someone_else',
    });
    const stale = delivery('subscription.created', subscription(workspace.id, { id: 'sub_s' }), {
      at: now - 600,
    });
    const future = delivery('subscription.created', subscription(workspace.id, { id: 'sub_n' }), {
      at: now + 600,
    });
    const good = delivery('subscription.created', subscription(workspace.id, { id: 'sub_g' }));
    // The body changed after signing (a Business product slipped in).
    const tampered = {
      raw: good.raw.replace('prod-pro-month', 'prod-business-month'),
      headers: good.headers,
    };
    const unsigned = { raw: good.raw, headers: {} };
    for (const [name, d] of Object.entries({ forged, stale, future, tampered, unsigned })) {
      const res = await post(d);
      expect(res.status, name).toBe(400);
      expect(((await res.json()) as { detail: string }).detail).toMatch(/signature/);
    }
    expect(await eventCount()).toBe(before);
    expect((await storedPlan(workspace.id))?.plan).toBeNull();

    // Another provider's path, or a body past the cap.
    expect((await post(good, 'stripe')).status).toBe(404);
    const huge = delivery('subscription.created', { pad: 'x'.repeat(300 * 1024) });
    expect((await post(huge)).status).toBe(413);
  });

  it('applies each event once: a replayed delivery changes nothing', async () => {
    const { workspace } = await tenant();
    const sub = { id: `sub_${uuidv7()}` };
    const first = delivery('subscription.created', subscription(workspace.id, sub));
    expect(await ok(post(first), 202)).toEqual({ received: true, duplicate: false });
    // Downgraded later by an operator (or a newer event)...
    await setWorkspacePlan(t.db, workspace.id, { plan: null, overrides: {} });
    // ...then the old delivery replayed, freshly signed with the same id: a duplicate.
    const replay = delivery('subscription.created', subscription(workspace.id, sub), {
      id: first.id,
    });
    expect(await ok(post(replay), 202)).toEqual({ received: true, duplicate: true });
    expect((await storedPlan(workspace.id))?.plan).toBeNull();
    // Concurrent retries of one event: applied once.
    const racing = delivery(
      'subscription.updated',
      subscription(workspace.id, { ...sub, modified_at: '2026-11-05T00:00:00Z' })
    );
    const answers = await Promise.all([post(racing), post(racing), post(racing)]);
    const bodies = await Promise.all(
      answers.map(async (r) => {
        expect([202, 500]).toContain(r.status);
        return r.status === 202 ? ((await r.json()) as { duplicate: boolean }) : null;
      })
    );
    expect(bodies.filter((b) => b && !b.duplicate)).toHaveLength(1);
    expect((await storedPlan(workspace.id))?.plan).toBe('pro');
  });

  it('ignores events older than the stored subscription (out of order)', async () => {
    const { workspace } = await tenant();
    const sub = { id: `sub_${uuidv7()}` };
    const older = delivery(
      'subscription.created',
      subscription(workspace.id, { ...sub, modified_at: '2026-11-01T10:00:00.000001Z' })
    );
    const newer = delivery(
      'subscription.updated',
      subscription(workspace.id, {
        ...sub,
        product_id: 'prod-business-month',
        modified_at: '2026-11-01T10:00:00.000002Z',
      })
    );
    await ok(post(newer), 202);
    await ok(post(older), 202);
    expect((await storedPlan(workspace.id))?.plan).toBe('business');
    const { rows } = await t.db.execute<{ outcome: string }>(
      sql`SELECT outcome FROM billing_events WHERE event_id = ${older.id}`
    );
    expect(rows[0]?.outcome).toBe('stale');
  });

  it("acknowledges what isn't ours without touching any workspace", async () => {
    const { workspace } = await tenant();
    const other = await tenant();
    const sub = { id: `sub_${uuidv7()}` };
    const outcomes = async (ids: string[]) => {
      const { rows } = await t.db.execute<{ event_id: string; outcome: string }>(
        sql`SELECT event_id, outcome FROM billing_events WHERE event_id = ANY(${`{${ids.join(',')}}`}::text[])`
      );
      return Object.fromEntries(rows.map((r) => [r.event_id, r.outcome]));
    };
    const unknownType = delivery('order.paid', { id: 'ord_1' });
    const unknownProduct = delivery(
      'subscription.created',
      subscription(workspace.id, { id: 'sub_x', product_id: 'prod-other-app' })
    );
    const noWorkspace = delivery('subscription.created', subscription(null, { id: 'sub_y' }));
    const noSuchWorkspace = delivery(
      'subscription.created',
      subscription(uuidv7(), { id: `sub_${uuidv7()}` })
    );
    const mine = delivery('subscription.created', subscription(workspace.id, sub));
    // The same subscription, claiming the other workspace.
    const moved = delivery(
      'subscription.updated',
      subscription(other.workspace.id, { ...sub, modified_at: '2026-11-09T00:00:00Z' })
    );
    for (const d of [unknownType, unknownProduct, noWorkspace, noSuchWorkspace, mine, moved]) {
      expect((await post(d)).status).toBe(202);
    }
    expect(
      await outcomes(
        [unknownType, unknownProduct, noWorkspace, noSuchWorkspace, mine, moved].map((d) => d.id)
      )
    ).toEqual({
      [unknownType.id]: 'ignored',
      [unknownProduct.id]: 'ignored',
      [noWorkspace.id]: 'unmatched',
      [noSuchWorkspace.id]: 'unmatched',
      [mine.id]: 'applied',
      [moved.id]: 'unmatched',
    });
    expect((await storedPlan(workspace.id))?.plan).toBe('pro');
    expect((await storedPlan(other.workspace.id))?.plan).toBeNull();
  });

  it('keeps subscriptions to their tenant and the events log away from the app role', async () => {
    const { workspace } = await tenant();
    const other = await tenant();
    await ok(
      post(delivery('subscription.created', subscription(workspace.id, { id: `sub_${uuidv7()}` }))),
      202
    );
    const scoped = (workspaceId: string, query: ReturnType<typeof sql>) =>
      t.appDb.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('app.user_id', '', true), set_config('app.workspace_id', ${workspaceId}, true)`
        );
        return tx.execute<{ n: number }>(query);
      });
    const count = sql`SELECT count(*)::int AS n FROM billing_subscriptions`;
    expect((await scoped(workspace.id, count)).rows[0]?.n).toBe(1);
    expect((await scoped(other.workspace.id, count)).rows[0]?.n).toBe(0);
    await expect(
      scoped(workspace.id, sql`SELECT count(*)::int AS n FROM billing_events`)
    ).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------------------------
  // : seats, in-app subscription changes, dunning
  // ---------------------------------------------------------------------------------------------

  const quiet = { info: () => {}, warn: () => {} };
  async function subscribed(over: Record<string, unknown> = {}) {
    const tn = await tenant();
    const sub = { id: `sub_${uuidv7()}`, customer_id: `cus_${uuidv7()}`, seats: 1, ...over };
    await ok(post(delivery('subscription.created', subscription(tn.workspace.id, sub))), 202);
    return { ...tn, sub };
  }
  async function storedSub(workspaceId: string) {
    const { rows } = await t.db.execute<{
      seats: number | null;
      entitled: boolean;
      status: string;
      past_due_since: Date | null;
      dunning_stage: number;
    }>(sql`SELECT seats, entitled, status, past_due_since, dunning_stage
             FROM billing_subscriptions WHERE workspace_id = ${workspaceId}::uuid`);
    const row = rows[0];
    return row && { ...row, past_due_since: row.past_due_since && new Date(row.past_due_since) };
  }
  const billingOf = (workspaceId: string, cookie: string) =>
    ok<WorkspaceBilling>(request(app, 'GET', `/api/workspaces/${workspaceId}/billing`, { cookie }));

  it('shows the seats, the billable editors and whether the subscription can be changed', async () => {
    const { workspace, cookie } = await subscribed({ seats: 3 });
    await addMember(t.db, workspace.id, 'editor');
    await addMember(t.db, workspace.id, 'commenter');
    const billing = await billingOf(workspace.id, cookie);
    expect(billing).toMatchObject({
      editors: 2,
      manage: true,
      subscription: { seats: 3, graceEndsAt: null, status: 'active' },
    });
    const none = await tenant();
    expect(await billingOf(none.workspace.id, none.cookie)).toMatchObject({
      editors: 1,
      manage: false,
      subscription: null,
    });
    const ossBilling = await ok<WorkspaceBilling>(
      request(oss, 'GET', `/api/workspaces/${workspace.id}/billing`, { cookie })
    );
    expect(ossBilling).toMatchObject({ enabled: false, manage: false });
  });

  it('syncs the seats to the billable editors a minute after membership changes', async () => {
    const { workspace, cookie, sub } = await subscribed({ seats: 1 });
    const commenter = await addMember(t.db, workspace.id, 'commenter');
    // Two changes in a row: commenter → editor, then a second editor's role change.
    const editor = await addMember(t.db, workspace.id, 'editor');
    for (const [userId, role] of [
      [commenter.id, 'editor'],
      [editor.id, 'creator'],
    ] as const) {
      const res = await request(app, 'PATCH', `/api/workspaces/${workspace.id}/members/${userId}`, {
        cookie,
        body: { role },
      });
      expect(res.status).toBe(200);
    }
    const sent: { queue: string; jobs: JobInsert<RelayJobData>[] }[] = [];
    // Waits out transactions open elsewhere in the cluster, which hold the relay's horizon back.
    await relayAll(t.appDb, {
      insert: async (queue, jobs) => sent.push({ queue, jobs }),
      subscribers: [seatSubscriber],
    });
    const mine = sent
      .flatMap((b) => b.jobs.map((j) => ({ queue: b.queue, ...j })))
      .filter((j) => j.data?.workspaceId === workspace.id);
    // Debounced, one queued per workspace: one job per relay batch (seats.test.ts), and the
    // horizon may split the events over batches, but every job shares the workspace's singleton
    // key, so the stately queue keeps one.
    expect(mine.length).toBeGreaterThanOrEqual(1);
    for (const job of mine) {
      expect(job).toMatchObject({
        queue: 'billing.seats',
        singletonKey: `seats:${workspace.id}`,
        startAfter: SEAT_SYNC_DELAY_SECONDS,
      });
    }

    const deps = { db: t.appDb, billing: fake.provider, logger: quiet };
    // Owner, the commenter made editor, the creator: 3.
    expect(await syncSeats(deps, workspace.id)).toEqual({
      synced: true,
      subscriptionId: sub.id,
      from: 1,
      to: 3,
    });
    expect(fake.seatCalls).toEqual([{ subscriptionId: sub.id, seats: 3 }]);
    expect((await storedSub(workspace.id))?.seats).toBe(3);
    // Idempotent: nothing to change, no call.
    expect(await syncSeats(deps, workspace.id)).toEqual({ synced: false, reason: 'in sync' });
    expect(fake.seatCalls).toHaveLength(1);

    // Removing someone lowers them; a provider failure throws (pg-boss retries) and stores nothing.
    const removed = await request(
      app,
      'DELETE',
      `/api/workspaces/${workspace.id}/members/${editor.id}`,
      { cookie }
    );
    expect(removed.status).toBe(204);
    fake.state.down = true;
    await expect(syncSeats(deps, workspace.id)).rejects.toBeInstanceOf(BillingUnavailableError);
    expect((await storedSub(workspace.id))?.seats).toBe(3);
    fake.state.down = false;
    expect(await syncSeats(deps, workspace.id)).toMatchObject({ synced: true, from: 3, to: 2 });

    // No subscription, or a provider without seats: nothing to do.
    const plain = await tenant();
    expect(await syncSeats(deps, plain.workspace.id)).toEqual({
      synced: false,
      reason: 'no subscription',
    });
    const { updateSeats: _drop, ...flat } = fake.provider;
    expect(await syncSeats({ ...deps, billing: flat }, workspace.id)).toEqual({
      synced: false,
      reason: 'no seats',
    });
  });

  it('changes the plan and cancels or resumes through the provider, for owners', async () => {
    const { workspace, cookie, sub } = await subscribed();
    const path = `/api/workspaces/${workspace.id}/billing/subscription`;
    const patch = (body: unknown, as = cookie, target = app) =>
      request(target, 'PATCH', path, { cookie: as, body });

    expect((await patch({ plan: 'business', interval: 'month' })).status).toBe(204);
    expect((await patch({ cancelAtPeriodEnd: true })).status).toBe(204);
    expect(fake.changes).toEqual([
      { subscriptionId: sub.id, change: { plan: 'business', interval: 'month' } },
      { subscriptionId: sub.id, change: { cancelAtPeriodEnd: true } },
    ]);
    // Nothing changes until the provider's event.
    expect((await storedPlan(workspace.id))?.plan).toBe('pro');

    for (const [body, status] of [
      [{ plan: 'pro', interval: 'month' }, 409],
      [{ cancelAtPeriodEnd: false }, 409],
      [{ plan: 'business', interval: 'year' }, 422],
      [{ plan: 'pro' }, 422],
      [{ cancelAtPeriodEnd: true, plan: 'pro', interval: 'month' }, 422],
      [{}, 422],
    ] as const) {
      expect((await patch(body)).status, JSON.stringify(body)).toBe(status);
    }
    fake.state.down = true;
    expect((await patch({ plan: 'pro', interval: 'year' })).status).toBe(503);
    fake.state.down = false;

    const creator = await addMember(t.db, workspace.id, 'creator');
    expect(
      (await patch({ cancelAtPeriodEnd: true }, await createSession(t.db, creator))).status
    ).toBe(403);
    expect((await patch({ cancelAtPeriodEnd: true }, cookie, oss)).status).toBe(404);
    const none = await tenant();
    expect(
      (
        await request(app, 'PATCH', `/api/workspaces/${none.workspace.id}/billing/subscription`, {
          cookie: none.cookie,
          body: { cancelAtPeriodEnd: true },
        })
      ).status
    ).toBe(409);
    expect(fake.changes).toHaveLength(2);
  });

  it('keeps the plan for 14 days past due, emails owners, then falls back to the default plan', async () => {
    const { workspace, cookie, owner, sub } = await subscribed();
    const usage = () =>
      ok<WorkspaceUsage>(request(app, 'GET', `/api/workspaces/${workspace.id}/usage`, { cookie }));
    const sent: EmailMessage[] = [];
    const deps = {
      db: t.appDb,
      billing: fake.provider,
      entitlements: edition.entitlements,
      logger: quiet,
      email: {
        transport: { send: async (m: EmailMessage) => void sent.push(m) },
        appUrl: app.config.appUrl,
      },
    };
    const event = (status: string, modified: string) =>
      post(
        delivery(
          'subscription.updated',
          subscription(workspace.id, { ...sub, status, modified_at: modified })
        )
      );

    expect((await event('past_due', '2026-11-05T00:00:00Z')).status).toBe(202);
    const since = (await storedSub(workspace.id))?.past_due_since;
    expect(since).toBeInstanceOf(Date);
    const start = since ?? new Date();
    const at = (days: number) => new Date(start.getTime() + days * 86_400_000);
    expect((await storedPlan(workspace.id))?.plan).toBe('pro');
    const billing = await billingOf(workspace.id, cookie);
    expect(billing.subscription).toMatchObject({
      status: 'past_due',
      entitled: true,
      graceEndsAt: at(14).toISOString(),
    });

    // The first sweep: "payment failed" to the owner, once.
    expect(await checkDunning(deps, workspace.id, at(0.01))).toMatchObject({ emails: 1, ended: 0 });
    expect(sent.map((m) => m.to)).toEqual([owner.email]);
    expect(sent[0]?.subject).toMatch(/Payment failed/);
    expect(sent[0]?.text).toContain(`${app.config.appUrl}/w/${workspace.id}/billing`);
    expect(await checkDunning(deps, workspace.id, at(1))).toMatchObject({ emails: 0 });
    // A retried past_due event keeps the start of the grace period.
    expect((await event('past_due', '2026-11-06T00:00:00Z')).status).toBe(202);
    expect((await storedSub(workspace.id))?.past_due_since?.getTime()).toBe(start.getTime());

    // Three days before the end: the reminder.
    expect(await checkDunning(deps, workspace.id, at(11.5))).toMatchObject({ emails: 1 });
    expect(sent[1]?.subject).toMatch(/keeps its Pro plan until/);
    expect((await storedPlan(workspace.id))?.plan).toBe('pro');

    // Past the grace period: the default plan, nothing deleted, one last email.
    const result = await runDunning(deps, at(14.01));
    expect(result).toMatchObject({ ended: 1 });
    expect((await storedPlan(workspace.id))?.plan).toBeNull();
    expect((await usage()).plan.id).toBe('free');
    expect(await storedSub(workspace.id)).toMatchObject({ entitled: false, dunning_stage: 3 });
    // A second subscription isn't sold meanwhile: the payment is what needs fixing.
    const second = await request(app, 'POST', `/api/workspaces/${workspace.id}/billing/checkout`, {
      cookie,
      body: { plan: 'pro', interval: 'month' },
    });
    expect(second.status).toBe(409);
    expect(sent[2]?.subject).toMatch(/is on (free|Free) limits/);
    expect(await checkDunning(deps, workspace.id, at(15))).toMatchObject({ emails: 0, ended: 0 });
    // Another past_due event after the grace period (in real time) doesn't bring the plan back...
    await t.db.execute(sql`
      UPDATE billing_subscriptions SET past_due_since = now() - interval '15 days'
       WHERE workspace_id = ${workspace.id}::uuid`);
    expect((await event('past_due', '2026-11-25T00:00:00Z')).status).toBe(202);
    expect((await storedPlan(workspace.id))?.plan).toBeNull();

    // ...but the payment going through does, and the next failure starts over.
    expect((await event('active', '2026-11-26T00:00:00Z')).status).toBe(202);
    expect((await storedPlan(workspace.id))?.plan).toBe('pro');
    expect(await storedSub(workspace.id)).toMatchObject({
      entitled: true,
      past_due_since: null,
      dunning_stage: 0,
    });
    expect((await billingOf(workspace.id, cookie)).subscription?.graceEndsAt).toBeNull();
  });

  it('falls back even when the dunning email fails, and queues seat syncs for drift', async () => {
    const { workspace, sub } = await subscribed({ seats: 5 });
    await ok(
      post(
        delivery(
          'subscription.updated',
          subscription(workspace.id, {
            ...sub,
            status: 'past_due',
            modified_at: '2026-11-05T00:00:00Z',
          })
        )
      ),
      202
    );
    const queued: string[] = [];
    const deps = {
      db: t.appDb,
      billing: fake.provider,
      entitlements: edition.entitlements,
      logger: quiet,
      email: {
        transport: {
          send: async () => {
            throw new Error('smtp down');
          },
        },
        appUrl: app.config.appUrl,
      },
      queueSeatSync: async (id: string) => void queued.push(id),
    };
    const later = new Date(Date.now() + 15 * 86_400_000);
    expect(await checkDunning(deps, workspace.id, later)).toMatchObject({ emails: 0, ended: 1 });
    expect((await storedPlan(workspace.id))?.plan).toBeNull();
    // The email's stage wasn't recorded: the next run tries again.
    expect((await storedSub(workspace.id))?.dunning_stage).toBe(0);

    // Seats: stored 5, one billable editor: queued for a sync (entitled subscriptions only).
    const drift = await subscribed({ seats: 5 });
    await runDunning({ ...deps, email: undefined });
    expect(queued).toContain(drift.workspace.id);
    expect(queued).not.toContain(workspace.id);
  });
});
