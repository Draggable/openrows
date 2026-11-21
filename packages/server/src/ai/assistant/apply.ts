import {
  type AssistantAction,
  type AssistantApplyResult,
  type AssistantAutomationOp,
  type AssistantFieldSpec,
  type AssistantFilter,
  type AssistantPlan,
  type AutomationAction,
  type AutomationTrigger,
  type CreateFieldInput,
  createAutomationSchema,
  type FilterGroup,
  linkOptionsSchema,
  MAX_FIND_RECORDS,
  nextChoiceColor,
  type UpdateViewInput,
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
import { createView, liveViews, loadView, updateView } from '../../views/service.js';
import { planProblems } from './plan.js';
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
  readonly #byId = new Map<string, TableRow>();
  constructor(
    private readonly ctx: SchemaContext,
    rows: TableRow[]
  ) {
    for (const t of rows) this.add(t);
  }
  add(row: TableRow) {
    this.#tables.set(lower(row.name), row);
    this.#byId.set(row.id, row);
  }
  /** The table a link field links to. */
  linked(link: FieldRow): TableRow {
    const id = linkOptionsSchema.safeParse(link.config ?? {}).data?.linkedTableId;
    const row = id ? this.#byId.get(id) : undefined;
    if (!row) {
      throw new AppError('VALIDATION_FAILED', {
        detail: `"${link.name}" links to no table of this base.`,
      });
    }
    return row;
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

/**
 * A planned field as the field service's input: names resolved to ids (the linked table, a
 * lookup's link and looked-up field), choices with colours. AI prompts keep their `{Field name}`
 * references, which the field service stores by id.
 */
async function fieldInput(
  spec: AssistantFieldSpec,
  table: TableRow,
  names: Names
): Promise<CreateFieldInput> {
  const input: CreateFieldInput = { name: spec.name, type: spec.type };
  if (spec.description) input.description = spec.description;
  if (spec.type === 'singleSelect' || spec.type === 'multipleSelect') {
    input.options = { choices: choices(spec.choices ?? []) };
  } else if (spec.type === 'formula') {
    input.options = { formula: spec.formula ?? '' };
  } else if (spec.type === 'link' && spec.linkedTable) {
    input.options = { linkedTableId: names.table(spec.linkedTable).id };
  } else if (spec.type === 'lookup' || spec.type === 'rollup' || spec.type === 'count') {
    const link = await names.field(table, spec.linkField ?? '');
    const options: Record<string, unknown> = { recordLinkFieldId: link.id };
    if (spec.type !== 'count') {
      const source = await names.field(names.linked(link), spec.linkedField ?? '');
      options['fieldIdInLinkedTable'] = source.id;
    }
    if (spec.type === 'rollup' && spec.aggregation) options['function'] = spec.aggregation;
    input.options = options;
  } else if (spec.type === 'button' && spec.button) {
    input.options = {
      label: spec.button.label,
      action: spec.button.action,
      // Only a button that opens a URL has a formula; one that runs automations has none.
      ...(spec.button.action === 'openUrl' ? { formula: spec.formula ?? '' } : {}),
    };
  } else if (spec.type === 'ai' && spec.ai) {
    input.options = {
      prompt: spec.ai.prompt,
      output: spec.ai.output,
      ...(spec.ai.output === 'singleSelect' ? { choices: choices(spec.choices ?? []) } : {}),
    };
  }
  return input;
}

/** A planned view's layout, by field ids: what the view service checks and saves. */
async function viewLayout(
  op: Extract<AssistantPlan['operations'][number], { op: 'createView' }>,
  table: TableRow,
  names: Names
): Promise<UpdateViewInput | null> {
  if (!op.field) return null;
  const fieldId = (await names.field(table, op.field)).id;
  switch (op.type) {
    case 'kanban':
      return { kanban: { stackFieldId: fieldId } };
    case 'calendar':
      return { calendar: { dateFields: [{ startFieldId: fieldId }] } };
    case 'timeline':
      return {
        timeline: {
          startFieldId: fieldId,
          endFieldId: op.endField ? (await names.field(table, op.endField)).id : null,
        },
      };
    case 'list':
      return { list: { parentFieldId: fieldId } };
    default:
      return null;
  }
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

/** A planned filter by field ids: the view filter language the automations engine takes. */
async function filterOf(
  names: Names,
  table: TableRow,
  filter: AssistantFilter
): Promise<FilterGroup> {
  const conditions: FilterGroup['conditions'] = [];
  for (const c of filter.conditions) {
    const fieldId = (await names.field(table, c.field)).id;
    const empty = c.operator === 'isEmpty' || c.operator === 'isNotEmpty' || c.value === null;
    conditions.push({ fieldId, operator: c.operator, ...(empty ? {} : { value: c.value }) });
  }
  return { conjunction: filter.conjunction, conditions };
}

/** The table a findRecords step reads, by the step's number. */
type Found = Map<number, TableRow>;

async function action(
  names: Names,
  table: TableRow | null,
  a: AssistantAction,
  n: number,
  found: Found
): Promise<AutomationAction> {
  switch (a.type) {
    case 'sendEmail':
      return { type: 'sendEmail', to: a.to, subject: a.subject, body: a.body };
    case 'updateRecord': {
      const target = a.step === null ? table : (found.get(a.step) ?? null);
      if (!target) {
        throw new AppError('VALIDATION_FAILED', { detail: `Step ${n} has no record to update.` });
      }
      return {
        type: 'updateRecord',
        tableId: target.id,
        recordId: a.step === null ? '{{trigger.record.id}}' : `{{steps.${a.step}.records}}`,
        fields: await cells(names, target, a.cells),
      };
    }
    case 'createRecord': {
      const target = names.table(a.table);
      return {
        type: 'createRecord',
        tableId: target.id,
        fields: await cells(names, target, a.cells),
      };
    }
    case 'findRecords': {
      const target = names.table(a.table);
      found.set(n, target);
      return {
        type: 'findRecords',
        tableId: target.id,
        ...(a.filter ? { filter: await filterOf(names, target, a.filter) } : {}),
        limit: a.limit ?? MAX_FIND_RECORDS,
      };
    }
    case 'httpRequest': {
      const body = a.body?.trim() ? (JSON.parse(a.body) as unknown) : undefined;
      return {
        type: 'httpRequest',
        method: a.method,
        url: a.url.trim(),
        // Plain headers only: secret ones are the user's to add in the builder.
        headers: a.headers.map((h) => ({ name: h.name, value: h.value, secret: false })),
        ...(body !== undefined && a.method !== 'GET' ? { body } : {}),
      };
    }
  }
}

/** A planned trigger by ids: its table, form view, button field, conditions or schedule. */
async function triggerOf(
  ctx: SchemaContext,
  names: Names,
  op: AssistantAutomationOp,
  table: TableRow | null
): Promise<AutomationTrigger> {
  if (op.trigger === 'scheduled') {
    if (!op.schedule) throw new AppError('VALIDATION_FAILED', { detail: 'No schedule.' });
    return { type: 'scheduled', schedule: op.schedule };
  }
  if (op.trigger === 'webhookReceived') return { type: 'webhookReceived' };
  if (!table) {
    throw new AppError('VALIDATION_FAILED', { detail: `A ${op.trigger} trigger needs a table.` });
  }
  switch (op.trigger) {
    case 'recordCreated':
      return { type: 'recordCreated', tableId: table.id };
    case 'recordUpdated':
      return {
        type: 'recordUpdated',
        tableId: table.id,
        fieldIds: op.watchFields?.length
          ? await Promise.all(op.watchFields.map(async (n) => (await names.field(table, n)).id))
          : null,
      };
    case 'recordMatches':
      if (!op.filter) throw new AppError('VALIDATION_FAILED', { detail: 'No conditions.' });
      return {
        type: 'recordMatches',
        tableId: table.id,
        filter: await filterOf(names, table, op.filter),
      };
    case 'formSubmitted': {
      const form = (await liveViews(ctx.tx, table.id, ctx.userId)).find(
        (v) => v.type === 'form' && lower(v.name) === lower(op.formView ?? '')
      );
      if (!form) {
        throw new AppError('VALIDATION_FAILED', {
          detail: `"${table.name}" has no form view "${op.formView ?? ''}".`,
        });
      }
      return { type: 'formSubmitted', tableId: table.id, viewId: form.id };
    }
    case 'buttonClicked':
      return {
        type: 'buttonClicked',
        tableId: table.id,
        fieldId: (await names.field(table, op.buttonField ?? '')).id,
      };
  }
}

/**
 * Applies a change plan the user confirmed, in the request's transaction: every operation
 * goes through the service the matching API route uses (tables, fields with their formula,
 * link, lookup, rollup, count, button and AI checks, views with their layout checks,
 * automations with every trigger and action the plan holds, created switched off), as the
 * user. The plan is checked against the base as it is now first (HTTP steps' URLs against the
 * outbound rules too); any problem refuses the whole plan (422), and a service's refusal rolls
 * everything back.
 */
export async function applyPlan(
  ctx: SchemaContext,
  base: BaseRow,
  plan: AssistantPlan,
  automationDeps: AutomationDeps
): Promise<AssistantApplyResult> {
  const { tx } = ctx;
  const problems = await planProblems(
    plan,
    (await describedBase(tx, base.id, ctx.userId)).base,
    automationDeps.checkUrl
  );
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
        const { name: _name, ...change } = await fieldInput(primary, table, names);
        await updateField(ctx, primaryRow, change);
      }
      result.fields++;
      for (const spec of rest) {
        await createField(ctx, table, await fieldInput(spec, table, names));
        result.fields++;
      }
    } else if (op.op === 'createField') {
      const table = names.table(op.table);
      await createField(ctx, table, await fieldInput(op.field, table, names));
      result.fields++;
    } else if (op.op === 'createView') {
      const table = names.table(op.table);
      const view = await createView(ctx, table, { name: op.name, type: op.type });
      const layout = await viewLayout(op, table, names);
      if (layout) await updateView(ctx, await loadView(tx, view.id), layout, { canLock: true });
      result.views++;
    } else {
      const table = op.table === null ? null : names.table(op.table);
      const trigger = await triggerOf(ctx, names, op, table);
      const actions: AutomationAction[] = [];
      const found: Found = new Map();
      for (const [i, a] of op.actions.entries()) {
        actions.push(await action(names, table, a, i + 1, found));
      }
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
