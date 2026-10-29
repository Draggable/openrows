import { type ChildProcess, spawn } from 'node:child_process';
import { uuidv7 } from 'uuidv7';
import { RUNNER_SOURCE } from './runner.js';
import { type ScriptProcess, superviseScript } from './supervise.js';
import type {
  ScriptBridge,
  ScriptConfig,
  ScriptExecutor,
  ScriptLimits,
  ScriptRequest,
  ScriptResult,
} from './types.js';

/**
 * The `local-container` executor: one throwaway container per script on this host's
 * Docker, through the `docker` CLI. The container is the security boundary:
 *
 * - no network at all (`--network none`): the script's `base` and `fetch` are calls over its
 *   stdio, which the server runs (as the automation's person, through the SSRF-safe client);
 * - a read-only root, an 8 MB `noexec` tmpfs at /tmp, no IPC namespace sharing;
 * - user `nobody` (65534), every capability dropped, `no-new-privileges`, Docker's default
 *   seccomp profile (never `unconfined`), an optional runtime such as gVisor's `runsc`;
 * - limits: memory (and swap) `memoryMb`, V8's heap below it, 1 CPU, 32 processes, RLIMIT_CPU
 *   `cpuSeconds`, 64 open files, no core dumps; the wall clock and the output are the
 *   supervisor's (supervise.ts), which removes the container when either runs out;
 * - nothing from the server's environment: no `-e`, no mounts, no secrets, the image's own
 *   variables only; `--pull never`, so a run never waits on a registry.
 */

const STDERR_KEEP = 16 * 1024;

export interface DockerRunOptions {
  image: string;
  runtime: string | undefined;
  name: string;
  limits: ScriptLimits;
  runnerSource: string;
}

/** The `docker run` arguments of one script's container. */
export function dockerRunArgs(o: DockerRunOptions): string[] {
  const heapMb = Math.max(32, Math.floor(o.limits.memoryMb * 0.6));
  return [
    'run',
    '--rm',
    '--interactive',
    '--name',
    o.name,
    '--label',
    'openrows.script=1',
    '--pull',
    'never',
    '--network',
    'none',
    '--ipc',
    'none',
    '--hostname',
    'sandbox',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=8m',
    '--workdir',
    '/tmp',
    '--user',
    '65534:65534',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    ...(o.runtime ? ['--runtime', o.runtime] : []),
    '--memory',
    `${o.limits.memoryMb}m`,
    '--memory-swap',
    `${o.limits.memoryMb}m`,
    '--cpus',
    '1',
    '--pids-limit',
    '32',
    '--ulimit',
    `cpu=${o.limits.cpuSeconds}:${o.limits.cpuSeconds + 1}`,
    '--ulimit',
    'nofile=64:64',
    '--ulimit',
    'core=0:0',
    '--log-driver',
    'none',
    '--entrypoint',
    'node',
    o.image,
    `--max-old-space-size=${heapMb}`,
    '--disallow-code-generation-from-strings',
    '--disable-proto=delete',
    '-e',
    o.runnerSource,
  ];
}

/** The docker CLI's environment: how to reach the daemon, nothing else of the server's. */
function cliEnv(): Record<string, string> {
  const keep = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG'] as const;
  const keepTls = ['DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'] as const;
  const env: Record<string, string> = {};
  for (const key of [...keep, ...keepTls]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** A semaphore: at most `n` sandboxes at once in this process. */
function limiter(n: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

export interface LocalContainerOptions extends Pick<ScriptConfig, 'docker' | 'image' | 'runtime'> {
  concurrency: number;
  /** Tests only: another program for the container (the escape suite's probes). */
  runnerSource?: string;
}

export function createLocalContainerExecutor(options: LocalContainerOptions): ScriptExecutor {
  const slot = limiter(options.concurrency);

  const removeContainer = (name: string) =>
    new Promise<void>((resolve) => {
      const rm = spawn(options.docker, ['rm', '--force', name], {
        env: cliEnv(),
        stdio: 'ignore',
      });
      const timer = setTimeout(() => rm.kill('SIGKILL'), 15_000);
      rm.on('error', () => resolve());
      rm.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });

  const start = (request: ScriptRequest): ScriptProcess => {
    const name = `openrows-script-${uuidv7()}`;
    const child: ChildProcess = spawn(
      options.docker,
      dockerRunArgs({
        image: options.image,
        runtime: options.runtime,
        name,
        limits: request.limits,
        runnerSource: options.runnerSource ?? RUNNER_SOURCE,
      }),
      { env: cliEnv(), stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_KEEP);
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.on('error', (err) => {
          stderr += `\n${err.message}`;
          resolve({ code: 127, signal: null });
        });
        child.on('close', (code, signal) => resolve({ code, signal }));
      }
    );
    const { stdin, stdout } = child;
    if (!stdin || !stdout) throw new Error('docker run without stdio');
    return {
      stdin,
      stdout,
      exited,
      stderr: () => stderr,
      kill: async () => {
        // The CLI going away doesn't stop the container: remove it first.
        await removeContainer(name);
        child.kill('SIGKILL');
        await exited;
      },
    };
  };

  return {
    kind: 'local-container',
    run: (request: ScriptRequest, bridge: ScriptBridge): Promise<ScriptResult> =>
      slot(async () => {
        const proc = start(request);
        const result = await superviseScript(proc, request, bridge);
        if (
          result.status === 'failed' &&
          /No such image|Unable to find image/.test(proc.stderr())
        ) {
          return {
            ...result,
            error: `The script image isn't on this server's Docker yet (docker pull ${options.image}).`,
          };
        }
        if (
          result.status === 'failed' &&
          /Cannot connect to the Docker daemon|ENOENT/.test(proc.stderr())
        ) {
          return { ...result, error: "This server can't reach Docker to run scripts." };
        }
        return result;
      }),
  };
}
