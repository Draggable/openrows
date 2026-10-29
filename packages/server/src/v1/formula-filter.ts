import {
  type BinaryOperator,
  type FilterOperator,
  type FormulaNode,
  getFieldType,
  parseFormula,
} from '@openrows/shared';
import type { Predicate } from '../data/query/compile.js';
import { AppError } from '../lib/errors.js';

/**
 * `filterByFormula` of the REST API v1. The formula is parsed by the formula engine,
 * fields by name, then translated into a condition tree the query compiler turns into SQL, each
 * condition with the field type's own filter semantics (the registry's `filterOperators`). What
 * has no SQL translation is a 422 INVALID_FILTER_BY_FORMULA: a formula is never evaluated in
 * JavaScript against the table's rows.
 *
 * Supported: `AND`, `OR`, `NOT`, `TRUE()`, `FALSE()`; a field compared (`= != < <= > >=`) with a
 * literal (text, number, `TRUE()`, `FALSE()`, `BLANK()`, `''`, `TODAY()` for dates); a field on
 * its own (checked, or not empty); `FIND`/`SEARCH(text, {field})` (contains, ignoring case);
 * `IS_BEFORE`, `IS_AFTER`, `IS_SAME(…, 'day')` with a date; `RECORD_ID() = '…'`.
 */

/** A field of the table, as the translation needs it. */
export interface FilterField {
  id: string;
  name: string;
  type: string;
}

type Value = { kind: 'value'; value: string | number | boolean } | { kind: 'blank' };

function fail(message: string): never {
  throw new AppError('INVALID_FILTER_BY_FORMULA', { detail: message });
}

function unsupported(name: string): never {
  return fail(`${name}() isn't supported in filterByFormula (it can't run as a database query).`);
}

const COMPARISONS = new Set<BinaryOperator>(['=', '!=', '<', '<=', '>', '>=']);

/** The filter operators that mean a comparison, most specific first. */
const OPERATORS: Record<string, FilterOperator[]> = {
  '=': ['=', 'is', 'isExactly'],
  '!=': ['!=', 'isNot'],
  '<': ['<', 'isBefore'],
  '<=': ['<=', 'isOnOrBefore'],
  '>': ['>', 'isAfter'],
  '>=': ['>=', 'isOnOrAfter'],
};

/** `a < b` read from the right: `b > a`. */
const FLIPPED: Record<string, BinaryOperator> = {
  '=': '=',
  '!=': '!=',
  '<': '>',
  '<=': '>=',
  '>': '<',
  '>=': '<=',
};

const isCall = (node: FormulaNode, name: string, args?: number) =>
  node.type === 'call' && node.name === name && (args === undefined || node.args.length === args);

const defOf = (f: FilterField) => getFieldType(f.type as Parameters<typeof getFieldType>[0]);

const supports = (f: FilterField, op: FilterOperator) => defOf(f).filterOperators.includes(op);

function condition(f: FilterField, operator: FilterOperator, value?: unknown): Predicate {
  return {
    kind: 'condition',
    condition: { fieldId: f.id, operator, ...(value === undefined ? {} : { value }) },
  };
}

/** `{field} op value`. */
function compare(f: FilterField, op: BinaryOperator, value: Value): Predicate {
  const def = defOf(f);
  if (value.kind === 'blank') {
    if (op !== '=' && op !== '!=') fail(`Only = and != compare "${f.name}" with a blank.`);
    if (def.emptyValue === false) return condition(f, 'is', op !== '=');
    if (!supports(f, 'isEmpty')) fail(`"${f.name}" can't be checked for blanks.`);
    return condition(f, op === '=' ? 'isEmpty' : 'isNotEmpty');
  }
  if (value.value === 'today' && def.sort !== 'chronological') {
    fail(`TODAY() compares with date fields only, not "${f.name}".`);
  }
  // A checkbox is TRUE or FALSE: `{Done} = 0` means unchecked.
  if (def.emptyValue === false && (op === '=' || op === '!=')) {
    const checked = Boolean(value.value) && value.value !== '0';
    return condition(f, 'is', op === '=' ? checked : !checked);
  }
  const operator = OPERATORS[op]?.find((o) => supports(f, o));
  if (operator) return condition(f, operator, value.value);
  if (op === '!=') return { kind: 'not', item: compare(f, '=', value) };
  return fail(`"${f.name}" can't be compared with ${op} in filterByFormula.`);
}

