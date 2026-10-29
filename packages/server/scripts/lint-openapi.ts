/**
 * Lints the OpenAPI document the server serves at /api/openapi.json with Redocly's
 * `recommended` ruleset: `npm run lint:openapi` (CI's check job). The document is generated from
 * the registered routes exactly as the server does it, without a database. Exits 1 on any error;
 * warnings are printed.
 */
import { createConfig, formatProblems, getTotals, lintFromString } from '@redocly/openapi-core';
import { generateOpenApi } from '../src/openapi.js';

const document = generateOpenApi();
const config = await createConfig({ extends: ['recommended'] });
const problems = await lintFromString({
  source: JSON.stringify(document, null, 2),
  absoluteRef: 'openapi.json',
  config,
});
const totals = getTotals(problems);
formatProblems(problems, { totals, version: 'openapi-core', format: 'stylish' });
const operations = Object.values(document.paths).flatMap((p) => Object.keys(p)).length;
console.log(
  `OpenAPI lint: ${operations} operations, ${totals.errors} errors, ${totals.warnings} warnings`
);
if (totals.errors > 0) process.exit(1);
