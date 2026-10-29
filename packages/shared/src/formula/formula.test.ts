import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { FormulaFieldInfo } from './check.js';
import { FIXTURE_FIELDS } from './fixtures.js';
import {
  checkFormula,
  compileFormula,
  FORMULA_FUNCTIONS,
  FORMULA_TYPES,
  type FormulaNode,
  formatFormula,
  MAX_FORMULA_DEPTH,
  MAX_FORMULA_LENGTH,
  MAX_FORMULA_NESTING,
  type ParseResult,
  parseFormula,
  parseStoredFormula,
  serializeFormula,
  tokenize,
} from './index.js';

const fields = FIXTURE_FIELDS;
const parse = (source: string) => parseFormula(source, { fields });

function shape(node: FormulaNode): unknown {
  return JSON.parse(
    JSON.stringify(node, (key, value) =>
      key === 'range' || key === 'nameRange' ? undefined : value
    )
  );
}

function expectSane(result: ParseResult, length: number) {
  if (result.ok) {
    expect(result.ast.range.start).toBeGreaterThanOrEqual(0);
    expect(result.ast.range.end).toBeLessThanOrEqual(length);
    const checked = checkFormula(result.ast, { fields });
    expect(FORMULA_TYPES).toContain(checked.type);
    for (const e of checked.errors) {
      expect(e.range.start).toBeGreaterThanOrEqual(0);
      expect(e.range.end).toBeLessThanOrEqual(length);
    }
    // Whatever parses round-trips through both forms.
    const stored = serializeFormula(result.ast);
    const back = parseStoredFormula(stored);
    expect(back.ok && shape(back.ast)).toEqual(shape(result.ast));
    const display = parse(formatFormula(result.ast, fields));
    expect(display.ok && shape(display.ast)).toEqual(shape(result.ast));
  } else {
    expect(result.error.range.start).toBeGreaterThanOrEqual(0);
    expect(result.error.range.start).toBeLessThanOrEqual(result.error.range.end);
    expect(result.error.range.end).toBeLessThanOrEqual(length);
    expect(result.error.message).not.toBe('');
  }
}

describe('parseFormula', () => {
  it('builds a typed AST with source ranges and field ids', () => {
    const result = parse('{Price} * 2');
    expect(result).toEqual({
      ok: true,
      ast: {
        type: 'binary',
        operator: '*',
        left: { type: 'field', fieldId: fields[2]?.id, range: { start: 0, end: 7 } },
        right: { type: 'number', value: 2, range: { start: 10, end: 11 } },
        range: { start: 0, end: 11 },
      },
    });
  });

  it('accepts line breaks and tabs between tokens', () => {
    const result = parse('IF(\n\t{Done},\r\n\t"yes",\n\t"no"\n)');
    expect(result.ok && serializeFormula(result.ast)).toBe(`IF({${fields[6]?.id}}, "yes", "no")`);
  });

  it('rejects an empty formula', () => {
    expect(parse('')).toMatchObject({ ok: false, error: { code: 'unexpectedEnd' } });
    expect(parse('   ')).toMatchObject({ ok: false, error: { code: 'unexpectedEnd' } });
  });

  it('caps the length', () => {
    const long = `"${'x'.repeat(MAX_FORMULA_LENGTH)}"`;
    expect(parse(long)).toMatchObject({
      ok: false,
      error: { code: 'tooLong', range: { start: MAX_FORMULA_LENGTH, end: long.length } },
    });
    expect(parse(`"${'x'.repeat(MAX_FORMULA_LENGTH - 2)}"`).ok).toBe(true);
  });

  it('caps nesting of parentheses, calls and signs without blowing the stack', () => {
    const ok = `${'('.repeat(MAX_FORMULA_NESTING)}1${')'.repeat(MAX_FORMULA_NESTING)}`;
    expect(parse(ok).ok).toBe(true);
    for (const deep of [
      `${'('.repeat(MAX_FORMULA_NESTING + 1)}1${')'.repeat(MAX_FORMULA_NESTING + 1)}`,
      `${'('.repeat(4000)}1${')'.repeat(4000)}`,
      `${'ABS('.repeat(1500)}1${')'.repeat(1500)}`,
      `${'-'.repeat(9000)}1`,
      '('.repeat(MAX_FORMULA_LENGTH),
    ]) {
      expect(parse(deep)).toMatchObject({ ok: false, error: { code: 'tooDeep' } });
    }
  });

  it('caps the depth of long operator chains', () => {
    const chain = (n: number) => Array.from({ length: n }, () => '1').join('+');
    expect(parse(chain(MAX_FORMULA_DEPTH)).ok).toBe(true);
    expect(parse(chain(MAX_FORMULA_DEPTH + 1))).toMatchObject({
      ok: false,
      error: { code: 'tooDeep' },
    });
    expect(parse(chain(4000))).toMatchObject({ ok: false, error: { code: 'tooDeep' } });
  });

  it('only reads ids in the stored form, never bare names', () => {
    expect(parseStoredFormula('{anything} + 1').ok).toBe(true);
    expect(parseStoredFormula('Price + 1')).toMatchObject({
      ok: false,
      error: { code: 'unexpectedToken', range: { start: 0, end: 5 } },
    });
  });
});

