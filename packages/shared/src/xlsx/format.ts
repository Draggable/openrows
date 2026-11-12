/**
 * Number cells as a sheet shows them, in the shapes the import's type inference reads: dates
 * (serial numbers under a date format) as `YYYY-MM-DD`, with ` HH:MM[:SS]` when the format
 * has a time, percentages as `12.5%`, dollar amounts as `$1234.50`, and fixed decimals as the
 * format gives them. Other formats (General, scientific, fractions) give the plain number.
 * Digit grouping, colours and padding are left out: they don't change the value.
 */

export type CellFormat =
  | { kind: 'general' }
  | { kind: 'fixed'; decimals: number }
  | { kind: 'percent'; decimals: number }
  | { kind: 'currency'; decimals: number }
  | { kind: 'date'; date: boolean; time: boolean; seconds: boolean; elapsed: boolean };

/** The built-in number formats (ECMA-376 §18.8.30) a cell can name by id. */
const BUILT_IN: Record<number, string> = {
  0: 'General',
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  5: '"$"#,##0_);("$"#,##0)',
  6: '"$"#,##0_);[Red]("$"#,##0)',
  7: '"$"#,##0.00_);("$"#,##0.00)',
  8: '"$"#,##0.00_);[Red]("$"#,##0.00)',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  12: '# ?/?',
  13: '# ??/??',
  14: 'm/d/yyyy',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'm/d/yyyy h:mm',
  37: '#,##0 ;(#,##0)',
  38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)',
  40: '#,##0.00;[Red](#,##0.00)',
  41: '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)',
  42: '_("$"* #,##0_);_("$"* (#,##0);_("$"* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)',
  44: '_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  47: 'mm:ss.0',
  48: '##0.0E+0',
  49: '@',
};
// East Asian built-in date formats.
for (const id of [27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58]) {
  BUILT_IN[id] = 'yyyy-mm-dd';
}
for (const id of [32, 33, 55, 56]) BUILT_IN[id] = 'h:mm:ss';

/** The format code of a built-in id (General when unknown). */
export function builtInFormat(id: number): string {
  return BUILT_IN[id] ?? 'General';
}

/** The first section of a format code (positive numbers), splitting on `;` outside quotes. */
function firstSection(code: string): string {
  let quoted = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '\\') i++;
    else if (ch === '"') quoted = !quoted;
    else if (ch === ';' && !quoted) return code.slice(0, i);
  }
  return code;
}

/** Decimal places of a numeric format section: digit placeholders after its point. */
function decimalsOf(section: string): number {
  const m = /\.([0#?]+)/.exec(section);
  return Math.min(m?.[1]?.length ?? 0, 15);
}

/** What kind of value a format code shows. */
export function classifyFormat(code: string): CellFormat {
  let section = firstSection(code);
  let currency = false;
  let elapsed = false;
  // Literal text (quoted or escaped) shows as is: only a dollar sign in it matters.
  section = section.replace(/"([^"]*)"|\\(.)/g, (_, quoted?: string, escaped?: string) => {
    if ((quoted ?? escaped ?? '').includes('$')) currency = true;
    return '';
  });
  // Padding and fill take the next character.
  section = section.replace(/[_*]./g, '');
  // Brackets: colours, conditions, locales ([$€-407]), currency ([$$-409]), elapsed time ([h]).
  section = section.replace(/\[([^\]]*)\]/g, (_, inner: string) => {
    if (/^(h+|m+|s+)$/i.test(inner)) {
      elapsed = true;
      return inner;
    }
    if (inner.startsWith('$') && inner.slice(1).split('-')[0]?.includes('$')) currency = true;
    return '';
  });
  if (section.includes('$')) currency = true;
  section = section.replace(/AM\/PM|A\/P/gi, '');
  if (section.trim() === '' || /^general$/i.test(section.trim())) return { kind: 'general' };
  const lower = section.toLowerCase();
  if (/[dmyhs]/.test(lower) && !/general/.test(lower)) {
    const time = /[hs]/.test(lower);
    const date = /[dy]/.test(lower) || (lower.includes('m') && !time);
    return { kind: 'date', date, time, seconds: lower.includes('s'), elapsed };
  }
  // Scientific notation and fractions: the plain number.
  if (/e[+-]/.test(lower) || /[0#?]\s*\/\s*[0-9#?]/.test(lower)) return { kind: 'general' };
  if (!/[0#?]/.test(section)) return { kind: 'general' };
  const decimals = decimalsOf(section);
  if (section.includes('%')) return { kind: 'percent', decimals };
  if (currency) return { kind: 'currency', decimals };
  return { kind: 'fixed', decimals };
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `toFixed` without a negative zero (`-0.00`). */
function fixed(value: number, decimals: number): string {
  const s = value.toFixed(decimals);
  return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s;
}

/** A number as General shows it: at most 15 significant digits (the sheet's precision). */
export function generalNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return String(Number(value.toPrecision(15)));
}

/** Days from the epoch of the 1900 date system to 9999-12-31: the last date a sheet shows. */
const MAX_SERIAL = 2_958_465;
const DAY_MS = 86_400_000;

/**
 * A date serial as `YYYY-MM-DD`, `YYYY-MM-DD HH:MM[:SS]` or `HH:MM[:SS]`. The 1900 system
 * counts its phantom 29 February 1900 (serial 60) like the sheet does; the 1904 system starts
 * on 1 January 1904.
 */
function dateText(
  serial: number,
  f: Extract<CellFormat, { kind: 'date' }>,
  date1904: boolean
): string | null {
  if (!(serial >= 0 && serial <= MAX_SERIAL)) return null;
  const totalSeconds = Math.round(serial * 86_400);
  const days = Math.floor(totalSeconds / 86_400);
  const secs = totalSeconds - days * 86_400;
  const epoch = date1904
    ? Date.UTC(1904, 0, 1)
    : days < 60
      ? Date.UTC(1899, 11, 31)
      : Date.UTC(1899, 11, 30);
  const d = new Date(epoch + days * DAY_MS);
  const day = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const hours = f.elapsed && !f.date ? Math.floor(totalSeconds / 3600) : Math.floor(secs / 3600);
  const clock = `${pad(hours)}:${pad(Math.floor((secs % 3600) / 60))}${f.seconds ? `:${pad(secs % 60)}` : ''}`;
  if (f.date && f.time) return `${day} ${clock}`;
  if (f.time) return clock;
  return day;
}

/** A number cell's text under its format. */
export function formatNumber(value: number, format: CellFormat, date1904: boolean): string {
  switch (format.kind) {
    case 'general':
      return generalNumber(value);
    case 'fixed':
      return fixed(value, format.decimals);
    case 'percent':
      return `${fixed(value * 100, format.decimals)}%`;
    case 'currency': {
      const text = fixed(Math.abs(value), format.decimals);
      return `${value < 0 && /[1-9]/.test(text) ? '-' : ''}$${text}`;
    }
    case 'date':
      return dateText(value, format, date1904) ?? generalNumber(value);
  }
}

/**
 * An ISO 8601 date cell (`t="d"`) as the same text a date serial gives: the date alone at
 * midnight, else the date and time (the zone dropped, like the sheet shows it).
 */
export function isoDateText(value: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value.trim());
  if (!m) return value;
  const [, day, h = '00', min = '00', s = '00'] = m;
  if (h === '00' && min === '00' && s === '00') return day ?? value;
  return `${day} ${h}:${min}${s !== '00' ? `:${s}` : ''}`;
}
