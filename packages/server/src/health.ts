import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { AwsClient } from 'aws4fetch';
import type { Pool } from 'pg';
import type { Config, S3Config } from './config.js';
import type { Logger } from './lib/logger.js';

/** One dependency /ready probes. `check` rejects when the dependency is unusable. */
export interface DependencyCheck {
  name: string;
  check: (signal: AbortSignal) => Promise<void>;
}

export interface CheckResult {
  status: 'ok' | 'error';
  durationMs: number;
  /** Short reason only; the full error is logged, never returned. */
  error?: 'timeout' | 'failed';
}

export interface Readiness {
  ok: boolean;
  checks: Record<string, CheckResult>;
}

export const CHECK_TIMEOUT_MS = 2_000;

/** Runs all checks in parallel, each with its own timeout. */
export async function runChecks(
  checks: DependencyCheck[],
  opts: { logger?: Logger; timeoutMs?: number } = {}
): Promise<Readiness> {
  const timeoutMs = opts.timeoutMs ?? CHECK_TIMEOUT_MS;
  const entries = await Promise.all(
    checks.map(async ({ name, check }): Promise<[string, CheckResult]> => {
      const start = performance.now();
      const signal = AbortSignal.timeout(timeoutMs);
      const elapsed = () => Math.round(performance.now() - start);
      try {
        await Promise.race([
          check(signal),
          new Promise<never>((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
        ]);
        return [name, { status: 'ok', durationMs: elapsed() }];
      } catch (err) {
        const timedOut = signal.aborted;
        opts.logger?.warn({ err, dependency: name }, 'readiness check failed');
        return [
          name,
          { status: 'error', durationMs: elapsed(), error: timedOut ? 'timeout' : 'failed' },
        ];
      }
    })
  );
  const results = Object.fromEntries(entries);
  return { ok: entries.every(([, r]) => r.status === 'ok'), checks: results };
}

export function postgresCheck(pool: Pick<Pool, 'query'>): DependencyCheck {
  return {
    name: 'database',
    check: async () => {
      await pool.query('SELECT 1');
    },
  };
}

/** A signed HeadBucket: proves the endpoint is reachable, the keys work and the bucket exists. */
export function s3Check(s3: S3Config): DependencyCheck {
  const client = new AwsClient({
    accessKeyId: s3.accessKey,
    secretAccessKey: s3.secretKey,
    region: s3.region,
    service: 's3',
  });
  const url = `${s3.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(s3.bucket)}`;
  return {
    name: 's3',
    check: async (signal) => {
      const res = await client.fetch(url, { method: 'HEAD', signal });
      if (!res.ok) throw new Error(`HeadBucket returned ${res.status}`);
    },
  };
}

function resp(...args: string[]): string {
  return `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')}`;
}

/**
 * PINGs Redis (AUTH first if the URL has credentials). A raw RESP exchange, so the core needs no
 * Redis client until something actually uses Redis.
 */
export function redisCheck(redisUrl: string): DependencyCheck {
  const url = new URL(redisUrl);
  const tls = url.protocol === 'rediss:';
  const port = Number(url.port) || 6379;
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const commands: string[] = [];
  if (password) commands.push(user ? resp('AUTH', user, password) : resp('AUTH', password));
  commands.push(resp('PING'));

  return {
    name: 'redis',
    check: (signal) =>
      new Promise<void>((resolve, reject) => {
        const socket: Socket = tls
          ? tlsConnect({ host: url.hostname, port, servername: url.hostname })
          : netConnect({ host: url.hostname, port });
        const done = (err?: Error) => {
          socket.destroy();
          if (err) reject(err);
          else resolve();
        };
        signal.addEventListener('abort', () => done(new Error('aborted')), { once: true });
        let buffer = '';
        socket.setEncoding('utf8');
        socket.once(tls ? 'secureConnect' : 'connect', () => socket.write(commands.join('')));
        socket.on('data', (chunk: string) => {
          buffer += chunk;
          const replies = buffer.split('\r\n').slice(0, -1);
          const error = replies.find((r) => r.startsWith('-'));
          if (error) return done(new Error(`Redis replied ${error.split(' ')[0]}`));
          if (replies.length >= commands.length) {
            const last = replies[commands.length - 1];
            done(last === '+PONG' ? undefined : new Error('Unexpected reply to PING'));
          }
        });
        socket.on('error', (err) => done(err));
        socket.on('close', () => done(new Error('Connection closed')));
      }),
  };
}

/** The checks /ready runs: the database always, S3 and Redis only when configured. */
export function buildChecks(config: Config, pool: Pick<Pool, 'query'>): DependencyCheck[] {
  const checks = [postgresCheck(pool)];
  if (config.s3) checks.push(s3Check(config.s3));
  if (config.redisUrl) checks.push(redisCheck(config.redisUrl));
  return checks;
}
