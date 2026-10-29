import { createLocalContainerExecutor } from './local-container.js';
import type { ScriptConfig, ScriptSandbox } from './types.js';

export { createScriptBridge, type ScriptBridgeEnv } from './bridge.js';
export { createLocalContainerExecutor, dockerRunArgs } from './local-container.js';
export * from './types.js';

/**
 * The core's scripts: with AUTOMATION_SCRIPTS on, every workspace may run them with the
 * server's limits (self-hosting, AGPL); off, nobody may. The hosted service wraps `limitsFor`
 * with its plans (paid plans only, per-plan limits).
 */
export function createScriptSandbox(config: ScriptConfig): ScriptSandbox {
  if (config.executor === 'off') {
    return { executor: null, limitsFor: async () => ({ available: false, reason: 'disabled' }) };
  }
  const executor = createLocalContainerExecutor(config);
  return {
    executor,
    limitsFor: async () => ({ available: true, limits: config.limits }),
  };
}
