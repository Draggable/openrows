import { CsvParseError, detectDelimiter } from './index.js';

/** Text held to find the first line (for the delimiter) before parsing starts, at most. */
const HEAD_MAX = 1024 * 1024;

type State = 'start' | 'plain' | 'quoted' | 'quote' | 'cr';

/**
 * `parseCsv` for text that arrives a piece at a time (a download): the same rows, the same
 * errors and the same delimiter detection as `parseCsv` over the whole text, with only the row
 * being read in memory. Complete rows go to `onRow` as soon as they end; `end()` finishes the
 * last one (and throws for a quote that never closes). An error `onRow` throws comes out of
 * `push` or `end`. Without a `delimiter`, the text is held until its first line break (at
 * most 1 MiB, then the delimiter is picked from what is held) and the delimiter detected there.
 * With `maxRowChars`, a row longer than that (its cells' characters and one per cell) is an
 * error as soon as it gets there, so a file without line breaks is never held whole.
 */
export class CsvRowStream {
  private delimiter: string | undefined;
  private head = '';
  private started = false;
  private state: State = 'start';
  private row: string[] = [];
  private cell = '';
  private line = 1;
  private quoteLine = 1;
  private rowChars = 0;
  private rowLine = 1;
  private readonly maxRowChars: number;

  constructor(
    private readonly onRow: (cells: string[]) => void,
    opts: { delimiter?: string; maxRowChars?: number } = {}
  ) {
    this.maxRowChars = opts.maxRowChars ?? Number.POSITIVE_INFINITY;
    const d = opts.delimiter;
    if (d !== undefined && (d.length !== 1 || d === '"' || d === '\n' || d === '\r')) {
      throw new Error(`CsvRowStream: invalid delimiter ${JSON.stringify(d)}`);
    }
    this.delimiter = d;
  }

  /** Parses the next piece of the text. */
  push(text: string): void {
    if (!this.started && text.length > 0) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    if (this.delimiter === undefined) {
      this.head += text;
      if (!this.head.includes('\n') && this.head.length < HEAD_MAX) return;
      this.delimiter = detectDelimiter(this.head);
      text = this.head;
      this.head = '';
    }
    this.parse(text);
  }

  /** The end of the text: the last row, if any. */
  end(): void {
    if (this.delimiter === undefined) {
      this.delimiter = detectDelimiter(this.head);
      const text = this.head;
      this.head = '';
      this.parse(text);
    }
    switch (this.state) {
      case 'start':
        // Right after a delimiter: the row ends with an empty cell.
        if (this.row.length > 0) {
          this.cell = '';
          this.endCell();
          this.endRow();
        }
        break;
      case 'plain':
      case 'quote':
        this.endCell();
        this.endRow();
        break;
      case 'quoted':
        throw new CsvParseError('A quoted cell never closes', this.quoteLine);
      case 'cr':
        break;
    }
    this.state = 'start';
  }

  /** `n` more characters in the row being read. */
  private grow(n: number) {
    this.rowChars += n;
    if (this.rowChars > this.maxRowChars) {
      throw new CsvParseError(
        `A row is longer than ${this.maxRowChars.toLocaleString('en')} characters`,
        this.rowLine
      );
    }
  }

  /** The cell read so far ends: it joins the row. */
  private endCell() {
    this.grow(1);
    this.row.push(this.cell);
    this.cell = '';
  }

  private endRow() {
    const row = this.row;
    this.row = [];
    this.rowChars = 0;
    this.rowLine = this.line;
    // A blank line is one empty cell: skip it.
    if (!(row.length === 1 && row[0] === '')) this.onRow(row);
  }

  /** After a cell, at a delimiter or line break `ch`: the next cell or row. */
  private separator(ch: number) {
    if (ch === 10 || ch === 13) {
      this.line++;
      this.endRow();
      this.state = ch === 13 ? 'cr' : 'start';
    } else {
      this.state = 'start';
    }
  }

  private parse(text: string) {
    const d = (this.delimiter ?? ',').charCodeAt(0);
    const n = text.length;
    let i = 0;
    while (i < n) {
      switch (this.state) {
        case 'cr':
          // CRLF is one line break.
          if (text.charCodeAt(i) === 10) i++;
          this.state = 'start';
          break;
        case 'start':
          this.cell = '';
          if (text.charCodeAt(i) === 34) {
            this.state = 'quoted';
            this.quoteLine = this.line;
            i++;
          } else {
            this.state = 'plain';
          }
          break;
        case 'plain': {
          let j = i;
          while (j < n) {
            const c = text.charCodeAt(j);
            if (c === d || c === 10 || c === 13) break;
            j++;
          }
          this.grow(j - i);
          this.cell += text.slice(i, j);
          i = j;
          if (j < n) {
            this.endCell();
            this.separator(text.charCodeAt(j));
            i++;
          }
          break;
        }
        case 'quoted': {
          const q = text.indexOf('"', i);
          const chunk = q === -1 ? text.slice(i) : text.slice(i, q);
          for (let k = chunk.indexOf('\n'); k !== -1; k = chunk.indexOf('\n', k + 1)) this.line++;
          this.grow(chunk.length);
          this.cell += chunk;
          if (q === -1) {
            i = n;
          } else {
            i = q + 1;
            this.state = 'quote';
          }
          break;
        }
        case 'quote': {
          const c = text.charCodeAt(i);
          if (c === 34) {
            // A doubled quote.
            this.grow(1);
            this.cell += '"';
            this.state = 'quoted';
            i++;
          } else if (c === d || c === 10 || c === 13) {
            this.endCell();
            this.separator(c);
            i++;
          } else {
            throw new CsvParseError('Text after a closing quote', this.line);
          }
          break;
        }
      }
    }
  }
}
