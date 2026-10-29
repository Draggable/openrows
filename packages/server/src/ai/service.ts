import {
  AI_DEFAULT_BASE_URL,
  type AiSettings,
  type AiSource,
  aiCreditsFor,
  type UpdateAiSettings,
  usageResetDay,
} from '@openrows/shared';
import { eq, sql } from 'drizzle-orm';
import { attachmentHostAllowed } from '../airtable/client.js';
import type { Cipher } from '../auth/crypto.js';
import type { AiConfig } from '../config.js';
import type { Database, Transaction } from '../db/index.js';
import { workspaceAiSettings } from '../db/schema.js';
import type { EntitlementsProvider, ManagedAi, UsageMeter } from '../edition/types.js';
import { withTenant } from '../jobs/tenant.js';
import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import {
  createSafeFetch,
  createUrlCheck,
  type OutboundConfig,
  outboundPolicy,
  type SafeFetch,
  SafeFetchError,
} from '../lib/safe-fetch/index.js';
import {
  type AiChatRequest,
  type AiChatResult,
  type AiProvider,
  AiProviderError,
  createOpenAiCompatibleProvider,
} from './provider.js';

/**
 * Which AI provider a workspace uses: the workspace's own (an owner's key in Settings →
 * AI) first, then the instance's (AI_MODEL, AI_BASE_URL, AI_API_KEY), else none, and AI
 * features are hidden. Keys are encrypted at rest and decrypted only to build the provider for
 * one request; nothing here returns, logs or throws them.
 *
 * Outbound requests go through the SSRF-safe client. A workspace's base URL is a user's choice:
 * the outbound rules (OUTBOUND_HTTP_*) apply as to webhooks, and AI_ALLOWED_HOSTS narrows the
 * hosts further (the hosted service lists its supported providers). The instance's URL is the
 * operator's choice, so its host and port are reachable even when private (Ollama next door).
 *
 * The instance's provider is AI_*, or the edition's own (the hosted service's managed AI,
 * `edition.ai`, with a model per plan). Its requests cost AI credits (shared's aiCreditsFor),
 * counted per workspace and UTC month in `ai_credit_counts` and reported to the edition's
 * UsageMeter; at the plan's `aiCreditsPerMonth` further requests are refused (a soft block:
 * requests already running finish and count, so a month can end a little over). A workspace's
 * own key is never counted or blocked.
 */

export interface AiDeps {
  config: AiConfig;
  outbound: OutboundConfig;
  cipher: Cipher;
  usage: UsageMeter;
  /** The plan's AI credits (`aiCreditsPerMonth`) and, for the edition's provider, its model. */
  entitlements: EntitlementsProvider;
  /** openrows_app: the credit counter, in transactions of its own (requests outlive the caller's). */
  db: Database;
  /** The edition's provider: undefined keeps AI_*; null: no instance provider. */
  managed?: ManagedAi | null | undefined;
  logger: Logger;
  /** Tests: the clients for workspace URLs and the instance's (default: the SSRF-safe one). */
  http?: { workspace?: SafeFetch; instance?: SafeFetch };
  /** Tests: the save-time URL check (default: the outbound rules, resolving the host). */
  checkUrl?: (url: string) => Promise<void>;
}

/** A workspace's provider, metered and logged, and where it came from. */
export interface WorkspaceAi {
  source: AiSource;
  provider: AiProvider;
}

/** What the instance's provider is for one workspace. */
interface InstanceAi {
  provider: AiProvider;
  /** The plan's AI credits this month; null: unlimited. */
  creditLimit: number | null;
}

/** The instance URL's own host and port join the outbound rules' allowlist. */
function instanceOutbound(outbound: OutboundConfig, baseUrl: string): OutboundConfig {
  const url = new URL(baseUrl);
  const port = url.port ? Number(url.port) : undefined;
  return {
    allowHttp: outbound.allowHttp || url.protocol === 'http:',
    extraPorts: port ? [...outbound.extraPorts, port] : outbound.extraPorts,
    allow: [...outbound.allow, url.hostname.replace(/^\[|\]$/g, '')],
    deny: outbound.deny,
  };
}

