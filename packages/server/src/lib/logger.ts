import { type DestinationStream, type Logger, pino } from 'pino';

export type { Logger };

/**
 * Paths pino replaces with "[redacted]". Request logs only carry method, path and status, so
 * this is a safety net for errors and objects logged with context.
 */
export const REDACT_PATHS = [
  'authorization',
  'cookie',
  'password',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'clientSecret',
  'encryptionKey',
  'secretKey',
  'accessKey',
  'databaseUrl',
  'redisUrl',
  '*.authorization',
  '*.cookie',
  '*.password',
  '*.secret',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.idToken',
  '*.clientSecret',
  '*.encryptionKey',
  '*.secretKey',
  '*.accessKey',
  '*.databaseUrl',
  '*.redisUrl',
  'headers["set-cookie"]',
  '*.headers.authorization',
  '*.headers.cookie',
  '*.headers["set-cookie"]',
];

/** A structured JSON logger (one object per line on stdout, or on `destination`). */
export function createLogger(
  opts: { level: string; destination?: DestinationStream } = { level: 'info' }
): Logger {
  return pino(
    {
      level: opts.level,
      base: { service: 'openrows-server' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    },
    opts.destination
  );
}
