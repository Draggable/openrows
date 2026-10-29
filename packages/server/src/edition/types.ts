import {
  type AuditAction,
  type AuditActorKind,
  type BillingInterval,
  type BillingOffer,
  PLAN_FEATURES,
  PLAN_LIMITS,
  type PlanFeature,
  type PlanLimit,
  type SubscriptionStatus,
} from '@openrows/shared';
import type { RouteRegistry } from '../authz/routes.js';
import type { Config } from '../config.js';
import type { Database, Transaction } from '../db/index.js';
import type { QueueDefinition } from '../jobs/runtime.js';
import type { Logger } from '../lib/logger.js';
import type { SafeFetch } from '../lib/safe-fetch/index.js';
import type { SyncConnector } from '../syncs/sources/connectors.js';
import type { HookRegistry } from './hooks.js';

/**
 * The open-core plug-in interfaces (ADR-005 §4). The core defines them and ships the OSS
 * implementations (oss.ts: unlimited, every feature on, no billing, a meter that never blocks);
 * the hosted edition's composition root passes its own. The core never imports the hosted
 * edition: dependencies point from it to here.
 */

/** Which build is running: the open-source core, or the hosted service (EDITION). */
export type EditionName = 'oss' | 'cloud';

/** Features a plan can turn off (REVIEW §6). The OSS edition has every one on. */
export const FEATURES = PLAN_FEATURES;
export type Feature = PlanFeature;

export type { BillingInterval, BillingOffer, SubscriptionStatus };

/** Limits a plan can set (REVIEW §6 "Suggested hosted tiers"). `null`: unlimited. */
export const LIMITS = PLAN_LIMITS;
export type Limit = PlanLimit;

/** What one workspace may do and how much of it. */
export interface Entitlements {
  /** The plan's id: `self-hosted` in the OSS edition. */
  readonly plan: string;
  /** The plan's name, for people: `Self-hosted` in the OSS edition. */
  readonly planName: string;
  has(feature: Feature): boolean;
  /** The limit, or `null` for unlimited. */
  limit(limit: Limit): number | null;
}

export interface EntitlementsProvider {
  /** For logs and `/health`: `oss` or the provider's name. */
  readonly id: string;
  /**
   * The workspace's entitlements. `tx` is the caller's transaction, scoped to the workspace
   * (RLS): a provider that reads the stored plan reads it through `readWorkspacePlan(tx, id)`.
   * Providers may cache; `invalidate` drops what they cached for the workspace (called when its
   * plan changes, also from other processes through the bus).
   */
  forWorkspace(workspaceId: string, tx: Transaction): Promise<Entitlements>;
  invalidate?(workspaceId: string): void;
}

export interface BillingProvider {
  readonly id: string;
  /** Whether workspaces have subscriptions at all; false in the OSS edition. */
  readonly enabled: boolean;
  /**
   * Where the workspace's owners upgrade its plan (the Usage page's button and the limit
   * warnings); null when there is nothing to upgrade (the OSS edition). With checkout it's
   * the app's own plan picker.
   */
  upgradeUrl(workspaceId: string): Promise<string | null>;
  /** The plans owners can buy; empty without checkout. */
  offers(): readonly BillingOffer[];
  /**
   * Starts a checkout at the provider for the workspace, with the workspace's id in its
   * metadata so the subscription's events name it. Throws BillingUnavailableError when the
   * provider can't be reached or refuses.
   */
  checkout?(input: CheckoutInput): Promise<{ url: string }>;
  /** The provider's customer portal (change plan, cancel, invoices) for a subscription's customer. */
  portal?(input: { workspaceId: string; customerId: string; returnUrl: string }): Promise<{
    url: string;
  }>;
  /**
   * Sets the subscription's seats to the workspace's billable editors (the provider
   * prorates). Called by the worker's debounced `billing.seats` job after membership changes.
   * Absent: subscriptions aren't billed per seat. Throws BillingUnavailableError on failure.
   */
  updateSeats?(input: { subscriptionId: string; seats: number }): Promise<void>;
  /**
   * Changes the subscription at the provider: another plan or interval (prorated), or a
   * cancellation at the period's end (or taking it back). Its signed event then updates the
   * stored subscription and the plan. Throws BillingUnavailableError on failure.
   */
  updateSubscription?(input: { subscriptionId: string; change: SubscriptionChange }): Promise<void>;
  /** The provider's signed webhooks: `POST /api/billing/<provider>/webhooks`. */
  webhooks?: BillingWebhooks;
}