function baseUrlError(message: string): AppError {
  return new AppError('VALIDATION_FAILED', {
    detail: message,
    extensions: { errors: [{ path: 'baseUrl', message }] },
  });
}

export class AiService {
  readonly #deps: AiDeps;
  readonly #workspaceHttp: SafeFetch;
  readonly #checkUrl: (url: string) => Promise<void>;
  /** AI_*'s provider; undefined with the edition's own or none. */
  readonly #instance: AiProvider | undefined;
  /** The edition's provider per model (a plan may pick its own). */
  readonly #managed = new Map<string, AiProvider>();

  constructor(deps: AiDeps) {
    this.#deps = deps;
    const policy = outboundPolicy(deps.outbound);
    this.#workspaceHttp = deps.http?.workspace ?? createSafeFetch(policy);
    const check = createUrlCheck(policy);
    this.#checkUrl = deps.checkUrl ?? ((url) => check(url));
    const instance = deps.managed === undefined ? deps.config.instance : undefined;
    this.#instance = instance
      ? createOpenAiCompatibleProvider({
          baseUrl: instance.baseUrl,
          model: instance.model,
          apiKey: instance.apiKey,
          http:
            deps.http?.instance ??
            createSafeFetch(outboundPolicy(instanceOutbound(deps.outbound, instance.baseUrl))),
          timeoutMs: deps.config.timeoutMs,
        })
      : undefined;
  }

  /** Whether the server has a provider of its own (AI_* or the edition's). */
  get instanceAvailable(): boolean {
    return this.#deps.managed ? true : this.#instance !== undefined;
  }

  #managedProvider(managed: ManagedAi, model: string): AiProvider {
    let provider = this.#managed.get(model);
    if (!provider) {
      provider = createOpenAiCompatibleProvider({
        baseUrl: managed.baseUrl,
        model,
        apiKey: managed.apiKey,
        http:
          this.#deps.http?.instance ??
          createSafeFetch(outboundPolicy(instanceOutbound(this.#deps.outbound, managed.baseUrl))),
        timeoutMs: this.#deps.config.timeoutMs,
      });
      this.#managed.set(model, provider);
    }
    return provider;
  }

  /** The instance's provider for the workspace (its plan's model and credits), or none. */
  async #instanceFor(tx: Transaction, workspaceId: string): Promise<InstanceAi | null> {
    const { managed } = this.#deps;
    if (!managed && !this.#instance) return null;
    const entitlements = await this.#deps.entitlements.forWorkspace(workspaceId, tx);
    const creditLimit = entitlements.limit('aiCreditsPerMonth');
    if (managed) {
      return {
        provider: this.#managedProvider(managed, managed.modelFor(entitlements.plan)),
        creditLimit,
      };
    }
    return this.#instance ? { provider: this.#instance, creditLimit } : null;
  }

  /** The workspace's AI credits this UTC month, in its scope (RLS). */
  async #creditsUsed(tx: Transaction, workspaceId: string): Promise<number> {
    const { rows } = await tx.execute<{ credits: string }>(sql`
      SELECT credits FROM ai_credit_counts
       WHERE workspace_id = ${workspaceId}::uuid
         AND month = date_trunc('month', now() AT TIME ZONE 'UTC')::date`);
    return Number(rows[0]?.credits ?? 0);
  }

  /** Whether `host` may serve a workspace's AI (AI_ALLOWED_HOSTS; unset: any). */
  hostAllowed(host: string): boolean {
    const hosts = this.#deps.config.allowedHosts;
    return hosts === undefined || attachmentHostAllowed(host, hosts);
  }

  async #row(tx: Transaction, workspaceId: string) {
    const [row] = await tx
      .select()
      .from(workspaceAiSettings)
      .where(eq(workspaceAiSettings.workspaceId, workspaceId));
    return row;
  }

