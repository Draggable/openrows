import {
  type AssistantFieldSpec,
  type AssistantOperation,
  type AssistantPlan,
  type AssistantProblem,
  getFieldType,
  isFieldTypeName,
} from '@openrows/shared';

/**
 * The assistant panel's model: a plan's operations as the diff the user reviews, which of
 * them are ticked (all but those with problems), and the plan that "Apply" sends.
 */

export type OperationKind = 'table' | 'field' | 'view' | 'automation';

export interface OperationRow {
  index: number;
  kind: OperationKind;
  /** "Table Customers", "Field Total in Orders"... */
  title: string;
  /** One line per field, the formula, the view's field, the trigger and actions. */
  details: string[];
  problems: string[];
}

export function typeLabel(type: string): string {
  return isFieldTypeName(type) ? getFieldType(type).label : type;
}

const VIEW_LABELS: Record<string, string> = {
  grid: 'Grid',
  kanban: 'Kanban',
  calendar: 'Calendar',
  gallery: 'Gallery',
  form: 'Form',
  timeline: 'Timeline',
  list: 'List',
};

function fieldLine(f: AssistantFieldSpec): string {
  const parts = [`${f.name}: ${typeLabel(f.type)}`];
  if (f.type === 'lookup' || f.type === 'rollup' || f.type === 'count') {
    const what = f.type === 'count' ? 'records' : `"${f.linkedField ?? '?'}"`;
    parts.push(
      `(${f.type === 'rollup' ? `${f.aggregation ?? '?'} of ` : ''}${what} through ${f.linkField ?? '?'})`
    );
  }
  if (f.type === 'button' && f.button) {
    parts.push(
      `"${f.button.label}" (${f.button.action === 'openUrl' ? 'opens a URL' : 'runs automations'})`
    );
  }
  if (f.type === 'ai' && f.ai) parts.push(`(answers ${f.ai.output}): ${f.ai.prompt}`);
  if (f.choices?.length) parts.push(`(${f.choices.join(', ')})`);
  if (f.linkedTable) parts.push(`→ ${f.linkedTable}`);
  if (f.formula && (f.type !== 'button' || f.button?.action === 'openUrl')) {
    parts.push(`= ${f.formula}`);
  }
  return parts.join(' ');
}

function viewDetails(op: Extract<AssistantOperation, { op: 'createView' }>): string[] {
  if (!op.field) return [];
  switch (op.type) {
    case 'kanban':
      return [`Stacked by ${op.field}`];
    case 'timeline':
      return [op.endField ? `From ${op.field} to ${op.endField}` : `Dated by ${op.field}`];
    case 'list':
      return [`Nested by ${op.field}`];
    default:
      return [`Dated by ${op.field}`];
  }
}

function describe(op: AssistantOperation): Omit<OperationRow, 'index' | 'problems'> {
  switch (op.op) {
    case 'createTable':
      return {
        kind: 'table',
        title: `Table ${op.name}`,
        details: op.fields.map((f, i) => `${fieldLine(f)}${i === 0 ? ' (primary)' : ''}`),
      };
    case 'createField':
      return {
        kind: 'field',
        title: `Field ${op.field.name} in ${op.table}`,
        details: [fieldLine(op.field)],
      };
    case 'createView':
      return {
        kind: 'view',
        title: `${VIEW_LABELS[op.type] ?? op.type} view ${op.name} in ${op.table}`,
        details: viewDetails(op),
      };
    case 'createAutomation':
      return {
        kind: 'automation',
        title: `Automation ${op.name} (off)`,
        details: [
          op.trigger === 'recordCreated'
            ? `When a record is created in ${op.table}`
            : `When a record is updated in ${op.table}${op.watchFields?.length ? ` (${op.watchFields.join(', ')})` : ''}`,
          ...op.actions.map((a) =>
            a.type === 'sendEmail'
              ? `Send an email to ${a.to.join(', ')}: ${a.subject}`
              : a.type === 'updateRecord'
                ? `Update the record: ${a.cells.map((c) => `${c.field} = ${c.value}`).join(', ')}`
                : `Create a record in ${a.table}`
          ),
        ],
      };
  }
}

export function planRows(
  plan: AssistantPlan,
  problems: readonly AssistantProblem[]
): OperationRow[] {
  return plan.operations.map((op, index) => ({
    index,
    ...describe(op),
    problems: problems.filter((p) => p.operation === index).map((p) => p.message),
  }));
}

/** Ticked at first: every operation without a problem. */
export function initialSelection(
  plan: AssistantPlan,
  problems: readonly AssistantProblem[]
): Set<number> {
  const bad = new Set(problems.map((p) => p.operation));
  return new Set(plan.operations.map((_, i) => i).filter((i) => !bad.has(i)));
}

/** The plan with the ticked operations only, in order: what "Apply" sends. */
export function selectedPlan(plan: AssistantPlan, selected: ReadonlySet<number>): AssistantPlan {
  return { ...plan, operations: plan.operations.filter((_, i) => selected.has(i)) };
}

export function changeCount(n: number): string {
  return `${n} ${n === 1 ? 'change' : 'changes'}`;
}
