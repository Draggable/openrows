import { z } from 'zod';
import { DEFAULT_LOCALE } from './util.js';

// Date and time helpers for the date, dateTime, createdTime and lastModifiedTime types. Dates are
// `YYYY-MM-DD` strings (a calendar day, no zone); datetimes are UTC ISO strings with milliseconds
// (`2026-10-25T09:30:00.000Z`). Time zones are IANA names, resolved with Intl only.

export const DATE_FORMATS = ['local', 'friendly', 'us', 'european', 'iso'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export const TIME_FORMATS = ['12h', '24h'] as const;
export type TimeFormat = (typeof TIME_FORMATS)[number];

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, 'Unknown time zone');

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** A real calendar day between years 1 and 9999 as `YYYY-MM-DD`, or `null`. */
export function makeDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || year < 1 || year > 9999) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  const last = new Date(Date.UTC(2000, month, 0)).getUTCDate();
  const daysInMonth =
    month === 2 && !(year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 28 : last;
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth) return null;
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

export function isValidDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  return !!m && makeDate(Number(m[1]), Number(m[2]), Number(m[3])) === value;
}

const MIN_INSTANT = wallMs(1, 1, 1, 0, 0, 0, 0);
const MAX_INSTANT = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

function instantFromMs(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < MIN_INSTANT || ms > MAX_INSTANT) return null;
  return new Date(ms).toISOString();
}

export function isValidInstant(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    instantFromMs(Date.parse(value)) === value
  );
}

/** Offset of `tz` from UTC at instant `ms`, in minutes (east positive). */
export function zoneOffset(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    era: 'short',
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const era = parts.find((p) => p.type === 'era')?.value;
  const year = era === 'BC' || era === 'B' ? 1 - get('year') : get('year');
  const wall = new Date(0);
  wall.setUTCFullYear(year, get('month') - 1, get('day'));
  wall.setUTCHours(get('hour'), get('minute'), get('second'), 0);
  return Math.round((wall.getTime() - (ms - (((ms % 1000) + 1000) % 1000))) / 60_000);
}

/**
 * UTC ms of a wall-clock time in `tz` (DST gaps resolve forward, overlaps to the earlier).
 * `wallMs` is the wall time read as if it were UTC.
 */
export function wallToUtc(wallMs: number, tz: string): number {
  // The offsets a day either side: they differ only next to a DST change.
  const before = zoneOffset(wallMs - 86_400_000, tz);
  const after = zoneOffset(wallMs + 86_400_000, tz);
  const valid = [Math.max(before, after), Math.min(before, after)]
    .map((offset) => wallMs - offset * 60_000)
    .filter((utc) => utc + zoneOffset(utc, tz) * 60_000 === wallMs);
  // Both read back in an overlap (the earlier instant first); none in a gap, where the
  // offset before the change moves the time forward by the gap.
  return valid[0] ?? wallMs - before * 60_000;
}

function wallMs(y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number) {
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  t.setUTCHours(h, mi, s, ms);
  return t.getTime();
}

const DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/**
 * Parses a datetime string into a UTC ISO instant. With `Z` or an offset it is exact; without one
 * it is a wall-clock time in `tz` (a bare date is midnight there). Anything else is `null`.
 */
export function parseInstant(text: string, tz: string): string | null {
  const m = DATETIME_RE.exec(text.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!makeDate(y, mo, d)) return null;
  const h = Number(m[4] ?? 0);
  const mi = Number(m[5] ?? 0);
  const s = Number(m[6] ?? 0);
  if (h > 23 || mi > 59 || s > 59) return null;
  const ms = Number(`${m[7] ?? ''}000`.slice(0, 3));
  const wall = wallMs(y, mo, d, h, mi, s, ms);
  const zone = m[8];
  if (!zone) return instantFromMs(wallToUtc(wall, tz));
  if (zone.toUpperCase() === 'Z') return instantFromMs(wall);
  const om = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone);
  if (!om) return null;
  const offset = (om[1] === '-' ? -1 : 1) * (Number(om[2]) * 60 + Number(om[3] ?? 0));
  if (Math.abs(offset) > 18 * 60) return null;
  return instantFromMs(wall - offset * 60_000);
}

/** Instant from a `Date`, or `null` when invalid or out of range. */
export function instantFromDate(date: Date): string | null {
  return instantFromMs(date.getTime());
}

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function wallParts(instant: string, tz: string): WallParts & { offset: number } {
  const ms = Date.parse(instant);
  const offset = zoneOffset(ms, tz);
  const w = new Date(ms + offset * 60_000);
  return {
    year: w.getUTCFullYear(),
    month: w.getUTCMonth() + 1,
    day: w.getUTCDate(),
    hour: w.getUTCHours(),
    minute: w.getUTCMinutes(),
    offset,
  };
}

