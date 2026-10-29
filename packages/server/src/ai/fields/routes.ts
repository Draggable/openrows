import { contracts } from '@openrows/shared';
import { principalMay } from '../../authz/policy.js';
import type { RouteRegistry } from '../../authz/routes.js';
import { AppError } from '../../lib/errors.js';
import { loadField, loadTable } from '../../tables/service.js';
import type { AiService } from '../service.js';
import { aiFieldStatus, cancelAiField, generateAiField } from './service.js';

/**
 * AI fields, on the field (`field` resource kind):
 * - `GET /api/fields/:fieldId/ai`: everyone on the base (`field:ai_status`), the generation
 *   state: counts and the records not done, with their errors.
 * - `POST .../ai/generate`: editors name records (`recordIds`), creators the whole field
 *   (`scope`: `all` or `missing`); the cells become pending for the worker.
 * - `POST .../ai/cancel`: editors; pending cells become canceled, values kept.
 */
export function aiFieldRoutes(routes: RouteRegistry, deps: { ai: AiService }) {
  const f = contracts.fields;

  routes.endpoint(f.aiStatus, { resource: 'field', action: 'field:ai_status' }, async (c) => {
    const { tx, resource } = c.var;
    const field = await loadField(tx, resource.id);
    const table = await loadTable(tx, field.tableId);
    const available = (await deps.ai.source(tx, resource.workspaceId)) !== null;
    return aiFieldStatus(tx, table, field, available);
  });

  routes.endpoint(
    f.aiGenerate,
    { resource: 'field', action: 'field:ai_generate' },
    async (c, { body }) => {
      const { tx, resource, principal } = c.var;
      if (!('recordIds' in body) && !principalMay(principal, resource.role, 'field:update')) {
        throw new AppError('FORBIDDEN', {
          detail: 'Generating a whole field needs the creator role.',
        });
      }
      if ((await deps.ai.source(tx, resource.workspaceId)) === null) {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'AI is off for this workspace. An owner can set it up in Settings → AI.',
        });
      }
      const field = await loadField(tx, resource.id);
      const table = await loadTable(tx, field.tableId);
      const queued = await generateAiField(tx, table, field, body, principal.user.id);
      c.var.logger.info({ fieldId: field.id, queued }, 'ai field: generation requested');
      return { queued };
    }
  );

  routes.endpoint(f.aiCancel, { resource: 'field', action: 'field:ai_generate' }, async (c) => {
    const { tx, resource, principal } = c.var;
    const field = await loadField(tx, resource.id);
    const table = await loadTable(tx, field.tableId);
    return { canceled: await cancelAiField(tx, table, field, principal.user.id) };
  });
}