describe('stored and display forms', () => {
  const table: FormulaFieldInfo[] = [
    { id: 'f1', name: 'Price', type: 'number' },
    { id: 'f2', name: 'Qty', type: 'number' },
  ];

  it('is rename-safe: the stored form keeps ids, the display form follows the names', () => {
    const compiled = compileFormula('ROUND({Price} * Qty, 2)', { fields: table });
    expect(compiled).toMatchObject({ ok: true, stored: 'ROUND({f1} * {f2}, 2)', type: 'number' });
    const renamed = table.map((f) => (f.id === 'f1' ? { ...f, name: 'Unit } cost' } : f));
    const stored = parseStoredFormula(compiled.stored ?? '');
    expect(stored.ok && formatFormula(stored.ast, renamed)).toBe(
      'ROUND({Unit \\} cost} * {Qty}, 2)'
    );
    const reparsed = parseFormula('ROUND({Unit \\} cost} * {Qty}, 2)', { fields: renamed });
    expect(reparsed.ok && serializeFormula(reparsed.ast)).toBe(compiled.stored);
  });

  it('shows a deleted field by id, which then fails to parse and to check', () => {
    const stored = parseStoredFormula('{f9} + 1');
    if (!stored.ok) throw new Error('expected a parse');
    expect(formatFormula(stored.ast, table)).toBe('{f9} + 1');
    expect(checkFormula(stored.ast, { fields: table }).errors).toEqual([
      { code: 'unknownField', message: 'This field no longer exists', range: { start: 0, end: 4 } },
    ]);
    expect(compileFormula('{f9} + 1', { fields: table })).toMatchObject({
      ok: false,
      errors: [{ code: 'unknownField' }],
    });
  });

  it('is canonical: the same formula written differently stores the same text', () => {
    const forms = [
      'round( {Price}*(Qty) ,2 )',
      'ROUND({Price} * {Qty}, 2)',
      'Round((Price*Qty),2)',
    ];
    const stored = new Set(forms.map((f) => compileFormula(f, { fields: table }).stored));
    expect([...stored]).toEqual(['ROUND({f1} * {f2}, 2)']);
  });

  it('keeps the parentheses precedence needs', () => {
    for (const [source, canonical] of [
      ['(1 + 2) * 3', '(1 + 2) * 3'],
      ['1 - (2 - 3)', '1 - (2 - 3)'],
      ['(1 - 2) - 3', '1 - 2 - 3'],
      ['-(1 + 2)', '-(1 + 2)'],
      ['("a" & "b") = "ab"', '"a" & "b" = "ab"'],
      ['1 = (2 = 3)', '1 = (2 = 3)'],
    ] as const) {
      const result = parse(source);
      expect(result.ok && serializeFormula(result.ast)).toBe(canonical);
    }
  });
});

describe('compileFormula', () => {
  it('reports type errors but keeps the AST and stored form for the editor', () => {
    const result = compileFormula('{Name} * 2 + YEAR({Price})', { fields });
    expect(result.ok).toBe(false);
    expect(result.stored).not.toBeNull();
    expect(result.errors.map((e) => [e.code, e.range])).toEqual([
      ['typeMismatch', { start: 0, end: 6 }],
      ['typeMismatch', { start: 18, end: 25 }],
    ]);
  });

  it('reports a syntax error without an AST', () => {
    expect(compileFormula('1 +', { fields })).toMatchObject({
      ok: false,
      ast: null,
      stored: null,
      errors: [{ code: 'unexpectedEnd', range: { start: 3, end: 3 } }],
    });
  });
});

describe('function catalog', () => {
  it('has upper-case names that the lexer reads as identifiers', () => {
    for (const name of Object.keys(FORMULA_FUNCTIONS)) {
      expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
      const tokens = tokenize(`${name}()`).tokens;
      expect(tokens[0]).toMatchObject({ kind: 'identifier', text: name });
    }
  });
});

// Fuzzing: random input never crashes the lexer, parser, checker or printers, every range
// stays inside the source, and whatever parses round-trips.

