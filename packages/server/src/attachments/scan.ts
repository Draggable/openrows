import { connect } from 'node:net';

/**
 * Malware scanning of uploads: a client of ClamAV's daemon, clamd, over TCP
 * (CLAMAV_URL, `tcp://host:port`). A file is streamed with clamd's INSTREAM command (chunks
 * prefixed by their 4-byte big-endian length, then a zero-length chunk) and clamd answers one
 * line: `stream: OK`, `stream: <signature> FOUND`, or `... ERROR`.
 *
 * Fails closed: anything but a clear OK or FOUND (no connection, a timeout, a clamd error such
 * as its StreamMaxLength, a garbled answer) throws ScannerUnavailableError, and the file waits.
 */

export type ScanVerdict = { infected: false } | { infected: true; signature: string };

export interface MalwareScanner {
  scan(body: AsyncIterable<Uint8Array>): Promise<ScanVerdict>;
  /** clamd answers PING with PONG. */
  ping(): Promise<boolean>;
}

export class ScannerUnavailableError extends Error {
  override readonly name = 'ScannerUnavailableError';
}

export interface ClamdOptions {
  host: string;
  port: number;
  /** For the whole exchange (connect, upload, verdict); default 120 s. */
  timeoutMs?: number;
}

/** `tcp://host:port` (port 3310 when omitted), or null when the URL isn't one. */
export function parseClamavUrl(url: string): { host: string; port: number } | null {
  const m = /^tcp:\/\/(\[[0-9a-f:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?\/?$/i.exec(url);
  if (!m?.[1]) return null;
  const port = m[2] === undefined ? 3310 : Number(m[2]);
  if (port < 1 || port > 65_535) return null;
  return { host: m[1].replace(/^\[|\]$/g, ''), port };
}

/** clamd's chunks: at most this many bytes each. */
const CHUNK = 64 * 1024;
/** An answer is one short line; anything longer is garbage. */
const MAX_REPLY = 4096;

/** The verdict in clamd's answer to INSTREAM (without the terminating NUL). */
export function parseClamdReply(reply: string): ScanVerdict {
  const line = reply.replace(/\0+$/, '').trim();
  if (line === 'stream: OK') return { infected: false };
  const found = /^stream: (.+) FOUND$/.exec(line);
  if (found?.[1]) {
    // A signature name is short printable ASCII; keep it so (it is stored and mailed).
    const signature = found[1].replace(/[^\x20-\x7e]/g, '?').slice(0, 200);
    return { infected: true, signature };
  }
  throw new ScannerUnavailableError(`clamd answered: ${line.slice(0, 200)}`);
}

function* chunks(part: Uint8Array): Generator<Uint8Array> {
  for (let i = 0; i < part.byteLength; i += CHUNK) yield part.subarray(i, i + CHUNK);
}

/** One request to clamd: `command`, then the frames of `body` if any; resolves clamd's answer. */
function exchange(
  opts: ClamdOptions,
  command: string,
  body?: AsyncIterable<Uint8Array>
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = connect({ host: opts.host, port: opts.port });
    let reply = '';
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(reply);
    };
    socket.setTimeout(opts.timeoutMs ?? 120_000, () =>
      done(new ScannerUnavailableError('clamd timed out'))
    );
    socket.setEncoding('utf8');
    socket.on('data', (data: string) => {
      reply += data;
      if (reply.length > MAX_REPLY) done(new ScannerUnavailableError('clamd answer too long'));
      // Answers end with NUL (the z-prefixed commands); clamd may close before we finish.
      else if (reply.includes('\0')) done();
    });
    socket.on('end', () => done());
    socket.on('error', (err) => {
      // A reply that came before the error (clamd closes on a size limit) still counts.
      if (reply) done();
      else done(new ScannerUnavailableError(`clamd unreachable: ${err.message}`));
    });
    socket.on('close', () => {
      if (!settled) done(reply ? undefined : new ScannerUnavailableError('clamd closed'));
    });

    const write = (data: Uint8Array | string) =>
      new Promise<void>((ok, fail) => {
        if (settled) return fail(new Error('settled'));
        socket.write(data, (err) => (err ? fail(err) : ok()));
      });
    socket.once('connect', () => {
      (async () => {
        await write(`z${command}\0`);
        if (!body) return;
        const size = Buffer.alloc(4);
        for await (const part of body) {
          for (const chunk of chunks(part)) {
            size.writeUInt32BE(chunk.byteLength, 0);
            await write(Buffer.from(size));
            await write(chunk);
          }
        }
        await write(Buffer.alloc(4));
      })().catch((err: unknown) => {
        // Writing failed: wait for clamd's answer (it may have refused the stream), else fail.
        if (!settled && !reply) {
          setTimeout(
            () =>
              done(
                new ScannerUnavailableError(
                  `clamd write failed: ${err instanceof Error ? err.message : String(err)}`
                )
              ),
            1000
          ).unref();
        }
      });
    });
  });
}

export function clamdScanner(opts: ClamdOptions): MalwareScanner {
  return {
    async scan(body) {
      return parseClamdReply(await exchange(opts, 'INSTREAM', body));
    },
    async ping() {
      try {
        return (
          (await exchange({ ...opts, timeoutMs: 5000 }, 'PING')).replace(/\0+$/, '') === 'PONG'
        );
      } catch {
        return false;
      }
    },
  };
}
