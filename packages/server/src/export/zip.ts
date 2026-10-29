import { pipeline, Readable } from 'node:stream';
import { crc32, createDeflateRaw } from 'node:zlib';

/**
 * A streaming ZIP writer: entries are written one after another as their bytes arrive, each
 * with a data descriptor (sizes and CRC-32 after the data), so nothing but the central
 * directory's few bytes per entry is held in memory. Text is deflated; `store` entries
 * (attachment files, usually compressed already) are copied as they are. Archives past 4 GiB or
 * 65,535 entries get the ZIP64 end records; a single entry is capped at 4 GiB.
 */

export interface ZipEntry {
  /** The path inside the archive, `/`-separated. */
  name: string;
  data: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>;
  /** Copy the bytes without compressing them. */
  store?: boolean;
  modified?: Date;
}

const MAX32 = 0xffffffff;
const encoder = new TextEncoder();

/** MS-DOS time and date of `d` (local fields, 2-second precision, from 1980). */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

interface Written {
  name: Uint8Array;
  method: number;
  time: number;
  date: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
}

const FLAGS = 0x0008 | 0x0800; // data descriptor follows, UTF-8 names

function localHeader(e: Omit<Written, 'crc' | 'compressed' | 'size' | 'offset'>): Uint8Array {
  const b = Buffer.alloc(30 + e.name.length);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(20, 4);
  b.writeUInt16LE(FLAGS, 6);
  b.writeUInt16LE(e.method, 8);
  b.writeUInt16LE(e.time, 10);
  b.writeUInt16LE(e.date, 12);
  // CRC and sizes are 0 here: they follow the data in the descriptor.
  b.writeUInt16LE(e.name.length, 26);
  b.set(e.name, 30);
  return b;
}

function dataDescriptor(e: Written): Uint8Array {
  const b = Buffer.alloc(16);
  b.writeUInt32LE(0x08074b50, 0);
  b.writeUInt32LE(e.crc, 4);
  b.writeUInt32LE(e.compressed, 8);
  b.writeUInt32LE(e.size, 12);
  return b;
}

function centralHeader(e: Written): Uint8Array {
  const zip64 = e.offset > MAX32;
  const extra = zip64 ? 12 : 0;
  const b = Buffer.alloc(46 + e.name.length + extra);
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE((3 << 8) | 45, 4); // made by: Unix, 4.5
  b.writeUInt16LE(zip64 ? 45 : 20, 6);
  b.writeUInt16LE(FLAGS, 8);
  b.writeUInt16LE(e.method, 10);
  b.writeUInt16LE(e.time, 12);
  b.writeUInt16LE(e.date, 14);
  b.writeUInt32LE(e.crc, 16);
  b.writeUInt32LE(e.compressed, 20);
  b.writeUInt32LE(e.size, 24);
  b.writeUInt16LE(e.name.length, 28);
  b.writeUInt16LE(extra, 30);
  b.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a regular file, rw-r--r--
  b.writeUInt32LE(zip64 ? MAX32 : e.offset, 42);
  b.set(e.name, 46);
  if (zip64) {
    const at = 46 + e.name.length;
    b.writeUInt16LE(0x0001, at);
    b.writeUInt16LE(8, at + 2);
    b.writeBigUInt64LE(BigInt(e.offset), at + 4);
  }
  return b;
}

function endRecords(count: number, cdOffset: number, cdSize: number): Uint8Array {
  const zip64 = count > 0xffff || cdOffset > MAX32 || cdSize > MAX32;
  const parts: Buffer[] = [];
  if (zip64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE((3 << 8) | 45, 12);
    rec.writeUInt16LE(45, 14);
    rec.writeBigUInt64LE(BigInt(count), 24);
    rec.writeBigUInt64LE(BigInt(count), 32);
    rec.writeBigUInt64LE(BigInt(cdSize), 40);
    rec.writeBigUInt64LE(BigInt(cdOffset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(cdOffset + cdSize), 8);
    locator.writeUInt32LE(1, 16);
    parts.push(rec, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Math.min(count, 0xffff), 8);
  end.writeUInt16LE(Math.min(count, 0xffff), 10);
  end.writeUInt32LE(Math.min(cdSize, MAX32), 12);
  end.writeUInt32LE(Math.min(cdOffset, MAX32), 16);
  parts.push(end);
  return Buffer.concat(parts);
}

/** The archive of `entries`, chunk by chunk. */
export async function* zip(
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>
): AsyncGenerator<Uint8Array> {
  const written: Written[] = [];
  const names = new Set<string>();
  let offset = 0;
  for await (const entry of entries) {
    if (names.has(entry.name)) throw new Error(`zip: duplicate entry ${entry.name}`);
    names.add(entry.name);
    const head = {
      name: encoder.encode(entry.name),
      method: entry.store ? 0 : 8,
      ...dosDateTime(entry.modified ?? new Date()),
    };
    const local = localHeader(head);
    yield local;
    let crc = 0;
    let size = 0;
    const source = Readable.from(
      (async function* () {
        for await (const chunk of entry.data) {
          const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
          if (bytes.byteLength === 0) continue;
          crc = crc32(bytes, crc);
          size += bytes.byteLength;
          yield bytes;
        }
      })(),
      { objectMode: false }
    );
    let compressed = 0;
    // pipeline, not pipe: a failing source must fail the deflate stream this loop reads.
    const output = entry.store ? source : pipeline(source, createDeflateRaw(), () => undefined);
    for await (const chunk of output) {
      const bytes = chunk as Uint8Array;
      compressed += bytes.byteLength;
      yield bytes;
    }
    if (size > MAX32 || compressed > MAX32) throw new Error(`zip: ${entry.name} is over 4 GiB`);
    const e: Written = { ...head, crc, compressed, size, offset };
    yield dataDescriptor(e);
    written.push(e);
    offset += local.byteLength + compressed + 16;
  }
  let cdSize = 0;
  for (const e of written) {
    const header = centralHeader(e);
    cdSize += header.byteLength;
    yield header;
  }
  yield endRecords(written.length, offset, cdSize);
}

/** `zip(entries)` as a web stream, pulled as the client reads; `onError` hears a failure. */
export function zipStream(
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
  onError: (err: unknown) => void
): ReadableStream<Uint8Array> {
  const it = zip(entries);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await it.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (err) {
        onError(err);
        controller.error(err);
      }
    },
    async cancel() {
      await it.return(undefined);
    },
  });
}
