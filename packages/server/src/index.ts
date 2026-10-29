import { startApi } from './main.js';

// The OSS edition's API entry point (`node dist/index.js`). The hosted edition starts through
// the hosted edition's composition root instead (ADR-005).
await startApi();