export type SubscriptionChange =
  | { plan: string; interval: BillingInterval }
  | { cancelAtPeriodEnd: boolean };

export interface CheckoutInput {
  workspaceId: string;
  /** Who started it (an owner). */
  userId: string;
  plan: string;
  interval: BillingInterval;
  /** The workspace's billable editors: the seats a per-seat checkout starts with (≥ 1). */
  seats: number;
  /** Where the provider sends the buyer after paying, and when they go back. */
  successUrl: string;
  returnUrl: string;
}

export interface BillingWebhooks {
  /** The provider's name: the webhook path's segment and the events' namespace. */
  readonly provider: string;
  /**
   * Verifies the delivery's signature on the raw body (and its timestamp window) and reads the
   * event. Throws BillingWebhookError when it isn't a genuine, fresh event of the provider.
   */
  verify(body: Uint8Array, headers: Record<string, string>): Promise<BillingEvent>;
  /**
   * The plan a workspace's subscriptions give it: the best plan of the entitled ones, null (the
   * edition's default plan) without any.
   */
  planFor(subscriptions: readonly StoredSubscription[]): string | null;
}

/** A verified provider event. */
export interface BillingEvent {
  /** The provider's event id (Standard Webhooks' `webhook-id`): each is applied once. */
  id: string;
  type: string;
  /** The subscription it reports; null for events that don't change a plan (ignored). */
  subscription: SubscriptionEvent | null;
}

/** A subscription as an event reports it. */
export interface SubscriptionEvent {
  /** The provider's subscription id. */
  id: string;
  customerId: string;
  /** From the checkout's metadata; null when the subscription didn't come from our checkout. */
  workspaceId: string | null;
  plan: string;
  interval: BillingInterval;
  status: SubscriptionStatus;
  /** Whether this state grants the plan. */
  entitled: boolean;
  cancelAtPeriodEnd: boolean;
  /** ISO 8601. */
  currentPeriodEnd: string | null;
  /** Seats billed; null when the subscription isn't per seat. */
  seats?: number | null;
  /** The provider's version of the subscription (ISO 8601, kept at its precision). */
  changedAt: string;
}

/** A workspace's subscription as stored. */
export interface StoredSubscription {
  subscriptionId: string;
  plan: string;
  interval: BillingInterval;
  status: SubscriptionStatus;
  entitled: boolean;
}

/** A delivery that isn't a genuine, fresh event: answered 400, nothing recorded. */
export class BillingWebhookError extends Error {
  override name = 'BillingWebhookError';
}

/**
 * The provider can't be reached or refused (503); carries no secret and no response body.
 * `detail` is for the server's log only (never the response): what the provider said was
 * wrong, e.g. a validation error's field and message, without the values sent.
 */
export class BillingUnavailableError extends Error {
  override name = 'BillingUnavailableError';
  constructor(
    message: string,
    readonly detail?: string
  ) {
    super(message);
  }
}

/**
 * What a usage meter counts (REVIEW §6). `aiCredits`: the credits of AI requests on the
 * instance's provider (shared's aiCreditsFor), also kept in `ai_credit_counts` for the plan's
 * `aiCreditsPerMonth`; requests on a workspace's own key aren't metered.
 */
export const USAGE_METRICS = [
  'apiCalls',
  'automationRuns',
  'records',
  'attachmentBytes',
  'aiCredits',
] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

export type UsageDecision =
  | { allowed: true }
  | { allowed: false; metric: UsageMetric; used: number; limit: number };

