import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { type ServerType, serve } from '@hono/node-server';
import type { Hono } from 'hono';
import type { AppEnv } from './lib/context.js';

export interface StartedServer {
  server: ServerType;
  port: number;
  close: () => Promise<void>;
}

export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

/**
 * Serves the app on Node via @hono/node-server. Pass port 0 for an ephemeral port. `onUpgrade`
 * gets every HTTP upgrade request (the realtime gateway); without it upgrades are refused.
 */
export function startServer(
  app: Hono<AppEnv>,
  port: number,
  opts: { onUpgrade?: UpgradeHandler } = {}
): Promise<StartedServer> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port }, (info: AddressInfo) => {
      resolve({
        server,
        port: info.port,
        close: () =>
          new Promise<void>((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
    const onUpgrade = opts.onUpgrade;
    if (onUpgrade) server.on('upgrade', onUpgrade);
  });
}
