import type { FormulaNode } from './ast.js';
import { type FormulaFieldRef, infixPower, PREFIX_POWER } from './parser.js';

function quote(value: string): string {
  return `"${value.replace(/[\\"\n\r\t]/g, (c) => ({ '\n': '\\n', '\r': '\\r', '\t': '\\t' })[c] ?? `\\${c}`)}"`;
}

function brace(reference: string): string {
  return `{${reference.replace(/[\\}]/g, (c) => `\\${c}`)}}`;
}

function power(node: FormulaNode): number {
  if (node.type === 'binary') return infixPower(node.operator);
  if (node.type === 'unary') return PREFIX_POWER;
  return Number.POSITIVE_INFINITY;
}

/** Canonical text: upper-case names, single spaces, only the parentheses precedence needs. */
function print(node: FormulaNode, reference: (fieldId: string) => string): string {
  const wrap = (child: FormulaNode, parens: boolean): string => {
    const text = print(child, reference);
    return parens ? `(${text})` : text;
  };
  switch (node.type) {
    case 'number':
      return String(node.value);
    case 'string':
      return quote(node.value);
    case 'boolean':
      return node.value ? 'TRUE' : 'FALSE';
    case 'field':
      return reference(node.fieldId);
    case 'unary':
      return `${node.operator}${wrap(node.operand, power(node.operand) < PREFIX_POWER)}`;
    case 'binary': {
      const p = infixPower(node.operator);
      return `${wrap(node.left, power(node.left) < p)} ${node.operator} ${wrap(node.right, power(node.right) <= p)}`;
    }
    case 'call':
      return `${node.name}(${node.args.map((a) => print(a, reference)).join(', ')})`;
  }
}

/**
 * The stored form of a formula: canonical text with fields as `{<field id>}`. Renaming a field
 * never changes it, the same AST always gives the same text, and `parseStoredFormula` reads it
 * back to the same AST (up to source ranges).
 */
export function serializeFormula(ast: FormulaNode): string {
  return print(ast, brace);
}

/**
 * The display form: canonical text with fields as `{<current name>}`, which `parseFormula`
 * reads back. A field missing from `fields` (deleted) shows as its id, so re-parsing it reports
 * an unknown field.
 */
export function formatFormula(ast: FormulaNode, fields: readonly FormulaFieldRef[]): string {
  const names = new Map(fields.map((f) => [f.id, f.name]));
  return print(ast, (id) => brace(names.get(id) ?? id));
}
