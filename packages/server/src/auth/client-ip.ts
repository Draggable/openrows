import { isIP } from 'node:net';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

export interface ClientIpOptions {
  /** Only then is `X-Forwarded-For` read at all. */
  trustProxy: boolean;
  /** Number of trusted proxies that append to `X-Forwarded-For`. */
  hops: number;
}

function socketAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    // app.request() in tests has no socket.
    return undefined;
  }
}

function normalize(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  const v = ip.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  return isIP(v) ? v : undefined;
}

/**
 * The real client IP, for rate limiting and the session record (H7).
 *
 * Without a trusted proxy the TCP peer address is the only truth and `X-Forwarded-For` is
 * ignored, because any client can send it. Behind `hops` trusted proxies, each appends the
 * address it saw, so the client is the entry `hops` places from the right; anything further
 * left was written by the client and is never used.
 */
export function clientIp(c: Context, opts: ClientIpOptions): string | undefined {
  const peer = normalize(socketAddress(c));
  if (!opts.trustProxy) return peer;
  const forwarded = (c.req.header('x-forwarded-for') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return normalize(forwarded[forwarded.length - opts.hops]) ?? peer;
}