export function formulaPredicate(source: string, fields: readonly FilterField[]): Predicate {
  const parsed = parseFormula(source, { fields });
  if (!parsed.ok) fail(`The formula is invalid: ${parsed.error.message}`);
  const byId = new Map(fields.map((f) => [f.id, f]));
  function fieldOf(node: FormulaNode): FilterField | null {
    return node.type === 'field' ? (byId.get(node.fieldId) ?? null) : null;
  }

  function literal(node: FormulaNode): Value | null {
    switch (node.type) {
      case 'string':
        return node.value === '' ? { kind: 'blank' } : { kind: 'value', value: node.value };
      case 'number':
        return { kind: 'value', value: node.value };
      case 'boolean':
        return { kind: 'value', value: node.value };
      case 'unary':
        if (node.operand.type === 'number') {
          return {
            kind: 'value',
            value: node.operator === '-' ? -node.operand.value : node.operand.value,
          };
        }
        return null;
      case 'call':
        if (isCall(node, 'TRUE', 0)) return { kind: 'value', value: true };
        if (isCall(node, 'FALSE', 0)) return { kind: 'value', value: false };
        if (isCall(node, 'BLANK', 0)) return { kind: 'blank' };
        if (isCall(node, 'TODAY', 0)) return { kind: 'value', value: 'today' };
        return null;
      default:
        return null;
    }
  }

  /** `FIND(text, {field})` / `SEARCH(text, {field})`: the field contains the text. */
  function contains(node: FormulaNode): Predicate | null {
    if (node.type !== 'call' || (node.name !== 'FIND' && node.name !== 'SEARCH')) return null;
    const [needle, haystack, start] = node.args;
    const f = haystack ? fieldOf(haystack) : null;
    const text = needle ? literal(needle) : null;
    if (!f || !text || start) {
      fail(`${node.name} is supported as ${node.name}('text', {Field}) only.`);
    }
    if (!supports(f, 'contains')) fail(`"${f.name}" can't be searched with ${node.name}.`);
    if (text.kind === 'blank') return { kind: 'constant', value: true };
    return condition(f, 'contains', String(text.value));
  }

  function binary(node: Extract<FormulaNode, { type: 'binary' }>): Predicate {
    if (!COMPARISONS.has(node.operator)) {
      fail(`The ${node.operator} operator can't be used in filterByFormula.`);
    }
    const { left, right } = node;
    // RECORD_ID() = '…'
    for (const [side, other] of [
      [left, right],
      [right, left],
    ] as const) {
      if (isCall(side, 'RECORD_ID', 0)) {
        const id = literal(other);
        if (id?.kind !== 'value' || (node.operator !== '=' && node.operator !== '!=')) {
          fail("RECORD_ID() is supported as RECORD_ID() = 'id' only.");
        }
        const match: Predicate = { kind: 'recordIds', ids: [String(id.value)] };
        return node.operator === '=' ? match : { kind: 'not', item: match };
      }
    }
    // FIND(…) > 0, FIND(…) = 0
    const found = contains(left);
    if (found) {
      const n = literal(right);
      if (n?.kind === 'value' && n.value === 0) {
        if (node.operator === '>' || node.operator === '!=') return found;
        if (node.operator === '=') return { kind: 'not', item: found };
      }
      if (n?.kind === 'value' && n.value === 1 && node.operator === '>=') return found;
      fail(`${(left as { name: string }).name}(…) is supported as a condition, > 0 or = 0.`);
    }
    const lf = fieldOf(left);
    const rf = fieldOf(right);
    if (lf && !rf) {
      const value = literal(right);
      if (value) return compare(lf, node.operator, value);
    }
    if (rf && !lf) {
      const value = literal(left);
      if (value) return compare(rf, FLIPPED[node.operator] as BinaryOperator, value);
    }
    for (const side of [left, right]) {
      if (side.type === 'call' && !literal(side)) unsupported(side.name);
    }
    return fail('filterByFormula compares a field with a value, like {Status} = "Done".');
  }

  /** IS_BEFORE({Date}, '2024-01-31'), IS_AFTER, IS_SAME(…, 'day'). */
  function dateCall(node: Extract<FormulaNode, { type: 'call' }>): Predicate {
    const [a, b, unit] = node.args;
    const f = a ? fieldOf(a) : null;
    const day = b ? literal(b) : null;
    if (!f || !day || day.kind !== 'value' || typeof day.value !== 'string') {
      return fail(`${node.name} is supported as ${node.name}({Date}, 'YYYY-MM-DD') only.`);
    }
    if (unit) {
      const u = literal(unit);
      if (node.name !== 'IS_SAME' || u?.kind !== 'value' || !/^days?$/.test(String(u.value))) {
        fail(`${node.name} compares by day only.`);
      }
    }
    const op = node.name === 'IS_BEFORE' ? '<' : node.name === 'IS_AFTER' ? '>' : '=';
    if (defOf(f).sort !== 'chronological')
      fail(`${node.name} needs a date field, not "${f.name}".`);
    return compare(f, op, day);
  }

  function predicate(node: FormulaNode): Predicate {
    switch (node.type) {
      case 'boolean':
        return { kind: 'constant', value: node.value };
      case 'number':
        return { kind: 'constant', value: node.value !== 0 };
      case 'string':
        return { kind: 'constant', value: node.value !== '' };
      case 'field': {
        const f = byId.get(node.fieldId);
        if (!f) return fail('No such field.');
        // A field on its own: checked, or not empty.
        if (defOf(f).emptyValue === false) return condition(f, 'is', true);
        if (!supports(f, 'isNotEmpty')) fail(`"${f.name}" can't be used as a condition.`);
        return condition(f, 'isNotEmpty');
      }
      case 'binary':
        return binary(node);
      case 'unary':
        return fail(`The ${node.operator} operator can't be used as a condition.`);
      case 'call': {
        switch (node.name) {
          case 'AND':
          case 'OR':
            if (node.args.length === 0) fail(`${node.name}() needs at least one condition.`);
            return { kind: node.name === 'AND' ? 'and' : 'or', items: node.args.map(predicate) };
          case 'NOT': {
            const [arg] = node.args;
            if (!arg || node.args.length !== 1) return fail('NOT() takes one condition.');
            return { kind: 'not', item: predicate(arg) };
          }
          case 'TRUE':
          case 'FALSE':
            return { kind: 'constant', value: node.name === 'TRUE' };
          case 'FIND':
          case 'SEARCH':
            return contains(node) as Predicate;
          case 'IS_BEFORE':
          case 'IS_AFTER':
          case 'IS_SAME':
            return dateCall(node);
          default:
            return unsupported(node.name);
        }
      }
    }
  }

  return predicate(parsed.ast);
}

/**
 * Whether `{field} = value` (an upsert's `fieldsToMergeOn`): the same comparison as
 * `filterByFormula`'s, so merging matches what a filter would.
 */
export function equalsPredicate(field: FilterField, value: unknown): Predicate {
  if (value === null || value === undefined || value === '') {
    return compare(field, '=', { kind: 'blank' });
  }
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return fail(`"${field.name}" can't be merged on: give it a text, number or boolean value.`);
  }
  return compare(field, '=', { kind: 'value', value });
}
