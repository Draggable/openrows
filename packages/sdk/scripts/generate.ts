import { writeFileSync } from 'node:fs';
import { GENERATED_PATH, generateV1Types } from './codegen.js';
import { generateReference, REFERENCE_PATH, serialize } from './reference.js';

// `npm run generate -w @openrows/sdk`: the v1 types from the contracts, then the reference the
// app's /docs/api/sdk page shows (from the SDK's source, so after the types).
writeFileSync(GENERATED_PATH, generateV1Types());
console.log(`wrote ${GENERATED_PATH}`);
writeFileSync(REFERENCE_PATH, serialize(await generateReference()));
console.log(`wrote ${REFERENCE_PATH}`);
