import type { SessionStore } from '../auth/sessions.js';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import type { Logger } from '../lib/logger.js';
import { createEventBus, type EventBus } from './bus.js';
import { RealtimeGateway, type RealtimeLimits } from './gateway.js';
import type { FieldVisibility } from './projection.js';

export { type EventBus, PostgresEventBus } from './bus.js';
export { RealtimeGateway } from './gateway.js';

/**
 * Starts this process's realtime side: the event bus picked by `EVENT_BUS` (its LISTEN
 * connection uses `DATABASE_URL`) and the `/ws` gateway. Pass `gateway.handleUpgrade` to
 * `startServer`; close it before the HTTP server, whose close waits for open sockets.
 */
export async function startRealtime(deps: {
  config: Pick<Config, 'appUrl' | 'databaseUrl' | 'eventBus'>;
  db: Database;
  store: SessionStore;
  logger: Logger;
  visibility?: FieldVisibility;
  limits?: Partial<RealtimeLimits>;
}): Promise<{ bus: EventBus; gateway: RealtimeGateway; close: () => Promise<void> }> {
  const { config, db, store, logger } = deps;
  const bus = createEventBus(config.eventBus, { db, databaseUrl: config.databaseUrl, logger });
  await bus.start();
  const gateway = new RealtimeGateway({
    db,
    store,
    bus,
    appUrl: config.appUrl,
    logger,
    visibility: deps.visibility,
    limits: deps.limits,
  });
  return {
    bus,
    gateway,
    close: async () => {
      await gateway.close();
      await bus.close();
    },
  };
}
