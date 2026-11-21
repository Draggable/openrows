import { parseAiPrompt, storeAiPrompt } from '../fields/ai.js';
import {
  compileFormula,
  type FormulaFieldInfo,
  type FormulaType,
  fieldFormulaType,
  tokenize,
} from '../formula/index.js';
import {
  type AssistantFieldSpec,
  type AssistantOperation,
  type AssistantPlan,
  type AssistantProblem,
  CALENDAR_FIELD_TYPES,
  KANBAN_FIELD_TYPES,
  NON_PRIMARY_TYPES,
  NUMERIC_ROLLUP_FUNCTIONS,
  READ_ONLY_PLAN_TYPES,
  TEXT_ROLLUP_FUNCTIONS,
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
  /** A link field's linked table, by name. */
  linkedTable?: string;
  /** Whether its values are numbers (a numeric rollup applies); unset: by its type. */
  numeric?: boolean;
  /** An AI field, or a field computed from one: an AI field's prompt can't read it. */
  fromAi?: boolean;
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

/** `name`, or `name 2`, `name 3`…: the first one the table doesn't have (an inverse link's). */
function freeName(table: AssistantTableInfo, name: string): string {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${name} ${n}`;
    if (!fieldOf(table, candidate)) return candidate;
  }
}

function isNumeric(field: AssistantFieldInfo): boolean {
  return field.numeric ?? fieldFormulaType(field) === 'number';
}

/** The field names a formula references, as written. */
function formulaReferences(formula: string): string[] {
  return tokenize(formula)
    .tokens.filter((t) => t.kind === 'reference')
    .map((t) => t.text);
}

const isFormulaLike = (type: string) => type === 'formula' || type === 'button';

/** The names of the same table a planned field reads (formula, prompt, link field). */
function sameTableReads(spec: AssistantFieldSpec): string[] {
  // A button that runs automations has no formula: one the model set anyway isn't applied.
  if (spec.type === 'button' && spec.button?.action !== 'openUrl') return [];
  if (isFormulaLike(spec.type)) return formulaReferences(spec.formula ?? '');
  if (spec.type === 'ai') {
    return parseAiPrompt(spec.ai?.prompt ?? '').flatMap((p) => ('token' in p ? [p.token] : []));
  }
  if (spec.type === 'lookup' || spec.type === 'rollup' || spec.type === 'count') {
    return spec.linkField ? [spec.linkField] : [];
  }
  return [];
}

const keyOf = (table: string, field: string) => `${lower(table)}\u0000${lower(field)}`;

/**
 * The planned fields that would read themselves through formulas, lookups, rollups and AI
 * prompts (each field with its loop, by name). Operations run in order, so such a loop always
 * reads a field the plan creates later; this names it as the loop it is.
 */
function planLoops(plan: AssistantPlan, base: AssistantBaseInfo): Map<string, string[]> {
  const planned = new Map<string, { table: string; spec: AssistantFieldSpec }>();
  const remember = (table: string, spec: AssistantFieldSpec) => {
    const key = keyOf(table, spec.name);
    if (!planned.has(key)) planned.set(key, { table, spec });
  };
  for (const op of plan.operations) {
    if (op.op === 'createTable') for (const f of op.fields) remember(op.name, f);
    else if (op.op === 'createField') remember(op.table, op.field);
  }
  const existing = new Map<string, AssistantFieldInfo>();
  for (const t of base.tables) for (const f of t.fields) existing.set(keyOf(t.name, f.name), f);
  const linkedTableOf = (table: string, link: string): string | undefined => {
    const key = keyOf(table, link);
    const p = planned.get(key);
    if (p) return p.spec.type === 'link' ? (p.spec.linkedTable ?? undefined) : undefined;
    return existing.get(key)?.linkedTable;
  };
  const reads = (key: string): string[] => {
    const p = planned.get(key);
    if (!p) return [];
    const out = sameTableReads(p.spec).map((name) => keyOf(p.table, name));
    const { spec } = p;
    if ((spec.type === 'lookup' || spec.type === 'rollup') && spec.linkField && spec.linkedField) {
      const linked = linkedTableOf(p.table, spec.linkField);
      if (linked) out.push(keyOf(linked, spec.linkedField));
    }
    return out.filter((k) => planned.has(k));
  };

  const loops = new Map<string, string[]>();
  const done = new Set<string>();
  const path: string[] = [];
  const visit = (key: string) => {
    if (done.has(key)) return;
    const at = path.indexOf(key);
    if (at !== -1) {
      const loop = path.slice(at);
      const names = [...loop, key].map((k) => planned.get(k)?.spec.name ?? '?');
      for (const k of loop) if (!loops.has(k)) loops.set(k, names);
      return;
    }
    path.push(key);
    for (const next of reads(key)) visit(next);
    path.pop();
    done.add(key);
  };
  for (const key of planned.keys()) visit(key);
  return loops;
}

/**
 * What in a plan can't be applied to the base as it is: names already taken, tables and fields
 * that don't exist (in the base or earlier in the plan), formulas that don't parse or
 * type-check, fields that would read themselves in a loop, lookups, rollups and counts without
 * a link of their table (or a field of the linked table to read), rollup aggregations that
 * don't apply to the field's values, buttons and AI fields missing what they need, views on a
 * field of the wrong type, primary fields of a type that can't be one. Operations are checked
 * in order, as they'd be applied. An operation with a problem is left out of what's applied,
 * so an operation that needs it (a formula over a field it creates, a view of a table it
 * creates) gets a problem too. An empty list: the server's services should accept every
 * operation.
 */
export function checkPlan(plan: AssistantPlan, base: AssistantBaseInfo): AssistantProblem[] {
  const problems = checkOperations(plan, base);
  // Check again without the operations that have problems, as the plan that would be applied
  // without them, until no other operation turns out to need one of them.
  for (;;) {
    const bad = new Set(problems.map((p) => p.operation));
    const kept = plan.operations.flatMap((_, i) => (bad.has(i) ? [] : [i]));
    if (kept.length === plan.operations.length) return problems;
    const rest = checkOperations(
      { ...plan, operations: kept.map((i) => plan.operations[i] as AssistantOperation) },
      base
    );
    if (rest.length === 0) return problems.sort((a, b) => a.operation - b.operation);
    for (const p of rest) {
      problems.push({
        ...p,
        operation: kept[p.operation] as number,
        // Not the formula's own fault: no point asking the model to fix it.
        kind: 'reference',
        message: `${p.message} It needs a change above that can't be made.`,
      });
    }
  }
}

