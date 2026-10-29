/**
 * Run-script steps: the sandbox's settings and the executor interface. A script runs in a
 * throwaway sandbox (an executor: `local-container` today, a remote runner later) that has no
 * network, no secrets and no database: everything it does to the base (and its `fetch`) is a
 * call over the sandbox's stdio that the server runs as the person the automation runs as.
 */

/**
 * Where scripts run by default: the same Node 22 image as docker/Dockerfile, pinned by digest
 * (docker/README.md "Image pins").
 */
export const DEFAULT_SCRIPT_IMAGE =
  'node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d';

export interface ScriptLimits {
  /** Wall clock, container start included. */
  timeoutSeconds: number;
  /** CPU time (RLIMIT_CPU). */
  cpuSeconds: number;
  memoryMb: number;
}

export interface ScriptConfig {
  executor: 'off' | 'local-container';
  /** The `docker` CLI. */
  docker: string;
  image: string;
  /** A Docker runtime such as `runsc`; undefined: Docker's default (runc). */
  runtime: string | undefined;
  /** The server's limits; a plan may lower them. */
  limits: ScriptLimits;
  /** Sandboxes one process runs at once. */
  concurrency: number;
}

/** A table of the automation's base as the script sees it (`base.getTable(...)`). */
export interface ScriptTableInfo {
  id: string;
  name: string;
  fields: { id: string; name: string; type: string }[];
}

/** What the sandbox gets: the script, its input variables, the base's schema and the limits. */
export interface ScriptRequest {
  script: string;
  config: Record<string, unknown>;
  base: { id: string; name: string; tables: ScriptTableInfo[] };
  limits: ScriptLimits;
}

export const SCRIPT_METHODS = ['select', 'get', 'create', 'update', 'delete', 'fetch'] as const;
export type ScriptMethod = (typeof SCRIPT_METHODS)[number];

/** Runs a script's call on the server; throws ScriptCallError for an answer the script sees. */
export type ScriptBridge = (method: ScriptMethod, args: unknown) => Promise<unknown>;

/** An error the script gets back from a call (it may catch it). */
export class ScriptCallError extends Error {
  override name = 'ScriptCallError';
}

export interface ScriptLog {
  level: 'log' | 'info' | 'warn' | 'error';
  text: string;
}

export interface ScriptResult {
  status: 'succeeded' | 'failed';
  /** What it passed to `output.set`. */
  output: Record<string, unknown>;
  logs: ScriptLog[];
  /** Why it failed: its own error (with the line) or a limit. */
  error: string | null;
  durationMs: number;
}

/** Runs one script in a sandbox, answering its calls through `bridge`. */
export interface ScriptExecutor {
  readonly kind: string;
  run(request: ScriptRequest, bridge: ScriptBridge): Promise<ScriptResult>;
}

export type ScriptAvailability =
  | { available: true; limits: ScriptLimits }
  | { available: false; reason: 'disabled' | 'plan' };

/**
 * Scripts as a server offers them: the executor and who may use it with which limits. The core
 * gives every workspace the server's limits when AUTOMATION_SCRIPTS is on; the hosted service
 * plugs its plans in here (`limitsFor`), and never the other way round (ADR-005).
 */
export interface ScriptSandbox {
  executor: ScriptExecutor | null;
  limitsFor(workspaceId: string): Promise<ScriptAvailability>;
}
