import { createServer, type Server, type Socket } from 'node:net';

/**
 * A stand-in for ClamAV's clamd on a random loopback port: it speaks the INSTREAM and
 * PING commands and "detects" the EICAR test file (the industry's harmless test string) by its
 * bytes, as clamd does with its Eicar-Test-Signature. `mode` makes it misbehave like a down or
 * broken scanner.
 */
export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export interface FakeClamd {
  url: string;
  host: string;
  port: number;
  /** `ok` scans; `error` answers an ERROR; `hang` never answers; `limit` refuses big streams. */
  mode: 'ok' | 'error' | 'hang' | 'limit';
  /** Streams scanned so far. */
  scans: number;
  close(): Promise<void>;
}

export async function startFakeClamd(opts: { streamMaxLength?: number } = {}): Promise<FakeClamd> {
  const max = opts.streamMaxLength ?? 200 * 1024 * 1024;
  const sockets = new Set<Socket>();
  const state: FakeClamd = {
    mode: 'ok',
    scans: 0,
    host: '127.0.0.1',
    port: 0,
    url: '',
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buf = Buffer.alloc(0);
    let command: string | null = null;
    const data: Buffer[] = [];
    let total = 0;
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (command === null) {
        const end = buf.indexOf(0);
        if (end < 0) return;
        command = buf.subarray(0, end).toString('utf8');
        buf = buf.subarray(end + 1);
        if (command === 'zPING') {
          socket.end('PONG\0');
          return;
        }
        if (command !== 'zINSTREAM') {
          socket.end('UNKNOWN COMMAND\0');
          return;
        }
      }
      if (state.mode === 'hang') return;
      while (buf.length >= 4) {
        const n = buf.readUInt32BE(0);
        if (n === 0) {
          state.scans++;
          if (state.mode === 'error') {
            socket.end("stream: Can't allocate memory ERROR\0");
            return;
          }
          const text = Buffer.concat(data).toString('latin1');
          socket.end(
            text.includes(EICAR) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0'
          );
          return;
        }
        if (buf.length < 4 + n) return;
        data.push(Buffer.from(buf.subarray(4, 4 + n)));
        total += n;
        buf = buf.subarray(4 + n);
        if (state.mode === 'limit' || total > max) {
          socket.end('INSTREAM size limit exceeded. ERROR\0');
          return;
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  state.port = address.port;
  state.url = `tcp://127.0.0.1:${address.port}`;
  return state;
}
