import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import {
  SCRIPT_METHODS,
  type ScriptBridge,
  ScriptCallError,
  type ScriptLog,
  type ScriptRequest,
  type ScriptResult,
} from './types.js';

/**
 * The server's side of the runner's protocol (runner.ts), for any executor whose sandbox gives
 * it the runner's stdin and stdout: sends the start message, answers calls one at a time through
 * the bridge, keeps logs and the output, and enforces the limits the sandbox can't (wall clock,
 * how much it prints, how many calls it makes). Nothing the sandbox prints is trusted: every
 * line is parsed with a schema, and a line that isn't the protocol stops the script.
 */

/** Everything the sandbox may print (calls, logs, the output). */
export const MAX_SCRIPT_STDOUT_BYTES = 8 * 1024 * 1024;
/** One line (a call with its arguments, say 50 records of cells). */
const MAX_LINE_BYTES = 2 * 1024 * 1024;
export const MAX_SCRIPT_CALLS = 500;
export const MAX_SCRIPT_OUTPUT_BYTES = 64 * 1024;
const MAX_LOGS = 200;
const MAX_LOG_BYTES = 32 * 1024;

const messageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('call'),
    id: z.number().int().positive(),
    method: z.enum(SCRIPT_METHODS),
    args: z.unknown(),
  }),
  z.object({
    type: z.literal('log'),
    level: z.enum(['log', 'info', 'warn', 'error']),
    text: z.string().max(4000),
  }),
  z.object({ type: z.literal('done'), output: z.record(z.string(), z.unknown()) }),
  z.object({
    type: z.literal('error'),
    message: z.string().max(4000),
    line: z.number().int().nullable().optional(),
  }),
]);

/** A running sandbox as the supervisor sees it. */
export interface ScriptProcess {
  stdin: Writable;
  stdout: Readable;
  /** Resolves when it has exited: its exit code, or the signal that killed it. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Stops it now (and its container); resolves once it is gone. */
  kill(): Promise<void>;
  /** The end of what it wrote to stderr (diagnostics only, never shown to users). */
  stderr(): string;
}

/** Why a sandbox that ended without a result stopped, from its exit status. */
export function exitReason(
  exit: { code: number | null; signal: NodeJS.Signals | null },
  stderr: string,
  request: ScriptRequest
): string {
  const { cpuSeconds, memoryMb } = request.limits;
  if (/heap out of memory|ERR_WORKER_OUT_OF_MEMORY|allocation failed/i.test(stderr)) {
    return `The script used more than ${memoryMb} MB of memory.`;
  }
  // RLIMIT_CPU: SIGXCPU (152 through Docker), then SIGKILL at the hard limit.
  if (exit.signal === 'SIGXCPU' || exit.code === 152) {
    return `The script used more than ${cpuSeconds} s of CPU time.`;
  }
  if (exit.code === 137 || exit.signal === 'SIGKILL') {
    return `The script was stopped: it used more than ${memoryMb} MB of memory or ${cpuSeconds} s of CPU time.`;
  }
  if (exit.code === 2) return 'The script stopped before it finished.';
  return `The script stopped unexpectedly (exit code ${exit.code ?? exit.signal ?? 'unknown'}).`;
}

export async function superviseScript(
  proc: ScriptProcess,
  request: ScriptRequest,
  bridge: ScriptBridge
): Promise<ScriptResult> {
  const started = performance.now();
  const logs: ScriptLog[] = [];
  let logBytes = 0;
  let calls = 0;
  let printed = 0;
  let outcome: { output: Record<string, unknown>; error: string | null } | null = null;
  /** An unexpected error from the bridge (the database, a bug): rethrown after the sandbox. */
  let fatal: { error: unknown } | null = null;
  let killing: Promise<void> | null = null;
  // Calls run one at a time, in order: they share the run's transaction.
  let queue: Promise<void> = Promise.resolve();

  const stop = (error: string) => {
    outcome ??= { output: {}, error };
    killing ??= proc.kill();
  };
  const write = (message: unknown) => {
    if (killing || proc.stdin.destroyed) return;
    proc.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const timer = setTimeout(
    () => stop(`The script ran longer than ${request.limits.timeoutSeconds} s.`),
    request.limits.timeoutSeconds * 1000
  );
  proc.stdin.on('error', () => {});

  const handle = (message: z.infer<typeof messageSchema>) => {
    switch (message.type) {
      case 'log': {
        logBytes += message.text.length;
        if (logs.length < MAX_LOGS && logBytes <= MAX_LOG_BYTES) {
          logs.push({ level: message.level, text: message.text });
        } else if (logs.length === 0 || logs.at(-1)?.text !== '[more logs left out]') {
          logs.push({ level: 'warn', text: '[more logs left out]' });
        }
        return;
      }
      case 'done': {
        const size = JSON.stringify(message.output).length;
        if (size > MAX_SCRIPT_OUTPUT_BYTES) stop('The output is larger than 64 KB.');
        else outcome ??= { output: message.output, error: null };
        return;
      }
      case 'error':
        outcome ??= {
          output: {},
          error: message.line ? `${message.message} (line ${message.line})` : message.message,
        };
        return;
      case 'call': {
        calls += 1;
        if (calls > MAX_SCRIPT_CALLS) {
          stop(`The script made more than ${MAX_SCRIPT_CALLS} calls.`);
          return;
        }
        queue = queue.then(async () => {
          if (killing) return;
          try {
            const value = await bridge(message.method, message.args);
            write({ type: 'result', id: message.id, ok: true, value: value ?? null });
          } catch (err) {
            if (err instanceof ScriptCallError) {
              write({ type: 'result', id: message.id, ok: false, error: err.message });
              return;
            }
            fatal ??= { error: err };
            stop('The server failed to answer a call.');
          }
        });
        return;
      }
    }
  };

  const lines = createInterface({ input: proc.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  proc.stdout.on('data', (chunk: Buffer) => {
    printed += chunk.length;
    if (printed > MAX_SCRIPT_STDOUT_BYTES) stop('The script printed too much.');
  });
  lines.on('line', (line) => {
    if (killing) return;
    if (line.length > MAX_LINE_BYTES) {
      stop('The script sent a message that is too large.');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      stop('The script wrote to the output stream directly.');
      return;
    }
    const message = messageSchema.safeParse(parsed);
    if (!message.success) {
      stop('The script sent a message the server could not read.');
      return;
    }
    handle(message.data);
  });

  write({ type: 'start', ...request });
  const exit = await proc.exited;
  clearTimeout(timer);
  await killing;
  // A call may still be on the transaction: let it end before the run goes on.
  await queue;
  lines.close();
  if (fatal) throw (fatal as { error: unknown }).error;
  const final = outcome ?? { output: {}, error: exitReason(exit, proc.stderr(), request) };
  return {
    status: final.error === null ? 'succeeded' : 'failed',
    output: final.output,
    logs,
    error: final.error,
    durationMs: Math.round(performance.now() - started),
  };
}