  /** What owners see in Settings → AI: never the key. */
  async settings(tx: Transaction, workspaceId: string): Promise<AiSettings> {
    const row = await this.#row(tx, workspaceId);
    const instance = await this.#instanceFor(tx, workspaceId);
    const credits =
      instance && instance.creditLimit !== null
        ? {
            used: await this.#creditsUsed(tx, workspaceId),
            limit: instance.creditLimit,
            resetsOn: nextMonth(new Date()),
          }
        : null;
    return {
      workspaceId,
      source: row ? 'workspace' : instance ? 'instance' : null,
      instance: {
        available: instance !== null,
        model: instance?.provider.model ?? null,
        credits,
      },
      workspace: row
        ? {
            baseUrl: row.baseUrl,
            model: row.model,
            hasKey: true,
            updatedAt: row.updatedAt.toISOString(),
          }
        : null,
      allowedHosts: this.#deps.config.allowedHosts ?? null,
    };
  }

  /** Where AI features get their provider, for the members' availability check. */
  async source(tx: Transaction, workspaceId: string): Promise<AiSource | null> {
    if (await this.#row(tx, workspaceId)) return 'workspace';
    return this.instanceAvailable ? 'instance' : null;
  }

  /** Stores the workspace's provider (owners). The key is kept when `apiKey` is omitted. */
  async save(
    tx: Transaction,
    workspaceId: string,
    userId: string,
    input: UpdateAiSettings
  ): Promise<AiSettings> {
    const baseUrl = (input.baseUrl ?? AI_DEFAULT_BASE_URL).replace(/\/+$/, '');
    const url = new URL(baseUrl);
    if (!this.hostAllowed(url.hostname)) {
      throw baseUrlError(
        `This server only reaches these AI providers: ${(this.#deps.config.allowedHosts ?? []).join(', ')}.`
      );
    }
    try {
      await this.#checkUrl(baseUrl);
    } catch (err) {
      if (err instanceof SafeFetchError) throw baseUrlError(err.message);
      throw err;
    }
    const existing = await this.#row(tx, workspaceId);
    // A key goes with its URL: pointing a stored key at another host needs it typed again, so a
    // changed URL can't send it somewhere new.
    if (existing && input.apiKey === undefined && existing.baseUrl !== baseUrl) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'Enter the API key again to use it with another URL.',
        extensions: {
          errors: [{ path: 'apiKey', message: 'Enter the API key again for the new URL.' }],
        },
      });
    }
    const apiKeyEncrypted =
      input.apiKey !== undefined
        ? this.#deps.cipher.encrypt(input.apiKey)
        : existing?.apiKeyEncrypted;
    if (!apiKeyEncrypted) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'Enter an API key.',
        extensions: { errors: [{ path: 'apiKey', message: 'Enter an API key.' }] },
      });
    }
    const values = { baseUrl, model: input.model, apiKeyEncrypted, updatedBy: userId };
    await tx
      .insert(workspaceAiSettings)
      .values({ workspaceId, ...values })
      .onConflictDoUpdate({
        target: workspaceAiSettings.workspaceId,
        set: { ...values, updatedAt: new Date() },
      });
    return this.settings(tx, workspaceId);
  }

  /** Removes the workspace's own provider: back to the instance's, or none. */
  async remove(tx: Transaction, workspaceId: string): Promise<AiSettings> {
    await tx.delete(workspaceAiSettings).where(eq(workspaceAiSettings.workspaceId, workspaceId));
    return this.settings(tx, workspaceId);
  }

  /**
   * The workspace's provider, metered (`aiTokens` on the instance's provider: the hosted
   * credits; a workspace's own key isn't metered) and logged; null when AI is off.
   * `tx` is scoped to the workspace (RLS).
   */
  async forWorkspace(tx: Transaction, workspaceId: string): Promise<WorkspaceAi | null> {
    const row = await this.#row(tx, workspaceId);
    if (row) {
      const apiKey = this.#deps.cipher.decrypt(row.apiKeyEncrypted);
      if (apiKey === undefined) {
        // Another ENCRYPTION_KEY, or tampered with: the owner sets the key again.
        this.#deps.logger.warn({ workspaceId }, 'ai: the workspace key does not decrypt');
        return null;
      }
      const provider = createOpenAiCompatibleProvider({
        baseUrl: row.baseUrl,
        model: row.model,
        apiKey,
        http: this.#guarded(),
        timeoutMs: this.#deps.config.timeoutMs,
      });
      return { source: 'workspace', provider: this.#metered(provider, workspaceId, null) };
    }
    const instance = await this.#instanceFor(tx, workspaceId);
    if (!instance) return null;
    return {
      source: 'instance',
      provider: this.#metered(instance.provider, workspaceId, instance),
    };
  }

  /** The workspace client, re-checking AI_ALLOWED_HOSTS on each request (it may have changed). */
  #guarded(): SafeFetch {
    return async (input, init) => {
      const url = new URL(input);
      if (!this.hostAllowed(url.hostname)) {
        throw new SafeFetchError('ADDRESS_NOT_ALLOWED', "This server doesn't reach that host");
      }
      return this.#workspaceHttp(url, init);
    };
  }

  /** Refuses a request on the instance's provider once the month's credits are used up. */
  async #assertCredits(workspaceId: string, limit: number | null): Promise<void> {
    const { usage, db } = this.#deps;
    if (limit !== null) {
      const used = await withTenant(db, workspaceId, (tx) => this.#creditsUsed(tx, workspaceId));
      if (used >= limit) throw creditsUsedUp(used, limit);
    }
    const decision = await usage.check(workspaceId, 'aiCredits', 1);
    if (!decision.allowed) throw creditsUsedUp(decision.used, decision.limit);
  }

  /**
   * Counts an answered request's credits. A failure to count is logged, never the request's:
   * the answer is already paid for.
   */
  async #countCredits(workspaceId: string, tokens: number): Promise<number> {
    const credits = aiCreditsFor(tokens);
    const { db, usage, logger } = this.#deps;
    try {
      await db.execute(
        sql`SELECT ai_credit_count(${workspaceId}::uuid, ${credits}::int, ${Math.min(Math.max(0, Math.floor(tokens)), 2_000_000_000)}::int)`
      );
      await usage.record(workspaceId, 'aiCredits', credits);
    } catch (err) {
      logger.error({ err, workspaceId, credits }, 'ai: credits not counted');
    }
    return credits;
  }

  #metered(provider: AiProvider, workspaceId: string, instance: InstanceAi | null): AiProvider {
    const { logger } = this.#deps;
    const source: AiSource = instance ? 'instance' : 'workspace';
    const assertCredits = (limit: number | null) => this.#assertCredits(workspaceId, limit);
    const countCredits = (tokens: number) => this.#countCredits(workspaceId, tokens);
    return {
      id: provider.id,
      model: provider.model,
      async chat<T = undefined>(request: AiChatRequest<T>): Promise<AiChatResult<T>> {
        if (instance) await assertCredits(instance.creditLimit);
        const started = Date.now();
        try {
          const result = await provider.chat(request);
          const credits = instance ? await countCredits(result.usage.totalTokens) : 0;
          logger.info(
            {
              workspaceId,
              ai: {
                provider: provider.id,
                source,
                model: result.model,
                tokens: result.usage.totalTokens,
                estimated: result.usage.estimated,
                credits,
                ms: Date.now() - started,
              },
            },
            'ai: request'
          );
          return result;
        } catch (err) {
          if (err instanceof AiProviderError) {
            logger.warn(
              {
                workspaceId,
                ai: {
                  provider: provider.id,
                  source,
                  model: provider.model,
                  code: err.code,
                  detail: err.detail,
                  ms: Date.now() - started,
                },
              },
              'ai: request failed'
            );
          }
          throw err;
        }
      },
    };
  }
}

/** The first day of the next UTC month (YYYY-MM-DD): when the credits start again. */
function nextMonth(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    .toISOString()
    .slice(0, 10);
}

function creditsUsedUp(used: number, limit: number): AiProviderError {
  const resets = usageResetDay(nextMonth(new Date()));
  return new AiProviderError(
    'QUOTA_EXCEEDED',
    `This workspace has used this month's ${limit.toLocaleString('en-US')} AI credits. They reset on ${resets}; an owner can upgrade the plan or add the workspace's own API key in Settings → AI.`,
    `aiCredits ${used}/${limit}`
  );
}
