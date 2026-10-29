import { RE2JS } from 're2js';
import { isValidTimeZone } from '../../fields/datetime.js';
import type { FunctionImpl } from './env.js';
import {
  checkText,
  FormulaDate,
  type FormulaValue,
  fail,
  requireDate,
  toDate,
  toInteger,
  toNumber,
  toText,
} from './values.js';

/**
 * Date functions. Instants are UTC ms; the date parts, units of a calendar (days, months...)
 * and formats read them in the date's time zone (`SET_TIMEZONE`, UTC by default, as in Airtable)
 * and its locale (`SET_LOCALE`, `en` by default). Format tokens follow moment.js, which
 * Airtable's DATETIME_FORMAT and DATETIME_PARSE use.
 */

const DAY_MS = 86_400_000;
/** 0001-01-01 and the end of 9999, the range dates keep. */
const MIN_MS = -62_135_596_800_000;
const MAX_MS = 253_402_300_799_999;

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/** Offset of `tz` at instant `ms`, in ms (east positive). */
function offsetMs(ms: number, tz: string): number {
  if (tz === 'UTC') return 0;
  let f = offsetFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      era: 'short',
    });
    offsetFormatters.set(tz, f);
  }
  const parts = f.formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const era = parts.find((p) => p.type === 'era')?.value;
  const year = era === 'BC' || era === 'B' ? 1 - get('year') : get('year');
  const wall = new Date(0);
  wall.setUTCFullYear(year, get('month') - 1, get('day'));
  wall.setUTCHours(get('hour'), get('minute'), get('second'), 0);
  return wall.getTime() - (ms - (((ms % 1000) + 1000) % 1000));
}

const zoneOf = (d: FormulaDate) => d.timeZone ?? 'UTC';

/** The wall clock of `d` in its zone, as a UTC-based `Date` (read with getUTC*). */
function wall(d: FormulaDate): Date {
  return new Date(d.ms + offsetMs(d.ms, zoneOf(d)));
}

/** The instant of a wall-clock time (as UTC ms) in `tz`: gaps resolve forward. */
function fromWall(wallMs: number, tz: string): number {
  const guess = wallMs - offsetMs(wallMs, tz);
  return wallMs - offsetMs(guess, tz);
}

function checkMs(ms: number): number {
  if (!Number.isFinite(ms) || ms < MIN_MS || ms > MAX_MS) fail('The date is out of range');
  return ms;
}

type Unit = 'ms' | 's' | 'm' | 'h' | 'd' | 'w' | 'M' | 'Q' | 'y';

const UNIT_NAMES: Record<string, Unit> = {
  milliseconds: 'ms',
  millisecond: 'ms',
  ms: 'ms',
  seconds: 's',
  second: 's',
  s: 's',
  minutes: 'm',
  minute: 'm',
  m: 'm',
  hours: 'h',
  hour: 'h',
  h: 'h',
  days: 'd',
  day: 'd',
  d: 'd',
  weeks: 'w',
  week: 'w',
  w: 'w',
  months: 'M',
  month: 'M',
  M: 'M',
  quarters: 'Q',
  quarter: 'Q',
  Q: 'Q',
  years: 'y',
  year: 'y',
  y: 'y',
};

/** A unit name (short ones case-sensitive: `M` months, `m` minutes). */
function unitOf(v: FormulaValue | undefined, fallback: Unit): Unit {
  if (v === undefined || v === null || v === '') return fallback;
  const name = toText(v).trim();
  const unit = Object.hasOwn(UNIT_NAMES, name)
    ? UNIT_NAMES[name]
    : name.length > 2 && Object.hasOwn(UNIT_NAMES, name.toLowerCase())
      ? UNIT_NAMES[name.toLowerCase()]
      : undefined;
  return unit ?? fail(`"${name.slice(0, 30)}" is not a date unit`);
}

const FIXED: Partial<Record<Unit, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

