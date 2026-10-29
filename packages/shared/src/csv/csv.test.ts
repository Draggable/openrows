import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CsvParseError,
  csvLine,
  detectDelimiter,
  inferField,
  neutralizeCell,
  optionsForColumn,
  parseCsv,
} from './index.js';

describe('parseCsv', () => {
  it('reads plain, quoted and empty cells', () => {
    expect(parseCsv('a,b,c\n1,"x, y",\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x, y', ''],
    ]);
  });

  it('reads doubled quotes and line breaks inside quotes', () => {
    expect(parseCsv('"say ""hi""","line 1\r\nline 2"\r\nz,w')).toEqual([
      ['say "hi"', 'line 1\r\nline 2'],
      ['z', 'w'],
    ]);
  });

  it('takes CRLF, LF and CR line ends, drops a BOM and blank lines', () => {
    expect(parseCsv('﻿a\r\nb\n\nc\rd')).toEqual([['a'], ['b'], ['c'], ['d']]);
  });

  it('keeps a trailing empty cell', () => {
    expect(parseCsv('a,')).toEqual([['a', '']]);
    expect(parseCsv('a,\n')).toEqual([['a', '']]);
  });

  it('detects ; tab and | delimiters', () => {
    expect(detectDelimiter('a;b;c\n1,2;3')).toBe(';');
    expect(parseCsv('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv('a|b', { delimiter: '|' })).toEqual([['a', 'b']]);
  });

  it('refuses an unclosed quote and text after a closing quote, with the line', () => {
    expect(() => parseCsv('a\n"open,b\nc')).toThrow(CsvParseError);
    expect(() => parseCsv('a\n"open,b\nc')).toThrow(/line 2/);
    expect(() => parseCsv('"a"b,c')).toThrow(/after a closing quote/);
  });

  it('reads back what csvLine wrote (property)', () => {
    const cell = fc.string({ unit: fc.constantFrom('a', ' ', ',', '"', '\n', '\r', 'é', '=') });
    const table = fc.array(fc.array(cell, { minLength: 2, maxLength: 5 }), {
      minLength: 1,
      maxLength: 8,
    });
    fc.assert(
      fc.property(table, (rows) => {
        const text = rows.map((r) => csvLine(r)).join('');
        expect(parseCsv(text, { delimiter: ',' })).toEqual(rows);
      })
    );
  });
});

describe('neutralizeCell (formula injection)', () => {
  it.each([
    ['=1+1', "'=1+1"],
    ['+cmd', "'+cmd"],
    ['-2+3', "'-2+3"],
    ['-$1+cmd', "'-$1+cmd"],
    ['-1 ', "'-1 "],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\t=x', "'\t=x"],
    ['\r=x', "'\r=x"],
    ['=HYPERLINK("http://evil","x")', `'=HYPERLINK("http://evil","x")`],
  ])('prefixes %j', (input, out) => {
    expect(neutralizeCell(input)).toBe(out);
  });

  it.each(['', 'plain', '-12.5', '-3', '+4', '-$1,234.00', '-3%', '42', 'a=b', ' =x'])(
    'keeps %j',
    (input) => {
      expect(neutralizeCell(input)).toBe(input);
    }
  );
});

describe('inferField', () => {
  const many = (values: string[], times = 4) => Array.from({ length: times }, () => values).flat();

  it.each([
    [['true', 'False', 'yes', ''], 'checkbox'],
    [['1', '2.25', '-3'], 'number'],
    [['1,234.5', '-12', '1,000,000'], 'number'],
    [['$1,234.00', '-$5.50'], 'currency'],
    [['12.5%', '-3%'], 'percent'],
    [['2024-01-31', '2025-12-01'], 'date'],
    [['1/31/2024', '12/1/2025'], 'date'],
    [['2024-01-31T10:00:00Z', '2024-02-01 08:30'], 'dateTime'],
    [['a@example.com', 'b@example.org'], 'email'],
    [['https://openrows.io', 'http://example.com/x?y=1'], 'url'],
    [['one\ntwo', 'three'], 'longText'],
    [['Alice', 'Bob', 'Carol'], 'singleLineText'],
    [['', ' '], 'singleLineText'],
  ])('%j → %s', (cells, type) => {
    expect(inferField(cells).type).toBe(type);
  });

  it('takes the longest fraction as the number precision', () => {
    expect(inferField(['1', '2.5', '3.125']).options).toEqual({ precision: 3 });
  });

  it('reads day-first dates as european', () => {
    expect(inferField(['31/01/2024', '1/12/2025'])).toEqual({
      type: 'date',
      options: { dateFormat: 'european' },
    });
  });

  it('makes a single select of a few values repeated often', () => {
    const inferred = inferField(many(['Todo', 'Doing', 'Done']));
    expect(inferred.type).toBe('singleSelect');
    const choices = (inferred.options as { choices: { name: string }[] }).choices;
    expect(choices.map((c) => c.name)).toEqual(['Todo', 'Doing', 'Done']);
  });

  it('keeps text when values barely repeat', () => {
    expect(inferField(many(['a', 'b', 'c', 'd', 'e'], 2)).type).toBe('singleLineText');
  });
});

describe('optionsForColumn', () => {
  it('keeps the inferred options for the inferred type', () => {
    expect(optionsForColumn('number', ['1.25'])).toEqual({ precision: 2 });
  });

  it('builds choices from the distinct values for select types', () => {
    const options = optionsForColumn('multipleSelect', ['a', 'b', 'a', '']) as {
      choices: { name: string }[];
    };
    expect(options.choices.map((c) => c.name)).toEqual(['a', 'b']);
  });

  it('falls back to the defaults', () => {
    expect(optionsForColumn('longText', ['x'])).toEqual({});
  });
});
