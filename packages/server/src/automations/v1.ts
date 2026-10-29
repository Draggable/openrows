import {
  type Automation,
  type ButtonOptions,
  contracts,
  MAX_AUTOMATION_HOOK_BYTES,
  type V1Automation,
} from '@openrows/shared';
import { eq, sql } from 'drizzle-orm';
import { bodyLimit } from 'hono/body-limit';
import { uuidv7 } from 'uuidv7';
import { audit } from '../audit/record.js';
import { assertAllowed, authorize } from '../authz/policy.js';
import { resolveResource } from '../authz/resolve.js';
import type { RouteRegistry } from '../authz/routes.js';
import { automations } from '../db/index.js';
import { workspaceGroup } from '../jobs/defer.js';
import type { Jobs } from '../jobs/send.js';
import { AppError } from '../lib/errors.js';
import { assertTableAllows } from '../records/permissions.js';
import { getRecord, tableFields } from '../records/service.js';
import { loadTable } from '../tables/service.js';
import {
  type AutomationContext,
  type AutomationDeps,
  listAutomations,
  listRuns,
  loadAutomation,
  toAutomation,
  updateAutomation,
} from './service.js';
import { AUTOMATION_QUEUE } from './subscriber.js';

export interface V1AutomationDeps extends AutomationDeps {
  jobs: Jobs;
}

/** The API's view of an automation: no webhook URL (a credential) and no last request. */
function toV1({ webhookUrl: _url, webhookSample: _sample, ...rest }: Automation): V1Automation {
  return rest;
}

const conflict = (detail: string) => new AppError('CONFLICT', { detail });
const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_FAILED', {
    detail: message,
    extensions: { errors: [{ path, message }] },
  });

/**
 * Automations in the REST API v1: a base's creators, and their tokens with
 * `automations:read` (list, get, runs), `automations:manage` (turn on or off) and
 * `automations:run` (trigger), read, switch and trigger the automations they built in the app.
 * Resource routes on the base in the path, so ids of other bases and tenants are 404s. Building
 * and changing automations stays in the app (sessions only, `base:manage_automations`).
 *
 * A trigger queues one run exactly as the automation's own trigger would: a webhook-received
 * automation gets the body as if POSTed to its URL; a button-clicked one a click on the record's
 * button by the caller, who must be able to edit the record (as for the button itself). The run
 * runs as the automation's creator, in the worker, under the workspace's quotas.
 */
