import { MAX_IMPORT_COLUMNS, MAX_IMPORT_ROWS } from '../csv/index.js';
import {
  builtInFormat,
  type CellFormat,
  classifyFormat,
  formatNumber,
  generalNumber,
  isoDateText,
} from './format.js';
import {
  type InflateBudget,
  inflateEntry,
  NOT_A_WORKBOOK,
  readZipDirectory,
  XlsxReadError,
  type ZipEntry,
} from './zip.js';

export { XlsxReadError } from './zip.js';

/**
 * Excel workbooks (.xlsx, Office Open XML) for import: one sheet's cells as rows of text, the
 * same shape `parseCsv` gives, so the import preview, the type inference and the server's
 * import treat a sheet like a CSV file. Shared, so the client's preview and the server's import
 * read a workbook the same way.
 *
 * Only data is read: cell values (the cached result of a formula, never the formula itself),
 * shared strings, number formats and the workbook's date system. Macros (`vbaProject.bin`),
 * external links, DDE, connections and embedded objects are never opened, and nothing is
 * fetched. The XML is scanned for the few elements it needs; DTDs and entity declarations are
 * not processed (only the predefined entities and character references are decoded), so entity
 * expansion can't happen. Everything inflated counts against `MAX_XLSX_UNPACKED_BYTES`, by
 * the bytes that actually come out, whatever sizes the archive declares.
 */

/** Most bytes the parts of a workbook one read opens may unpack to (a zip bomb stops here). */
export const MAX_XLSX_UNPACKED_BYTES = 200 * 1024 * 1024;
/** Most cells (empty ones between values included) one sheet may hold. */
export const MAX_XLSX_CELLS = 10_000_000;

/** The media type of .xlsx files. */
export const XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface XlsxReadOptions {
  /** The sheet to read, by name: the first one when omitted. */
  sheet?: string | undefined;
  /** Default MAX_XLSX_UNPACKED_BYTES. */
  maxUnpackedBytes?: number;
  /** Most non-empty rows (the header included); default MAX_IMPORT_ROWS + 1. */
  maxRows?: number;
  /** Values past this column are refused; default MAX_IMPORT_COLUMNS. */
  maxColumns?: number;
  /** Default MAX_XLSX_CELLS. */
  maxCells?: number;
}

export interface XlsxSheet {
  /** Every worksheet of the workbook, in tab order. */
  sheets: string[];
  /** The sheet read. */
  sheet: string;
  /**
   * Its rows, top to bottom: cells from column A to the row's last non-empty one. Rows without
   * a value are left out, like blank lines of a CSV file.
   */
  rows: string[][];
}

/** `PK\x03\x04`: a ZIP archive, which every .xlsx file is. */
export function isZipFile(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** An OLE compound file: a legacy .xls, or an .xlsx encrypted with a password. */
function isCompoundFile(bytes: Uint8Array): boolean {
  const magic = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  return magic.every((b, i) => bytes[i] === b);
}

// ---------------------------------------------------------------------------------------------
// XML: just enough to read SpreadsheetML. Tags may carry a namespace prefix (`<x:row>`).

const NAME_PREFIX = '(?:[A-Za-z_][\\w.-]*:)?';
const ENTITY = /&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|(lt|gt|amp|quot|apos));/g;
const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function fromCodePoint(code: number, raw: string): string {
  return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
    ? String.fromCodePoint(code)
    : raw;
}

/** Predefined entities and character references; anything else stays as written. */
function decodeXml(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(ENTITY, (raw, dec?: string, hex?: string, name?: string) => {
    if (dec) return fromCodePoint(Number.parseInt(dec, 10), raw);
    if (hex) return fromCodePoint(Number.parseInt(hex, 16), raw);
    return NAMED[name ?? ''] ?? raw;
  });
}

/** Cell text: entities, then the `_xHHHH_` escapes of ST_Xstring (`_x000D_`: a carriage return). */
function decodeText(text: string): string {
  const decoded = decodeXml(text);
  if (!decoded.includes('_x')) return decoded;
  return decoded.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
}

/** A start tag's attributes by local name (`r:id` → `id`), decoded. */
function attributes(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of tag.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const name = m[1] ?? '';
    const local = name.slice(name.indexOf(':') + 1);
    if (!out.has(local)) out.set(local, decodeXml(m[2] ?? m[3] ?? ''));
  }
  return out;
}

const elementPatterns = new Map<string, RegExp>();

