import { contracts } from '@openrows/shared';
import { eq } from 'drizzle-orm';
import type { RouteRegistry } from '../../authz/routes.js';
import type { AutomationDeps } from '../../automations/service.js';
import { createBase } from '../../bases/service.js';
import { bases } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import { type RateLimiter, retryAfter, tightestBucket } from '../../ratelimit/limiter.js';
import { type AiProvider, AiProviderError } from '../provider.js';
import type { AiService } from '../service.js';
import { applyPlan } from './apply.js';
import { generatePlan } from './plan.js';
import { describedBase, sampleRecords } from './schema.js';

/** Plans per user: a burst of 10, then one every 6 seconds. */
const PLAN_RATE = { perSecond: 1 / 6, burst: 10 };

function providerError(err: unknown): never {
  if (!(err instanceof AiProviderError)) throw err;
  if (err.code === 'QUOTA_EXCEEDED') throw new AppError('QUOTA_EXCEEDED', { detail: err.message });
  if (err.code === 'RATE_LIMITED') throw new AppError('RATE_LIMITED', { detail: err.message });
  throw new AppError('SERVICE_UNAVAILABLE', {
    detail: `The AI assistant couldn't answer. ${err.message}`,
  });
}

/**
 * The AI assistant: change plans proposed by the workspace's AI provider, applied
 * only when the user confirms them. Creators only (they could make every change by hand), and
 * sessions only. The plan routes never write; the apply routes take the confirmed plan back,
 * check it against the base again and run it through the usual services in one transaction.
 * - `POST /api/bases/:baseId/assistant/plan` and `.../apply`: `base:ai_assistant`.
 * - `POST /api/workspaces/:workspaceId/assistant/plan` and `.../apply`: "Describe it", a new
 *   base (`base:create`).
 */
export function assistantRoutes(
  routes: RouteRegistry,
  deps: { ai: AiService; limiter: RateLimiter; automations: AutomationDeps }
) {
  const { ai, limiter } = deps;

  async function provider(
    c: { header: (name: string, value: string) => void },
    tx: Parameters<AiService['forWorkspace']>[0],
    workspaceId: string,
    userId: string
  ): Promise<AiProvider> {
    const decision = await limiter.take([
      { kind: 'user', key: `ai-assistant:${userId}`, policy: PLAN_RATE },
    ]);
    if (!decision.allowed) {
      const bucket = tightestBucket(decision);
      if (bucket) c.header('Retry-After', String(retryAfter(bucket)));
      throw new AppError('RATE_LIMITED', {
        detail: 'Too many requests to the assistant. Try again in a few seconds.',
      });
    }
    const resolved = await ai.forWorkspace(tx, workspaceId);
    if (!resolved) {
      throw new AppError('CONFLICT', {
        detail: 'AI is off for this workspace. An owner can set it up in Settings → AI.',
      });
    }
    return resolved.provider;
  }

  routes.endpoint(
    contracts.bases.assistantPlan,
    { resource: 'base', action: 'base:ai_assistant', token: null },
    async (c, { body }) => {
      const { tx, resource, principal } = c.var;
      const model = await provider(c, tx, resource.workspaceId, principal.user.id);
      const { base, tables } = await describedBase(tx, resource.id);
      const records = body.includeRecords
        ? await sampleRecords(
            { tx, workspaceId: resource.workspaceId, userId: principal.user.id },
            tables
          )
        : undefined;
      try {
        const result = await generatePlan(model, {
          base,
          prompt: body.prompt,
          newBase: false,
          records,
        });
        c.var.logger.info(
          {
            baseId: resource.id,
            operations: result.plan.operations.length,
            problems: result.problems.length,
            attempts: result.attempts,
            includeRecords: body.includeRecords,
          },
          'ai assistant: plan proposed'
        );
        return result;
      } catch (err) {
        providerError(err);
      }
    }
  );

  routes.endpoint(
    contracts.bases.assistantApply,
    { resource: 'base', action: 'base:ai_assistant', token: null },
    async (c, { body }) => {
      const { tx, resource, principal } = c.var;
      const [base] = await tx.select().from(bases).where(eq(bases.id, resource.id));
      if (!base) throw new Error('authorized base not visible under RLS');
      const ctx = {
        tx,
        workspaceId: resource.workspaceId,
        userId: principal.user.id,
        role: resource.role,
      };
      const result = await applyPlan(ctx, base, body.plan, deps.automations);
      c.var.logger.info(result, 'ai assistant: plan applied');
      return result;
    }
  );

  routes.endpoint(
    contracts.workspaces.assistantPlan,
    { resource: 'workspace', action: 'base:create', token: null },
    async (c, { body }) => {
      const { tx, resource, principal } = c.var;
      const model = await provider(c, tx, resource.workspaceId, principal.user.id);
      try {
        const result = await generatePlan(model, {
          base: { tables: [] },
          prompt: body.prompt,
          newBase: true,
        });
        c.var.logger.info(
          {
            workspaceId: resource.workspaceId,
            operations: result.plan.operations.length,
            problems: result.problems.length,
            attempts: result.attempts,
          },
          'ai assistant: base plan proposed'
        );
        return result;
      } catch (err) {
        providerError(err);
      }
    }
  );

  routes.endpoint(
    contracts.workspaces.assistantApply,
    { resource: 'workspace', action: 'base:create', token: null },
    async (c, { body }) => {
      const { tx, resource, principal } = c.var;
      const ctx = {
        tx,
        workspaceId: resource.workspaceId,
        userId: principal.user.id,
        role: resource.role,
      };
      const created = await createBase(ctx, { name: body.name }, resource.role);
      const [base] = await tx.select().from(bases).where(eq(bases.id, created.id));
      if (!base) throw new Error('created base not visible under RLS');
      const result = await applyPlan(ctx, base, body.plan, deps.automations);
      c.var.logger.info({ ...result }, 'ai assistant: base created from a plan');
      return result;
    }
  );
}
