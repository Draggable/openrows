// The formula AST. References are field ids: a rename never changes a parsed formula or
// its stored text. Every node carries the source range it was parsed from, so the type checker
// and the editor can point at the exact characters.

/** Half-open `[start, end)` UTF-16 offsets into the source text. */
export interface SourceRange {
  start: number;
  end: number;
}

export type BinaryOperator = '+' | '-' | '*' | '/' | '&' | '=' | '!=' | '<' | '<=' | '>' | '>=';

export type UnaryOperator = '-' | '+';

export interface NumberNode {
  type: 'number';
  value: number;
  range: SourceRange;
}

export interface StringNode {
  type: 'string';
  value: string;
  range: SourceRange;
}

/** Bare `TRUE`/`FALSE` (`TRUE()`/`FALSE()` are calls). */
export interface BooleanNode {
  type: 'boolean';
  value: boolean;
  range: SourceRange;
}

/** A field reference, by id. */
export interface FieldNode {
  type: 'field';
  fieldId: string;
  range: SourceRange;
}

export interface UnaryNode {
  type: 'unary';
  operator: UnaryOperator;
  operand: FormulaNode;
  range: SourceRange;
}

export interface BinaryNode {
  type: 'binary';
  operator: BinaryOperator;
  left: FormulaNode;
  right: FormulaNode;
  range: SourceRange;
}

/** A function call. `name` is upper-cased; unknown names are a type error, not a parse error. */
export interface CallNode {
  type: 'call';
  name: string;
  args: FormulaNode[];
  range: SourceRange;
  /** The range of the name, for "unknown function" errors. */
  nameRange: SourceRange;
}

export type FormulaNode =
  | NumberNode
  | StringNode
  | BooleanNode
  | FieldNode
  | UnaryNode
  | BinaryNode
  | CallNode;

export type FormulaErrorCode =
  // syntax
  | 'tooLong'
  | 'tooDeep'
  | 'unexpectedCharacter'
  | 'unexpectedToken'
  | 'unexpectedEnd'
  | 'unterminatedString'
  | 'unterminatedReference'
  | 'emptyReference'
  | 'invalidNumber'
  | 'unknownField'
  // types
  | 'unknownFunction'
  | 'wrongArgumentCount'
  | 'typeMismatch'
  | 'invalidArgument';

/** A syntax or type error with the source range it applies to. */
export interface FormulaError {
  code: FormulaErrorCode;
  message: string;
  range: SourceRange;
}

/** Longest formula source accepted, in UTF-16 code units. */
export const MAX_FORMULA_LENGTH = 10_000;

/** Deepest nesting of parentheses, calls and unary operators. */
export const MAX_FORMULA_NESTING = 64;

/**
 * Deepest AST accepted (operator chains like `a & b & c & ...` nest one level per operator).
 * Every recursive walk over an AST is bounded by it, so a hostile formula can't blow the stack.
 */
export const MAX_FORMULA_DEPTH = 512;
