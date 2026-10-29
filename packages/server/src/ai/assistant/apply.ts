import {
  type AssistantAction,
  type AssistantApplyResult,
  type AssistantFieldSpec,
  type AssistantPlan,
  type AutomationAction,
  type AutomationTrigger,
  type CreateFieldInput,
  checkPlan,
  createAutomationSchema,
  nextChoiceColor,
} from '@openrows/shared';
import { uuidv7 } from 'uuidv7';
import { type AutomationDeps, createAutomation } from '../../automations/service.js';
import type { BaseRow } from '../../bases/service.js';
import {
  createField,
  type FieldRow,
  liveFields,
  type SchemaContext,
  type TableRow,
  updateField,
} from '../../fields/service.js';
import { AppError } from '../../lib/errors.js';
import { createTable, liveTables, loadTable } from '../../tables/service.js';
import { createView, loadView, updateView } from '../../views/service.js';
import { describedBase } from './schema.js';

const lower = (s: string) => s.trim().toLowerCase();

function choices(names: readonly string[]) {
  return names.map((name, i) => ({
    id: `sel${uuidv7().replaceAll('-', '').slice(-12)}`,
    name,
    color: nextChoiceColor(i),
  }));
}

class Names {
  readonly #tables = new Map<string, TableRow>();
  constructor(
    private readonly ctx: SchemaContext,
    rows: TableRow[]
  ) {
    for (const t of rows) this.#tables.set(lower(t.name), t);
  }
  add(row: TableRow) {
    this.#tables.set(lower(row.name), row);
  }
  table(name: string): TableRow {
    const row = this.#tables.get(lower(name));
    if (!row)
      throw new AppError('VALIDATION_FAILED', { detail: `There is no table named "${name}".` });
    return row;
  }
  async field(table: TableRow, name: string): Promise<FieldRow> {
    const row = (await liveFields(this.ctx.tx, table.id)).find(
      (f) => lower(f.name) === lower(name)
    );
    if (!row) {
      throw new AppError('VALIDATION_FAILED', {
        detail: `"${table.name}" has no field "${name}".`,
      });
    }
    return row;
  }
}

function fieldInput(spec: AssistantFieldSpec, names: Names): CreateFieldInput {
  const input: CreateFieldInput = { name: spec.name, type: spec.type };
  if (spec.description) input.description = spec.description;
  if (spec.type === 'singleSelect' || spec.type === 'multipleSelect') {
    input.options = { choices: choices(spec.choices ?? []) };
  } else if (spec.type === 'formula') {
    input.options = { formula: spec.formula ?? '' };
  } else if (spec.type === 'link' && spec.linkedTable) {
    input.options = { linkedTableId: names.table(spec.linkedTable).id };
  }
  return input;
}

async function cells(
  names: Names,
  table: TableRow,
  list: readonly { field: string; value: string }[]
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const cell of list) out[(await names.field(table, cell.field)).id] = cell.value;
  return out;
}

async function action(
  names: Names,
  table: TableRow,
  a: AssistantAction
): Promise<AutomationAction> {
  if (a.type === 'sendEmail')
    return { type: 'sendEmail', to: a.to, subject: a.subject, body: a.body };
  if (a.type === 'updateRecord') {
    return {
      type: 'updateRecord',
      tableId: table.id,
      recordId: '{{trigger.record.id}}',
      fields: await cells(names, table, a.cells),
    };
  }
  const target = names.table(a.table);
  return { type: 'createRecord', tableId: target.id, fields: await cells(names, target, a.cells) };
}

/**
 * Applies a change plan the user confirmed, in the request's transaction: every operation
 * goes through the service the matching API route uses (tables, fields with their formula and
 * link checks, views, automations, created switched off), as the user. The plan is checked
 * against the base as it is now first; any problem refuses the whole plan (422), and a service's
 * refusal rolls everything back.
 */
export async function applyPlan(
  ctx: SchemaContext,
  base: BaseRow,
  plan: AssistantPlan,
  automationDeps: AutomationDeps
): Promise<AssistantApplyResult> {
  const { tx } = ctx;
  const problems = checkPlan(plan, (await describedBase(tx, base.id)).base);
  if (problems.length > 0) {
    throw new AppError('VALIDATION_FAILED', {
      detail: "The plan doesn't fit the base as it is now.",
      extensions: {
        errors: problems.map((p) => ({
          path: `plan.operations.${p.operation}`,
          message: p.message,
        })),
      },
    });
  }
  const names = new Names(ctx, await liveTables(tx, base.id));
  const result: AssistantApplyResult = {
    baseId: base.id,
    tables: 0,
    fields: 0,
    views: 0,
    automations: 0,
    firstTableId: null,
  };

  for (const op of plan.operations) {
    if (op.op === 'createTable') {
      const [primary, ...rest] = op.fields;
      if (!primary) continue;
      const created = await createTable(ctx, base, {
        name: op.name,
        ...(op.description ? { description: op.description } : {}),
        primaryFieldName: primary.name,
      });
      const table = await loadTable(tx, created.id);
      names.add(table);
      result.tables++;
      result.firstTableId ??= table.id;
      const primaryRow = await names.field(table, primary.name);
      if (primary.type !== 'singleLineText' || primary.description) {
        const { name: _name, ...change } = fieldInput(primary, names);
        await updateField(ctx, primaryRow, change);
      }
      result.fields++;
      for (const spec of rest) {
        await createField(ctx, table, fieldInput(spec, names));
        result.fields++;
      }
    } else if (op.op === 'createField') {
      await createField(ctx, names.table(op.table), fieldInput(op.field, names));
      result.fields++;
    } else if (op.op === 'createView') {
      const table = names.table(op.table);
      const view = await createView(ctx, table, { name: op.name, type: op.type });
      if (op.field && (op.type === 'kanban' || op.type === 'calendar')) {
        const fieldId = (await names.field(table, op.field)).id;
        await updateView(
          ctx,
          await loadView(tx, view.id),
          op.type === 'kanban'
            ? { kanban: { stackFieldId: fieldId } }
            : { calendar: { dateFields: [{ startFieldId: fieldId }] } },
          { canLock: true }
        );
      }
      result.views++;
    } else {
      const table = names.table(op.table);
      const trigger: AutomationTrigger =
        op.trigger === 'recordCreated'
          ? { type: 'recordCreated', tableId: table.id }
          : {
              type: 'recordUpdated',
              tableId: table.id,
              fieldIds: op.watchFields?.length
                ? await Promise.all(
                    op.watchFields.map(async (n) => (await names.field(table, n)).id)
                  )
                : null,
            };
      const actions: AutomationAction[] = [];
      for (const a of op.actions) actions.push(await action(names, table, a));
      await createAutomation(
        {
          tx,
          workspaceId: ctx.workspaceId,
          baseId: base.id,
          userId: ctx.userId,
          deps: automationDeps,
        },
        createAutomationSchema.parse({ name: op.name, trigger, actions, enabled: false })
      );
      result.automations++;
    }
  }
  return result;
}
