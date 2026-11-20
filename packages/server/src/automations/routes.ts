import { type Automation, contracts } from '@openrows/shared';
import { audit } from '../audit/record.js';
import type { RouteRegistry } from '../authz/routes.js';
import type { Edition } from '../edition/types.js';
import type { Jobs } from '../jobs/send.js';
import { tableFields } from '../records/service.js';
import { loadTable } from '../tables/service.js';
import { automationButton, clickRecordButton } from './buttons.js';
import { type AutomationRunDeps, retryRun, testAutomation } from './run.js';
import {
  type AutomationContext,
  type AutomationDeps,
  createAutomation,
  deleteAutomation,
  listAutomations,
  listFailedRuns,
  listRuns,
  loadAutomation,
  rotateHookUrl,
  scriptsFor,
  toAutomation,
  updateAutomation,
} from './service.js';

/**
 * Automations under the base: its creators list, create, change, turn on and off and
 * delete them, read their runs, test them and retry failed runs. Resource routes on the
 * base in the path, so ids of other bases and tenants are 404s. Sessions only until the REST API v1 has automations.
 */
export function automationRoutes(
  routes: RouteRegistry,
  deps: AutomationDeps & {
    jobs: Jobs;
    /** Test runs and retries run in the request: the database and outbound steps. */
    run: AutomationRunDeps;
  }
) {
  const a = contracts.automations;
  const access = { resource: 'base', action: 'base:manage_automations' } as const;
  // Tests and retries create records under the workspace's plan too.
  const runDeps = (c: { var: { edition: Edition } }): AutomationRunDeps => ({
    ...deps.run,
    entitlements: c.var.edition.entitlements,
  });

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

  routes.endpoint(a.list, access, async (c) => ({
    automations: await listAutomations(c.var.tx, c.var.resource.id, deps),
    scripts: await scriptsFor(deps, c.var.resource.workspaceId),
  }));

  routes.endpoint(a.create, access, async (c, { body }) => {
    const created = await createAutomation(context(c), body);
    c.var.logger.info({ automationId: created.id }, 'automation created');
    await audit(c, c.var.tx, {
      workspaceId: c.var.resource.workspaceId,
      action: 'automation.create',
      target: { type: 'automation', id: created.id, name: created.name },
      summary: { after: automationSummary(created) },
    });
    return created;
  });

  routes.endpoint(a.get, access, async (c, { params }) =>
    toAutomation(await loadAutomation(c.var.tx, c.var.resource.id, params.automationId), deps)
  );

  routes.endpoint(a.update, access, async (c, { params, body }) => {
    const before = toAutomation(
      await loadAutomation(c.var.tx, c.var.resource.id, params.automationId),
      deps
    );
    const updated = await updateAutomation(context(c), params.automationId, body);
    await audit(c, c.var.tx, {
      workspaceId: c.var.resource.workspaceId,
      action: 'automation.update',
      target: { type: 'automation', id: updated.id, name: updated.name },
      summary: {
        before: automationSummary(before),
        after: { ...automationSummary(updated), changed: Object.keys(body) },
      },
    });
    if (body.enabled !== undefined) {
      c.var.logger.info(
        { automationId: updated.id, enabled: updated.enabled },
        'automation switched'
      );
    }
    return updated;
  });

  routes.endpoint(a.delete, access, async (c, { params }) => {
    const before = toAutomation(
      await loadAutomation(c.var.tx, c.var.resource.id, params.automationId),
      deps
    );
    await deleteAutomation(c.var.tx, c.var.resource.id, params.automationId);
    await audit(c, c.var.tx, {
      workspaceId: c.var.resource.workspaceId,
      action: 'automation.delete',
      target: { type: 'automation', id: before.id, name: before.name },
      summary: { before: automationSummary(before) },
    });
    c.var.logger.info({ automationId: params.automationId }, 'automation deleted');
    return null;
  });

  // The builder's failed runs: every automation's dead letters, to retry from one place.
  routes.endpoint(a.failedRuns, access, async (c, { query }) => ({
    runs: await listFailedRuns(c.var.tx, c.var.resource.id, query.limit),
  }));

  routes.endpoint(a.runs, access, async (c, { params, query }) => ({
    runs: await listRuns(c.var.tx, c.var.resource.id, params.automationId, query),
  }));

  /**
   * The builder's Test: one run now, as the caller with their role, in this request's
   * transaction (run.ts, testAutomation). Not counted; the last run stays.
   */
  routes.endpoint(a.test, access, async (c, { params, body }) => {
    const automation = await loadAutomation(c.var.tx, c.var.resource.id, params.automationId);
    const run = await testAutomation(c.var.tx, runDeps(c), {
      automation,
      userId: c.var.principal.user.id,
      role: c.var.resource.role,
      recordId: body.recordId,
    });
    c.var.logger.info({ automationId: automation.id, runId: run.id }, 'automation tested');
    return run;
  });

  /** A failed run again, once, as the caller (run.ts, retryRun). */
  routes.endpoint(a.retryRun, access, async (c, { params }) => {
    const automation = await loadAutomation(c.var.tx, c.var.resource.id, params.automationId);
    const run = await retryRun(c.var.tx, runDeps(c), {
      automation,
      runId: params.runId,
      userId: c.var.principal.user.id,
      role: c.var.resource.role,
    });
    c.var.logger.info(
      { automationId: automation.id, runId: run.id, retryOf: params.runId },
      'automation run retried'
    );
    return run;
  });

  routes.endpoint(a.rotateWebhook, access, async (c, { params }) => {
    const rotated = await rotateHookUrl(context(c), params.automationId);
    c.var.logger.info({ automationId: rotated.id }, 'automation webhook URL rotated');
    return rotated;
  });

  /**
   * A click on a button field that runs automations: the clicker needs to be able to edit
   * the record (editor and up, the table's "edit records" permission) and to see it. Each enabled
   * automation whose trigger is this button gets a run, which runs as its creator (like every
   * automation) and records the clicker as who started it.
   */
  routes.endpoint(
    a.clickButton,
    { resource: 'table', action: 'record:update' },
    async (c, { params }) => {
      const { tx, resource, principal } = c.var;
      const table = await loadTable(tx, resource.id);
      const field = (await tableFields(tx, table)).find((f) => f.row.id === params.fieldId);
      const { started } = await clickRecordButton(
        {
          tx,
          workspaceId: resource.workspaceId,
          table,
          who: { role: resource.role, userId: principal.user.id },
          jobs: deps.jobs,
        },
        automationButton(field),
        params.recordId
      );
      c.var.logger.info(
        { tableId: table.id, fieldId: params.fieldId, started },
        'automation button clicked'
      );
      return { started };
    }
  );
}

/** What the audit log keeps of an automation: its shape, not its configs or secrets. */
function automationSummary(a: Automation) {
  return {
    name: a.name,
    enabled: a.enabled,
    trigger: a.trigger.type,
    actions: a.actions.map((x) => x.type),
  };
}
