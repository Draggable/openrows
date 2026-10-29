import { getFieldType, isFieldTypeName } from '../fields/index.js';
import type { FormulaError, FormulaNode, SourceRange } from './ast.js';
import {
  type ArgKind,
  DATE_UNITS,
  FORMULA_FUNCTIONS,
  type FormulaType,
  type FunctionSignature,
} from './functions.js';
import type { FormulaFieldRef } from './parser.js';

/** A field as the type checker sees it. */
export interface FormulaFieldInfo extends FormulaFieldRef {
  type: string;
  /**
   * Overrides the registry's type (computed fields whose type depends on their config, like
   * another formula). A field type the registry doesn't know types as `any`.
   */
  resultType?: FormulaType;
}

export interface CheckResult {
  type: FormulaType;
  /** Every type error, in source order. Empty when the formula type-checks. */
  errors: FormulaError[];
}

const ARTICLE: Record<FormulaType, string> = {
  text: 'text',
  number: 'a number',
  date: 'a date',
  boolean: 'a boolean',
  array: 'a list',
  null: 'blank',
  any: 'any value',
};

const NEEDS: Record<ArgKind, string> = {
  any: 'any value',
  text: 'text',
  boolean: 'a boolean',
  number: 'a number',
  numbers: 'numbers',
  date: 'a date',
  array: 'a list',
  unit: 'a date unit',
};

export function fieldFormulaType(field: { type: string; resultType?: FormulaType }): FormulaType {
  if (field.resultType) return field.resultType;
  return isFieldTypeName(field.type) ? getFieldType(field.type).formulaType : 'any';
}

/** Short units are case-sensitive (`M` months, `m` minutes); long names aren't. */
function isDateUnit(value: string): boolean {
  return (
    DATE_UNITS.includes(value) || (value.length > 2 && DATE_UNITS.includes(value.toLowerCase()))
  );
}

function accepts(kind: ArgKind, type: FormulaType): boolean {
  if (type === 'any' || type === 'null') return true;
  switch (kind) {
    case 'any':
    case 'text':
    case 'boolean':
      return true;
    case 'unit':
      return type === 'text';
    case 'number':
      return type === 'number' || type === 'boolean';
    case 'numbers':
      return type === 'number' || type === 'boolean' || type === 'array';
    case 'date':
      return type === 'date' || type === 'text';
    case 'array':
      return type === 'array';
  }
}

/** The type of either of two values (IF branches): equal types, or the non-blank one. */
function join(a: FormulaType, b: FormulaType): FormulaType {
  if (a === b || b === 'null') return a;
  if (a === 'null') return b;
  return 'any';
}

/** What `<`, `>` and friends compare: numbers (and booleans), dates (and text), or text. */
function orderClass(type: FormulaType): 'number' | 'date' | 'text' | 'array' | null {
  if (type === 'number' || type === 'boolean') return 'number';
  if (type === 'date') return 'date';
  if (type === 'text') return 'text';
  if (type === 'array') return 'array';
  return null;
}

/**
 * Type-checks a parsed formula against the table's fields (field types come from the
 * registry's `formulaType`). Never throws; collects every error, each with its source range.
 * Unknown functions, wrong argument counts and unknown field ids type as `any`, so one mistake
 * doesn't cascade.
 */
