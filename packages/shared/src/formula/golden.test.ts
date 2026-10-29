import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FormulaNode } from './ast.js';
import { checkFormula } from './check.js';
import { FIXTURE_FIELDS } from './fixtures.js';
import { parseFormula, parseStoredFormula } from './parser.js';
import { formatFormula, serializeFormula } from './serialize.js';

// Golden files: `__golden__/<suite>.formulas.txt` lists formulas, one per line (`#` lines
// and blank lines are skipped); `<suite>.golden.json` holds what each one parses and types to.
// Regenerate after an intended change with
//   UPDATE_GOLDEN=1 npx vitest run packages/shared/src/formula/golden.test.ts
// and review the diff.

const DIR = join(import.meta.dirname, '__golden__');
const UPDATE = process.env['UPDATE_GOLDEN'] === '1';

function run(formula: string) {
  const parsed = parseFormula(formula, { fields: FIXTURE_FIELDS });
  if (!parsed.ok) return { formula, error: parsed.error };
  const { type, errors } = checkFormula(parsed.ast, { fields: FIXTURE_FIELDS });
  return {
    formula,
    stored: serializeFormula(parsed.ast),
    display: formatFormula(parsed.ast, FIXTURE_FIELDS),
    type,
    errors,
    ast: parsed.ast,
  };
}

/** The AST without source ranges, for comparing re-parsed forms. */
function shape(node: FormulaNode): unknown {
  return JSON.parse(
    JSON.stringify(node, (key, value) =>
      key === 'range' || key === 'nameRange' ? undefined : value
    )
  );
}

const suites = readdirSync(DIR)
  .filter((f) => f.endsWith('.formulas.txt'))
  .map((f) => f.replace(/\.formulas\.txt$/, ''))
  .sort();

it('has 500+ golden formulas', () => {
  const total = suites
    .map((s) => readFileSync(join(DIR, `${s}.formulas.txt`), 'utf8'))
    .flatMap((text) => text.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#')));
  expect(total.length).toBeGreaterThanOrEqual(500);
});

describe.each(suites)('%s', (suite) => {
  const formulas = readFileSync(join(DIR, `${suite}.formulas.txt`), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.startsWith('#'));
  const actual = formulas.map(run);
  const goldenPath = join(DIR, `${suite}.golden.json`);
  if (UPDATE) writeFileSync(goldenPath, `${JSON.stringify(actual, null, 2)}\n`);
  const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as unknown[];

  it('lists the same formulas as the golden file', () => {
    expect((golden as { formula: string }[]).map((g) => g.formula)).toEqual(formulas);
  });

  it.each(formulas.map((f, i) => [i + 1, f] as const))('#%i %s', (i) => {
    const result = actual[i - 1];
    expect(result).toEqual(golden[i - 1]);
    if (result?.ast && result.stored !== undefined && result.display !== undefined) {
      // The stored form reads back to the same AST; so does the display form, by name.
      const stored = parseStoredFormula(result.stored);
      expect(stored.ok && shape(stored.ast)).toEqual(shape(result.ast));
      expect(stored.ok && serializeFormula(stored.ast)).toBe(result.stored);
      const display = parseFormula(result.display, { fields: FIXTURE_FIELDS });
      expect(display.ok && shape(display.ast)).toEqual(shape(result.ast));
    }
  });
});
