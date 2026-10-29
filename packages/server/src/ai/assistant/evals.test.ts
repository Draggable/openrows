import { describe, expect, it } from 'vitest';
import {
  EVAL_MIN_PASS_RATE,
  gradeSuggestion,
  loadEvalCases,
  loadRecordings,
  recordedProvider,
  runFormulaEvals,
} from './evals.js';
import { generateFormula } from './formula.js';

describe('formula generation evals (recorded provider)', () => {
  const cases = loadEvalCases();
  const recordings = loadRecordings();

  it('has at least 50 cases, each with a recording', () => {
    expect(cases.length).toBeGreaterThanOrEqual(50);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) expect(recordings.has(c.id), c.id).toBe(true);
  });

  it(`passes at least ${EVAL_MIN_PASS_RATE * 100}% of the cases`, async () => {
    const report = await runFormulaEvals(cases, (c) =>
      recordedProvider(recordings.get(c.id) ?? [])
    );
    const failed = report.results.filter((r) => !r.passed);
    // The recordings answer every case; a failure means the engine or a case changed.
    expect(failed).toEqual([]);
    expect(report.passRate).toBeGreaterThanOrEqual(EVAL_MIN_PASS_RATE);
    // Recordings whose first formula didn't type-check pass on the retry.
    expect(report.retried).toBeGreaterThanOrEqual(3);
  });

  it('fails formulas that type-check but compute the wrong value', () => {
    const c = cases.find((x) => x.id === 'days-between');
    if (!c) throw new Error('case missing');
    const wrong = { ok: true as const, type: 'number' as const, explanation: '', attempts: 1 };
    expect(
      gradeSuggestion(c, { ...wrong, formula: 'DATETIME_DIFF({Start}, {End}, "days")' }).passed
    ).toBe(false);
    expect(
      gradeSuggestion(c, { ...wrong, formula: 'DATETIME_DIFF({End}, {Start}, "days")' }).passed
    ).toBe(true);
  });

  it('retries once on a type error, then gives up', async () => {
    const fields = [{ name: 'Qty', type: 'number' }];
    const fixed = await generateFormula(recordedProvider(['UPPER({Qty}, 1, 2)', '{Qty} * 2']), {
      fields,
      prompt: 'double',
    });
    expect(fixed).toMatchObject({ ok: true, formula: '{Qty} * 2', type: 'number', attempts: 2 });
    const failed = await generateFormula(recordedProvider(['{Nope}', '{Still nope}', '{Qty}']), {
      fields,
      prompt: 'x',
    });
    expect(failed).toMatchObject({ ok: false, formula: '{Still nope}', attempts: 2 });
  });
});