/** Every element `name` of `xml` (start tag and, unless empty, content). */
function* elements(xml: string, name: string): Generator<{ attrs: string; body: string }> {
  let re = elementPatterns.get(name);
  if (!re) {
    re = new RegExp(
      `<${NAME_PREFIX}${name}(?=[\\s/>])([^>]*?)(?:/>|>([\\s\\S]*?)</${NAME_PREFIX}${name}\\s*>)`,
      'g'
    );
    elementPatterns.set(name, re);
  }
  for (const m of xml.matchAll(re)) yield { attrs: m[1] ?? '', body: m[2] ?? '' };
}

const PHONETIC = new RegExp(
  `<${NAME_PREFIX}rPh(?=[\\s/>])[\\s\\S]*?</${NAME_PREFIX}rPh\\s*>|<${NAME_PREFIX}rPh\\b[^>]*/>`,
  'g'
);

/** The text of a string item (`<si>`, `<is>`): its runs joined, phonetic guides left out. */
function stringItem(body: string): string {
  let text = '';
  for (const t of elements(body.replace(PHONETIC, ''), 't')) text += decodeText(t.body);
  return text;
}

/** Most characters a start tag may take while the scanner waits for its `>`. */
const MAX_PENDING_TAG = 1024 * 1024;

/**
 * Finds the elements `name` in XML that arrives in pieces, calling `onElement` with each whole
 * element. Work stays linear in the input: an element's end tag is looked for only in what's
 * new (plus a short overlap), and its pieces are joined once, when it ends.
 */
class ElementScanner {
  private readonly open: RegExp;
  private readonly close: RegExp;
  /** Text before the next element (or a start tag still arriving). */
  private pending = '';
  /** Pieces of the element whose end tag hasn't come. */
  private parts: string[] | null = null;
  /** The end of what was searched for the end tag: a split end tag may start here. */
  private tail = '';

  constructor(
    name: string,
    private readonly onElement: (xml: string) => void
  ) {
    this.open = new RegExp(`<${NAME_PREFIX}${name}(?=[\\s/>])`, 'g');
    this.close = new RegExp(`</${NAME_PREFIX}${name}\\s*>`, 'g');
  }

  push(text: string): void {
    let rest = text;
    if (this.parts) {
      const after = this.inside(rest);
      if (after === null) return;
      rest = after;
    }
    let s = this.pending + rest;
    for (;;) {
      this.open.lastIndex = 0;
      const m = this.open.exec(s);
      if (!m) {
        // Keep a start tag that may be split across pieces.
        const lt = s.lastIndexOf('<');
        this.pending = lt >= 0 && s.length - lt < 256 ? s.slice(lt) : '';
        return;
      }
      const gt = s.indexOf('>', m.index);
      if (gt < 0) {
        this.pending = s.slice(m.index);
        if (this.pending.length > MAX_PENDING_TAG) throw new XlsxReadError(NOT_A_WORKBOOK);
        return;
      }
      if (s[gt - 1] === '/') {
        this.onElement(s.slice(m.index, gt + 1));
        s = s.slice(gt + 1);
        continue;
      }
      this.parts = [s.slice(m.index, gt + 1)];
      this.tail = '';
      const after = this.inside(s.slice(gt + 1));
      if (after === null) {
        this.pending = '';
        return;
      }
      s = after;
    }
  }

  /** Text inside an open element: what follows its end, or null while it goes on. */
  private inside(text: string): string | null {
    const parts = this.parts ?? [];
    const window = this.tail + text;
    this.close.lastIndex = 0;
    const m = this.close.exec(window);
    if (!m) {
      parts.push(text);
      this.tail = window.slice(-256);
      return null;
    }
    const end = m.index + m[0].length - this.tail.length;
    parts.push(text.slice(0, end));
    this.parts = null;
    this.tail = '';
    this.onElement(parts.join(''));
    return text.slice(end);
  }
}

// ---------------------------------------------------------------------------------------------
// The package: relationships, the workbook, styles, shared strings, the sheet.

interface Part {
  read(name: string): string | undefined;
  stream(name: string, onText: (text: string) => void): boolean;
}

function openPackage(bytes: Uint8Array, budget: InflateBudget): Part {
  const entries = readZipDirectory(bytes);
  const lower = new Map<string, ZipEntry>();
  for (const e of entries.values()) lower.set(e.name.toLowerCase(), e);
  const find = (name: string) => entries.get(name) ?? lower.get(name.toLowerCase());
  const stream = (name: string, onText: (text: string) => void) => {
    const entry = find(name);
    if (!entry) return false;
    const decoder = new TextDecoder('utf-8');
    inflateEntry(bytes, entry, budget, (chunk) => {
      const text = decoder.decode(chunk, { stream: true });
      if (text) onText(text);
    });
    const last = decoder.decode();
    if (last) onText(last);
    return true;
  };
  return {
    stream,
    read(name) {
      const pieces: string[] = [];
      return stream(name, (t) => pieces.push(t)) ? pieces.join('') : undefined;
    },
  };
}