export interface UsageMeter {
  readonly id: string;
  /** Counts `amount` (default 1) of `metric` for the workspace. */
  record(workspaceId: string, metric: UsageMetric, amount?: number): Promise<void>;
  /** Whether `amount` more fits the workspace's limit. The OSS meter always allows it. */
  check(workspaceId: string, metric: UsageMetric, amount?: number): Promise<UsageDecision>;
}

/**
 * One action for a workspace's audit log (ADR-005 §4's AuditSink). `summary` is checked
 * again by the sink (sanitizeAuditValues): primitive values only, no secrets or cell values.
 */
export interface AuditRecord {
  workspaceId: string;
  action: AuditAction;
  actor: AuditActorInfo;
  target: { type: string; id?: string | null; name?: string | null };
  summary?: { before?: Record<string, unknown>; after?: Record<string, unknown> };
}

/** Who did it, and from where (the request's client IP and user agent). */
export interface AuditActorInfo {
  kind: AuditActorKind;
  userId: string | null;
  email: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Where the core sends audit records. The OSS edition's does nothing (`enabled: false`,
 * so callers skip the work of building records); the hosted one keeps them for workspaces whose
 * plan has the audit log. `record` runs in the caller's transaction, scoped to the record's
 * workspace (RLS), so an entry commits or rolls back with the change it describes.
 */
export interface AuditSink {
  readonly id: string;
  readonly enabled: boolean;
  record(tx: Transaction, entry: AuditRecord): Promise<void>;
}

/** A sign-in the callback is about to complete: the user is upserted, no session yet. */
export interface SignInAttempt {
  userId: string;
  /** The verified, lower-cased address. */
  email: string;
  /**
   * The Keycloak identity provider the person came through (the ID token's `identity_provider`
   * claim, from the realm's session note mapper); undefined for the realm's own sign-in.
   */
  identityProvider: string | undefined;
  ip: string | null;
  userAgent: string | null;
}

export type SignInDecision =
  /** `method`: how the person signed in, for the audit log (`oidc`, `sso`). */
  | { allowed: true; method: string }
  | { allowed: false; reason: 'sso_required' | 'sso_domain_mismatch' | 'sso_not_found' };

/**
 * Per-workspace single sign-on (hosted edition): home-realm discovery on the sign-in page
 * and the checks of each sign-in ("require SSO", the provider's verified domains, JIT
 * membership). The OSS edition's finds nothing and allows every sign-in.
 */
export interface SingleSignOn {
  readonly id: string;
  /** The Keycloak identity provider alias for the address's verified domain, or null. */
  discover(db: Database, email: string): Promise<string | null>;
  /**
   * Decides a sign-in before its session starts; an allowed sign-in through a workspace's
   * provider may add the person to that workspace (JIT). Throws only when it can't decide (the
   * callback then refuses the sign-in).
   */
  signIn(db: Database, attempt: SignInAttempt): Promise<SignInDecision>;
}

/**
 * The edition's own AI provider for every workspace (the hosted service's managed AI on an
 * OpenAI-compatible endpoint). It replaces the instance's AI_* provider; requests on it are
 * metered in AI credits against the plan's `aiCreditsPerMonth`. The key only ever goes into the
 * provider's Authorization header: never logged or returned.
 */
export interface ManagedAi {
  /** For logs: e.g. `hosted`. */
  readonly id: string;
  /** Up to the version segment; `/chat/completions` is appended. */
  readonly baseUrl: string;
  readonly apiKey: string;
  /** The model for the workspace's plan (a plan may pick its own). */
  modelFor(plan: string): string;
}

/** A region as the edition describes it: shared's Region, `appUrl` its app's origin. */
export interface RegionInfo {
  readonly id: string;
  readonly name: string;
  /** Null: this stack's own APP_URL (the OSS edition's one region). */
  readonly appUrl: string | null;
}