export function checkFormula(
  ast: FormulaNode,
  options: { fields: readonly FormulaFieldInfo[] }
): CheckResult {
  const fields = new Map(options.fields.map((f) => [f.id, fieldFormulaType(f)] as const));
  const errors: FormulaError[] = [];
  const report = (code: FormulaError['code'], message: string, range: SourceRange) => {
    errors.push({ code, message, range });
  };

  const numeric = (node: FormulaNode, type: FormulaType, operator: string) => {
    if (accepts('number', type)) return;
    const hint =
      type === 'date'
        ? ' (use DATEADD or DATETIME_DIFF for dates)'
        : type === 'text' && operator === '+'
          ? ' (use & to join text)'
          : type === 'text'
            ? ' (use VALUE to read a number from text)'
            : '';
    report(
      'typeMismatch',
      `"${operator}" needs numbers, but this is ${ARTICLE[type]}${hint}`,
      node.range
    );
  };

  const call = (node: Extract<FormulaNode, { type: 'call' }>): FormulaType => {
    const argTypes = node.args.map(visit);
    const sig: FunctionSignature | undefined = Object.hasOwn(FORMULA_FUNCTIONS, node.name)
      ? FORMULA_FUNCTIONS[node.name]
      : undefined;
    if (!sig) {
      report('unknownFunction', `Unknown function ${node.name}`, node.nameRange);
      return 'any';
    }
    const count = node.args.length;
    const max = sig.rest ? (sig.maxArgs ?? Number.POSITIVE_INFINITY) : sig.args.length;
    if (count < sig.required || count > max) {
      const expected =
        sig.rest !== undefined
          ? `at least ${sig.required}`
          : sig.required === sig.args.length
            ? `${sig.required}`
            : `${sig.required} to ${sig.args.length}`;
      const noun = expected.endsWith(' 1') || expected === '1' ? 'argument' : 'arguments';
      report(
        'wrongArgumentCount',
        `${node.name} takes ${expected} ${noun}, got ${count}`,
        node.range
      );
      return sig.returns === 'join' ? 'any' : sig.returns;
    }
    node.args.forEach((arg, i) => {
      const kind = sig.args[i] ?? sig.rest ?? 'any';
      const type = argTypes[i] ?? 'any';
      if (!accepts(kind, type)) {
        report(
          'typeMismatch',
          `${node.name} needs ${NEEDS[kind]} for argument ${i + 1}, but this is ${ARTICLE[type]}`,
          arg.range
        );
      } else if (kind === 'unit' && arg.type === 'string' && !isDateUnit(arg.value)) {
        report('invalidArgument', `"${arg.value}" is not a date unit`, arg.range);
      }
    });
    if (sig.returns !== 'join') return sig.returns;
    if (node.name === 'IF') return join(argTypes[1] ?? 'null', argTypes[2] ?? 'null');
    // SWITCH(expr, pattern, result, ..., default?): results at 2, 4, ...; a trailing default.
    let type: FormulaType | null = null;
    for (let i = 2; i < argTypes.length; i += 2)
      type = type === null ? (argTypes[i] ?? 'any') : join(type, argTypes[i] ?? 'any');
    if (argTypes.length % 2 === 0) {
      const fallback = argTypes[argTypes.length - 1] ?? 'any';
      type = type === null ? fallback : join(type, fallback);
    } else if (type !== null) {
      type = join(type, 'null');
    }
    return type ?? 'any';
  };

  function visit(node: FormulaNode): FormulaType {
    switch (node.type) {
      case 'number':
        return 'number';
      case 'string':
        return 'text';
      case 'boolean':
        return 'boolean';
      case 'field': {
        const type = fields.get(node.fieldId);
        if (type === undefined) {
          report('unknownField', 'This field no longer exists', node.range);
          return 'any';
        }
        return type;
      }
      case 'unary': {
        const type = visit(node.operand);
        numeric(node.operand, type, node.operator);
        return 'number';
      }
      case 'binary': {
        const left = visit(node.left);
        const right = visit(node.right);
        switch (node.operator) {
          case '&':
            return 'text';
          case '=':
          case '!=':
            return 'boolean';
          case '<':
          case '<=':
          case '>':
          case '>=': {
            const a = orderClass(left);
            const b = orderClass(right);
            if (a === 'array')
              report('typeMismatch', `"${node.operator}" can't compare a list`, node.left.range);
            if (b === 'array')
              report('typeMismatch', `"${node.operator}" can't compare a list`, node.right.range);
            const datey = (c: typeof a) => c === 'date' || c === 'text';
            if (
              a !== null &&
              b !== null &&
              a !== 'array' &&
              b !== 'array' &&
              a !== b &&
              !(datey(a) && datey(b))
            ) {
              report(
                'typeMismatch',
                `"${node.operator}" compares ${ARTICLE[left]} with ${ARTICLE[right]}`,
                node.range
              );
            }
            return 'boolean';
          }
          default:
            numeric(node.left, left, node.operator);
            numeric(node.right, right, node.operator);
            return 'number';
        }
      }
      case 'call':
        return call(node);
    }
  }

  const type = visit(ast);
  errors.sort((x, y) => x.range.start - y.range.start || x.range.end - y.range.end);
  return { type, errors };
}