/** `target` of a relationship, from the part `from` (`xl/workbook.xml`), as an archive path. */
function resolvePath(from: string, target: string): string {
  const base = target.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') base.pop();
    else if (seg !== '.' && seg !== '') base.push(seg);
  }
  return base.join('/');
}

/** The relationships part of `part` (`xl/_rels/workbook.xml.rels`). */
function relsPath(part: string): string {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

interface Relationship {
  type: string;
  target: string;
}

/** A part's internal relationships by id; external ones (links to other files) are dropped. */
function relationships(pkg: Part, part: string): Map<string, Relationship> {
  const out = new Map<string, Relationship>();
  const xml = pkg.read(relsPath(part));
  if (!xml) return out;
  for (const rel of elements(xml, 'Relationship')) {
    const a = attributes(rel.attrs);
    const id = a.get('Id');
    const target = a.get('Target');
    if (!id || !target || a.get('TargetMode')?.toLowerCase() === 'external') continue;
    out.set(id, { type: a.get('Type') ?? '', target: resolvePath(part, target) });
  }
  return out;
}

const relType = (rel: Relationship, kind: string) => rel.type.endsWith(`/${kind}`);

/** The cell formats (`cellXfs`) by style index. */
function cellFormats(xml: string | undefined): CellFormat[] {
  if (!xml) return [];
  const custom = new Map<number, string>();
  for (const f of elements(xml, 'numFmt')) {
    const a = attributes(f.attrs);
    const id = Number(a.get('numFmtId'));
    if (Number.isInteger(id)) custom.set(id, a.get('formatCode') ?? 'General');
  }
  const xfs = elements(xml, 'cellXfs').next().value;
  if (!xfs) return [];
  const cache = new Map<number, CellFormat>();
  const out: CellFormat[] = [];
  for (const xf of elements(xfs.body, 'xf')) {
    const id = Number(attributes(xf.attrs).get('numFmtId') ?? 0);
    let format = cache.get(id);
    if (!format) {
      format = classifyFormat(custom.get(id) ?? builtInFormat(id));
      cache.set(id, format);
    }
    out.push(format);
  }
  return out;
}

/** "A" → 0, "AB" → 27; -1 when not a column reference. */
function columnIndex(ref: string): number {
  const m = /^([A-Za-z]{1,3})\d*$/.exec(ref);
  if (!m?.[1]) return -1;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** "A", "B", …, "AA": for messages. */
function columnName(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const VALUE = new RegExp(`<${NAME_PREFIX}v(?:\\s[^>]*)?>([^<]*)</${NAME_PREFIX}v\\s*>`);
const INLINE = new RegExp(`<${NAME_PREFIX}is(?:\\s[^>]*)?>([\\s\\S]*?)</${NAME_PREFIX}is\\s*>`);

interface SheetContext {
  strings: string[];
  formats: CellFormat[];
  date1904: boolean;
}

/** A cell's text as the sheet shows it. */
function cellText(attrs: Map<string, string>, body: string, ctx: SheetContext): string {
  const type = attrs.get('t') ?? 'n';
  if (type === 'inlineStr') {
    const is = INLINE.exec(body);
    return is ? stringItem(is[1] ?? '') : '';
  }
  const v = VALUE.exec(body);
  if (!v) return '';
  const raw = decodeText(v[1] ?? '');
  switch (type) {
    case 's':
      return ctx.strings[Number(raw)] ?? '';
    case 'b':
      return raw.trim() === '1' || raw.trim().toLowerCase() === 'true' ? 'TRUE' : 'FALSE';
    case 'd':
      return isoDateText(raw);
    case 'str':
    case 'e':
      return raw;
    default: {
      const n = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(n)) return raw;
      const format = ctx.formats[Number(attrs.get('s') ?? 0)];
      return format ? formatNumber(n, format, ctx.date1904) : generalNumber(n);
    }
  }
}

/** The workbook's worksheets and how to read them. */
interface Workbook {
  sheets: { name: string; path: string }[];
  date1904: boolean;
  stylesPath: string | undefined;
  stringsPath: string | undefined;
}

function readWorkbook(pkg: Part): Workbook {
  const root = relationships(pkg, '');
  const office = [...root.values()].find((r) => relType(r, 'officeDocument'));
  const path = office?.target ?? 'xl/workbook.xml';
  const xml = pkg.read(path);
  if (!xml) throw new XlsxReadError(NOT_A_WORKBOOK);
  const rels = relationships(pkg, path);
  const pr = elements(xml, 'workbookPr').next().value;
  const date1904 = ['1', 'true'].includes(
    attributes(pr?.attrs ?? '')
      .get('date1904')
      ?.toLowerCase() ?? ''
  );
  const sheets: Workbook['sheets'] = [];
  for (const s of elements(xml, 'sheet')) {
    const a = attributes(s.attrs);
    const rel = rels.get(a.get('id') ?? '');
    const name = a.get('name');
    // Chart sheets and dialog or macro sheets hold no cells to import.
    if (name && rel && relType(rel, 'worksheet')) sheets.push({ name, path: rel.target });
  }
  const find = (kind: string) => [...rels.values()].find((r) => relType(r, kind))?.target;
  return { sheets, date1904, stylesPath: find('styles'), stringsPath: find('sharedStrings') };
}

/** The worksheets of a workbook, in tab order. Throws XlsxReadError. */
export function xlsxSheetNames(bytes: Uint8Array, opts: XlsxReadOptions = {}): string[] {
  checkMagic(bytes);
  const limit = opts.maxUnpackedBytes ?? MAX_XLSX_UNPACKED_BYTES;
  return readWorkbook(openPackage(bytes, { left: limit, limit })).sheets.map((s) => s.name);
}

function checkMagic(bytes: Uint8Array) {
  if (isCompoundFile(bytes)) {
    throw new XlsxReadError(
      'This is an older Excel file (.xls) or a password-protected workbook. Save it as .xlsx without a password, or as CSV, and import that.'
    );
  }
  if (!isZipFile(bytes)) throw new XlsxReadError(NOT_A_WORKBOOK);
}

/**
 * Reads one sheet of an .xlsx workbook (`opts.sheet`, else the first) as rows of text. Throws
 * XlsxReadError, with a message for the person importing, for a file that isn't a workbook,
 * an unknown sheet, or one past the limits (unpacked bytes, rows, columns, cells).
 */
export function readXlsx(bytes: Uint8Array, opts: XlsxReadOptions = {}): XlsxSheet {
  checkMagic(bytes);
  const limit = opts.maxUnpackedBytes ?? MAX_XLSX_UNPACKED_BYTES;
  const maxRows = opts.maxRows ?? MAX_IMPORT_ROWS + 1;
  const maxColumns = opts.maxColumns ?? MAX_IMPORT_COLUMNS;
  const maxCells = opts.maxCells ?? MAX_XLSX_CELLS;
  const pkg = openPackage(bytes, { left: limit, limit });
  const book = readWorkbook(pkg);
  if (book.sheets.length === 0) throw new XlsxReadError('The workbook has no sheets.');
  const chosen =
    opts.sheet === undefined ? book.sheets[0] : book.sheets.find((s) => s.name === opts.sheet);
  if (!chosen) throw new XlsxReadError(`The workbook has no sheet named "${opts.sheet}".`);

  const strings: string[] = [];
  if (book.stringsPath) {
    const scanner = new ElementScanner('si', (si) => {
      const body = /^<[^>]*\/>$/.test(si) ? '' : si.slice(si.indexOf('>') + 1);
      strings.push(stringItem(body));
    });
    pkg.stream(book.stringsPath, (t) => scanner.push(t));
  }
  const ctx: SheetContext = {
    strings,
    formats: cellFormats(book.stylesPath ? pkg.read(book.stylesPath) : undefined),
    date1904: book.date1904,
  };

  const rows: string[][] = [];
  let cells = 0;
  const scanner = new ElementScanner('row', (rowXml) => {
    const row: string[] = [];
    let col = -1;
    for (const c of elements(rowXml, 'c')) {
      const attrs = attributes(c.attrs);
      const ref = attrs.get('r');
      const at = ref === undefined ? col + 1 : columnIndex(ref);
      col = at < 0 ? col + 1 : at;
      const text = cellText(attrs, c.body, ctx);
      if (text === '') continue;
      if (col >= maxColumns) {
        throw new XlsxReadError(
          `The sheet has values past column ${columnName(maxColumns - 1)}: an import takes at most ${maxColumns} columns.`
        );
      }
      while (row.length < col) row.push('');
      row[col] = text;
    }
    if (row.length === 0) return;
    cells += row.length;
    if (rows.length >= maxRows) {
      throw new XlsxReadError(
        `The sheet has more than ${(maxRows - 1).toLocaleString('en-US')} rows.`
      );
    }
    if (cells > maxCells) {
      throw new XlsxReadError(`The sheet has more than ${maxCells.toLocaleString('en-US')} cells.`);
    }
    rows.push(row);
  });
  if (!pkg.stream(chosen.path, (t) => scanner.push(t))) throw new XlsxReadError(NOT_A_WORKBOOK);
  return { sheets: book.sheets.map((s) => s.name), sheet: chosen.name, rows };
}