/** Adds `count` units: fixed units to the instant, calendar units to the wall clock. */
function addUnits(d: FormulaDate, count: number, unit: Unit): FormulaDate {
  const fixed = FIXED[unit];
  if (fixed !== undefined) return d.with({ ms: checkMs(d.ms + count * fixed), dateOnly: false });
  const w = wall(d);
  if (unit === 'd' || unit === 'w') {
    w.setUTCDate(w.getUTCDate() + Math.trunc(count) * (unit === 'w' ? 7 : 1));
  } else {
    const months = Math.trunc(count) * (unit === 'y' ? 12 : unit === 'Q' ? 3 : 1);
    const day = w.getUTCDate();
    w.setUTCDate(1);
    w.setUTCMonth(w.getUTCMonth() + months);
    // Clamp to the end of the month (Jan 31 + 1 month = Feb 28), as moment does.
    const last = new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth() + 1, 0)).getUTCDate();
    w.setUTCDate(Math.min(day, last));
  }
  return d.with({ ms: checkMs(fromWall(w.getTime(), zoneOf(d))) });
}

/** Whole months from `b` to `a` (moment's monthDiff, truncated toward zero). */
function monthDiff(a: FormulaDate, b: FormulaDate): number {
  const wa = wall(a);
  const wb = wall(b);
  const sign = a.ms >= b.ms ? 1 : -1;
  const [hi, lo] = sign > 0 ? [wa, wb] : [wb, wa];
  let months =
    (hi.getUTCFullYear() - lo.getUTCFullYear()) * 12 + (hi.getUTCMonth() - lo.getUTCMonth());
  const anchor = new Date(lo.getTime());
  const day = anchor.getUTCDate();
  anchor.setUTCDate(1);
  anchor.setUTCMonth(anchor.getUTCMonth() + months);
  const last = new Date(
    Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0)
  ).getUTCDate();
  anchor.setUTCDate(Math.min(day, last));
  if (anchor.getTime() > hi.getTime()) months -= 1;
  return sign * months;
}

/** `a - b` in whole units, truncated toward zero. */
function diff(a: FormulaDate, b: FormulaDate, unit: Unit): number {
  const fixed = FIXED[unit];
  if (fixed !== undefined) return Math.trunc((a.ms - b.ms) / fixed);
  if (unit === 'd' || unit === 'w') {
    // Calendar days in the zone (a DST day is still one day).
    const days = (wall(a).getTime() - wall(b).getTime()) / DAY_MS;
    return Math.trunc(unit === 'w' ? days / 7 : days);
  }
  const months = monthDiff(a, b);
  return Math.trunc(unit === 'y' ? months / 12 : unit === 'Q' ? months / 3 : months);
}

/** The start of the unit containing `d`, as its wall clock ms (for IS_SAME). */
function startOf(d: FormulaDate, unit: Unit): number {
  const w = wall(d);
  const y = w.getUTCFullYear();
  const mo = w.getUTCMonth();
  switch (unit) {
    case 'ms':
      return w.getTime();
    case 's':
      return w.getTime() - w.getUTCMilliseconds();
    case 'm':
      return Date.UTC(y, mo, w.getUTCDate(), w.getUTCHours(), w.getUTCMinutes());
    case 'h':
      return Date.UTC(y, mo, w.getUTCDate(), w.getUTCHours());
    case 'd':
      return Date.UTC(y, mo, w.getUTCDate());
    case 'w':
      return Date.UTC(y, mo, w.getUTCDate() - w.getUTCDay());
    case 'M':
      return Date.UTC(y, mo, 1);
    case 'Q':
      return Date.UTC(y, mo - (mo % 3), 1);
    case 'y':
      return Date.UTC(y, 0, 1);
  }
}

const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, '0');

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

const nameFormatters = new Map<string, Intl.DateTimeFormat>();

function name(ms: number, locale: string, part: 'month' | 'weekday', style: 'long' | 'short') {
  const key = `${locale}|${part}|${style}`;
  let f = nameFormatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', [part]: style });
    nameFormatters.set(key, f);
  }
  return f.format(new Date(ms));
}

/** ISO week number and its year of a wall-clock date. */
function isoWeek(w: Date): { week: number; year: number } {
  const t = new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return {
    week: Math.ceil(((t.getTime() - yearStart) / DAY_MS + 1) / 7),
    year: t.getUTCFullYear(),
  };
}