/** The instant as ISO with `tz`'s offset (`2026-10-25T11:30:00.000+02:00`), for conversions. */
export function instantInZone(instant: string, tz: string): string {
  const ms = Date.parse(instant);
  const offset = zoneOffset(ms, tz);
  const w = new Date(ms + offset * 60_000).toISOString().slice(0, 23);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${w}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function formatDay(year: number, month: number, day: number, fmt: DateFormat, locale?: string) {
  switch (fmt) {
    case 'iso':
      return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
    case 'us':
      return `${month}/${day}/${year}`;
    case 'european':
      return `${day}/${month}/${year}`;
    case 'friendly':
      return `${MONTHS[month - 1]} ${day}, ${year}`;
    case 'local': {
      const d = new Date(0);
      d.setUTCFullYear(year, month - 1, day);
      return new Intl.DateTimeFormat(locale ?? DEFAULT_LOCALE, {
        timeZone: 'UTC',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }).format(d);
    }
  }
}

export function formatDate(value: string, fmt: DateFormat, locale?: string): string {
  const m = DATE_RE.exec(value);
  if (!m) return '';
  return formatDay(Number(m[1]), Number(m[2]), Number(m[3]), fmt, locale);
}

export function formatInstant(
  instant: string,
  tz: string,
  dateFormat: DateFormat,
  timeFormat: TimeFormat,
  locale?: string
): string {
  const p = wallParts(instant, tz);
  const day = formatDay(p.year, p.month, p.day, dateFormat, locale);
  const time =
    timeFormat === '24h'
      ? `${pad(p.hour)}:${pad(p.minute)}`
      : `${p.hour % 12 === 0 ? 12 : p.hour % 12}:${pad(p.minute)} ${p.hour < 12 ? 'AM' : 'PM'}`;
  return `${day} ${time}`;
}

/** The month (1-12) an English name or its abbreviation (3 letters or more) stands for. */
function monthOf(name: string): number | null {
  const n = name.toLowerCase().replace(/\.$/, '');
  if (n.length < 3) return null;
  const i = MONTHS.findIndex((m) => m.toLowerCase().startsWith(n));
  return i < 0 ? null : i + 1;
}

/**
 * Reads a calendar day from a string: ISO (`2026-10-25`, or the date part of an ISO datetime,
 * which keeps that string's local day), `M/D/YYYY` (`D/M/YYYY` when `dayFirst`), or a day with
 * an English month name (`Jan 31, 2026`, `January 31 2026`, `31 Jan 2026`): what `formatDate`
 * writes reads back, so an exported CSV re-imports.
 */
export function parseDate(text: string, dayFirst: boolean): string | null {
  const t = text.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(t);
  if (iso) {
    if (t.length > 10 && parseInstant(t, 'UTC') === null) return null;
    return makeDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }
  const slash = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(t);
  if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    return makeDate(Number(slash[3]), dayFirst ? b : a, dayFirst ? a : b);
  }
  const monthFirst = /^([A-Za-z]{3,9}\.?)\s+(\d{1,2}),?\s+(\d{4})$/.exec(t);
  if (monthFirst) {
    const month = monthOf(monthFirst[1] ?? '');
    return month ? makeDate(Number(monthFirst[3]), month, Number(monthFirst[2])) : null;
  }
  const dayFirstName = /^(\d{1,2})\s+([A-Za-z]{3,9}\.?),?\s+(\d{4})$/.exec(t);
  if (dayFirstName) {
    const month = monthOf(dayFirstName[2] ?? '');
    return month ? makeDate(Number(dayFirstName[3]), month, Number(dayFirstName[1])) : null;
  }
  return null;
}

/**
 * Reads a displayed datetime (`Jan 31, 2026 3:30 PM`, `31/1/2026 15:30`): a day `parseDate`
 * reads, then a 12- or 24-hour time, as a wall-clock time in `tz`.
 */
export function parseDisplayInstant(text: string, dayFirst: boolean, tz: string): string | null {
  const m = /^(.*\S)\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/.exec(text.trim());
  if (!m) return null;
  const day = parseDate(m[1] ?? '', dayFirst);
  if (!day) return null;
  let hour = Number(m[2]);
  const meridiem = m[5]?.toLowerCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === 'pm' ? 12 : 0);
  }
  return parseInstant(`${day}T${pad(hour)}:${m[3]}:${m[4] ?? '00'}`, tz);
}
