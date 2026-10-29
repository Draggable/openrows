import {
  type ArgKind,
  type CompileResult,
  compileFormula,
  evaluateFormula,
  type FieldMeta,
  FORMULA_FUNCTIONS,
  type FormulaError,
  type FormulaFieldInfo,
  type FormulaNode,
  type FormulaType,
  type FunctionSignature,
  fieldFormulaValue,
  formatFormula,
  formulaOptionsSchema,
  formulaResult,
  getFieldType,
  parseFormula,
  parseStoredFormula,
  type Token,
  tokenize,
} from '@openrows/shared';

// The formula editor's logic, apart from CodeMirror: what the fields look like to the
// parser and type checker, completions, signature help, diagnostics and the result preview. All
// of it comes from the shared engine, so the editor agrees with the server.

/** The table's fields as the parser and type checker see them, without the edited field. */
export function formulaFields(fields: readonly FieldMeta[], selfId?: string): FormulaFieldInfo[] {
  return fields
    .filter((f) => f.id !== selfId && !f.deletedAt)
    .map((f) => {
      const resultType =
        f.type === 'formula' ? formulaOptionsSchema.safeParse(f.options).data?.resultType : null;
      return { id: f.id, name: f.name, type: f.type, ...(resultType ? { resultType } : {}) };
    });
}

/**
 * The text to show for a saved formula: the stored form (fields by id) re-printed with the
 * current names. Text that isn't in the stored form (fields by name) stays as it is.
 */
export function displayFormula(formula: string, fields: readonly FormulaFieldInfo[]): string {
  if (formula.trim() === '' || parseFormula(formula, { fields }).ok) return formula;
  const stored = parseStoredFormula(formula);
  return stored.ok ? formatFormula(stored.ast, fields) : formula;
}

export type FormulaAnalysis =
  | { ok: true; ast: FormulaNode; stored: string; type: FormulaType; errors: [] }
  | { ok: false; ast: FormulaNode | null; type: FormulaType | null; errors: FormulaError[] };

/** Parses and type-checks the editor's text; an empty formula is an error too (can't save). */
export function analyzeFormula(
  source: string,
  fields: readonly FormulaFieldInfo[]
): FormulaAnalysis {
  if (source.trim() === '') {
    return {
      ok: false,
      ast: null,
      type: null,
      errors: [{ code: 'unexpectedEnd', message: 'Write a formula', range: { start: 0, end: 0 } }],
    };
  }
  const r: CompileResult = compileFormula(source, { fields });
  if (r.ok) return { ok: true, ast: r.ast, stored: r.stored, type: r.type, errors: [] };
  return { ok: false, ast: r.ast, type: r.type, errors: r.errors };
}

/** "returns a number" and friends, for the result type preview. */
export const RESULT_TYPE_LABELS: Record<FormulaType, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  boolean: 'Boolean (1 or 0)',
  array: 'List',
  null: 'Blank',
  any: 'Depends on the values',
};

/** A field name as a reference: `{Name}` with `\` and `}` escaped. */
export function fieldReference(name: string): string {
  return `{${name.replace(/[\\}]/g, (c) => `\\${c}`)}}`;
}

export type CompletionSpot =
  /** Inside `{…`: field names; `from` is the `{`, `to` the end of the reference (after `}`). */
  | { kind: 'field'; from: number; to: number; query: string }
  /** A word (or nothing, on request): functions and fields; `from` is its start. */
  | { kind: 'name'; from: number; to: number; query: string };

const WORD_END = /[\p{L}_][\p{L}\p{N}_]*$/u;
const WORD_START = /^[\p{L}\p{N}_]*/u;

/**
 * What to complete at `pos`: a field reference being typed, a word (function or bare field
 * name), or, when `explicit` (Ctrl-Space), whatever goes at the cursor. Nothing inside text.
 */
export function completionSpot(
  source: string,
  pos: number,
  explicit = false
): CompletionSpot | null {
  const before = tokenize(source.slice(0, pos));
  if (before.error?.code === 'unterminatedString') return null;
  if (before.error?.code === 'unterminatedReference') {
    const from = before.error.range.start;
    // The reference's end: through the closing `}` if the rest of the source has one.
    const rest = tokenize(source.slice(from));
    const first = rest.tokens[0];
    const to = first?.kind === 'reference' ? from + first.range.end : pos;
    return { kind: 'field', from, to, query: source.slice(from + 1, pos) };
  }
  if (before.error) return null;
  const word = WORD_END.exec(source.slice(0, pos));
  const after = WORD_START.exec(source.slice(pos))?.[0].length ?? 0;
  if (word) {
    // A number like `1e5` isn't a word.
    const last = before.tokens.at(-2);
    if (last?.kind === 'number' && last.range.end === pos) return null;
    return { kind: 'name', from: pos - word[0].length, to: pos + after, query: word[0] };
  }
  return explicit ? { kind: 'name', from: pos, to: pos, query: '' } : null;
}

