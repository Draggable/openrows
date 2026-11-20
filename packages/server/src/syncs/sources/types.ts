/**
 * External sync sources: a CSV file at a URL (csv.ts) and a Postgres table or query
 * (postgres.ts). Both give rows of text cells under named columns; the engine (../run.ts) maps
 * the columns to the synced table's fields by name and upserts by a key column (or the row
 * number) through the same code as table sources.
 */

/** What a read returns: the columns (unique names, in order) and rows of text or null. */
export interface ExternalRows {
  columns: string[];
  rows: (string | null)[][];
  /** Kept for the next run when this one succeeds (a CSV's ETag and Last-Modified). */
  state: Record<string, string>;
}

/** A read, or "not modified since the state's run" (a CSV's 304). */
export type ExternalRead = ({ notModified: false } & ExternalRows) | { notModified: true };

/** Rows of a read, a page at a time as it goes (a run stages them); a promise is awaited. */
export type RowSink = (rows: (string | null)[][]) => void | Promise<void>;

/**
 * A streamed read: its rows went to the sink (`rows` of them) and these are its columns; or
 * "not modified since the state's run" (a CSV's 304).
 */
export type StreamedRead =
  | {
      notModified: false;
      columns: string[];
      rows: number;
      state: Record<string, string>;
      /** The source's label now (a connector's names). */
      label?: string;
    }
  | { notModified: true };

/** A source problem whose message is safe to show (no addresses, URLs or credentials). */
export class SourceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SourceError';
  }
}

/** More rows than the cap: the engine pauses the sync (`too_many_records`). */
export class TooManyRows extends Error {
  constructor() {
    super('too many rows');
    this.name = 'TooManyRows';
  }
}

/**
 * Unique, non-empty column names: blanks become "Column 3", repeats "Name 2" (like the CSV
 * import's header), each cut to 255 characters.
 */
export function columnNames(raw: readonly string[]): string[] {
  const taken = new Set<string>();
  return raw.map((value, i) => {
    const base = value.trim().slice(0, 240) || `Column ${i + 1}`;
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
    taken.add(name.toLowerCase());
    return name;
  });
}
