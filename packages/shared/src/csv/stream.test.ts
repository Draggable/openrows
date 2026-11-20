import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CsvParseError, CsvRowStream, parseCsv } from './index.js';

/** Streams `pieces` through a CsvRowStream: its rows, or the error it threw. */
function streamed(pieces: string[], opts: { delimiter?: string; maxRowChars?: number } = {}) {
  const rows: string[][] = [];
  const stream = new CsvRowStream((row) => rows.push(row), opts);
  try {
    for (const piece of pieces) stream.push(piece);
    stream.end();
  } catch (err) {
    return { error: err instanceof CsvParseError ? err.message : String(err) };
  }
  return { rows };
}

function whole(text: string, opts: { delimiter?: string } = {}) {
  try {
    return { rows: parseCsv(text, opts) };
  } catch (err) {
    return { error: err instanceof CsvParseError ? err.message : String(err) };
  }
}

/** `text` cut at `cuts` (positions, any order). */
function split(text: string, cuts: number[]): string[] {
  const at = [...new Set(cuts.map((c) => c % (text.length + 1)))].sort((a, b) => a - b);
  const pieces: string[] = [];
  let from = 0;
  for (const c of at) {
    pieces.push(text.slice(from, c));
    from = c;
  }
  pieces.push(text.slice(from));
  return pieces;
}

describe('CsvRowStream', () => {
  it('fails a row longer than maxRowChars as soon as it gets there', () => {
    const opts = { delimiter: ',', maxRowChars: 10 };
    // Its cells' characters and one per cell: 4 + 2 = 6, then 3 + 2 = 5 (a doubled quote is one).
    expect(streamed(['ab,c', 'd\n"x""",y\n'], opts)).toEqual({
      rows: [
        ['ab', 'cd'],
        ['x"', 'y'],
      ],
    });
    expect(streamed(['ok\n', 'a,b,c,d,e,f', ',g\n'], opts)).toEqual({
      error: 'A row is longer than 10 characters (line 2)',
    });
    // One quoted cell and no line break: refused while it is still being read.
    const rows: string[][] = [];
    const stream = new CsvRowStream((row) => rows.push(row), opts);
    stream.push('"');
    expect(() => {
      for (let i = 0; i < 1000; i++) stream.push('0123456789');
    }).toThrow(/longer than 10 characters \(line 1\)/);
    expect(rows).toEqual([]);
  });

  it('reads rows as they end, across pieces', () => {
    const rows: string[][] = [];
    const stream = new CsvRowStream((row) => rows.push(row));
    stream.push('﻿a,b\n1,"x');
    expect(rows).toEqual([['a', 'b']]);
    stream.push(', ""y""');
    stream.push('"\r');
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', 'x, "y"'],
    ]);
    stream.push('\n2,');
    stream.end();
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', 'x, "y"'],
      ['2', ''],
    ]);
  });

  it('detects the delimiter on the first line, held until it ends', () => {
    expect(streamed(['a;b', ';c\n1;2;3'])).toEqual({
      rows: [
        ['a', 'b', 'c'],
        ['1', '2', '3'],
      ],
    });
    expect(streamed(['a\tb'])).toEqual({ rows: [['a', 'b']] });
  });

  it("throws parseCsv's errors with their lines", () => {
    expect(streamed(['a\n"open', '\nmore'])).toEqual({
      error: 'A quoted cell never closes (line 2)',
    });
    expect(streamed(['a\n"x"', 'y'])).toEqual({ error: 'Text after a closing quote (line 2)' });
  });

  it('passes an error of onRow through', () => {
    const stream = new CsvRowStream(() => {
      throw new Error('enough');
    });
    expect(() => stream.push('a\nb\n')).toThrow('enough');
  });

  it('matches parseCsv on any text, however it is cut', () => {
    const text = fc
      .array(fc.constantFrom('a', 'b', ',', ';', '\t', '"', '\n', '\r', ' ', 'é', '﻿'), {
        maxLength: 40,
      })
      .map((chars) => chars.join(''));
    fc.assert(
      fc.property(text, fc.array(fc.nat(), { maxLength: 6 }), (csv, cuts) => {
        expect(streamed(split(csv, cuts))).toEqual(whole(csv));
        expect(streamed(split(csv, cuts), { delimiter: ';' })).toEqual(
          whole(csv, { delimiter: ';' })
        );
      }),
      { numRuns: 3000 }
    );
  });
});