function offsetText(offset: number, colon: boolean): string {
  const minutes = Math.round(offset / 60_000);
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}${colon ? ':' : ''}${pad(abs % 60)}`;
}

const LONG_FORMATS: Record<string, string> = {
  LTS: 'h:mm:ss A',
  LT: 'h:mm A',
  L: 'MM/DD/YYYY',
  l: 'M/D/YYYY',
  LL: 'MMMM D, YYYY',
  ll: 'MMM D, YYYY',
  LLL: 'MMMM D, YYYY h:mm A',
  lll: 'MMM D, YYYY h:mm A',
  LLLL: 'dddd, MMMM D, YYYY h:mm A',
  llll: 'ddd, MMM D, YYYY h:mm A',
};

const TOKEN_RE =
  /\[[^\]]*\]|YYYY|YY|Qo|Q|MMMM|MMM|MM|Mo|M|DDDD|DDD|DD|Do|D|dddd|ddd|dd|do|d|E|e|WW|Wo|W|ww|w|HH|H|hh|h|kk|k|mm|m|ss|s|SSS|SS|S|A|a|ZZ|Z|X|x|LTS|LT|LLLL|LLL|LL|L|llll|lll|ll|l/g;

/** Formats a date with moment.js tokens (`[...]` is literal). */
export function formatMoment(d: FormulaDate, format: string): string {
  const expanded = format.replace(/\[[^\]]*\]|LTS|LT|LLLL|LLL|LL|L|llll|lll|ll|l/g, (t) =>
    t.startsWith('[') ? t : (LONG_FORMATS[t] ?? t)
  );
  const offset = offsetMs(d.ms, zoneOf(d));
  const w = new Date(d.ms + offset);
  const locale = d.locale ?? 'en';
  const y = w.getUTCFullYear();
  const mo = w.getUTCMonth() + 1;
  const day = w.getUTCDate();
  const h = w.getUTCHours();
  const dow = w.getUTCDay();
  const doy = Math.floor((Date.UTC(y, mo - 1, day) - Date.UTC(y, 0, 1)) / DAY_MS) + 1;
  const iso = isoWeek(w);
  const week = Math.floor((doy - 1 + new Date(Date.UTC(y, 0, 1)).getUTCDay()) / 7) + 1;
  const tokens: Record<string, () => string> = {
    YYYY: () => (y < 0 ? '-' : '') + pad(y, 4),
    YY: () => pad(y % 100),
    Q: () => String(Math.floor((mo - 1) / 3) + 1),
    Qo: () => ordinal(Math.floor((mo - 1) / 3) + 1),
    M: () => String(mo),
    Mo: () => ordinal(mo),
    MM: () => pad(mo),
    MMM: () => name(w.getTime(), locale, 'month', 'short'),
    MMMM: () => name(w.getTime(), locale, 'month', 'long'),
    D: () => String(day),
    Do: () => ordinal(day),
    DD: () => pad(day),
    DDD: () => String(doy),
    DDDD: () => pad(doy, 3),
    d: () => String(dow),
    do: () => ordinal(dow),
    dd: () => name(w.getTime(), locale, 'weekday', 'short').slice(0, 2),
    ddd: () => name(w.getTime(), locale, 'weekday', 'short'),
    dddd: () => name(w.getTime(), locale, 'weekday', 'long'),
    e: () => String(dow),
    E: () => String(dow || 7),
    w: () => String(week),
    ww: () => pad(week),
    W: () => String(iso.week),
    Wo: () => ordinal(iso.week),
    WW: () => pad(iso.week),
    H: () => String(h),
    HH: () => pad(h),
    h: () => String(h % 12 || 12),
    hh: () => pad(h % 12 || 12),
    k: () => String(h || 24),
    kk: () => pad(h || 24),
    m: () => String(w.getUTCMinutes()),
    mm: () => pad(w.getUTCMinutes()),
    s: () => String(w.getUTCSeconds()),
    ss: () => pad(w.getUTCSeconds()),
    S: () => String(Math.floor(w.getUTCMilliseconds() / 100)),
    SS: () => pad(Math.floor(w.getUTCMilliseconds() / 10)),
    SSS: () => pad(w.getUTCMilliseconds(), 3),
    A: () => (h < 12 ? 'AM' : 'PM'),
    a: () => (h < 12 ? 'am' : 'pm'),
    Z: () => offsetText(offset, true),
    ZZ: () => offsetText(offset, false),
    X: () => String(Math.floor(d.ms / 1000)),
    x: () => String(d.ms),
  };
  return checkText(
    expanded.replace(TOKEN_RE, (t) => (t.startsWith('[') ? t.slice(1, -1) : (tokens[t]?.() ?? t)))
  );
}

/** Airtable's default DATETIME_FORMAT: ISO 8601 with milliseconds. */
const DEFAULT_FORMAT = 'YYYY-MM-DDTHH:mm:ss.SSSZ';

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

const PARSE_TOKEN_RE =
  /\[[^\]]*\]|YYYY|YY|MMMM|MMM|MM|M|DD|Do|D|dddd|ddd|HH|H|hh|h|mm|m|ss|s|SSS|A|a|ZZ|Z|X|x/g;

const PARSE_PATTERNS: Record<string, string> = {
  YYYY: '(\\d{4})',
  YY: '(\\d{2})',
  MMMM: '([A-Za-z]+)',
  MMM: '([A-Za-z]{3})',
  MM: '(\\d{2})',
  M: '(\\d{1,2})',
  DD: '(\\d{2})',
  Do: '(\\d{1,2})(?:st|nd|rd|th)',
  D: '(\\d{1,2})',
  dddd: '[A-Za-z]+',
  ddd: '[A-Za-z]{3}',
  HH: '(\\d{2})',
  H: '(\\d{1,2})',
  hh: '(\\d{2})',
  h: '(\\d{1,2})',
  mm: '(\\d{2})',
  m: '(\\d{1,2})',
  ss: '(\\d{2})',
  s: '(\\d{1,2})',
  SSS: '(\\d{1,3})',
  A: '([AaPp][Mm])',
  a: '([AaPp][Mm])',
  ZZ: '([+-]\\d{2}\\d{2}|Z)',
  Z: '([+-]\\d{2}:?\\d{2}|Z)',
  X: '(-?\\d{1,12})',
  x: '(-?\\d{1,15})',
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Reads a date with moment.js tokens (the subset above; day and month names in English).
 * The pattern is built from the format's tokens and escaped literals and runs on RE2 (linear
 * time). Without an offset in the text, the wall clock is in `tz`.
 */
export function parseMoment(text: string, format: string, tz: string): number | null {
  const tokens: string[] = [];
  let source = '';
  let last = 0;
  for (const m of format.matchAll(PARSE_TOKEN_RE)) {
    source += escapeRe(format.slice(last, m.index)).replace(/\s+/g, '\\s+');
    const t = m[0];
    if (t.startsWith('[')) {
      source += escapeRe(t.slice(1, -1));
    } else {
      const pattern = PARSE_PATTERNS[t] ?? escapeRe(t);
      source += pattern;
      if (pattern.startsWith('(')) tokens.push(t);
    }
    last = m.index + t.length;
  }
  source += escapeRe(format.slice(last)).replace(/\s+/g, '\\s+');
  const matcher = RE2JS.compile(`^\\s*${source}\\s*$`).matcher(text);
  if (!matcher.matches()) return null;
  const match = tokens.map((_, i) => matcher.group(i + 1));
  let y = 1970;
  let mo = 1;
  let d = 1;
  let h = 0;
  let mi = 0;
  let s = 0;
  let ms = 0;
  let pm: boolean | null = null;
  let offset: number | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const v = match[i] ?? '';
    const n = Number(v);
    switch (tokens[i]) {
      case 'YYYY':
        y = n;
        break;
      case 'YY':
        y = n + (n > 68 ? 1900 : 2000);
        break;
      case 'MMMM':
      case 'MMM': {
        const index = MONTH_NAMES.findIndex((name) => name.startsWith(v.toLowerCase()));
        if (index < 0 || v.length < 3) return null;
        mo = index + 1;
        break;
      }
      case 'MM':
      case 'M':
        mo = n;
        break;
      case 'DD':
      case 'D':
      case 'Do':
        d = n;
        break;
      case 'HH':
      case 'H':
      case 'hh':
      case 'h':
        h = n;
        break;
      case 'mm':
      case 'm':
        mi = n;
        break;
      case 'ss':
      case 's':
        s = n;
        break;
      case 'SSS':
        ms = Number(v.padEnd(3, '0'));
        break;
      case 'A':
      case 'a':
        pm = v.toLowerCase() === 'pm';
        break;
      case 'Z':
      case 'ZZ': {
        if (v === 'Z') {
          offset = 0;
          break;
        }
        const om = /^([+-])(\d{2}):?(\d{2})$/.exec(v);
        if (!om) return null;
        offset = (om[1] === '-' ? -1 : 1) * (Number(om[2]) * 60 + Number(om[3])) * 60_000;
        break;
      }
      case 'X':
        return n * 1000;
      case 'x':
        return n;
    }
  }
  if (pm !== null) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (pm ? 12 : 0);
  }
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null;
  const last2 = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d > last2) return null;
  const wallTime = new Date(0);
  wallTime.setUTCFullYear(y, mo - 1, d);
  wallTime.setUTCHours(h, mi, s, ms);
  return offset === null ? fromWall(wallTime.getTime(), tz) : wallTime.getTime() - offset;
}

const date = (v: FormulaValue | undefined) => toDate(v ?? null);

/** A date function of one present date, blank for a blank date. */
const part =
  (read: (w: Date) => number): FunctionImpl =>
  ([v]) => {
    const d = date(v);
    return d === null ? null : read(wall(d));
  };

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function startDay(v: FormulaValue | undefined): number {
  if (v === undefined || v === null || v === '') return 0;
  const name = toText(v).trim().toLowerCase();
  const index = WEEKDAYS.indexOf(name);
  if (index !== 0 && index !== 1) fail('The week starts on "Sunday" or "Monday"');
  return index;
}

/** Holiday days (wall-clock day numbers since the epoch) from `"2026-12-25, 2026-12-26"`. */
function holidays(v: FormulaValue | undefined): Set<number> {
  const out = new Set<number>();
  if (v === undefined || v === null) return out;
  const items = Array.isArray(v) ? v : toText(v).split(',');
  if (items.length > 1000) fail('Too many holidays');
  for (const item of items) {
    if (item === null || item === '') continue;
    if (typeof item === 'string' && item.trim() === '') continue;
    const d = requireDate(typeof item === 'string' ? item.trim() : item);
    out.add(Math.floor(wall(d).getTime() / DAY_MS));
  }
  return out;
}

const isWeekend = (dayNumber: number) => {
  const dow = (((dayNumber + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday
  return dow === 0 || dow === 6;
};

/** Most working days WORKDAY may move. */
const MAX_WORKDAYS = 100_000;

export const DATE_FUNCTIONS: Record<string, FunctionImpl> = {
  NOW: (_, env) => new FormulaDate(env.now),
  TODAY: (_, env) => new FormulaDate(Math.floor(env.now / DAY_MS) * DAY_MS, true),
  CREATED_TIME: (_, env) => (env.createdTime === null ? null : new FormulaDate(env.createdTime)),
  LAST_MODIFIED_TIME: (_, env) =>
    env.lastModifiedTime === null ? null : new FormulaDate(env.lastModifiedTime),
  RECORD_ID: (_, env) => env.recordId ?? '',
  DATEADD: ([v, count, unit]) => {
    const d = date(v);
    if (d === null) return null;
    return addUnits(d, toNumber(count ?? null), unitOf(unit, 'd'));
  },
  DATETIME_DIFF: ([a, b, unit]) => {
    const x = date(a);
    const y = date(b);
    if (x === null || y === null) return null;
    return diff(x, y, unitOf(unit, 's'));
  },
  DATETIME_FORMAT: ([v, format]) => {
    const d = date(v);
    if (d === null) return null;
    const f = format === undefined || format === null ? DEFAULT_FORMAT : toText(format);
    if (f.length > 200) fail('The format is too long');
    return formatMoment(d, f === '' ? DEFAULT_FORMAT : f);
  },
  DATETIME_PARSE: ([text, format, locale]) => {
    if (text instanceof FormulaDate) return text;
    const t = toText(text ?? null).trim();
    if (t === '') return null;
    if (format === undefined || format === null || format === '') return requireDate(t);
    const f = toText(format);
    if (f.length > 200) fail('The format is too long');
    const ms = parseMoment(t, f, 'UTC');
    if (ms === null) fail(`"${t.slice(0, 50)}" doesn't match the format "${f.slice(0, 50)}"`);
    const result = new FormulaDate(checkMs(ms));
    return locale === undefined || locale === null ? result : setLocale(result, locale);
  },
  DATESTR: ([v]) => {
    const d = date(v);
    return d === null ? null : formatMoment(d, 'YYYY-MM-DD');
  },
  TIMESTR: ([v]) => {
    const d = date(v);
    return d === null ? null : formatMoment(d, 'HH:mm:ss');
  },
  DAY: part((w) => w.getUTCDate()),
  MONTH: part((w) => w.getUTCMonth() + 1),
  YEAR: part((w) => w.getUTCFullYear()),
  HOUR: part((w) => w.getUTCHours()),
  MINUTE: part((w) => w.getUTCMinutes()),
  SECOND: part((w) => w.getUTCSeconds()),
  WEEKDAY: ([v, start]) => {
    const d = date(v);
    if (d === null) return null;
    return (wall(d).getUTCDay() - startDay(start) + 7) % 7;
  },
  WEEKNUM: ([v, start]) => {
    const d = date(v);
    if (d === null) return null;
    // Week 1 contains January 1 (spreadsheet WEEKNUM), weeks starting Sunday or Monday.
    const w = wall(d);
    const jan1 = Date.UTC(w.getUTCFullYear(), 0, 1);
    const doy = Math.floor(
      (Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()) - jan1) / DAY_MS
    );
    const jan1Dow = (new Date(jan1).getUTCDay() - startDay(start) + 7) % 7;
    return Math.floor((doy + jan1Dow) / 7) + 1;
  },
  WORKDAY: ([v, count, holidayList], env) => {
    const d = date(v);
    if (d === null) return null;
    const n = toInteger(count ?? null);
    if (Math.abs(n) > MAX_WORKDAYS) fail('Too many working days');
    const skip = holidays(holidayList);
    const w = wall(d);
    let day = Math.floor(w.getTime() / DAY_MS);
    const step = n < 0 ? -1 : 1;
    for (let left = Math.abs(n); left > 0; ) {
      day += step;
      env.step();
      if (!isWeekend(day) && !skip.has(day)) left -= 1;
    }
    return new FormulaDate(day * DAY_MS, true, d.timeZone, d.locale);
  },
  WORKDAY_DIFF: ([a, b, holidayList]) => {
    const x = date(a);
    const y = date(b);
    if (x === null || y === null) return null;
    const skip = holidays(holidayList);
    const from = Math.floor(wall(x).getTime() / DAY_MS);
    const to = Math.floor(wall(y).getTime() / DAY_MS);
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    // Working days in [lo, hi], both ends included (NETWORKDAYS).
    const total = hi - lo + 1;
    const weeks = Math.floor(total / 7);
    let count = weeks * 5;
    for (let day = lo + weeks * 7; day <= hi; day++) if (!isWeekend(day)) count += 1;
    for (const h of skip) if (h >= lo && h <= hi && !isWeekend(h)) count -= 1;
    return from <= to ? count : -count;
  },
  SET_TIMEZONE: ([v, tz]) => {
    const d = date(v);
    if (d === null) return null;
    const zone = toText(tz ?? null).trim();
    if (!isValidTimeZone(zone)) fail(`"${zone.slice(0, 50)}" is not a time zone`);
    return d.with({ timeZone: zone, dateOnly: false });
  },
  SET_LOCALE: ([v, locale]) => {
    const d = date(v);
    return d === null ? null : setLocale(d, locale ?? null);
  },
  IS_BEFORE: ([a, b]) => {
    const x = date(a);
    const y = date(b);
    return x !== null && y !== null && x.ms < y.ms;
  },
  IS_AFTER: ([a, b]) => {
    const x = date(a);
    const y = date(b);
    return x !== null && y !== null && x.ms > y.ms;
  },
  IS_SAME: ([a, b, unit]) => {
    const x = date(a);
    const y = date(b);
    if (x === null || y === null) return false;
    if (unit === undefined || unit === null || unit === '') return x.ms === y.ms;
    const u = unitOf(unit, 'ms');
    return startOf(x, u) === startOf(y.with({ timeZone: zoneOf(x) }), u);
  },
  TONOW: ([v, unit], env) => {
    const d = date(v);
    return d === null ? null : diff(new FormulaDate(env.now), d, unitOf(unit, 'd'));
  },
  FROMNOW: ([v, unit], env) => {
    const d = date(v);
    return d === null ? null : diff(d, new FormulaDate(env.now), unitOf(unit, 'd'));
  },
};

function setLocale(d: FormulaDate, locale: FormulaValue): FormulaDate {
  const tag = toText(locale).trim();
  let supported: string[] = [];
  try {
    supported = Intl.DateTimeFormat.supportedLocalesOf(tag);
  } catch {
    supported = [];
  }
  if (tag === '' || supported.length === 0) fail(`"${tag.slice(0, 30)}" is not a locale`);
  return d.with({ locale: supported[0] });
}