function checkOperations(plan: AssistantPlan, base: AssistantBaseInfo): AssistantProblem[] {
  const tables = new Tables(base);
  const loops = planLoops(plan, base);
  const problems: AssistantProblem[] = [];
  plan.operations.forEach((op, i) => {
    const add = (kind: AssistantProblem['kind'], message: string, field: string | null = null) =>
      problems.push({ operation: i, field, kind, message });
    checkOperation(op, { tables, loops, add });
  });
  return problems;
}

type Add = (kind: AssistantProblem['kind'], message: string, field?: string | null) => void;
interface Checker {
  tables: Tables;
  loops: Map<string, string[]>;
  add: Add;
}

/** Checks a planned field and adds it (and a link's inverse) to the tables it lands in. */
function addField(spec: AssistantFieldSpec, table: AssistantTableInfo, c: Checker): void {
  const { tables, add } = c;
  const name = spec.name;
  const info: AssistantFieldInfo = { name, type: spec.type };
  if (fieldOf(table, name)) {
    add('name', `"${table.name}" already has a field named "${name}".`, name);
  }
  const loop = c.loops.get(keyOf(table.name, name));
  if (loop) {
    add(
      isFormulaLike(spec.type) ? 'formula' : 'reference',
      `"${name}" would make a circular reference (${loop.join(' → ')}).`,
      name
    );
    table.fields.push(info);
    return;
  }
  const reads = (names: readonly string[]) => names.some((n) => fieldOf(table, n)?.fromAi === true);

  if (spec.type === 'link') {
    const target =
      spec.linkedTable && lower(spec.linkedTable) === lower(table.name)
        ? table
        : spec.linkedTable
          ? tables.get(spec.linkedTable)
          : undefined;
    if (!target) {
      add('reference', `"${name}" links to a table that doesn't exist.`, name);
    } else {
      info.linkedTable = target.name;
      // The inverse link the field service adds to the linked table, named after this one.
      if (target !== table) {
        target.fields.push({
          name: freeName(target, table.name),
          type: 'link',
          linkedTable: table.name,
        });
      }
    }
  } else if (spec.type === 'formula') {
    const check = checkFormulaSuggestion(spec.formula ?? '', table.fields);
    if (check.ok) info.resultType = check.type;
    else add('formula', `"${name}": ${check.errors.join(' ')}`, name);
    if (reads(formulaReferences(spec.formula ?? ''))) info.fromAi = true;
  } else if (spec.type === 'button') {
    checkButton(spec, table, add);
    if (spec.button?.action === 'openUrl' && reads(formulaReferences(spec.formula ?? ''))) {
      info.fromAi = true;
    }
  } else if (spec.type === 'lookup' || spec.type === 'rollup' || spec.type === 'count') {
    checkLinked(spec, table, info, c);
  } else if (spec.type === 'ai') {
    checkAi(spec, table, add);
    info.fromAi = true;
    info.numeric = spec.ai?.output === 'number';
  }
  table.fields.push(info);
}

function checkButton(spec: AssistantFieldSpec, table: AssistantTableInfo, add: Add): void {
  const name = spec.name;
  if (!spec.button || spec.button.label.trim() === '') {
    add('type', `The button "${name}" needs a label and an action.`, name);
    return;
  }
  if (spec.button.action !== 'openUrl') return;
  if (!spec.formula?.trim()) {
    add('type', `The button "${name}" opens a URL: it needs the formula that gives it.`, name);
    return;
  }
  const check = checkFormulaSuggestion(spec.formula, table.fields);
  if (!check.ok) add('formula', `"${name}": ${check.errors.join(' ')}`, name);
}

