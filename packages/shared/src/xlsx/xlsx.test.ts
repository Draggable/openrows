import fc from 'fast-check';
import { Deflate, deflateSync, strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { inferField } from '../csv/index.js';
import { classifyFormat, formatNumber } from './format.js';
import {
  isZipFile,
  MAX_XLSX_UNPACKED_BYTES,
  readXlsx,
  XlsxReadError,
  xlsxSheetNames,
} from './index.js';

// ---------------------------------------------------------------------------------------------
// Fixtures: minimal workbooks as Excel writes them.

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const escapeXml = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    // ST_Xstring: a literal `_xHHHH_` is written with its underscore escaped.
    .replace(/_(?=x[0-9A-Fa-f]{4}_)/g, '_x005F_')
    // Control characters (not allowed in XML) as `_xHHHH_`.
    .split('')
    .map((c) => {
      const code = c.charCodeAt(0);
      return code < 0x20 && c !== '\t' && c !== '\n' && c !== '\r'
        ? `_x${code.toString(16).padStart(4, '0').toUpperCase()}_`
        : c;
    })
    .join('');

/** An inline-string cell. */
const str = (ref: string, text: string) =>
  `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
/** A number cell, with a style index. */
const num = (ref: string, value: number | string, style?: number) =>
  `<c r="${ref}"${style !== undefined ? ` s="${style}"` : ''}><v>${value}</v></c>`;
const row = (r: number, ...cells: string[]) => `<row r="${r}">${cells.join('')}</row>`;

interface SheetSpec {
  name: string;
  /** The `<sheetData>` content. */
  data: string;
  /** A chart sheet: listed in the workbook, no cells. */
  chart?: boolean;
}

interface WorkbookSpec {
  sheets: SheetSpec[];
  strings?: string[];
  /** Custom number formats by id. */
  numFmts?: Record<number, string>;
  /** The numFmtId of each cell style, by style index. */
  styles?: number[];
  date1904?: boolean;
  /** Extra parts, by path. */
  extra?: Record<string, string>;
}

function workbookFiles(spec: WorkbookSpec): Record<string, Uint8Array> {
  const files: Record<string, string> = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  };
  const rels: string[] = [];
  const sheets: string[] = [];
  spec.sheets.forEach((s, i) => {
    const id = `rId${i + 1}`;
    const kind = s.chart ? 'chartsheet' : 'worksheet';
    const path = s.chart ? `chartsheets/sheet${i + 1}.xml` : `worksheets/sheet${i + 1}.xml`;
    rels.push(`<Relationship Id="${id}" Type="${REL}/${kind}" Target="${path}"/>`);
    sheets.push(`<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="${id}"/>`);
    files[`xl/${path}`] = s.chart
      ? `<chartsheet xmlns="${NS}"/>`
      : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}" xmlns:r="${REL}"><dimension ref="A1"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetData>${s.data}</sheetData></worksheet>`;
  });
  if (spec.strings) {
    rels.push(`<Relationship Id="rIdS" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>`);
    files['xl/sharedStrings.xml'] =
      `<sst xmlns="${NS}" count="${spec.strings.length}">` +
      spec.strings.map((s) => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`).join('') +
      '</sst>';
  }
  if (spec.styles) {
    rels.push(`<Relationship Id="rIdT" Type="${REL}/styles" Target="/xl/styles.xml"/>`);
    const fmts = Object.entries(spec.numFmts ?? {})
      .map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${escapeXml(code)}"/>`)
      .join('');
    files['xl/styles.xml'] =
      `<styleSheet xmlns="${NS}"><numFmts>${fmts}</numFmts>` +
      // Cell style formats come first and must not be read as cell formats.
      '<cellStyleXfs count="1"><xf numFmtId="10"/></cellStyleXfs>' +
      `<cellXfs>${spec.styles.map((id) => `<xf numFmtId="${id}" applyNumberFormat="1"/>`).join('')}</cellXfs></styleSheet>`;
  }
  files['xl/_rels/workbook.xml.rels'] =
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`;
  files['xl/workbook.xml'] =
    `<workbook xmlns="${NS}" xmlns:r="${REL}"><workbookPr${spec.date1904 ? ' date1904="1"' : ''}/><sheets>${sheets.join('')}</sheets></workbook>`;
  Object.assign(files, spec.extra);
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]));
}

const workbook = (spec: WorkbookSpec) => zipSync(workbookFiles(spec));

/**
 * A ZIP archive written by hand, so an entry can declare any size: `declaredSize` goes into
 * both headers whatever `data` inflates to.
 */
function rawZip(
  entries: { name: string; data: Uint8Array; method?: number; declaredSize?: number }[]
): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const header = (size: number) => {
    const b = new Uint8Array(size);
    return { b, v: new DataView(b.buffer) };
  };
  for (const e of entries) {
    const name = strToU8(e.name);
    const method = e.method ?? 8;
    const declared = e.declaredSize ?? e.data.length;
    const local = header(30);
    local.v.setUint32(0, 0x04034b50, true);
    local.v.setUint16(4, 20, true);
    local.v.setUint16(8, method, true);
    local.v.setUint32(18, e.data.length, true);
    local.v.setUint32(22, declared, true);
    local.v.setUint16(26, name.length, true);
    const cd = header(46);
    cd.v.setUint32(0, 0x02014b50, true);
    cd.v.setUint16(4, 20, true);
    cd.v.setUint16(6, 20, true);
    cd.v.setUint16(10, method, true);
    cd.v.setUint32(20, e.data.length, true);
    cd.v.setUint32(24, declared, true);
    cd.v.setUint16(28, name.length, true);
    cd.v.setUint32(42, offset, true);
    parts.push(local.b, name, e.data);
    central.push(cd.b, name);
    offset += 30 + name.length + e.data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = header(22);
  end.v.setUint32(0, 0x06054b50, true);
  end.v.setUint16(8, entries.length, true);
  end.v.setUint16(10, entries.length, true);
  end.v.setUint32(12, cdSize, true);
  end.v.setUint32(16, offset, true);
  const all = [...parts, ...central, end.b];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A valid workbook whose first sheet is replaced by `sheet` (compressed bytes, declared size). */
function workbookWithSheet(sheet: Uint8Array, declaredSize: number): Uint8Array {
  const files = workbookFiles({ sheets: [{ name: 'Bomb', data: '' }] });
  return rawZip(
    Object.entries(files).map(([name, data]) =>
      name === 'xl/worksheets/sheet1.xml'
        ? { name, data: sheet, declaredSize }
        : { name, data: deflateSync(data), declaredSize: data.length }
    )
  );
}

const readError = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof XlsxReadError) return err.message;
    throw err;
  }
  throw new Error('expected an XlsxReadError');
};

// ---------------------------------------------------------------------------------------------

describe('readXlsx', () => {
  it('reads a simple sheet: shared and inline strings, numbers, booleans, errors', () => {
    const bytes = workbook({
      strings: ['Name', 'Count', 'Done', 'Ada', 'Bob & <Co>'],
      sheets: [
        {
          name: 'Tasks',
          data:
            row(
              1,
              '<c r="A1" t="s"><v>0</v></c>',
              '<c r="B1" t="s"><v>1</v></c>',
              '<c r="C1" t="s"><v>2</v></c>'
            ) +
            row(2, '<c r="A2" t="s"><v>3</v></c>', num('B2', 3), '<c r="C2" t="b"><v>1</v></c>') +
            row(
              3,
              '<c r="A3" t="s"><v>4</v></c>',
              num('B3', '0.30000000000000004'),
              '<c r="C3" t="b"><v>0</v></c>'
            ) +
            row(
              4,
              str('A4', 'Formula'),
              '<c r="B4" t="e"><f>1/0</f><v>#DIV/0!</v></c>',
              '<c r="C4" t="str"><f>"x"&amp;"y"</f><v>xy</v></c>'
            ),
        },
      ],
    });
    expect(isZipFile(bytes)).toBe(true);
    expect(readXlsx(bytes)).toEqual({
      sheets: ['Tasks'],
      sheet: 'Tasks',
      rows: [
        ['Name', 'Count', 'Done'],
        ['Ada', '3', 'TRUE'],
        ['Bob & <Co>', '0.3', 'FALSE'],
        ['Formula', '#DIV/0!', 'xy'],
      ],
    });
  });

  it('leaves out empty rows and trailing empty cells, keeps gaps, places cells by reference', () => {
    const bytes = workbook({
      sheets: [
        {
          name: 'S',
          data:
            row(1, str('A1', 'a'), str('C1', 'c'), '<c r="F1" s="0"/>', str('G1', '')) +
            row(2, '<c r="A2" s="0"/>', '<c r="B2"><v></v></c>') +
            '<row r="3"/>' +
            row(9, str('B9', 'b')) +
            // No references: one after another.
            '<row><c t="inlineStr"><is><t>x</t></is></c><c><v>1</v></c></row>' +
            row(12, '<c r="A12"/>', '<c r="B12"/>'),
        },
      ],
    });
    expect(readXlsx(bytes).rows).toEqual([
      ['a', '', 'c'],
      ['', 'b'],
      ['x', '1'],
    ]);
  });

  it('decodes entities, escapes and rich text, without phonetic guides', () => {
    const bytes = workbook({
      sheets: [
        {
          name: 'S',
          data: row(
            1,
            '<c r="A1" t="inlineStr"><is><r><rPr><b/></rPr><t>Bold</t></r><r><t xml:space="preserve"> and &#233;&#x1F600; &quot;q&quot;</t></r><rPh sb="0" eb="1"><t>ルビ</t></rPh></is></c>',
            '<c r="B1" t="inlineStr"><is><t>line_x000D__x000A_two _x005F_x0041_</t></is></c>'
          ),
        },
      ],
    });
    expect(readXlsx(bytes).rows).toEqual([['Bold and é😀 "q"', 'line\r\ntwo _x0041_']]);
  });

  it('reads prefixed (namespaced) SpreadsheetML', () => {
    const bytes = zipSync({
      ...workbookFiles({ sheets: [{ name: 'S', data: '' }] }),
      'xl/worksheets/sheet1.xml': strToU8(
        `<x:worksheet xmlns:x="${NS}"><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>p</x:t></x:is></x:c><x:c r="B1"><x:v>2</x:v></x:c></x:row></x:sheetData></x:worksheet>`
      ),
    });
    expect(readXlsx(bytes).rows).toEqual([['p', '2']]);
  });

  it('round-trips any text through inline and shared strings', () => {
    const text = fc.string({ minLength: 1, maxLength: 40, unit: 'grapheme' });
    const sheet = fc.array(fc.array(text, { minLength: 1, maxLength: 4 }), {
      minLength: 1,
      maxLength: 6,
    });
    fc.assert(
      fc.property(sheet, (cells) => {
        // Even columns as inline strings, odd ones as shared strings (`strings` in order).
        const strings = cells.flat();
        let next = 0;
        const data = cells
          .map((r, i) =>
            row(
              i + 1,
              ...r.map((v, j) => {
                const ref = `${String.fromCharCode(65 + j)}${i + 1}`;
                const index = next++;
                return j % 2 === 0 ? str(ref, v) : `<c r="${ref}" t="s"><v>${index}</v></c>`;
              })
            )
          )
          .join('');
        const read = readXlsx(workbook({ strings, sheets: [{ name: 'S', data }] }));
        expect(read.rows).toEqual(cells);
      }),
      { numRuns: 100 }
    );
  });

  it('reads a sheet whose XML arrives in many inflated pieces', () => {
    const rows = Array.from({ length: 5000 }, (_, i) =>
      row(i + 1, str(`A${i + 1}`, `Row ${i + 1} ${'é'.repeat(i % 7)}`), num(`B${i + 1}`, i * 1.5))
    );
    const read = readXlsx(workbook({ sheets: [{ name: 'Big', data: rows.join('') }] }));
    expect(read.rows).toHaveLength(5000);
    expect(read.rows[0]).toEqual(['Row 1 ', '0']);
    expect(read.rows[4999]).toEqual([`Row 5000 ${'é'.repeat(4999 % 7)}`, '7498.5']);
  });
});

describe('sheets', () => {
  const multi = workbook({
    sheets: [
      { name: 'Summary', data: row(1, str('A1', 'Total'), num('B1', 10)) },
      { name: 'Chart', data: '', chart: true },
      { name: 'Q1 & Q2', data: row(1, str('A1', 'Name')) + row(2, str('A2', 'Ada')) },
      { name: 'Empty', data: '' },
    ],
  });

  it('lists worksheets in tab order, without chart sheets', () => {
    expect(xlsxSheetNames(multi)).toEqual(['Summary', 'Q1 & Q2', 'Empty']);
    expect(readXlsx(multi).sheets).toEqual(['Summary', 'Q1 & Q2', 'Empty']);
  });

  it('reads the first sheet by default, or the one asked for', () => {
    expect(readXlsx(multi)).toMatchObject({ sheet: 'Summary', rows: [['Total', '10']] });
    expect(readXlsx(multi, { sheet: 'Q1 & Q2' })).toMatchObject({
      sheet: 'Q1 & Q2',
      rows: [['Name'], ['Ada']],
    });
    expect(readXlsx(multi, { sheet: 'Empty' }).rows).toEqual([]);
  });

  it('refuses a sheet the workbook has not', () => {
    expect(readError(() => readXlsx(multi, { sheet: 'Chart' }))).toBe(
      'The workbook has no sheet named "Chart".'
    );
  });

  it('refuses a workbook without worksheets', () => {
    const charts = workbook({ sheets: [{ name: 'Chart', data: '', chart: true }] });
    expect(readError(() => readXlsx(charts))).toBe('The workbook has no sheets.');
  });

  it('never opens external links, macros or other parts', () => {
    const bytes = workbook({
      sheets: [{ name: 'S', data: row(1, '<c r="A1"><f>[1]Other!A1</f><v>42</v></c>') }],
      extra: {
        // Corrupt on purpose: reading any of them would fail the import.
        'xl/vbaProject.bin': 'not a real project',
        'xl/externalLinks/externalLink1.xml': '<externalLink',
        'xl/externalLinks/_rels/externalLink1.xml.rels': `<Relationships><Relationship Id="rId1" Type="${REL}/externalLinkPath" Target="https://example.test/x.xlsx" TargetMode="External"/></Relationships>`,
        'xl/connections.xml': '<connections',
      },
    });
    // The cached value of a formula with an external reference: nothing is fetched or evaluated.
    expect(readXlsx(bytes).rows).toEqual([['42']]);
  });
});

describe('number formats', () => {
  it('shows dates, times, percentages, money and decimals as the sheet does', () => {
    const bytes = workbook({
      numFmts: {
        164: 'yyyy\\-mm\\-dd hh:mm:ss',
        165: '"$"#,##0.00',
        166: '[$$-409]#,##0',
        167: '#,##0.000 "kg"',
        168: '[Red]0.0;[Blue]-0.0',
        169: 'dd/mm/yyyy',
        170: '[$€-407] #,##0.00',
      },
      // 0 General, 1 date, 2 date time, 3 time, 4 percent, 5..10 custom, 11 elapsed, 12 sci
      styles: [0, 14, 22, 20, 10, 164, 165, 166, 167, 168, 169, 46, 11, 170],
      sheets: [
        {
          name: 'S',
          data: row(
            1,
            num('A1', 45322, 1),
            num('B1', 45322.5729166667, 2),
            num('C1', 0.75, 3),
            num('D1', 0.125, 4),
            num('E1', 45322.0001157407, 5),
            num('F1', -1234.5, 6),
            num('G1', 99.6, 7),
            num('H1', 2.5, 8),
            num('I1', 3.0416, 9),
            num('J1', 1, 10),
            num('K1', 1.5, 11),
            num('L1', 12345.678, 12),
            num('M1', 7.5, 13),
            num('N1', 60, 1),
            num('O1', 61, 1)
          ),
        },
      ],
    });
    expect(readXlsx(bytes).rows).toEqual([
      [
        '2024-01-31',
        '2024-01-31 13:45',
        '18:00',
        '12.50%',
        '2024-01-31 00:00:10',
        '-$1234.50',
        '$100',
        '2.500',
        '3.0',
        '1900-01-01',
        '36:00:00',
        '12345.678',
        '7.50',
        '1900-02-28',
        '1900-03-01',
      ],
    ]);
  });

  it('reads the 1904 date system and ISO date cells', () => {
    const bytes = workbook({
      date1904: true,
      styles: [0, 14],
      sheets: [
        {
          name: 'S',
          data: row(
            1,
            num('A1', 0, 1),
            num('B1', 43860, 1),
            '<c r="C1" t="d"><v>2024-01-31T00:00:00</v></c>',
            '<c r="D1" t="d"><v>2024-01-31T09:30:00Z</v></c>'
          ),
        },
      ],
    });
    expect(readXlsx(bytes).rows).toEqual([
      ['1904-01-01', '2024-01-31', '2024-01-31', '2024-01-31 09:30'],
    ]);
  });

  it('classifies format codes', () => {
    expect(classifyFormat('General')).toEqual({ kind: 'general' });
    expect(classifyFormat('@')).toEqual({ kind: 'general' });
    expect(classifyFormat('0.00E+00')).toEqual({ kind: 'general' });
    expect(classifyFormat('# ?/?')).toEqual({ kind: 'general' });
    expect(classifyFormat('0.0 "days"')).toEqual({ kind: 'fixed', decimals: 1 });
    expect(classifyFormat('mmm-yy')).toMatchObject({ kind: 'date', date: true, time: false });
    expect(classifyFormat('mm:ss')).toMatchObject({ kind: 'date', date: false, time: true });
    expect(classifyFormat('h:mm AM/PM')).toMatchObject({
      kind: 'date',
      time: true,
      seconds: false,
    });
    expect(classifyFormat('_("$"* #,##0.00_)')).toEqual({ kind: 'currency', decimals: 2 });
  });

  it('never prints a negative zero', () => {
    expect(formatNumber(-0.001, { kind: 'fixed', decimals: 2 }, false)).toBe('0.00');
    expect(formatNumber(-0.001, { kind: 'currency', decimals: 2 }, false)).toBe('$0.00');
  });
});

describe('type inference on sheets', () => {
  it('infers the same field types as for CSV', () => {
    const header = row(
      1,
      ...['Day', 'At', 'Qty', 'Price', 'Share', 'Done', 'Note'].map((h, i) =>
        str(`${String.fromCharCode(65 + i)}1`, h)
      )
    );
    const data = [1, 2, 3]
      .map((i) =>
        row(
          i + 1,
          num(`A${i + 1}`, 45322 + i, 1),
          num(`B${i + 1}`, 45322 + i + 0.25, 2),
          num(`C${i + 1}`, i * 10),
          num(`D${i + 1}`, i * 2.5, 3),
          num(`E${i + 1}`, i / 8, 4),
          `<c r="F${i + 1}" t="b"><v>${i % 2}</v></c>`,
          str(`G${i + 1}`, `Note ${i}`)
        )
      )
      .join('');
    const bytes = workbook({
      numFmts: { 164: '"$"#,##0.00' },
      styles: [0, 14, 22, 164, 10],
      sheets: [{ name: 'S', data: header + data }],
    });
    const rows = readXlsx(bytes).rows;
    const column = (i: number) => rows.slice(1).map((r) => r[i] ?? '');
    expect(inferField(column(0))).toEqual({ type: 'date', options: {} });
    expect(inferField(column(1))).toEqual({ type: 'dateTime', options: {} });
    expect(inferField(column(2))).toEqual({ type: 'number', options: { precision: 0 } });
    expect(inferField(column(3))).toEqual({ type: 'currency', options: { precision: 2 } });
    expect(inferField(column(4))).toEqual({ type: 'percent', options: { precision: 2 } });
    expect(inferField(column(5))).toEqual({ type: 'checkbox', options: {} });
    expect(inferField(column(6))).toEqual({ type: 'singleLineText', options: {} });
  });
});

describe('limits', () => {
  it('stops a sheet that unpacks past the limit, whatever size it declares (zip bomb)', () => {
    // ~210 MB of spaces deflates to about 200 KB; the archive claims 1 KB.
    const compressed: Uint8Array[] = [];
    const deflate = new Deflate({ level: 9 }, (chunk) => compressed.push(chunk));
    const mb = new Uint8Array(1024 * 1024).fill(0x20);
    const total = Math.ceil(MAX_XLSX_UNPACKED_BYTES / mb.length) + 10;
    for (let i = 0; i < total; i++) deflate.push(mb, i === total - 1);
    const data = new Uint8Array(compressed.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of compressed) {
      data.set(c, at);
      at += c.length;
    }
    expect(data.length).toBeLessThan(1024 * 1024);
    const bomb = workbookWithSheet(data, 1024);
    expect(readError(() => readXlsx(bomb))).toBe(
      'The workbook unpacks to more than 200 MB, too much to import.'
    );
  });

  it('refuses an entry that declares more than the limit before inflating it', () => {
    const bytes = workbookWithSheet(deflateSync(strToU8('<sheetData/>')), 0xfffffff0);
    expect(readError(() => readXlsx(bytes))).toMatch(/unpacks to more than 200 MB/);
  });

  it('counts every part one read opens against the limit', () => {
    const bytes = workbook({
      strings: ['x'.repeat(4000)],
      sheets: [{ name: 'S', data: row(1, '<c r="A1" t="s"><v>0</v></c>') }],
    });
    expect(readXlsx(bytes).rows[0]?.[0]).toHaveLength(4000);
    expect(readError(() => readXlsx(bytes, { maxUnpackedBytes: 3000 }))).toMatch(/unpacks to more/);
  });

  it('refuses too many rows, values past the last column and too many cells', () => {
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => row(i + 1, num(`A${i + 1}`, i))).join('');
    const bytes = workbook({ sheets: [{ name: 'S', data: rows(11) }] });
    expect(readXlsx(bytes, { maxRows: 11 }).rows).toHaveLength(11);
    expect(readError(() => readXlsx(bytes, { maxRows: 10 }))).toBe(
      'The sheet has more than 9 rows.'
    );

    const wide = workbook({
      sheets: [
        { name: 'S', data: row(1, num('A1', 1), '<c r="SG1" s="0"/>') + row(2, num('SG2', 1)) },
      ],
    });
    // Column SG is the 501st: a styled empty cell there is fine, a value is not.
    expect(readError(() => readXlsx(wide))).toBe(
      'The sheet has values past column SF: an import takes at most 500 columns.'
    );

    const sparse = workbook({
      sheets: [{ name: 'S', data: row(1, num('A1', 1), num('SF1', 1)) + row(2, num('SF2', 1)) }],
    });
    expect(readXlsx(sparse).rows[1]).toHaveLength(500);
    expect(readError(() => readXlsx(sparse, { maxCells: 999 }))).toBe(
      'The sheet has more than 999 cells.'
    );
  });
});

describe('files that are not workbooks', () => {
  const NOT = 'The file is not a valid Excel workbook (.xlsx).';

  it('refuses text, empty and truncated files', () => {
    expect(readError(() => readXlsx(strToU8('a,b\n1,2')))).toBe(NOT);
    expect(readError(() => readXlsx(new Uint8Array()))).toBe(NOT);
    const good = workbook({ sheets: [{ name: 'S', data: row(1, num('A1', 1)) }] });
    expect(isZipFile(good.subarray(0, 100))).toBe(true);
    expect(readError(() => readXlsx(good.subarray(0, 100)))).toBe(NOT);
  });

  it('refuses a ZIP that is not a workbook, and corrupt entries', () => {
    expect(readError(() => readXlsx(zipSync({ 'readme.txt': strToU8('hi') })))).toBe(NOT);
    const corrupt = workbookWithSheet(new Uint8Array([0xff, 0xff, 0xff, 0xff]), 10);
    expect(readError(() => readXlsx(corrupt))).toBe(NOT);
  });

  it('explains legacy .xls and password-protected files', () => {
    const cfb = new Uint8Array(512);
    cfb.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(readError(() => readXlsx(cfb))).toMatch(/older Excel file \(\.xls\)/);
  });
});