const KIND_LABELS: Record<ArgKind, string> = {
  any: 'value',
  text: 'text',
  number: 'number',
  numbers: 'number',
  date: 'date',
  boolean: 'condition',
  array: 'list',
  unit: 'unit',
};

/** A function's parameters for display: `["text", "[number]"]`, `"…"` for the rest. */
export function signatureParams(sig: FunctionSignature): string[] {
  const params = sig.args.map((kind, i) =>
    i < sig.required ? KIND_LABELS[kind] : `[${KIND_LABELS[kind]}]`
  );
  if (sig.rest) params.push(`[${KIND_LABELS[sig.rest]}, …]`);
  return params;
}

/** `LEFT(text, number)`. */
export function signatureLabel(name: string, sig: FunctionSignature): string {
  return `${name}(${signatureParams(sig).join(', ')})`;
}

/** Every function in the library, alphabetically. */
export const FUNCTION_NAMES: readonly string[] = Object.keys(FORMULA_FUNCTIONS).sort();

export type SignatureHelp = {
  name: string;
  signature: FunctionSignature;
  params: string[];
  /** Index into `params` of the argument the cursor is in (the rest marker past the end). */
  active: number;
};

/** The innermost function call around `pos`, and which argument the cursor is in. */
export function signatureAt(source: string, pos: number): SignatureHelp | null {
  const { tokens } = tokenize(source.slice(0, pos));
  const stack: { name: string | null; arg: number }[] = [];
  let previous: Token | undefined;
  for (const token of tokens) {
    if (token.kind === '(') {
      stack.push({
        name: previous?.kind === 'identifier' ? previous.text.toUpperCase() : null,
        arg: 0,
      });
    } else if (token.kind === ',') {
      const top = stack.at(-1);
      if (top) top.arg += 1;
    } else if (token.kind === ')') {
      stack.pop();
    }
    previous = token;
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    const call = stack[i];
    if (!call?.name) continue;
    const signature = FORMULA_FUNCTIONS[call.name];
    if (!signature) return null;
    const params = signatureParams(signature);
    if (params.length === 0) return { name: call.name, signature, params, active: -1 };
    return {
      name: call.name,
      signature,
      params,
      active: Math.min(call.arg, params.length - 1),
    };
  }
  return null;
}

/** An error's range clamped to the text, for the inline marks. */
export function errorRange(error: FormulaError, length: number): { from: number; to: number } {
  const from = Math.max(0, Math.min(error.range.start, length));
  return { from, to: Math.max(from, Math.min(error.range.end, length)) };
}

/** The characters an error points at, for the error list ("at the end" when it's empty). */
export function errorSnippet(error: FormulaError, source: string): string {
  const { from, to } = errorRange(error, source.length);
  const text = source.slice(from, to).trim();
  if (text === '') return from >= source.trimEnd().length ? 'at the end' : `at ${from + 1}`;
  return text.length > 40 ? `“${text.slice(0, 39)}…”` : `“${text}”`;
}

export type FormulaPreview = { ok: true; text: string } | { ok: false; message: string };

/**
 * The formula's result for one record (its cells as the API gives them), evaluated like the
 * server does and shown like the field's cells (`format` with the field's options).
 */
export function previewFormula(
  ast: FormulaNode,
  fields: readonly FieldMeta[],
  record: {
    id: string;
    createdAt: string;
    updatedAt: string;
    fields: Record<string, unknown>;
  },
  options: unknown,
  now = Date.now()
): FormulaPreview {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const result = evaluateFormula(ast, {
    field: (id) => {
      const field = byId.get(id);
      if (!field) return null;
      const resultType =
        field.type === 'formula'
          ? formulaOptionsSchema.safeParse(field.options).data?.resultType
          : undefined;
      const def = getFieldType(field.type);
      const parsed = def.optionsSchema.safeParse(field.options ?? {});
      return fieldFormulaValue(
        {
          type: field.type,
          options: parsed.success ? parsed.data : def.optionsSchema.parse({}),
          ...(resultType ? { resultType } : {}),
        },
        record.fields[id] ?? null
      );
    },
    now,
    recordId: record.id,
    createdTime: Date.parse(record.createdAt),
    lastModifiedTime: Date.parse(record.updatedAt),
  });
  if (!result.ok) return { ok: false, message: result.message };
  const value = formulaResult(result);
  if (value === null) return { ok: true, text: '' };
  const def = getFieldType('formula');
  const parsed = def.optionsSchema.safeParse(options);
  return {
    ok: true,
    text: def.format(value as never, parsed.success ? parsed.data : def.optionsSchema.parse({})),
  };
}