export function v1AutomationRoutes(routes: RouteRegistry, deps: V1AutomationDeps) {
  const a = contracts.v1Automations;
  const read = { resource: 'base', action: 'base:read_automations' } as const;

  routes.use(
    a.trigger.path,
    bodyLimit({
      // The body plus its `{ "body": … }` wrapper.
      maxSize: MAX_AUTOMATION_HOOK_BYTES + 1024,
      onError: () => {
        throw new AppError('PAYLOAD_TOO_LARGE', { detail: 'A trigger body is at most 100 KB.' });
      },
    })
  );

  const context = (c: {
    var: {
      tx: AutomationContext['tx'];
      resource: { id: string; workspaceId: string };
      principal: { user: { id: string } };
    };
  }): AutomationContext => ({
    tx: c.var.tx,
    workspaceId: c.var.resource.workspaceId,
    baseId: c.var.resource.id,
    userId: c.var.principal.user.id,
    deps,
  });

  routes.endpoint(a.list, read, async (c) => ({
    automations: (await listAutomations(c.var.tx, c.var.resource.id, deps)).map(
      ({ runCount: _n, ...x }) => toV1(x)
    ),
  }));

  routes.endpoint(a.get, read, async (c, { params }) =>
    toV1(toAutomation(await loadAutomation(c.var.tx, c.var.resource.id, params.automationId)))
  );

  routes.endpoint(a.runs, read, async (c, { params, query }) => ({
    runs: await listRuns(c.var.tx, c.var.resource.id, params.automationId, query),
  }));

  routes.endpoint(
    a.update,
    { resource: 'base', action: 'base:toggle_automations' },
    async (c, { params, body }) => {
      const before = await loadAutomation(c.var.tx, c.var.resource.id, params.automationId);
      const updated = await updateAutomation(context(c), params.automationId, {
        enabled: body.enabled,
      });
      if (before.enabled !== updated.enabled) {
        await audit(c, c.var.tx, {
          workspaceId: c.var.resource.workspaceId,
          action: 'automation.update',
          target: { type: 'automation', id: updated.id, name: updated.name },
          summary: {
            before: { enabled: before.enabled },
            after: { enabled: updated.enabled, changed: ['enabled'] },
          },
        });
        c.var.logger.info(
          { automationId: updated.id, enabled: updated.enabled },
          'automation switched'
        );
      }
      return toV1(updated);
    }
  );

  routes.endpoint(
    a.trigger,
    { resource: 'base', action: 'base:run_automations' },
    async (c, { params, body }) => {
      const { tx, resource, principal } = c.var;
      const userId = principal.user.id;
      const row = await loadAutomation(tx, resource.id, params.automationId);
      const automation = toAutomation(row);
      const { trigger } = automation;
      if (trigger.type !== 'webhookReceived' && trigger.type !== 'buttonClicked') {
        throw conflict('Only webhook-received and button-clicked automations can be triggered.');
      }
      if (!automation.enabled) throw conflict('This automation is off. Turn it on first.');
      const group = { group: workspaceGroup(resource.workspaceId) };

      if (trigger.type === 'webhookReceived') {
        if (body.recordId !== undefined) {
          throw invalid('recordId', 'A webhook automation takes a body, not a record.');
        }
        const hookBody = body.body ?? {};
        if (Buffer.byteLength(JSON.stringify(hookBody)) > MAX_AUTOMATION_HOOK_BYTES) {
          throw new AppError('PAYLOAD_TOO_LARGE', { detail: 'A trigger body is at most 100 KB.' });
        }
        const requestId = uuidv7();
        const receivedAt = new Date();
        // Kept as the sample the builder maps fields from, as a request to its URL would be.
        await tx
          .update(automations)
          .set({
            hookSample: hookBody as Record<string, unknown>,
            hookSampleAt: receivedAt,
            updatedAt: sql`${automations.updatedAt}`,
          })
          .where(eq(automations.id, row.id));
        await deps.jobs.send(
          tx,
          AUTOMATION_QUEUE,
          {
            workspaceId: resource.workspaceId,
            subscriberId: row.id,
            hook: { requestId, receivedAt: receivedAt.toISOString(), body: hookBody },
          },
          group
        );
        c.var.logger.info({ automationId: row.id }, 'automation triggered (webhook)');
        return { queued: true as const, triggerId: requestId };
      }

      // A button click on the record, as the caller: they must be able to edit and see it.
      if (body.recordId === undefined) {
        throw invalid('recordId', 'A button automation needs the record whose button to click.');
      }
      const resolved = await resolveResource(tx, 'table', trigger.tableId, userId);
      const role = assertAllowed(
        authorize(principal, 'record:update', resolved, 'automations:run')
      );
      const table = await loadTable(tx, trigger.tableId);
      const field = (await tableFields(tx, table)).find((f) => f.row.id === trigger.fieldId);
      if (
        field?.row.type !== 'button' ||
        (field.options as ButtonOptions).action !== 'runAutomation'
      ) {
        throw conflict("The automation's button no longer runs automations.");
      }
      assertTableAllows(table, 'editRecords', { role, userId });
      const record = await getRecord(
        { tx, workspaceId: resource.workspaceId, userId, table },
        body.recordId
      );
      const clickId = uuidv7();
      await deps.jobs.send(
        tx,
        AUTOMATION_QUEUE,
        {
          workspaceId: resource.workspaceId,
          subscriberId: row.id,
          button: { clickId, recordId: record.id, fieldId: field.row.id, userId },
        },
        group
      );
      c.var.logger.info({ automationId: row.id }, 'automation triggered (button)');
      return { queued: true as const, triggerId: clickId };
    }
  );
}
