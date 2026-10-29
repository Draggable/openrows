import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compileFormula,
  evaluateFormula,
  FormulaDate,
  type FormulaValue,
  formulaResult,
} from '@openrows/shared';
import { z } from 'zod';
import type { AiChatRequest, AiChatResult, AiProvider } from '../provider.js';
import { type FormulaSuggestion, generateFormula } from './formula.js';

/**
 * Formula generation evals. Each case in `packages/server/evals/formula/*.jsonl` is a
 * description, a table's fields and sample records with the value the formula must give for each.
 * A case passes when the suggested formula type-checks and evaluates to every expected value, so
 * any correct formula passes, however it's written. CI replays the answers recorded in
 * `evals/formula/recorded/` (no network); `npm run eval:ai` asks a real provider.
 */

export const EVALS_DIR = fileURLToPath(new URL('../../../evals/formula/', import.meta.url));
/** The pass rate CI requires of the recorded answers. */
export const EVAL_MIN_PASS_RATE = 0.9;
/** What TODAY() and NOW() read unless a case says otherwise. */
const DEFAULT_NOW = '2026-06-15T12:00:00.000Z';

const scalar = z.union([z.string(), z.number(), z.null()]);

export const evalCaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  prompt: z.string().min(1),
  fields: z.array(z.strictObject({ name: z.string(), type: z.string() })).min(1),
  now: z.iso.datetime().optional(),
  records: z
    .array(z.strictObject({ cells: z.record(z.string(), z.unknown()), expected: scalar }))
    .min(1),
});
export type EvalCase = z.infer<typeof evalCaseSchema>;

export const recordingSchema = z.strictObject({
  id: z.string(),
  /** The model's formulas, in order: a second one answered a type error. */
  answers: z.array(z.string()).min(1),
});
export type Recording = z.infer<typeof recordingSchema>;

function readJsonl<T>(file: string, schema: z.ZodType<T>): T[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line, i) => [line.trim(), i + 1] as const)
    .filter(([line]) => line !== '')
    .map(([line, n]) => {
      const parsed = schema.safeParse(JSON.parse(line));
      if (!parsed.success) throw new Error(`${file}:${n}: ${parsed.error.message}`);
      return parsed.data;
    });
}

export function loadEvalCases(dir = EVALS_DIR): EvalCase[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();
  return files.flatMap((f) => readJsonl(join(dir, f), evalCaseSchema));
}

export function loadRecordings(dir = join(EVALS_DIR, 'recorded')): Map<string, string[]> {
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const out = new Map<string, string[]>();
  for (const f of files) {
    for (const r of readJsonl(join(dir, f), recordingSchema)) out.set(r.id, r.answers);
  }
  return out;
}

/** A provider that replays recorded formulas, one per request, as structured answers. */
export function recordedProvider(answers: readonly string[]): AiProvider {
  let next = 0;
  return {
    id: 'recorded',
    model: 'recorded',
    async chat<T = undefined>(request: AiChatRequest<T>): Promise<AiChatResult<T>> {
      const formula = answers[Math.min(next++, answers.length - 1)] ?? '';
      const text = JSON.stringify({ formula, explanation: 'Recorded answer.' });
      const data = request.output ? request.output.schema.parse(JSON.parse(text)) : undefined;
      return {
        text,
        data: data as T,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: true },
        model: 'recorded',
        finishReason: 'stop',
      };
    },
  };
}

const fieldId = (i: number) => `00000000-0000-7000-8000-${(i + 1).toString(16).padStart(12, '0')}`;

/** A sample cell as a formula reads it: dates as dates, lists as lists, the rest as is. */
function cellValue(type: string, value: unknown): FormulaValue {
  if (value === null || value === undefined) return null;
  if ((type === 'date' || type === 'dateTime') && typeof value === 'string') {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
    return new FormulaDate(Date.parse(dateOnly ? `${value}T00:00:00Z` : value), dateOnly);
  }
  if (Array.isArray(value)) return value.map((v) => cellValue('', v));
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return null;
}

function same(actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'number' && typeof expected === 'number') {
    return Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(expected));
  }
  return actual === expected;
}

export interface EvalResult {
  id: string;
  passed: boolean;
  formula: string;
  attempts: number;
  /** Why it failed: type errors, or the first record whose value differs. */
  reason?: string;
}

/** Whether a suggestion type-checks and gives every expected value. */
export function gradeSuggestion(c: EvalCase, s: FormulaSuggestion): EvalResult {
  const base = { id: c.id, formula: s.formula, attempts: s.attempts };
  if (!s.ok) return { ...base, passed: false, reason: `type-check: ${s.errors.join(' ')}` };
  const fields = c.fields.map((f, i) => ({ id: fieldId(i), name: f.name, type: f.type }));
  const compiled = compileFormula(s.formula, { fields });
  if (!compiled.ok) return { ...base, passed: false, reason: 'does not compile' };
  const now = Date.parse(c.now ?? DEFAULT_NOW);
  for (const [n, record] of c.records.entries()) {
    const byId = new Map(
      fields.map((f) => [f.id, cellValue(f.type, record.cells[f.name])] as const)
    );
    const actual = formulaResult(
      evaluateFormula(compiled.ast, { field: (id) => byId.get(id) ?? null, now })
    );
    if (!same(actual, record.expected)) {
      return {
        ...base,
        passed: false,
        reason: `record ${n + 1}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(record.expected)}`,
      };
    }
  }
  return { ...base, passed: true };
}

export interface EvalReport {
  results: EvalResult[];
  passed: number;
  total: number;
  passRate: number;
  /** Cases that needed the retry after a type error. */
  retried: number;
}

export async function runFormulaEvals(
  cases: readonly EvalCase[],
  providerFor: (c: EvalCase) => AiProvider,
  options: { concurrency?: number } = {}
): Promise<EvalReport> {
  const results: EvalResult[] = new Array(cases.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < cases.length) {
      const i = cursor++;
      const c = cases[i];
      if (!c) continue;
      try {
        const fields = c.fields.map((f) => ({ name: f.name, type: f.type }));
        const s = await generateFormula(providerFor(c), { fields, prompt: c.prompt });
        results[i] = gradeSuggestion(c, s);
      } catch (err) {
        results[i] = {
          id: c.id,
          passed: false,
          formula: '',
          attempts: 0,
          reason: err instanceof Error ? err.message : 'failed',
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 4) }, worker));
  const passed = results.filter((r) => r.passed).length;
  return {
    results,
    passed,
    total: results.length,
    passRate: results.length ? passed / results.length : 0,
    retried: results.filter((r) => r.attempts > 1).length,
  };
}
