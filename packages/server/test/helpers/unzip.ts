import { crc32, inflateRawSync } from 'node:zlib';

/**
 * A small ZIP reader for tests: reads the central directory (ZIP64 end records included),
 * inflates each entry and checks its CRC-32 and size, so a test sees what an unzip tool would.
 */
export function unzip(archive: Uint8Array): Map<string, Buffer> {
  const buf = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('unzip: no end of central directory');
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  const locator = eocd - 20;
  if (locator >= 0 && buf.readUInt32LE(locator) === 0x07064b50) {
    const rec = Number(buf.readBigUInt64LE(locator + 8));
    if (buf.readUInt32LE(rec) !== 0x06064b50) throw new Error('unzip: bad zip64 end record');
    count = Number(buf.readBigUInt64LE(rec + 32));
    cdOffset = Number(buf.readBigUInt64LE(rec + 48));
  }
  const out = new Map<string, Buffer>();
  let at = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('unzip: bad central header');
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const compressed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    let offset = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    if (offset === 0xffffffff) offset = Number(buf.readBigUInt64LE(at + 46 + nameLength + 4));
    if (buf.readUInt32LE(offset) !== 0x04034b50) throw new Error(`unzip: bad local header ${name}`);
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const raw = buf.subarray(start, start + compressed);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    if (data.length !== size) throw new Error(`unzip: ${name} size ${data.length} != ${size}`);
    if (crc32(data) !== crc) throw new Error(`unzip: ${name} CRC mismatch`);
    out.set(name, data);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

/** The archive's bytes from a response body. */
export async function zipOf(res: Response): Promise<Map<string, Buffer>> {
  return unzip(new Uint8Array(await res.arrayBuffer()));
}
