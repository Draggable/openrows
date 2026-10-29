import { compileFormula, type FormulaFieldInfo, type FormulaType } from '../formula/index.js';
import {
  type AssistantFieldSpec,
  type AssistantOperation,
  type AssistantPlan,
  type AssistantProblem,
  CALENDAR_FIELD_TYPES,
  KANBAN_FIELD_TYPES,
  NON_PRIMARY_TYPES,
  READ_ONLY_PLAN_TYPES,
} from './plan.js';

/** A base's schema as the plan checker (and the model) sees it. */
export interface AssistantBaseInfo {
  tables: AssistantTableInfo[];
}
export interface AssistantTableInfo {
  name: string;
  fields: AssistantFieldInfo[];
}
export interface AssistantFieldInfo {
  name: string;
  type: string;
  /** A formula's (or lookup's) result type. */
  resultType?: FormulaType;
  /** For the model: options, the linked table, a result type. */
  detail?: string;
}

/** Ids for the type checker: planned fields have none yet. */
function fakeId(n: number): string {
  return `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
}

function formulaFields(fields: readonly AssistantFieldInfo[]): FormulaFieldInfo[] {
  return fields.map((f, i) => ({
    id: fakeId(i + 1),
    name: f.name,
    type: f.type,
    ...(f.resultType ? { resultType: f.resultType } : {}),
  }));
}

export type FormulaCheck =
  | { ok: true; type: FormulaType }
  | { ok: false; type: FormulaType | null; errors: string[] };

/**
 * Whether a suggested formula parses and type-checks against a table's fields (names as the
 * user sees them), with its result type. The assistant checks every formula it suggests this way.
 */
export function checkFormulaSuggestion(
  formula: string,
  fields: readonly AssistantFieldInfo[]
): FormulaCheck {
  if (formula.trim() === '') return { ok: false, type: null, errors: ['The formula is empty.'] };
  const result = compileFormula(formula, { fields: formulaFields(fields) });
  if (result.ok) return { ok: true, type: result.type };
  return { ok: false, type: result.type, errors: result.errors.map((e) => e.message) };
}

const lower = (s: string) => s.trim().toLowerCase();

class Tables {
  readonly #tables = new Map<string, AssistantTableInfo>();
  constructor(base: AssistantBaseInfo) {
    for (const t of base.tables) {
      this.#tables.set(lower(t.name), { name: t.name, fields: [...t.fields] });
    }
  }
  get(name: string) {
    return this.#tables.get(lower(name));
  }
  add(name: string) {
    const table: AssistantTableInfo = { name, fields: [] };
    this.#tables.set(lower(name), table);
    return table;
  }
}

function fieldOf(table: AssistantTableInfo, name: string) {
  return table.fields.find((f) => lower(f.name) === lower(name));
}

/**
 * What in a plan can't be applied to the base as it is: names already taken, tables and fields
 * that don't exist (in the base or earlier in the plan), formulas that don't parse or
 * type-check, views on a field of the wrong type. Operations are checked in order, as they'd be
 * applied. An empty list: the server's services should accept every operation.
 */
export function checkPlan(plan: AssistantPlan, base: AssistantBaseInfo): AssistantProblem[] {
  const tables = new Tables(base);
  const problems: AssistantProblem[] = [];
  plan.operations.forEach((op, i) => {
    const add = (kind: AssistantProblem['kind'], message: string, field: string | null = null) =>
      problems.push({ operation: i, field, kind, message });
    checkOperation(op, tables, add);
  });
  return problems;
}

type Add = (kind: AssistantProblem['kind'], message: string, field?: string | null) => void;

function checkField(
  spec: AssistantFieldSpec,
  table: AssistantTableInfo,
  tables: Tables,
  add: Add
): AssistantFieldInfo {
  const info: AssistantFieldInfo = { name: spec.name, type: spec.type };
  if (fieldOf(table, spec.name)) {
    add('name', `"${table.name}" already has a field named "${spec.name}".`, spec.name);
  }
  if (spec.type === 'link') {
    if (
      !spec.linkedTable ||
      !(lower(spec.linkedTable) === lower(table.name) || tables.get(spec.linkedTable))
    ) {
      add('reference', `"${spec.name}" links to a table that doesn't exist.`, spec.name);
    }
  }
  if (spec.type === 'formula') {
    const check = checkFormulaSuggestion(spec.formula ?? '', table.fields);
    if (check.ok) info.resultType = check.type;
    else add('formula', `"${spec.name}": ${check.errors.join(' ')}`, spec.name);
  }
  return info;
}

function checkOperation(op: AssistantOperation, tables: Tables, add: Add): void {
  if (op.op === 'createTable') {
    if (tables.get(op.name)) {
      add('name', `A table named "${op.name}" already exists.`);
      return;
    }
    const table = tables.add(op.name);
    const [primary] = op.fields;
    if (primary && NON_PRIMARY_TYPES.includes(primary.type)) {
      add(
        'type',
        `The primary field "${primary.name}" can't be a ${primary.type} field.`,
        primary.name
      );
    }
    for (const spec of op.fields) table.fields.push(checkField(spec, table, tables, add));
    return;
  }
  const table = tables.get(op.table);
  if (!table) {
    add('reference', `There is no table named "${op.table}".`);
    return;
  }
  if (op.op === 'createField') {
    table.fields.push(checkField(op.field, table, tables, add));
    return;
  }
  if (op.op === 'createView') {
    const needs =
      op.type === 'kanban'
        ? KANBAN_FIELD_TYPES
        : op.type === 'calendar'
          ? CALENDAR_FIELD_TYPES
          : null;
    if (!needs) return;
    const field = op.field ? fieldOf(table, op.field) : undefined;
    if (!field) {
      add(
        'reference',
        `The ${op.type} view needs a field of "${table.name}" to ${op.type === 'kanban' ? 'stack by' : 'place records by'}.`
      );
    } else if (!needs.includes(field.type)) {
      add(
        'type',
        `A ${op.type} view can't use "${field.name}" (a ${field.type} field).`,
        field.name
      );
    }
    return;
  }
  for (const name of op.watchFields ?? []) {
    if (!fieldOf(table, name)) add('reference', `"${table.name}" has no field "${name}".`, name);
  }
  for (const action of op.actions) {
    if (action.type === 'sendEmail') continue;
    const target = action.type === 'createRecord' ? tables.get(action.table) : table;
    if (!target) {
      add(
        'reference',
        `There is no table named "${action.type === 'createRecord' ? action.table : op.table}".`
      );
      continue;
    }
    for (const cell of action.cells) {
      const field = fieldOf(target, cell.field);
      if (!field) add('reference', `"${target.name}" has no field "${cell.field}".`, cell.field);
      else if (READ_ONLY_PLAN_TYPES.includes(field.type)) {
        add('type', `"${field.name}" is computed: an automation can't set it.`, field.name);
      }
    }
  }
}
