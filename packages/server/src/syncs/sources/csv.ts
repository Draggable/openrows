import {
  CsvParseError,
  CsvRowStream,
  MAX_SYNC_CELL_CHARS,
  MAX_SYNC_CSV_BYTES,
  MAX_SYNC_CSV_ROW_CHARS,
} from '@openrows/shared';
import { type BodySink, type SafeFetch, SafeFetchError } from '../../lib/safe-fetch/index.js';
import {
  columnNames,
  type ExternalRead,
  type RowSink,
  SourceError,
  type StreamedRead,
  TooManyRows,
} from './types.js';

/**
 * A CSV file at a URL as a sync source. Fetched through the SSRF-safe client only (every
 * hop's address checked and pinned, at most 3 redirects, MAX_SYNC_CSV_BYTES, one deadline), with
 * a conditional GET (If-None-Match / If-Modified-Since from the last good run), so an unchanged
 * file is a 304 and the run writes nothing. The first row is the header. The file is parsed as
 * it downloads and its rows handed on a page at a time, so it is never held whole.
 */

/** A preview's download. */
export const CSV_TIMEOUT_MS = 60_000;
/** A run's whole download, up to MAX_SYNC_CSV_BYTES. */
export const CSV_RUN_TIMEOUT_MS = 10 * 60_000;
/** Rows handed to the sink at a time. */
const CSV_PAGE = 500;

export interface CsvState {
  etag?: string;
  lastModified?: string;
}

/** "data.example.com/exports/people.csv": the URL without its query, for the sync's label. */
export function csvLabel(url: string): string {
  const u = new URL(url);
  const label = `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  return label.length > 120 ? `${label.slice(0, 119)}…` : label;
}

/** The new table's default name: the file's name without its extension. */
export function csvTableName(url: string): string {
  const last = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '').replace(
    /\.(csv|tsv|txt)$/i,
    ''
  );
  return last.trim().slice(0, 255) || 'CSV';
}

export interface CsvReadOptions {
  state?: CsvState;
  /** More data rows than this: TooManyRows. */
  maxRows: number;
  maxBytes?: number;
  /** The longest row, in characters (MAX_SYNC_CSV_ROW_CHARS): longer fails the read. */
  maxRowChars?: number;
  timeoutMs?: number;
  /** Stops after this many data rows (a preview): the rest is neither read nor counted. */
  limit?: number;
}

class NotModified extends Error {}
class Enough extends Error {}

/** The response's status and type, before its body: a 304, an error or a web page end it. */
function checkHead(head: { status: number; headers: Headers }, state: CsvState | undefined) {
  if (head.status === 304 && state && (state.etag || state.lastModified)) throw new NotModified();
  if (head.status < 200 || head.status > 299) {
    throw new SourceError(`The URL answered ${head.status} instead of the file.`);
  }
  const type = head.headers.get('content-type') ?? '';
  if (/^\s*(text\/html|application\/xhtml)/i.test(type)) {
    throw new SourceError('The URL answered with a web page, not a CSV file.');
  }
}

/**
 * Downloads and parses the file, handing its data rows to `onRows` a page at a time (text
 * cells, empty ones null, each cut to MAX_SYNC_CELL_CHARS). Throws SourceError with a safe
 * message, or TooManyRows past `maxRows` (some rows may have gone to `onRows` by then).
 */
export async function streamCsv(
  http: SafeFetch,
  url: string,
  opts: CsvReadOptions & { onRows: RowSink }
): Promise<StreamedRead> {
  const headers: Record<string, string> = {
    accept: 'text/csv, text/plain;q=0.9, */*;q=0.1',
  };
  if (opts.state?.etag) headers['if-none-match'] = opts.state.etag;
  if (opts.state?.lastModified) headers['if-modified-since'] = opts.state.lastModified;
  const maxBytes = opts.maxBytes ?? MAX_SYNC_CSV_BYTES;

  let columns: string[] | undefined;
  let count = 0;
  let page: (string | null)[][] = [];
  const parser = new CsvRowStream(
    (cells) => {
      if (!columns) {
        columns = columnNames(cells);
        return;
      }
      if (opts.limit !== undefined && count >= opts.limit) throw new Enough();
      count++;
      if (count > opts.maxRows) throw new TooManyRows();
      page.push(
        columns.map((_, i) => {
          const cell = cells[i];
          if (cell === undefined || cell === '') return null;
          return cell.length > MAX_SYNC_CELL_CHARS ? cell.slice(0, MAX_SYNC_CELL_CHARS) : cell;
        })
      );
    },
    { maxRowChars: opts.maxRowChars ?? MAX_SYNC_CSV_ROW_CHARS }
  );
  const flush = async () => {
    if (page.length === 0) return;
    const rows = page;
    page = [];
    await opts.onRows(rows);
  };
  const decoder = new TextDecoder('utf-8');
  const feed: BodySink = (chunk) => {
    parser.push(decoder.decode(chunk, { stream: true }));
    if (page.length >= CSV_PAGE) return flush();
  };

  let res: Awaited<ReturnType<SafeFetch>>;
  try {
    let streamed = false;
    res = await http(url, {
      headers,
      maxBytes,
      timeoutMs: opts.timeoutMs ?? CSV_TIMEOUT_MS,
      stream: (head) => {
        checkHead(head, opts.state);
        streamed = true;
        return feed;
      },
    });
    // A client that doesn't stream answered with the whole body.
    if (!streamed) {
      checkHead(res, opts.state);
      await feed(res.body);
    }
    parser.push(decoder.decode());
    parser.end();
    await flush();
  } catch (err) {
    if (err instanceof NotModified) return { notModified: true };
    if (err instanceof Enough && columns) {
      await flush();
      return { notModified: false, columns, rows: count, state: {} };
    }
    if (err instanceof CsvParseError) {
      throw new SourceError(`The file isn't valid CSV: ${err.message}`, { cause: err });
    }
    if (err instanceof SafeFetchError) {
      if (err.code === 'RESPONSE_TOO_LARGE') {
        throw new SourceError(`The file is bigger than ${Math.round(maxBytes / 1024 / 1024)} MB.`, {
          cause: err,
        });
      }
      throw new SourceError(`Couldn't download the file: ${err.message}.`, { cause: err });
    }
    throw err;
  }
  if (!columns) throw new SourceError('The file is empty.');
  const state: Record<string, string> = {};
  const etag = res.headers.get('etag');
  const lastModified = res.headers.get('last-modified');
  if (etag && etag.length <= 256) state['etag'] = etag;
  if (lastModified && lastModified.length <= 64) state['lastModified'] = lastModified;
  return { notModified: false, columns, rows: count, state };
}

/** streamCsv with the rows kept: a preview's first rows (`limit`), or a small file. */
export async function readCsv(
  http: SafeFetch,
  url: string,
  opts: CsvReadOptions
): Promise<ExternalRead> {
  const rows: (string | null)[][] = [];
  const read = await streamCsv(http, url, {
    ...opts,
    onRows: (page) => {
      rows.push(...page);
    },
  });
  if (read.notModified) return read;
  return { notModified: false, columns: read.columns, rows, state: read.state };
}
