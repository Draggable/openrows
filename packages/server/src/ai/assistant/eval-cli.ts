import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AI_DEFAULT_BASE_URL } from '@openrows/shared';
import { createSafeFetch, outboundPolicy } from '../../lib/safe-fetch/index.js';
import { type AiProvider, createOpenAiCompatibleProvider } from '../provider.js';
import {
  EVAL_MIN_PASS_RATE,
  EVALS_DIR,
  type EvalCase,
  loadEvalCases,
  loadRecordings,
  recordedProvider,
  runFormulaEvals,
} from './evals.js';

/**
 * `npm run eval:ai`: the formula generation evals against a real provider, from
 * AI_BASE_URL (default OpenAI's), AI_MODEL and AI_API_KEY, as the server reads them. Prints the
 * pass rate and every failure; exits 1 below EVAL_MIN_PASS_RATE. `--recorded` replays the
 * recordings instead (what CI does); `--record` writes the real answers as the new recordings.
 * The key only goes into the Authorization header and is never printed.
 */

const args = new Set(process.argv.slice(2));

function realProvider(): (c: EvalCase) => AiProvider {
  const model = process.env['AI_MODEL']?.trim();
  if (!model) {
    console.error(
      'Set AI_MODEL (and AI_API_KEY, AI_BASE_URL) to run the evals against a provider.'
    );
    process.exit(2);
  }
  const baseUrl = process.env['AI_BASE_URL']?.trim() || AI_DEFAULT_BASE_URL;
  const url = new URL(baseUrl);
  const http = createSafeFetch(
    outboundPolicy({
      allowHttp: url.protocol === 'http:',
      extraPorts: url.port ? [Number(url.port)] : [],
      allow: [url.hostname.replace(/^\[|\]$/g, '')],
      deny: [],
    })
  );
  const provider = createOpenAiCompatibleProvider({
    baseUrl,
    model,
    apiKey: process.env['AI_API_KEY'],
    http,
    timeoutMs: 60_000,
  });
  console.log(`Provider ${provider.id}, model ${model}`);
  return () => provider;
}

const cases = loadEvalCases();
const recordings = loadRecordings();
const answers = new Map<string, string[]>();
const replay = args.has('--recorded');
const providerFor = replay
  ? (c: EvalCase) => recordedProvider(recordings.get(c.id) ?? [])
  : realProvider();

const report = await runFormulaEvals(
  cases,
  (c) => {
    const inner = providerFor(c);
    return {
      id: inner.id,
      model: inner.model,
      async chat(request) {
        const result = await inner.chat(request);
        const formula = (result.data as { formula?: unknown } | undefined)?.formula;
        if (typeof formula === 'string') answers.set(c.id, [...(answers.get(c.id) ?? []), formula]);
        return result;
      },
    };
  },
  { concurrency: replay ? 8 : 4 }
);

for (const r of report.results.filter((x) => !x.passed)) {
  console.log(`FAIL ${r.id}: ${r.reason ?? ''}\n     ${r.formula}`);
}
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
console.log(
  `\nFormula evals: ${report.passed}/${report.total} passed (${pct(report.passRate)}), ${report.retried} after a retry. Required: ${pct(EVAL_MIN_PASS_RATE)}.`
);

if (args.has('--record') && !replay) {
  const lines = cases
    .filter((c) => answers.has(c.id))
    .map((c) => JSON.stringify({ id: c.id, answers: answers.get(c.id) }));
  writeFileSync(join(EVALS_DIR, 'recorded', 'answers.jsonl'), `${lines.join('\n')}\n`);
  console.log(`Recorded ${lines.length} answers.`);
}
process.exit(report.passRate >= EVAL_MIN_PASS_RATE ? 0 : 1);
