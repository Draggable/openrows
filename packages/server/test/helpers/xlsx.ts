import { constants, crc32, deflateRawSync } from 'node:zlib';

/**
 * Small .xlsx workbooks for tests, written as Excel lays them out: inline strings, numbers,
 * booleans and dates (a serial number under the built-in date format), one part per sheet.
 */

export type XlsxCell = string | number | boolean | Date | null;

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';

const escapeXml = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const column = (i: number) => {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

/** Days since 1899-12-30: the 1900 date system's serial of a date after February 1900. */
const serial = (d: Date) => (d.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000;

function cell(ref: string, v: XlsxCell): string {
  if (v === null) return '';
  if (typeof v === 'string') {
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(v)}</t></is></c>`;
  }
  if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
  if (v instanceof Date) return `<c r="${ref}" s="1"><v>${serial(v)}</v></c>`;
  return `<c r="${ref}"><v>${v}</v></c>`;
}

function sheetXml(rows: XlsxCell[][]): string {
  const data = rows
    .map(
      (r, i) =>
        `<row r="${i + 1}">${r.map((v, j) => cell(`${column(j)}${i + 1}`, v)).join('')}</row>`
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}"><sheetData>${data}</sheetData></worksheet>`;
}

/** The parts of a workbook with `sheets` (name → rows), in order. */
export function xlsxParts(sheets: Record<string, XlsxCell[][]>): Record<string, Buffer> {
  const names = Object.keys(sheets);
  const parts: Record<string, string> = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    '_rels/.rels': `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>${names
      .map((n, i) => `<sheet name="${escapeXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${PKG}">${names
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
      )
      .join('')}<Relationship Id="rIdS" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `<styleSheet xmlns="${NS}"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>`,
  };
  names.forEach((n, i) => {
    parts[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(sheets[n] ?? []);
  });
  return Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Buffer.from(v)]));
}

/** A ZIP archive of deflated entries; `declaredSize` overrides the size an entry claims. */
export function zipArchive(
  entries: { name: string; data: Buffer; deflated?: Buffer; declaredSize?: number }[]
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const body = e.deflated ?? deflateRawSync(e.data);
    const crc = e.deflated ? 0 : crc32(e.data);
    const size = e.declaredSize ?? e.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A workbook with `sheets` (name → rows), base64-encoded as the import API takes it. */
export function xlsxBase64(sheets: Record<string, XlsxCell[][]>): string {
  const parts = xlsxParts(sheets);
  return zipArchive(Object.entries(parts).map(([name, data]) => ({ name, data }))).toString(
    'base64'
  );
}

/**
 * A zip bomb: a one-sheet workbook whose sheet claims 1 KB but inflates to `megabytes` MB of
 * spaces. The deflate stream repeats one fully flushed 1 MB block, so it is built (and sent)
 * in a few hundred kilobytes without ever holding the inflated sheet.
 */
export function xlsxBombBase64(megabytes: number): string {
  const block = deflateRawSync(Buffer.alloc(1024 * 1024, 0x20), {
    finishFlush: constants.Z_FULL_FLUSH,
  });
  // The final, empty block that ends the stream.
  const deflated = Buffer.concat([...Array<Buffer>(megabytes).fill(block), Buffer.from([3, 0])]);
  const parts = xlsxParts({ Bomb: [] });
  return zipArchive(
    Object.entries(parts).map(([name, data]) =>
      name === 'xl/worksheets/sheet1.xml'
        ? { name, data, deflated, declaredSize: 1024 }
        : { name, data }
    )
  ).toString('base64');
}
