import type { FormulaError, SourceRange } from './ast.js';

export type TokenKind =
  | 'number'
  | 'string'
  | 'reference'
  | 'identifier'
  | 'operator'
  | '('
  | ')'
  | ','
  | 'end';

export interface Token {
  kind: TokenKind;
  /** Number text, string value (unescaped), reference content (unescaped), name or operator. */
  text: string;
  range: SourceRange;
}

const OPERATORS = ['!=', '<>', '<=', '>=', '+', '-', '*', '/', '&', '=', '<', '>'];

const IDENT_START = /[\p{L}_]/u;
const IDENT_PART = /[\p{L}\p{N}_]/u;

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ' ';
}

/** String escapes; any other `\x` keeps its backslash (so `"\d"` in a regex stays `\d`). */
const ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '"': '"',
  "'": "'",
  '\\': '\\',
};

/** Splits formula source into tokens. Never throws; the first error stops it. */
export function tokenize(source: string): { tokens: Token[]; error: FormulaError | null } {
  const tokens: Token[] = [];
  let i = 0;
  const fail = (code: FormulaError['code'], message: string, start: number, end: number) => ({
    tokens,
    error: { code, message, range: { start, end } },
  });

  while (i < source.length) {
    const ch = source.charAt(i);
    if (isSpace(ch)) {
      i++;
      continue;
    }
    const start = i;

    if (isDigit(ch) || (ch === '.' && isDigit(source[i + 1]))) {
      while (isDigit(source[i])) i++;
      if (source[i] === '.') {
        i++;
        while (isDigit(source[i])) i++;
      }
      if (source[i] === 'e' || source[i] === 'E') {
        const save = i;
        i++;
        if (source[i] === '+' || source[i] === '-') i++;
        if (isDigit(source[i])) while (isDigit(source[i])) i++;
        else i = save;
      }
      tokens.push({ kind: 'number', text: source.slice(start, i), range: { start, end: i } });
      continue;
    }

    if (ch === '"' || ch === "'") {
      i++;
      let value = '';
      let closed = false;
      while (i < source.length) {
        const c = source.charAt(i);
        if (c === ch) {
          closed = true;
          i++;
          break;
        }
        if (c === '\\' && i + 1 < source.length) {
          const next = source.charAt(i + 1);
          value += ESCAPES[next] ?? `\\${next}`;
          i += 2;
          continue;
        }
        value += c;
        i++;
      }
      if (!closed)
        return fail('unterminatedString', 'This text is missing its closing quote', start, i);
      tokens.push({ kind: 'string', text: value, range: { start, end: i } });
      continue;
    }

    if (ch === '{') {
      i++;
      let name = '';
      let closed = false;
      while (i < source.length) {
        const c = source.charAt(i);
        if (c === '}') {
          closed = true;
          i++;
          break;
        }
        if (c === '\\' && i + 1 < source.length) {
          name += source.charAt(i + 1);
          i += 2;
          continue;
        }
        name += c;
        i++;
      }
      if (!closed)
        return fail('unterminatedReference', 'This field reference is missing its "}"', start, i);
      if (name.trim() === '')
        return fail('emptyReference', 'A field reference needs a field name', start, i);
      tokens.push({ kind: 'reference', text: name, range: { start, end: i } });
      continue;
    }

    if (IDENT_START.test(ch)) {
      i++;
      while (i < source.length && IDENT_PART.test(source.charAt(i))) i++;
      tokens.push({ kind: 'identifier', text: source.slice(start, i), range: { start, end: i } });
      continue;
    }

    if (ch === '(' || ch === ')' || ch === ',') {
      i++;
      tokens.push({ kind: ch, text: ch, range: { start, end: i } });
      continue;
    }

    const op = OPERATORS.find((o) => source.startsWith(o, i));
    if (op) {
      i += op.length;
      tokens.push({
        kind: 'operator',
        text: op === '<>' ? '!=' : op,
        range: { start, end: i },
      });
      continue;
    }

    const cp = source.codePointAt(i) ?? 0;
    const width = cp > 0xffff ? 2 : 1;
    return fail(
      'unexpectedCharacter',
      `Unexpected character "${source.slice(i, i + width)}"`,
      start,
      i + width
    );
  }
  tokens.push({ kind: 'end', text: '', range: { start: source.length, end: source.length } });
  return { tokens, error: null };
}
