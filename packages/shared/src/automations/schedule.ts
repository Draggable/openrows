import { isValidTimeZone, wallToUtc, zoneOffset } from '../fields/datetime.js';

/**
 * Scheduled automation triggers: a cron expression or "every N minutes, hours, days or
 * weeks", both in an IANA time zone. Times are wall-clock times in that zone, so a 09:00 run
 * stays at 09:00 across daylight saving changes:
 *
 * - a wall time the zone skips (spring forward) runs at the same distance past the change, so
 *   01:30 in a 01:00 → 02:00 gap runs at 02:30;
 * - a wall time the zone repeats (fall back) runs once, the first time.
 *
 * Minute and hour intervals are elapsed time from the start (every 2 hours is every 120
 * minutes, whatever the clock says); day and week intervals keep the start's wall time.
 */

/** The shortest gap between two runs a schedule may have. */
export const MIN_SCHEDULE_MINUTES = 5;
/** The largest N of "every N units". */
export const MAX_SCHEDULE_EVERY = 1000;
export const SCHEDULE_UNITS = ['minutes', 'hours', 'days', 'weeks'] as const;
export type ScheduleUnit = (typeof SCHEDULE_UNITS)[number];

export type Schedule =
  | { kind: 'cron'; expression: string; timeZone: string }
  | {
      kind: 'interval';
      every: number;
      unit: ScheduleUnit;
      /** The first run, a wall time in `timeZone` (`YYYY-MM-DDTHH:mm`). */
      startAt: string;
      timeZone: string;
    };

const MINUTE = 60_000;
const DAY = 86_400_000;

interface CronField {
  values: number[];
  /** Not `*` (day of month and day of week combine with OR when both are restricted). */
  restricted: boolean;
}

export interface Cron {
  minutes: CronField;
  hours: CronField;
  days: CronField;
  months: CronField;
  weekdays: CronField;
}

export class CronError extends Error {
  override name = 'CronError';
}

const MONTH_NAMES = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const MACROS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

function parseField(
  text: string,
  name: string,
  min: number,
  max: number,
  names?: readonly string[]
): CronField {
  const values = new Set<number>();
  const num = (s: string): number => {
    const named = names?.indexOf(s.toLowerCase()) ?? -1;
    if (named >= 0) return named + (names === MONTH_NAMES ? 1 : 0);
    if (!/^\d{1,2}$/.test(s)) throw new CronError(`"${s}" isn't a valid ${name}.`);
    return Number(s);
  };
  for (const part of text.split(',')) {
    const m = /^([^/]+)(?:\/(\d{1,3}))?$/.exec(part);
    if (!m?.[1]) throw new CronError(`"${part}" isn't a valid ${name}.`);
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) throw new CronError(`The ${name} step must be at least 1.`);
    let from: number;
    let to: number;
    if (m[1] === '*') {
      from = min;
      to = max;
    } else if (m[1].includes('-')) {
      const [a, b, ...rest] = m[1].split('-');
      if (a === undefined || b === undefined || rest.length) {
        throw new CronError(`"${part}" isn't a valid ${name}.`);
      }
      from = num(a);
      to = num(b);
    } else {
      from = num(m[1]);
      // `5/15`: from 5 to the end, every 15.
      to = m[2] === undefined ? from : max;
    }
    if (from < min || to > max || from > to) {
      throw new CronError(`The ${name} must be between ${min} and ${max}.`);
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return { values: [...values].sort((a, b) => a - b), restricted: !text.startsWith('*') };
}

/** Parses a five-field cron expression (minute hour day-of-month month day-of-week) or a macro. */
export function parseCron(expression: string): Cron {
  const text = MACROS[expression.trim().toLowerCase()] ?? expression.trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) {
    throw new CronError('A cron expression has five fields: minute hour day month weekday.');
  }
  const [mi, h, d, mo, wd] = parts as [string, string, string, string, string];
  const weekdays = parseField(wd, 'day of the week', 0, 7, DAY_NAMES);
  return {
    minutes: parseField(mi, 'minute', 0, 59),
    hours: parseField(h, 'hour', 0, 23),
    days: parseField(d, 'day of the month', 1, 31),
    months: parseField(mo, 'month', 1, 12, MONTH_NAMES),
    // 7 is Sunday too.
    weekdays: {
      restricted: weekdays.restricted,
      values: [...new Set(weekdays.values.map((v) => (v === 7 ? 0 : v)))].sort((a, b) => a - b),
    },
  };
}

/** The shortest gap the minute field allows within an hour (or across the hour), in minutes. */
function shortestMinuteGap(cron: Cron): number {
  const m = cron.minutes.values;
  if (m.length < 2) return 60;
  let gap = 60 - (m[m.length - 1] ?? 0) + (m[0] ?? 0);
  for (let i = 1; i < m.length; i++) gap = Math.min(gap, (m[i] ?? 0) - (m[i - 1] ?? 0));
  return gap;
}