/** A lookup, rollup or count: a link of its table, a field of the linked table, the function. */
function checkLinked(
  spec: AssistantFieldSpec,
  table: AssistantTableInfo,
  info: AssistantFieldInfo,
  { tables, add }: Checker
): void {
  const name = spec.name;
  const link = spec.linkField ? fieldOf(table, spec.linkField) : undefined;
  if (!link) {
    add('reference', `"${name}" needs a link field of "${table.name}" to read through.`, name);
    return;
  }
  if (link.type !== 'link') {
    add(
      'type',
      `"${name}" reads through "${link.name}", a ${link.type} field: it needs a link field.`,
      name
    );
    return;
  }
  const linked = link.linkedTable ? tables.get(link.linkedTable) : undefined;
  if (!linked) {
    add('reference', `"${link.name}" links to no table "${name}" can read.`, name);
    return;
  }
  if (spec.type === 'count') return;
  const source = spec.linkedField ? fieldOf(linked, spec.linkedField) : undefined;
  if (!source) {
    add('reference', `"${name}" needs a field of "${linked.name}" to read.`, name);
    return;
  }
  if (source.fromAi) info.fromAi = true;
  if (spec.type === 'lookup') {
    info.numeric = isNumeric(source);
    return;
  }
  const fn = spec.aggregation;
  if (!fn) {
    add('type', `The rollup "${name}" needs an aggregation.`, name);
    return;
  }
  const numeric = NUMERIC_ROLLUP_FUNCTIONS.includes(fn);
  if (numeric && !isNumeric(source)) {
    add(
      'type',
      `${fn} doesn't apply to "${source.name}" (a ${source.type} field): it aggregates numbers.`,
      name
    );
  }
  info.numeric = !TEXT_ROLLUP_FUNCTIONS.includes(fn);
}

function checkAi(spec: AssistantFieldSpec, table: AssistantTableInfo, add: Add): void {
  const name = spec.name;
  if (!spec.ai || spec.ai.prompt.trim() === '') {
    add('type', `The AI field "${name}" needs a prompt.`, name);
    return;
  }
  const own = table.fields.map((f, i) => ({ id: fakeId(i + 1), name: f.name }));
  const stored = storeAiPrompt(spec.ai.prompt, own);
  if (!stored.ok) {
    add('reference', `"${name}": ${stored.message}`, name);
  } else {
    for (const id of stored.referencedFieldIds) {
      const read = table.fields[own.findIndex((f) => f.id === id)];
      if (read?.fromAi) {
        add('reference', `"${name}" can't read "${read.name}": it is or reads an AI field.`, name);
      }
    }
  }
  if (spec.ai.output === 'singleSelect' && !spec.choices?.length) {
    add('type', `The AI field "${name}" picks one option: list the choices.`, name);
  }
}

const VIEW_FIELD_ROLE: Record<string, string> = {
  kanban: 'stack by',
  calendar: 'place records by',
  timeline: 'draw bars from',
  list: 'nest records by',
};

function checkView(
  op: Extract<AssistantOperation, { op: 'createView' }>,
  table: AssistantTableInfo,
  add: Add
): void {
  const role = VIEW_FIELD_ROLE[op.type];
  if (!role) return;
  const field = op.field ? fieldOf(table, op.field) : undefined;
  if (!field) {
    add('reference', `The ${op.type} view needs a field of "${table.name}" to ${role}.`);
    return;
  }
  const wrong = () =>
    add('type', `A ${op.type} view can't use "${field.name}" (a ${field.type} field).`, field.name);
  if (op.type === 'kanban') {
    if (!KANBAN_FIELD_TYPES.includes(field.type)) wrong();
  } else if (op.type === 'calendar') {
    if (!CALENDAR_FIELD_TYPES.includes(field.type)) wrong();
  } else if (op.type === 'list') {
    if (
      field.type !== 'link' ||
      !field.linkedTable ||
      lower(field.linkedTable) !== lower(table.name)
    ) {
      add(
        'type',
        `A list view nests records by a link to records of "${table.name}"; "${field.name}" isn't one.`,
        field.name
      );
    }
  } else {
    if (!CALENDAR_FIELD_TYPES.includes(field.type)) wrong();
    if (op.endField) {
      const end = fieldOf(table, op.endField);
      if (!end) {
        add('reference', `"${table.name}" has no field "${op.endField}".`, op.endField);
      } else if (!CALENDAR_FIELD_TYPES.includes(end.type)) {
        add(
          'type',
          `A timeline view can't end bars at "${end.name}" (a ${end.type} field).`,
          end.name
        );
      }
    }
  }
}

function checkOperation(op: AssistantOperation, c: Checker): void {
  const { tables, add } = c;
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
    for (const spec of op.fields) addField(spec, table, c);
    return;
  }
  const table = tables.get(op.table);
  if (!table) {
    add('reference', `There is no table named "${op.table}".`);
    return;
  }
  if (op.op === 'createField') {
    addField(op.field, table, c);
    return;
  }
  if (op.op === 'createView') {
    checkView(op, table, add);
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
