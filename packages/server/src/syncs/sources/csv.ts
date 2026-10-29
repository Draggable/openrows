import { CsvParseError, MAX_SYNC_CELL_CHARS, MAX_SYNC_CSV_BYTES, parseCsv } from '@openrows/shared';
import { type SafeFetch, SafeFetchError } from '../../lib/safe-fetch/index.js';
import { columnNames, type ExternalRead, SourceError, TooManyRows } from './types.js';

/**
 * A CSV file at a URL as a sync source. Fetched through the SSRF-safe client only (every
 * hop's address checked and pinned, at most 3 redirects, MAX_SYNC_CSV_BYTES, one deadline), with
 * a conditional GET (If-None-Match / If-Modified-Since from the last good run), so an unchanged
 * file is a 304 and the run writes nothing. The first row is the header.
 */

export const CSV_TIMEOUT_MS = 60_000;

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

export async function readCsv(
  http: SafeFetch,
  url: string,
  opts: { state?: CsvState; maxRows: number; maxBytes?: number }
): Promise<ExternalRead> {
  const headers: Record<string, string> = {
    accept: 'text/csv, text/plain;q=0.9, */*;q=0.1',
  };
  if (opts.state?.etag) headers['if-none-match'] = opts.state.etag;
  if (opts.state?.lastModified) headers['if-modified-since'] = opts.state.lastModified;
  let res: Awaited<ReturnType<SafeFetch>>;
  try {
    res = await http(url, {
      headers,
      maxBytes: opts.maxBytes ?? MAX_SYNC_CSV_BYTES,
      timeoutMs: CSV_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof SafeFetchError) {
      if (err.code === 'RESPONSE_TOO_LARGE') {
        throw new SourceError(
          `The file is bigger than ${Math.round((opts.maxBytes ?? MAX_SYNC_CSV_BYTES) / 1024 / 1024)} MB.`,
          { cause: err }
        );
      }
      throw new SourceError(`Couldn't download the file: ${err.message}.`, { cause: err });
    }
    throw err;
  }
  if (res.status === 304 && opts.state && (opts.state.etag || opts.state.lastModified)) {
    return { notModified: true };
  }
  if (res.status < 200 || res.status > 299) {
    throw new SourceError(`The URL answered ${res.status} instead of the file.`);
  }
  const type = res.headers.get('content-type') ?? '';
  if (/^\s*(text\/html|application\/xhtml)/i.test(type)) {
    throw new SourceError('The URL answered with a web page, not a CSV file.');
  }
  let table: string[][];
  try {
    table = parseCsv(new TextDecoder('utf-8').decode(res.body));
  } catch (err) {
    if (err instanceof CsvParseError) {
      throw new SourceError(`The file isn't valid CSV: ${err.message}`, { cause: err });
    }
    throw err;
  }
  const [header, ...body] = table;
  if (!header) throw new SourceError('The file is empty.');
  if (body.length > opts.maxRows) throw new TooManyRows();
  const columns = columnNames(header);
  const rows = body.map((cells) =>
    columns.map((_, i) => {
      const cell = cells[i];
      if (cell === undefined || cell === '') return null;
      return cell.length > MAX_SYNC_CELL_CHARS ? cell.slice(0, MAX_SYNC_CELL_CHARS) : cell;
    })
  );
  const state: Record<string, string> = {};
  const etag = res.headers.get('etag');
  const lastModified = res.headers.get('last-modified');
  if (etag && etag.length <= 256) state['etag'] = etag;
  if (lastModified && lastModified.length <= 64) state['lastModified'] = lastModified;
  return { notModified: false, columns, rows, state };
}
