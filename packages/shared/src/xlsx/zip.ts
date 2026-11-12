import { Inflate } from 'fflate';

/**
 * The ZIP container of a workbook: its central directory, and one entry inflated in small
 * steps against a byte budget. The budget counts what actually comes out of the inflater, not
 * the sizes the archive declares, so an entry that lies about its size (a zip bomb) stops at the
 * budget instead of filling memory.
 */

/** Why a workbook can't be read: the message is meant for the person importing it. */
export class XlsxReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XlsxReadError';
  }
}

export const NOT_A_WORKBOOK = 'The file is not a valid Excel workbook (.xlsx).';

/** One file of the archive, as its central directory describes it. */
export interface ZipEntry {
  name: string;
  /** 0: stored, 8: deflated. */
  method: number;
  flags: number;
  compressedSize: number;
  /** What the archive says the entry inflates to: checked first, never trusted. */
  declaredSize: number;
  localOffset: number;
}

/** Bytes still allowed to come out of the archive; shared by every entry one read inflates. */
export interface InflateBudget {
  left: number;
  /** The limit, for the message. */
  readonly limit: number;
}

/** Most entries an archive may list (a workbook has a few dozen). */
const MAX_ENTRIES = 10_000;
/**
 * Compressed bytes per inflate step: a step yields at most ~1,032 times as much (deflate's
 * top ratio), so memory between two budget checks stays around 16 MB.
 */
const STEP = 16 * 1024;

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function u16(b: Uint8Array, at: number): number {
  return (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
}
function u32(b: Uint8Array, at: number): number {
  return (u16(b, at) | (u16(b, at + 2) << 16)) >>> 0;
}

const invalid = () => new XlsxReadError(NOT_A_WORKBOOK);
const names = new TextDecoder('utf-8');

/** The archive's entries by name (`/` separated, no leading slash). */
export function readZipDirectory(bytes: Uint8Array): Map<string, ZipEntry> {
  // The end-of-central-directory record: in the last 22 bytes plus at most a 64 KiB comment.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 0xffff; i--) {
    if (u32(bytes, i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw invalid();
  const count = u16(bytes, eocd + 10);
  const offset = u32(bytes, eocd + 16);
  // ZIP64 (over 65,535 entries or 4 GB) is never needed within the import's limits.
  if (count === 0xffff || offset === 0xffffffff) throw invalid();
  if (count > MAX_ENTRIES) throw invalid();
  const entries = new Map<string, ZipEntry>();
  let at = offset;
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || u32(bytes, at) !== CENTRAL) throw invalid();
    const nameLength = u16(bytes, at + 28);
    const end = at + 46 + nameLength + u16(bytes, at + 30) + u16(bytes, at + 32);
    if (end > bytes.length) throw invalid();
    const name = names
      .decode(bytes.subarray(at + 46, at + 46 + nameLength))
      .replaceAll('\\', '/')
      .replace(/^\/+/, '');
    entries.set(name, {
      name,
      flags: u16(bytes, at + 8),
      method: u16(bytes, at + 10),
      compressedSize: u32(bytes, at + 20),
      declaredSize: u32(bytes, at + 24),
      localOffset: u32(bytes, at + 42),
    });
    at = end;
  }
  return entries;
}

/** The entry's compressed bytes, after its local header. */
function entryData(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  const at = entry.localOffset;
  if (at + 30 > bytes.length || u32(bytes, at) !== LOCAL) throw invalid();
  const start = at + 30 + u16(bytes, at + 26) + u16(bytes, at + 28);
  const end = start + entry.compressedSize;
  if (end > bytes.length) throw invalid();
  return bytes.subarray(start, end);
}

function tooBig(budget: InflateBudget): XlsxReadError {
  const mb = Math.round(budget.limit / (1024 * 1024));
  return new XlsxReadError(`The workbook unpacks to more than ${mb} MB, too much to import.`);
}

/**
 * Inflates one entry, handing its bytes to `onChunk` as they come, and charges them to
 * `budget`: past it, the read stops with an XlsxReadError. Encrypted entries and compression
 * methods other than stored and deflate are refused.
 */
export function inflateEntry(
  bytes: Uint8Array,
  entry: ZipEntry,
  budget: InflateBudget,
  onChunk: (chunk: Uint8Array) => void
): void {
  if (entry.flags & 1) throw invalid();
  if (entry.declaredSize > budget.left) throw tooBig(budget);
  const data = entryData(bytes, entry);
  const take = (chunk: Uint8Array) => {
    budget.left -= chunk.length;
    if (budget.left < 0) throw tooBig(budget);
    if (chunk.length > 0) onChunk(chunk);
  };
  if (entry.method === 0) {
    take(data);
    return;
  }
  if (entry.method !== 8) throw invalid();
  if (data.length === 0) return;
  const inflater = new Inflate(take);
  try {
    for (let i = 0; i < data.length; i += STEP) {
      inflater.push(data.subarray(i, i + STEP), i + STEP >= data.length);
    }
  } catch (err) {
    if (err instanceof XlsxReadError) throw err;
    // fflate's errors: corrupt deflate data.
    throw invalid();
  }
}
