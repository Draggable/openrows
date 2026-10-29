import {
  type BinaryOperator,
  type FormulaError,
  type FormulaErrorCode,
  type FormulaNode,
  MAX_FORMULA_DEPTH,
  MAX_FORMULA_LENGTH,
  MAX_FORMULA_NESTING,
  type SourceRange,
} from './ast.js';
import { type Token, tokenize } from './lexer.js';

/** A field a formula can reference: its id and current name. */
export interface FormulaFieldRef {
  id: string;
  name: string;
}

export type ParseResult = { ok: true; ast: FormulaNode } | { ok: false; error: FormulaError };

/** Infix binding powers, lowest first (Airtable: comparison < `&` < `+ -` < `* /`). */
const INFIX: Record<string, number> = {
  '=': 10,
  '!=': 10,
  '<': 10,
  '<=': 10,
  '>': 10,
  '>=': 10,
  '&': 20,
  '+': 30,
  '-': 30,
  '*': 40,
  '/': 40,
};

/** Binding power of a prefix `-`/`+` (tighter than any infix operator). */
export const PREFIX_POWER = 50;

export function infixPower(operator: BinaryOperator): number {
  return INFIX[operator] ?? 0;
}

class ParseFailure {
  constructor(readonly error: FormulaError) {}
}

type Resolve = (reference: string, range: SourceRange) => string;

function fail(code: FormulaErrorCode, message: string, range: SourceRange): never {
  throw new ParseFailure({ code, message, range });
}

function describe(token: Token): string {
  switch (token.kind) {
    case 'end':
      return 'end of formula';
    case 'string':
      return 'text value';
    case 'reference':
      return 'field reference';
    case 'number':
      return `number ${token.text}`;
    default:
      return `"${token.text}"`;
  }
}

