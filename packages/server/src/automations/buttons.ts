import type { ButtonOptions, PermissionSubject } from '@openrows/shared';
import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { automations, type Transaction } from '../db/index.js';
import type { TableRow } from '../fields/service.js';
import { workspaceGroup } from '../jobs/defer.js';
import type { Jobs } from '../jobs/send.js';
import { AppError } from '../lib/errors.js';
import { assertTableAllows } from '../records/permissions.js';
import { type FieldInfo, getRecord } from '../records/service.js';
import { AUTOMATION_QUEUE } from './subscriber.js';

/**
 * Button fields that run automations: what a click checks and starts, whether it comes from the
 * base (`automations.clickButton`) or from an interface page (`interfaces.clickPageButton`), so
 * both apply the same rules. The caller has already checked the clicker's role (`record:update`).
 */

export interface ButtonClickContext {
  tx: Transaction;
  workspaceId: string;
  table: TableRow;
  /** Who clicks, with their effective role (the table's "edit records" permission binds them). */
  who: PermissionSubject & { userId: string };
  jobs: Jobs;
}

/** The field as a button that runs automations: 404 for anything else, 409 for a URL button. */
export function automationButton(field: FieldInfo | undefined): FieldInfo {
  if (field?.row.type !== 'button') {
    throw new AppError('NOT_FOUND', { detail: 'No such button field in this table.' });
  }
  if ((field.options as ButtonOptions).action !== 'runAutomation') {
    throw new AppError('CONFLICT', { detail: 'This button opens a URL; it runs nothing.' });
  }
  return field;
}

/** The enabled automations a click on the button field starts. */
export async function buttonTargets(
  tx: Transaction,
  tableId: string,
  fieldId: string
): Promise<{ id: string }[]> {
  return tx
    .select({ id: automations.id })
    .from(automations)
    .where(
      and(
        eq(automations.tableId, tableId),
        eq(automations.enabled, true),
        eq(automations.triggerType, 'buttonClicked'),
        sql`${automations.trigger}->>'fieldId' = ${fieldId}`
      )
    );
}

/**
 * A click on a record's button: the table's "edit records" permission binds the clicker, the
 * record must be live, and each enabled automation triggered by the button gets a run (as its
 * creator, like every automation, recording the clicker). `requireTarget` refuses a click that
 * would start nothing (409) instead of answering `started: 0`.
 */
export async function clickRecordButton(
  ctx: ButtonClickContext,
  field: FieldInfo,
  recordId: string,
  opts: { requireTarget?: boolean } = {}
): Promise<{ started: number }> {
  const { tx, workspaceId, table, who } = ctx;
  const button = automationButton(field);
  assertTableAllows(table, 'editRecords', who);
  const record = await getRecord({ tx, workspaceId, userId: who.userId, table }, recordId);
  const targets = await buttonTargets(tx, table.id, button.row.id);
  if (opts.requireTarget && targets.length === 0) {
    throw new AppError('CONFLICT', { detail: 'No automation is turned on for this button.' });
  }
  const clickId = uuidv7();
  for (const target of targets) {
    await ctx.jobs.send(
      tx,
      AUTOMATION_QUEUE,
      {
        workspaceId,
        subscriberId: target.id,
        button: { clickId, recordId: record.id, fieldId: button.row.id, userId: who.userId },
      },
      { group: workspaceGroup(workspaceId) }
    );
  }
  return { started: targets.length };
}
