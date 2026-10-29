import { contracts } from '@openrows/shared';
import { z } from 'zod';
import { audit } from '../audit/record.js';
import type { RouteRegistry } from '../authz/routes.js';
import { AppError } from '../lib/errors.js';
import { type RateLimiter, retryAfter, tightestBucket } from '../ratelimit/limiter.js';
import { AiProviderError } from './provider.js';
import type { AiService } from './service.js';

/** Test requests per workspace: a burst of 5, then one every 12 seconds. */
const TEST_RATE = { perSecond: 1 / 12, burst: 5 };

const TestAnswer = z.strictObject({ ok: z.boolean() });

/**
 * AI settings:
 * - `GET /api/workspaces/:workspaceId/ai`: members (`workspace:read`), whether AI features are
 *   on and where the provider comes from; the app hides them when off.
 * - `GET`, `PUT` and `DELETE .../ai/settings`: owners (`workspace:manage_ai`), sessions only.
 *   The key is write-only: no response carries it or any part of it.
 * - `POST .../ai/settings/test`: owners; one tiny structured request to the provider in use,
 *   rate-limited per workspace. A provider's failure is a 200 with `ok: false` and a safe
 *   message (never the provider's own text, which can quote the key).
 */
export function aiRoutes(routes: RouteRegistry, deps: { ai: AiService; limiter: RateLimiter }) {
  const { ai, limiter } = deps;

  routes.endpoint(
    contracts.workspaces.ai,
    { resource: 'workspace', action: 'workspace:read' },
    async (c) => {
      const workspaceId = c.var.resource.id;
      const source = await ai.source(c.var.tx, workspaceId);
      return { workspaceId, available: source !== null, source };
    }
  );

  routes.endpoint(
    contracts.workspaces.aiSettings,
    { resource: 'workspace', action: 'workspace:manage_ai' },
    (c) => ai.settings(c.var.tx, c.var.resource.id)
  );

  routes.endpoint(
    contracts.workspaces.updateAiSettings,
    { resource: 'workspace', action: 'workspace:manage_ai' },
    async (c, { body }) => {
      const settings = await ai.save(c.var.tx, c.var.resource.id, c.var.principal.user.id, body);
      c.var.logger.info(
        { workspaceId: c.var.resource.id, keyChanged: body.apiKey !== undefined },
        'ai: workspace settings saved'
      );
      // The provider's host and model; the key only as whether it was replaced.
      await audit(c, c.var.tx, {
        workspaceId: c.var.resource.id,
        action: 'ai_settings.update',
        target: { type: 'workspace', id: c.var.resource.id },
        summary: {
          after: {
            host: settings.workspace ? hostOf(settings.workspace.baseUrl) : null,
            model: body.model,
            byok: body.apiKey !== undefined ? 'replaced' : 'kept',
          },
        },
      });
      return settings;
    }
  );

  routes.endpoint(
    contracts.workspaces.deleteAiSettings,
    { resource: 'workspace', action: 'workspace:manage_ai' },
    async (c) => {
      const settings = await ai.remove(c.var.tx, c.var.resource.id);
      c.var.logger.info({ workspaceId: c.var.resource.id }, 'ai: workspace key removed');
      await audit(c, c.var.tx, {
        workspaceId: c.var.resource.id,
        action: 'ai_settings.delete',
        target: { type: 'workspace', id: c.var.resource.id },
      });
      return settings;
    }
  );

  routes.endpoint(
    contracts.workspaces.testAiSettings,
    { resource: 'workspace', action: 'workspace:manage_ai' },
    async (c) => {
      const workspaceId = c.var.resource.id;
      const decision = await limiter.take([
        { kind: 'user', key: `ai-test:${workspaceId}`, policy: TEST_RATE },
      ]);
      if (!decision.allowed) {
        const bucket = tightestBucket(decision);
        if (bucket) c.header('Retry-After', String(retryAfter(bucket)));
        throw new AppError('RATE_LIMITED', {
          detail: 'Too many tests. Try again in a few seconds.',
        });
      }
      const resolved = await ai.forWorkspace(c.var.tx, workspaceId);
      if (!resolved) {
        throw new AppError('CONFLICT', {
          detail: 'No AI provider is set up: add an API key first.',
        });
      }
      const started = Date.now();
      try {
        const result = await resolved.provider.chat({
          messages: [
            {
              role: 'user',
              content: 'This is a connection test. Answer with {"ok": true}.',
            },
          ],
          output: { name: 'connection_test', schema: TestAnswer },
          maxTokens: 50,
        });
        const { inputTokens, outputTokens, totalTokens } = result.usage;
        return {
          ok: true,
          source: resolved.source,
          model: result.model,
          error: null,
          usage: { inputTokens, outputTokens, totalTokens },
          latencyMs: Date.now() - started,
        };
      } catch (err) {
        if (!(err instanceof AiProviderError)) throw err;
        return {
          ok: false,
          source: resolved.source,
          model: resolved.provider.model,
          error: err.message,
          usage: null,
          latencyMs: Date.now() - started,
        };
      }
    }
  );
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