/** Problems with a schedule, as messages; empty when it can be saved. */
export function scheduleProblems(schedule: Schedule): string[] {
  if (!isValidTimeZone(schedule.timeZone)) return ['Unknown time zone.'];
  if (schedule.kind === 'cron') {
    try {
      const cron = parseCron(schedule.expression);
      if (shortestMinuteGap(cron) < MIN_SCHEDULE_MINUTES) {
        return [`A schedule can run at most every ${MIN_SCHEDULE_MINUTES} minutes.`];
      }
      if (nextCronRun(cron, schedule.timeZone, new Date()) === null) {
        return ['This cron expression never runs.'];
      }
    } catch (err) {
      if (err instanceof CronError) return [err.message];
      throw err;
    }
    return [];
  }
  if (!Number.isInteger(schedule.every) || schedule.every < 1) {
    return ['Run every 1 or more units.'];
  }
  if (schedule.every > MAX_SCHEDULE_EVERY)
    return [`Run at most every ${MAX_SCHEDULE_EVERY} units.`];
  if (schedule.unit === 'minutes' && schedule.every < MIN_SCHEDULE_MINUTES) {
    return [`A schedule can run at most every ${MIN_SCHEDULE_MINUTES} minutes.`];
  }
  if (parseWall(schedule.startAt) === null) return ['Start at a date and time (YYYY-MM-DDTHH:mm).'];
  return [];
}

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** `YYYY-MM-DDTHH:mm` as wall ms (the wall time read as UTC), or null. */
function parseWall(text: string): number | null {
  const m = WALL_RE.exec(text);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  t.setUTCHours(h, mi, 0, 0);
  // 2026-02-30 rolls over: refuse it.
  if (t.getUTCDate() !== d || t.getUTCMonth() !== mo - 1) return null;
  return t.getTime();
}

/** The wall time of an instant in `tz`, read as UTC ms. */
function toWall(ms: number, tz: string): number {
  return ms + zoneOffset(ms, tz) * MINUTE;
}

/** Years of days the search looks ahead (Feb 29 on a Monday can be 28 years away). */
const SEARCH_DAYS = 366 * 29;

/** The first run of `cron` in `tz` strictly after `after`, or null if there's none in reach. */
export function nextCronRun(cron: Cron, tz: string, after: Date): Date | null {
  const afterMs = after.getTime();
  // The next whole minute after `after`, as a wall time.
  const startWall = Math.floor(toWall(afterMs, tz) / MINUTE) * MINUTE + MINUTE;
  const firstDay = Math.floor(startWall / DAY) * DAY;
  const months = new Set(cron.months.values);
  const days = new Set(cron.days.values);
  const weekdays = new Set(cron.weekdays.values);
  for (let i = 0; i < SEARCH_DAYS; i++) {
    const day = firstDay + i * DAY;
    const date = new Date(day);
    if (!months.has(date.getUTCMonth() + 1)) continue;
    const dom = days.has(date.getUTCDate());
    const dow = weekdays.has(date.getUTCDay());
    const dayMatches =
      cron.days.restricted && cron.weekdays.restricted
        ? dom || dow
        : (!cron.days.restricted || dom) && (!cron.weekdays.restricted || dow);
    if (!dayMatches) continue;
    for (const h of cron.hours.values) {
      for (const mi of cron.minutes.values) {
        const wall = day + h * 3_600_000 + mi * MINUTE;
        if (wall < startWall) continue;
        const utc = wallToUtc(wall, tz);
        // A repeated wall time already run (its first pass), or a skipped one mapped back.
        if (utc <= afterMs) continue;
        return new Date(utc);
      }
    }
  }
  return null;
}

/** The first run of a schedule strictly after `after` (null: none, or the schedule is invalid). */
export function nextScheduledRun(schedule: Schedule, after: Date): Date | null {
  if (scheduleProblems(schedule).length) return null;
  if (schedule.kind === 'cron') {
    return nextCronRun(parseCron(schedule.expression), schedule.timeZone, after);
  }
  const startWall = parseWall(schedule.startAt);
  if (startWall === null) return null;
  const tz = schedule.timeZone;
  const afterMs = after.getTime();
  const start = wallToUtc(startWall, tz);
  if (schedule.unit === 'minutes' || schedule.unit === 'hours') {
    const step = schedule.every * (schedule.unit === 'minutes' ? MINUTE : 3_600_000);
    if (afterMs < start) return new Date(start);
    return new Date(start + (Math.floor((afterMs - start) / step) + 1) * step);
  }
  // Days and weeks keep the start's wall time: count steps on the wall clock.
  const stepDays = schedule.every * (schedule.unit === 'weeks' ? 7 : 1);
  let k = Math.max(0, Math.floor((afterMs - start) / (stepDays * DAY)) - 1);
  for (;;) {
    const utc = wallToUtc(startWall + k * stepDays * DAY, tz);
    if (utc > afterMs) return new Date(utc);
    k++;
  }
}

/** The next `count` runs after `after`, for previews. */
export function upcomingRuns(schedule: Schedule, after: Date, count: number): Date[] {
  const out: Date[] = [];
  let at = after;
  for (let i = 0; i < count; i++) {
    const next = nextScheduledRun(schedule, at);
    if (!next) break;
    out.push(next);
    at = next;
  }
  return out;
}
