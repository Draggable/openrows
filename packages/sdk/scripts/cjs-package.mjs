// dist/cjs holds CommonJS while the package is "type": "module": this marker makes Node (and
// TypeScript) read the .js and .d.ts files there as CommonJS.
import { writeFileSync } from 'node:fs';

writeFileSync(
  new URL('../dist/cjs/package.json', import.meta.url),
  `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`
);
