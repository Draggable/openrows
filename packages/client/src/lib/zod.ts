import { z } from 'zod';

// Zod compiles object parsers with `new Function` when it can, and probes for that with a
// `Function('')` call that the Content-Security-Policy (script-src 'self', no 'unsafe-eval'
// ) refuses and reports as a violation. Parse without code generation instead. Imported
// first by main.tsx, before any schema parses.
z.config({ jitless: true });
