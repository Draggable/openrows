import { type FieldMeta, FORMULA_FUNCTIONS, parseFormula } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import {
  analyzeFormula,
  completionSpot,
  displayFormula,
  errorSnippet,
  FUNCTION_NAMES,
  fieldReference,
  formulaFields,
  previewFormula,
  signatureAt,
  signatureLabel,
} from './model';

const field = (id: string, name: string, type: FieldMeta['type'], options: unknown = {}) =>
  ({
    id,
    tableId: '00000000-0000-7000-8000-000000000000',
    name,
    description: null,
    type,
    options,
    isPrimary: false,
    position: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    deletedAt: null,
  }) satisfies FieldMeta;

const NAME = '01900000-0000-7000-8000-000000000001';
const PRICE = '01900000-0000-7000-8000-000000000002';
const QTY = '01900000-0000-7000-8000-000000000003';
const SELF = '01900000-0000-7000-8000-000000000004';
const FIELDS: FieldMeta[] = [
  field(NAME, 'Name', 'singleLineText'),
  field(PRICE, 'Unit price', 'currency', { precision: 2 }),
  field(QTY, 'Qty', 'number'),
  field(SELF, 'Total', 'formula', { formula: `{${PRICE}} * {${QTY}}`, resultType: 'number' }),
];
const INFOS = formulaFields(FIELDS, SELF);

describe('formulaFields', () => {
  it('leaves out the edited field and types formulas by their result type', () => {
    expect(INFOS.map((f) => f.name)).toEqual(['Name', 'Unit price', 'Qty']);
    expect(formulaFields(FIELDS).at(-1)).toMatchObject({ type: 'formula', resultType: 'number' });
  });
});

describe('displayFormula', () => {
  it('prints the stored form with the current names', () => {
    expect(displayFormula(`{${PRICE}} * {${QTY}}`, INFOS)).toBe('{Unit price} * {Qty}');
  });
  it('keeps text written with names and text that does not parse', () => {
    expect(displayFormula('{Qty}  +  1', INFOS)).toBe('{Qty}  +  1');
    expect(displayFormula('SUM(', INFOS)).toBe('SUM(');
    expect(displayFormula('', INFOS)).toBe('');
  });
});

describe('analyzeFormula', () => {
  it('gives the stored form and result type of a valid formula', () => {
    const r = analyzeFormula('{Unit price} * Qty', INFOS);
    expect(r).toMatchObject({ ok: true, stored: `{${PRICE}} * {${QTY}}`, type: 'number' });
  });
  it('reports type errors with the checker range', () => {
    const r = analyzeFormula('{Name} * 2', INFOS);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.range).toEqual({ start: 0, end: 6 });
    expect(errorSnippet(r.errors[0] ?? never(), '{Name} * 2')).toBe('“{Name}”');
  });
  it('reports syntax errors and an empty formula', () => {
    expect(analyzeFormula('SUM(1,', INFOS).errors[0]?.code).toBe('unexpectedEnd');
    expect(analyzeFormula('NOPE(1)', INFOS).errors[0]).toMatchObject({
      code: 'unknownFunction',
      range: { start: 0, end: 4 },
    });
    expect(analyzeFormula('  ', INFOS)).toMatchObject({
      ok: false,
      errors: [{ code: 'unexpectedEnd' }],
    });
  });
});

function never(): never {
  throw new Error('missing');
}

describe('completionSpot', () => {
  it('completes a field inside braces, through the closing brace', () => {
    expect(completionSpot('1 + {Un', 7)).toEqual({ kind: 'field', from: 4, to: 7, query: 'Un' });
    expect(completionSpot('{Un} + 1', 3)).toEqual({ kind: 'field', from: 0, to: 4, query: 'Un' });
  });
  it('completes words (functions and bare fields), not text or numbers', () => {
    expect(completionSpot('IF(su', 5)).toEqual({ kind: 'name', from: 3, to: 5, query: 'su' });
    expect(completionSpot('"su', 3)).toBeNull();
    expect(completionSpot('1e5', 3)).toBeNull();
    expect(completionSpot('1 + ', 4)).toBeNull();
    expect(completionSpot('1 + ', 4, true)).toEqual({ kind: 'name', from: 4, to: 4, query: '' });
  });
});

describe('signature help', () => {
  it('labels every function of the library', () => {
    expect(FUNCTION_NAMES).toHaveLength(Object.keys(FORMULA_FUNCTIONS).length);
    for (const name of FUNCTION_NAMES) {
      const sig = FORMULA_FUNCTIONS[name] ?? never();
      expect(signatureLabel(name, sig)).toMatch(new RegExp(`^${name}\\(.*\\)$`));
    }
    expect(signatureLabel('ROUND', FORMULA_FUNCTIONS['ROUND'] ?? never())).toBe(
      'ROUND(number, [number])'
    );
    expect(signatureLabel('CONCATENATE', FORMULA_FUNCTIONS['CONCATENATE'] ?? never())).toBe(
      'CONCATENATE(text, [text, …])'
    );
  });
  it('finds the innermost call and the argument under the cursor', () => {
    expect(signatureAt('LEFT({Name}, ', 13)).toMatchObject({ name: 'LEFT', active: 1 });
    expect(signatureAt('IF(len(x', 8)).toMatchObject({ name: 'LEN', active: 0 });
    expect(signatureAt('IF(LEN(x), ', 11)).toMatchObject({ name: 'IF', active: 1 });
    expect(signatureAt('CONCATENATE(a, b, c, ', 21)).toMatchObject({ active: 1 });
    expect(signatureAt('(1 + ', 5)).toBeNull();
    expect(signatureAt('1 + 2', 5)).toBeNull();
  });
});

describe('fieldReference', () => {
  it('escapes braces and backslashes so the parser reads the name back', () => {
    const name = 'Odd } name \\';
    const ast = parseFormula(fieldReference(name), { fields: [{ id: NAME, name }] });
    expect(ast).toMatchObject({ ok: true, ast: { type: 'field', fieldId: NAME } });
  });
});

describe('previewFormula', () => {
  const record = {
    id: '01900000-0000-7000-8000-0000000000aa',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    fields: { [NAME]: 'Desk', [PRICE]: 12.5, [QTY]: 3 },
  };
  const ast = (source: string) => {
    const r = analyzeFormula(source, INFOS);
    return r.ast ?? never();
  };
  it('evaluates the formula for a record and formats it like the cells', () => {
    expect(previewFormula(ast('{Unit price} * Qty'), FIELDS, record, {})).toEqual({
      ok: true,
      text: '37.5',
    });
    expect(previewFormula(ast('{Unit price} * Qty'), FIELDS, record, { precision: 2 })).toEqual({
      ok: true,
      text: '37.50',
    });
    expect(previewFormula(ast('UPPER(Name) & "!"'), FIELDS, record, {})).toEqual({
      ok: true,
      text: 'DESK!',
    });
    expect(previewFormula(ast('BLANK()'), FIELDS, record, {})).toEqual({ ok: true, text: '' });
  });
  it('reports evaluation errors', () => {
    expect(previewFormula(ast('ERROR()'), FIELDS, record, {}).ok).toBe(false);
  });
});
