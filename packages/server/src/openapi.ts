import type { OpenApiDocument } from '@openrows/shared';
import { createApp, openApiDocument } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { createLogger } from './lib/logger.js';

/**
 * The OpenAPI document of every registered route, as `GET /api/openapi.json` serves it, built
 * without a running server or database (the pool never connects): for the OpenAPI lint.
 */
export function generateOpenApi(): OpenApiDocument {
  // The hosted origin: the document is linted as it is published.
  const config = loadConfig({ NODE_ENV: 'test', APP_URL: 'https://app.openrows.io' });
  const { db, pool } = createDb(config.databaseUrl);
  try {
    const { routes } = createApp({
      config,
      logger: createLogger({ level: 'silent' }),
      db,
      checks: [],
    });
    return openApiDocument(routes.entries, config.appUrl);
  } finally {
    void pool.end();
  }
}
