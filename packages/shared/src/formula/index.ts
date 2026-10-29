// Formula engine v2: a Pratt parser to a typed AST that references fields by id, a type
// checker driven by the field-type registry, a stable stored form and the evaluator with
// Airtable's function library. Pure TypeScript: the client's formula editor and the
// server's recompute engine share it.

import type { FormulaError, FormulaNode } from './ast.js';
import { type CheckResult, checkFormula, type FormulaFieldInfo } from './check.js';
import type { FormulaType } from './functions.js';
import { parseFormula } from './parser.js';
import { serializeFormula } from './serialize.js';

export * from './ast.js';
export * from './check.js';
export * from './evaluate.js';
export { formatMoment, parseMoment } from './functions/date.js';
export type { EvalEnv, FunctionImpl } from './functions/env.js';
export { MAX_REGEX_LENGTH } from './functions/text.js';
export * from './functions/values.js';
export * from './functions.js';
export { type Token, type TokenKind, tokenize } from './lexer.js';
export * from './parser.js';
export * from './result.js';
export * from './serialize.js';

export type CompileResult =
  | { ok: true; ast: FormulaNode; stored: string; type: FormulaType; errors: [] }
  | {
      ok: false;
      ast: FormulaNode | null;
      stored: string | null;
      type: FormulaType | null;
      errors: FormulaError[];
    };

/**
 * What a formula field's config goes through: parse the text the user wrote (fields by name),
 * type-check it, and give its stored form. `ok` only without syntax or type errors; with type
 * errors only, the AST and stored form are still there for the editor.
 */
export function compileFormula(
  source: string,
  options: { fields: readonly FormulaFieldInfo[] }
): CompileResult {
  const parsed = parseFormula(source, options);
  if (!parsed.ok) return { ok: false, ast: null, stored: null, type: null, errors: [parsed.error] };
  const checked: CheckResult = checkFormula(parsed.ast, options);
  const stored = serializeFormula(parsed.ast);
  if (checked.errors.length > 0)
    return { ok: false, ast: parsed.ast, stored, type: checked.type, errors: checked.errors };
  return { ok: true, ast: parsed.ast, stored, type: checked.type, errors: [] };
}
