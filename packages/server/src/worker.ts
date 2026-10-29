import { startWorkerProcess } from './worker-main.js';

// The OSS edition's worker entry point (`node dist/worker.js`). The hosted edition starts through
// the hosted edition's composition root instead (ADR-005).
await startWorkerProcess();
