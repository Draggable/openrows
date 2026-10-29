// The formula evaluator: walks a parsed AST for one record with Airtable's semantics,
// under a step and a time budget. Pure TypeScript, so the server's recompute engine and the
// client's preview give the same results.

import type { FormulaNode } from './ast.js';
import { ARRAY_FUNCTIONS, LOGICAL_FUNCTIONS } from './functions/array.js';
import { DATE_FUNCTIONS } from './functions/date.js';
import type { EvalEnv, FunctionImpl } from './functions/env.js';
import { NUMERIC_FUNCTIONS } from './functions/numeric.js';
import { TEXT_FUNCTIONS } from './functions/text.js';
import {
  checkNumber,
  checkText,
  compareValues,
  equals,
  FormulaBudgetError,
  FormulaEvalError,
  type FormulaValue,
  fail,
  toNumber,
  toText,
  truthy,
} from './functions/values.js';

/** Every eagerly evaluated function, by name (IF, SWITCH and ISERROR are below). */
export const FUNCTION_IMPLS: Readonly<Record<string, FunctionImpl>> = {
  ...TEXT_FUNCTIONS,
  ...NUMERIC_FUNCTIONS,
  ...LOGICAL_FUNCTIONS,
  ...DATE_FUNCTIONS,
  ...ARRAY_FUNCTIONS,
};

/** Functions that evaluate their arguments themselves. */
export const LAZY_FUNCTIONS: readonly string[] = ['IF', 'SWITCH', 'ISERROR'];

/** Default budget of one evaluation: AST nodes visited plus work charged by functions. */
export const DEFAULT_MAX_STEPS = 100_000;

/** Default wall-clock budget of one evaluation, in ms. */
export const DEFAULT_TIMEOUT_MS = 100;

export interface EvaluateOptions {
  /** A referenced field's value (see `fieldFormulaValue`); unknown ids are blank. */
  field: (fieldId: string) => FormulaValue;
  /** What NOW() and TODAY() read, in UTC ms (default: the current time). */
  now?: number;
  recordId?: string | null;
  createdTime?: number | null;
  lastModifiedTime?: number | null;
  maxSteps?: number;
  timeoutMs?: number;
}

export type EvaluateResult =
  | { ok: true; value: FormulaValue }
  | {
      ok: false;
      /** What went wrong, for the editor; the cell shows `#ERROR!`. */
      message: string;
      /** The step or time budget ran out. */
      budget: boolean;
    };

/**
 * Evaluates a formula for one record. Never throws: an error (`ERROR()`, a bad argument, a
 * division by zero, an exhausted budget) is `{ ok: false }`. `IF` and `SWITCH` evaluate only the
 * branch they take; `ISERROR` catches errors (not budget exhaustion) below it.
 */
export function evaluateFormula(ast: FormulaNode, options: EvaluateOptions): EvaluateResult {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let steps = 0;
  const env: EvalEnv = {
    now: options.now ?? Date.now(),
    recordId: options.recordId ?? null,
    createdTime: options.createdTime ?? null,
    lastModifiedTime: options.lastModifiedTime ?? null,
    step(n = 1) {
      const before = steps;
      steps += n;
      if (steps > maxSteps) throw new FormulaBudgetError('The formula takes too many steps');
      if (steps >> 10 !== before >> 10 && Date.now() > deadline)
        throw new FormulaBudgetError('The formula takes too long');
    },
  };

  const lazy = (node: Extract<FormulaNode, { type: 'call' }>): FormulaValue => {
    const args = node.args;
    const arg = (i: number): FormulaValue => {
      const a = args[i];
      return a === undefined ? null : visit(a);
    };
    switch (node.name) {
      case 'IF':
        return truthy(arg(0)) ? arg(1) : arg(2);
      case 'SWITCH': {
        const value = arg(0);
        let i = 1;
        for (; i + 1 < args.length; i += 2) if (equals(value, arg(i))) return arg(i + 1);
        return i < args.length ? arg(i) : null;
      }
      default: {
        // ISERROR
        try {
          arg(0);
          return false;
        } catch (e) {
          if (e instanceof FormulaEvalError) return true;
          throw e;
        }
      }
    }
  };

  function visit(node: FormulaNode): FormulaValue {
    env.step();
    switch (node.type) {
      case 'number':
      case 'string':
      case 'boolean':
        return node.value;
      case 'field':
        return options.field(node.fieldId);
      case 'unary': {
        const v = toNumber(visit(node.operand));
        return node.operator === '-' ? checkNumber(-v) : v;
      }
      case 'binary': {
        const a = visit(node.left);
        const b = visit(node.right);
        switch (node.operator) {
          case '&':
            return checkText(toText(a) + toText(b));
          case '=':
            return equals(a, b);
          case '!=':
            return !equals(a, b);
          case '<':
            return compareValues(a, b) < 0;
          case '<=':
            return compareValues(a, b) <= 0;
          case '>':
            return compareValues(a, b) > 0;
          case '>=':
            return compareValues(a, b) >= 0;
          case '+':
            return checkNumber(toNumber(a) + toNumber(b));
          case '-':
            return checkNumber(toNumber(a) - toNumber(b));
          case '*':
            return checkNumber(toNumber(a) * toNumber(b));
          case '/': {
            const d = toNumber(b);
            if (d === 0) fail('Division by zero');
            return checkNumber(toNumber(a) / d);
          }
        }
        break;
      }
      case 'call': {
        if (LAZY_FUNCTIONS.includes(node.name)) return lazy(node);
        const impl = Object.hasOwn(FUNCTION_IMPLS, node.name)
          ? FUNCTION_IMPLS[node.name]
          : undefined;
        if (!impl) return fail(`Unknown function ${node.name}`);
        return impl(node.args.map(visit), env);
      }
    }
  }

  try {
    return { ok: true, value: visit(ast) };
  } catch (e) {
    if (e instanceof FormulaEvalError) return { ok: false, message: e.message, budget: false };
    if (e instanceof FormulaBudgetError) return { ok: false, message: e.message, budget: true };
    // A stack overflow (or a bug in a function) must not take the recompute down.
    if (e instanceof RangeError)
      return { ok: false, message: 'The formula is too complex', budget: true };
    return { ok: false, message: 'The formula could not be evaluated', budget: false };
  }
}
