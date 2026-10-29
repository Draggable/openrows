import { createApp } from './app.js';
import { type Config, ConfigError, loadConfig } from './config.js';
import { bypassesRls, createDb } from './db/index.js';
import { describeEdition, type EditionProviders, resolveEdition } from './edition/index.js';
import type { Edition } from './edition/types.js';
import { buildChecks } from './health.js';
import { relayLag } from './jobs/relay.js';
import { createLogger } from './lib/logger.js';
import { HttpMetrics, processMetrics, startMetricsHttp } from './lib/metrics.js';
import { startRealtime } from './realtime/index.js';
import { startServer } from './server.js';

export interface StartOptions {
  /** The hosted edition's providers; the OSS ones when omitted. */
  providers?: EditionProviders;
}

/**
 * The API process: `startApi()` is what an entry point runs. The core's entry,
 * `dist/index.js`, starts the OSS edition; the hosted edition's composition root passes the hosted
 * providers (EDITION=cloud). Exits the process on invalid configuration or a failed start.
 */
export async function startApi(options: StartOptions = {}): Promise<void> {
  let config: Config;
  let edition: Edition;
  try {
    config = loadConfig();
    // EDITION=cloud only from the hosted edition's entry point, with its providers.
    edition = resolveEdition(config.edition, options.providers);
  } catch (err) {
    // Fail fast: never boot with missing or default secrets, or without the edition's providers.
    const issues = err instanceof ConfigError ? err.issues : [String(err)];
    createLogger().fatal({ issues }, 'invalid configuration, refusing to start');
    process.exit(1);
  }

  const logger = createLogger({ level: config.logLevel });
  const db = createDb(config.databaseUrl);
  if (config.isProduction && !config.turnstile) {
    logger.error(
      'TURNSTILE_SECRET_KEY and TURNSTILE_SITE_KEY are not set: public forms refuse to publish and accept submissions until they are'
    );
  }
  // An idle client losing its connection must not crash the process; /ready reports the outage.
  db.pool.on('error', (err) => logger.warn({ err }, 'idle database client error'));

  // ADR-002: the server must connect as openrows_app, which RLS applies to. Production refuses a
  // superuser or BYPASSRLS role; elsewhere it's a warning. An unreachable database is left to /ready.
  try {
    if (await bypassesRls(db.pool)) {
      const msg =
        'DATABASE_URL connects as a role that bypasses row-level security; use openrows_app';
      if (config.isProduction) {
        logger.fatal(msg);
        process.exit(1);
      }
      logger.warn(msg);
    }
  } catch (err) {
    logger.warn({ err }, 'could not check the database role');
  }

  const metrics = config.metricsPort ? new HttpMetrics() : undefined;
  const { app, store, jobs } = createApp({
    config,
    edition,
    logger,
    db: db.db,
    checks: buildChecks(config, db.pool),
    metrics,
    // The outbox relay's lag, next to the checks; never makes /ready fail.
    readyDetails: async () => {
      const lag = await relayLag(db.db);
      return lag ? { outboxRelay: lag } : {};
    },
  });
  // Realtime: the event bus's LISTEN connection and the /ws gateway on the same server.
  const realtime = await startRealtime({ config, db: db.db, store, logger });
  // A workspace's plan changed in any process: drop its cached entitlements here.
  realtime.bus.onPlanChange((workspaceId) => edition.entitlements.invalidate?.(workspaceId));
  const { close } = await startServer(app, config.port, {
    onUpgrade: (req, socket, head) => realtime.gateway.handleUpgrade(req, socket, head),
  });
  // Prometheus: request counters, open sockets and memory on an internal port only.
  const metricsHttp =
    metrics && config.metricsPort
      ? await startMetricsHttp(
          () =>
            [
              metrics.render(),
              '# HELP openrows_realtime_connections Open realtime WebSockets in this process.',
              '# TYPE openrows_realtime_connections gauge',
              `openrows_realtime_connections ${realtime.gateway.connections}`,
              processMetrics(),
            ].join('\n'),
          { port: config.metricsPort, host: '0.0.0.0', logger }
        )
      : undefined;
  logger.info(
    {
      port: config.port,
      metricsPort: metricsHttp?.port,
      ...describeEdition(edition),
      env: config.env,
      signIn: config.oidc ? 'oidc' : 'not configured',
    },
    'OpenRows server listening'
  );

  function shutdown(signal: string) {
    logger.info({ signal }, 'shutting down');
    realtime
      .close()
      .then(() => jobs.stop())
      .then(() => Promise.all([close(), metricsHttp?.close(), db.close()]))
      .then(
        () => process.exit(0),
        (err: unknown) => {
          logger.error({ err }, 'shutdown failed');
          process.exit(1);
        }
      );
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    logger.fatal({ err }, 'unhandled rejection');
    process.exit(1);
  });
}