const TOKENS = [
  ...Object.keys(FORMULA_FUNCTIONS),
  ...fields.map((f) => `{${f.name.replace(/[\\}]/g, (c) => `\\${c}`)}}`),
  'Price',
  'Qty',
  'Nope',
  '{Nope}',
  'TRUE',
  'FALSE',
  '(',
  ')',
  ',',
  '+',
  '-',
  '*',
  '/',
  '&',
  '=',
  '!=',
  '<>',
  '<',
  '<=',
  '>',
  '>=',
  '0',
  '1',
  '2.5',
  '1e3',
  '.5',
  '"text"',
  "'x'",
  '""',
  '"\\"',
  '"unterminated',
  '{',
  '}',
  '\\',
  ' ',
  '\n',
  '!',
  '%',
];

describe('fuzzing', () => {
  it('never throws on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (source) => {
        expectSane(parse(source), source.length);
        expectSane(parseStoredFormula(source), source.length);
      }),
      { numRuns: 3000 }
    );
  });

  it('never throws on token soup', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...TOKENS), { maxLength: 60 }),
        fc.boolean(),
        (parts, spaced) => {
          const source = parts.join(spaced ? ' ' : '');
          expectSane(parse(source), source.length);
        }
      ),
      { numRuns: 5000 }
    );
  });

  it('never throws on mutated valid formulas', () => {
    const seeds = [
      'IF(AND({Price} > 0, {Qty} > 0), ROUND({Price} * {Qty}, 2), BLANK())',
      'DATETIME_FORMAT(DATEADD({Due}, -7, "days"), "M/D/YYYY") & " · " & {Name}',
      'SWITCH({Status}, "Todo", 0, "Done", 1, 0.5)',
      '{Weird \\} name} & {Back\\\\slash} & "say \\"hi\\""',
    ];
    const edit = fc.record({
      at: fc.nat(),
      remove: fc.nat({ max: 3 }),
      insert: fc.oneof(fc.constantFrom(...TOKENS), fc.string({ maxLength: 3 })),
    });
    fc.assert(
      fc.property(
        fc.constantFrom(...seeds),
        fc.array(edit, { minLength: 1, maxLength: 5 }),
        (seed, edits) => {
          let source = seed;
          for (const e of edits) {
            const at = e.at % (source.length + 1);
            source = source.slice(0, at) + e.insert + source.slice(at + e.remove);
          }
          expectSane(parse(source), source.length);
        }
      ),
      { numRuns: 5000 }
    );
  });

  it('round-trips every generated AST through the stored and display forms', () => {
    const range = { start: 0, end: 0 };
    const names = [...Object.keys(FORMULA_FUNCTIONS), 'NOSUCH', 'X_1'];
    const { node } = fc.letrec<{ node: FormulaNode }>((tie) => ({
      node: fc.oneof(
        { depthSize: 'small', withCrossShrink: true },
        fc
          .double({ min: 0, noNaN: true, noDefaultInfinity: true })
          .map((value) => ({ type: 'number' as const, value, range })),
        fc
          .string({ unit: 'binary', maxLength: 8 })
          .map((value) => ({ type: 'string' as const, value, range })),
        fc.boolean().map((value) => ({ type: 'boolean' as const, value, range })),
        fc
          .constantFrom(...fields.map((f) => f.id))
          .map((fieldId) => ({ type: 'field' as const, fieldId, range })),
        fc.record({
          type: fc.constant('unary' as const),
          operator: fc.constantFrom('-' as const, '+' as const),
          operand: tie('node'),
          range: fc.constant(range),
        }),
        fc.record({
          type: fc.constant('binary' as const),
          operator: fc.constantFrom(
            '+',
            '-',
            '*',
            '/',
            '&',
            '=',
            '!=',
            '<',
            '<=',
            '>',
            '>=' as const
          ),
          left: tie('node'),
          right: tie('node'),
          range: fc.constant(range),
        }),
        fc.record({
          type: fc.constant('call' as const),
          name: fc.constantFrom(...names),
          args: fc.array(tie('node'), { maxLength: 4 }),
          range: fc.constant(range),
          nameRange: fc.constant(range),
        })
      ),
    }));
    fc.assert(
      fc.property(node, (ast) => {
        const stored = serializeFormula(ast);
        const back = parseStoredFormula(stored);
        expect(back.ok && shape(back.ast)).toEqual(shape(ast));
        expect(back.ok && serializeFormula(back.ast)).toBe(stored);
        const display = parse(formatFormula(ast, fields));
        expect(display.ok && shape(display.ast)).toEqual(shape(ast));
        const checked = checkFormula(ast, { fields });
        expect(FORMULA_TYPES).toContain(checked.type);
      }),
      { numRuns: 3000 }
    );
  });
});