function parseTokens(source: string, resolve: Resolve, bareNames: boolean): ParseResult {
  if (source.length > MAX_FORMULA_LENGTH) {
    return {
      ok: false,
      error: {
        code: 'tooLong',
        message: `A formula can have at most ${MAX_FORMULA_LENGTH} characters`,
        range: { start: MAX_FORMULA_LENGTH, end: source.length },
      },
    };
  }
  const { tokens, error } = tokenize(source);
  if (error) return { ok: false, error };

  let pos = 0;
  let nesting = 0;
  const depth = new WeakMap<FormulaNode, number>();
  const peek = (): Token => tokens[pos] ?? (tokens[tokens.length - 1] as Token);
  const next = (): Token => {
    const token = peek();
    if (token.kind !== 'end') pos++;
    return token;
  };
  const unexpected = (token: Token): never =>
    token.kind === 'end'
      ? fail('unexpectedEnd', 'The formula ends too early', token.range)
      : fail('unexpectedToken', `Unexpected ${describe(token)}`, token.range);
  const expect = (kind: Token['kind'], what: string): Token => {
    const token = peek();
    if (token.kind !== kind) {
      if (token.kind === 'end') fail('unexpectedEnd', `Expected ${what}`, token.range);
      fail('unexpectedToken', `Expected ${what}, found ${describe(token)}`, token.range);
    }
    return next();
  };
  const node = <N extends FormulaNode>(n: N, ...children: FormulaNode[]): N => {
    const d = 1 + Math.max(0, ...children.map((c) => depth.get(c) ?? 1));
    if (d > MAX_FORMULA_DEPTH)
      fail('tooDeep', `A formula can nest at most ${MAX_FORMULA_DEPTH} levels`, n.range);
    depth.set(n, d);
    return n;
  };
  const nested = <T>(token: Token, parse: () => T): T => {
    if (++nesting > MAX_FORMULA_NESTING)
      fail(
        'tooDeep',
        `Parentheses, functions and signs can nest at most ${MAX_FORMULA_NESTING} levels`,
        token.range
      );
    const result = parse();
    nesting--;
    return result;
  };

  const parsePrefix = (): FormulaNode => {
    const token = next();
    switch (token.kind) {
      case 'number': {
        const value = Number(token.text);
        if (!Number.isFinite(value)) fail('invalidNumber', 'This number is too large', token.range);
        return node({ type: 'number', value, range: token.range });
      }
      case 'string':
        return node({ type: 'string', value: token.text, range: token.range });
      case 'reference':
        return node({
          type: 'field',
          fieldId: resolve(token.text, token.range),
          range: token.range,
        });
      case '(': {
        const inner = nested(token, () => parseExpression(0));
        expect(')', '")"');
        return inner;
      }
      case 'operator': {
        if (token.text !== '-' && token.text !== '+') return unexpected(token);
        const operand = nested(token, () => parseExpression(PREFIX_POWER));
        return node(
          {
            type: 'unary',
            operator: token.text,
            operand,
            range: { start: token.range.start, end: operand.range.end },
          },
          operand
        );
      }
      case 'identifier': {
        if (peek().kind === '(') {
          const open = next();
          const args: FormulaNode[] = [];
          nested(open, () => {
            if (peek().kind !== ')') {
              args.push(parseExpression(0));
              while (peek().kind === ',') {
                next();
                args.push(parseExpression(0));
              }
            }
          });
          const close = expect(')', '"," or ")"');
          return node(
            {
              type: 'call',
              name: token.text.toUpperCase(),
              args,
              range: { start: token.range.start, end: close.range.end },
              nameRange: token.range,
            },
            ...args
          );
        }
        const upper = token.text.toUpperCase();
        if (upper === 'TRUE' || upper === 'FALSE')
          return node({ type: 'boolean', value: upper === 'TRUE', range: token.range });
        if (!bareNames)
          fail(
            'unexpectedToken',
            `Unexpected "${token.text}": write fields as {Name}`,
            token.range
          );
        return node({
          type: 'field',
          fieldId: resolve(token.text, token.range),
          range: token.range,
        });
      }
      default:
        return unexpected(token);
    }
  };

  function parseExpression(minPower: number): FormulaNode {
    let left = parsePrefix();
    for (;;) {
      const token = peek();
      if (token.kind !== 'operator') break;
      const power = INFIX[token.text];
      if (power === undefined || power <= minPower) break;
      next();
      const right = parseExpression(power);
      left = node(
        {
          type: 'binary',
          operator: token.text as BinaryOperator,
          left,
          right,
          range: { start: left.range.start, end: right.range.end },
        },
        left,
        right
      );
    }
    return left;
  }

  try {
    if (peek().kind === 'end')
      fail('unexpectedEnd', 'The formula is empty', { start: 0, end: source.length });
    const ast = parseExpression(0);
    const rest = peek();
    if (rest.kind !== 'end') unexpected(rest);
    return { ok: true, ast };
  } catch (e) {
    if (e instanceof ParseFailure) return { ok: false, error: e.error };
    // A RangeError here would mean a recursion bound is wrong; report it rather than crash.
    if (e instanceof RangeError)
      return {
        ok: false,
        error: {
          code: 'tooDeep',
          message: 'This formula is too deep',
          range: { start: 0, end: 0 },
        },
      };
    throw e;
  }
}

/** Unescaped reference text → field id, matching names exactly, then ignoring case. */
function nameResolver(fields: readonly FormulaFieldRef[]): Resolve {
  const exact = new Map<string, string>();
  const folded = new Map<string, string | null>();
  for (const f of fields) {
    if (!exact.has(f.name)) exact.set(f.name, f.id);
    const key = f.name.trim().toLowerCase();
    folded.set(key, folded.has(key) && folded.get(key) !== f.id ? null : f.id);
  }
  return (reference, range) => {
    const id = exact.get(reference) ?? folded.get(reference.trim().toLowerCase());
    if (!id) fail('unknownField', `Unknown field {${reference}}`, range);
    return id;
  };
}

/**
 * Parses formula text as a user writes it: fields by name, as `{Field name}` or a bare
 * single-word name (`Price * 2`). Names resolve against `fields` (exact match first, then
 * ignoring case); the AST holds their ids.
 */
export function parseFormula(
  source: string,
  options: { fields: readonly FormulaFieldRef[] }
): ParseResult {
  return parseTokens(source, nameResolver(options.fields), true);
}

/** Parses the stored form (`serializeFormula`): every `{...}` is a field id. */
export function parseStoredFormula(stored: string): ParseResult {
  return parseTokens(stored, (reference) => reference, false);
}