/** Who a workspace in another region is created for: the identity the regions share. */
export interface RemoteWorkspaceOwner {
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

export interface RemoteWorkspaceInput {
  /** Created here (UUIDv7), so a retried request finds the same workspace. */
  workspaceId: string;
  region: string;
  name: string;
  owner: RemoteWorkspaceOwner;
  /** The plan it starts on: the plan of the caller's workspace that has `dataResidency`. */
  plan: string;
}

/**
 * Data residency. A region is one complete stack (api, worker, Postgres, attachments bucket,
 * backups) at its own origin, and a workspace lives in exactly one: the stack it was created on.
 * The hosted edition runs one stack per region; the home region (the EU) is where people sign up,
 * and its Enterprise owners create workspaces in the others through `createElsewhere`. The OSS
 * edition is one region with people creating workspaces themselves.
 */
export interface DataResidency {
  readonly id: string;
  /** This stack's region. */
  readonly current: RegionInfo;
  /** Every region, this one included, in display order. */
  readonly regions: readonly RegionInfo[];
  /**
   * Whether people create workspaces on this stack themselves (`POST /api/workspaces` and the
   * personal workspace of a first sign-in). False on a region whose workspaces are provisioned
   * from the home region.
   */
  readonly selfServe: boolean;
  /**
   * Creates the workspace on the region's stack, owned by `owner`; answers its URL there. Throws
   * RegionUnavailableError when the region can't be reached or refuses. Absent: no other region.
   */
  createElsewhere?(input: RemoteWorkspaceInput): Promise<{ id: string; url: string }>;
}

/** The other region can't be reached or refused (503); never carries its response. */
export class RegionUnavailableError extends Error {
  override name = 'RegionUnavailableError';
}

/** What hooks get besides their own arguments. */
export interface HookContext {
  config: Config;
  db: Database;
  logger: Logger;
}

/**
 * The hook points of the core. Each hook runs in registration order.
 * - `routes`: in createApp, after the core's routes and before the client's catch-all. Hooks
 *   add routes ONLY through the RouteRegistry (an access rule each; createApp still refuses a
 *   route that bypassed it).
 */
export type EditionHooks = {
  routes: (routes: RouteRegistry, ctx: HookContext) => void;
  /**
   * - `queues`: in the worker, after the core's queues; hooks add their own job queues
   *   (a name of their own, never one of the core's) to `queues`.
   */
  queues: (queues: Record<string, QueueDefinition>, ctx: WorkerHookContext) => void;
};

/** What `queues` hooks get: the worker's database (openrows_app), log and edition's providers. */
export interface WorkerHookContext {
  db: Database;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  entitlements: EntitlementsProvider;
  /** The SSRF-safe client (OUTBOUND_HTTP_*); absent when the worker has no outbound config. */
  http?: SafeFetch | undefined;
  /** The API's ENCRYPTION_KEY, for ciphers of the hook's own (createCipher with its purpose). */
  encryptionKey?: string | undefined;
}

/** What an edition's composition root passes to the core's entry points. */
export interface EditionProviders {
  entitlements: EntitlementsProvider;
  billing: BillingProvider;
  usage: UsageMeter;
  /** The audit log's sink; none (the OSS one) when omitted. */
  audit?: AuditSink;
  /** Per-workspace single sign-on; none (the OSS one) when omitted. */
  sso?: SingleSignOn;
  /**
   * The edition's AI provider. Omitted: the instance's AI_* provider, as in the OSS
   * edition; null: none (AI runs only on workspaces' own keys).
   */
  ai?: ManagedAi | null;
  /** Sync sources the edition adds (the hosted Google Sheets); none when omitted. */
  syncConnectors?: readonly SyncConnector[];
  /** Data residency; one region, self-serve (the OSS one) when omitted. */
  residency?: DataResidency;
  hooks?: HookRegistry<EditionHooks>;
}

/** The resolved edition the app and the worker run with. */
export interface Edition {
  readonly name: EditionName;
  readonly entitlements: EntitlementsProvider;
  readonly billing: BillingProvider;
  readonly usage: UsageMeter;
  readonly audit: AuditSink;
  readonly sso: SingleSignOn;
  /** See EditionProviders.ai: undefined keeps the instance's AI_* provider. */
  readonly ai?: ManagedAi | null;
  /** See EditionProviders.syncConnectors. */
  readonly syncConnectors: readonly SyncConnector[];
  readonly residency: DataResidency;
  readonly hooks: HookRegistry<EditionHooks>;
}
