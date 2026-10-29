import { describe, expect, it } from 'vitest';
import {
  CronError,
  nextCronRun,
  nextScheduledRun,
  parseCron,
  type Schedule,
  scheduleProblems,
  upcomingRuns,
} from './schedule.js';

const cron = (expression: string, timeZone: string): Schedule => ({
  kind: 'cron',
  expression,
  timeZone,
});
const runs = (s: Schedule, after: string, n: number) =>
  upcomingRuns(s, new Date(after), n).map((d) => d.toISOString());

describe('parseCron', () => {
  it('reads lists, ranges, steps, names and macros', () => {
    const c = parseCron('*/15 9-17 1,15 jan-mar MON-FRI');
    expect(c.minutes.values).toEqual([0, 15, 30, 45]);
    expect(c.hours.values).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(c.days.values).toEqual([1, 15]);
    expect(c.months.values).toEqual([1, 2, 3]);
    expect(c.weekdays.values).toEqual([1, 2, 3, 4, 5]);
    expect(parseCron('@daily').hours.values).toEqual([0]);
    expect(parseCron('0 0 * * 7').weekdays.values).toEqual([0]);
    expect(parseCron('5/20 * * * *').minutes.values).toEqual([5, 25, 45]);
  });

  it('refuses malformed expressions', () => {
    for (const bad of [
      '* * * *',
      '60 * * * *',
      '* 24 * * *',
      '0 0 0 * *',
      'a b c d e',
      '1-',
      '*/0 * * * *',
      '5-1 * * * *',
    ]) {
      expect(() => parseCron(bad), bad).toThrow(CronError);
    }
  });
});

describe('scheduleProblems', () => {
  it('limits how often a schedule runs and checks the zone and start', () => {
    expect(scheduleProblems(cron('*/5 * * * *', 'UTC'))).toEqual([]);
    expect(scheduleProblems(cron('* * * * *', 'UTC'))[0]).toMatch(/every 5 minutes/);
    expect(scheduleProblems(cron('0,58 * * * *', 'UTC'))[0]).toMatch(/every 5 minutes/);
    expect(scheduleProblems(cron('0 9 * * *', 'Mars/Olympus'))).toEqual(['Unknown time zone.']);
    expect(scheduleProblems(cron('0 0 30 2 *', 'UTC'))).toEqual([
      'This cron expression never runs.',
    ]);
    const every = (
      n: number,
      unit: 'minutes' | 'days',
      startAt = '2026-01-01T09:00'
    ): Schedule => ({
      kind: 'interval',
      every: n,
      unit,
      startAt,
      timeZone: 'UTC',
    });
    expect(scheduleProblems(every(5, 'minutes'))).toEqual([]);
    expect(scheduleProblems(every(4, 'minutes'))[0]).toMatch(/every 5 minutes/);
    expect(scheduleProblems(every(1, 'days', '2026-02-30T09:00'))[0]).toMatch(/Start at/);
    expect(scheduleProblems(every(0, 'days'))[0]).toMatch(/1 or more/);
  });
});

describe('cron next run', () => {
  it('runs strictly after the given instant, on whole minutes', () => {
    expect(runs(cron('*/15 * * * *', 'UTC'), '2026-05-01T10:15:00.000Z', 2)).toEqual([
      '2026-05-01T10:30:00.000Z',
      '2026-05-01T10:45:00.000Z',
    ]);
    expect(runs(cron('*/15 * * * *', 'UTC'), '2026-05-01T10:14:59.999Z', 1)).toEqual([
      '2026-05-01T10:15:00.000Z',
    ]);
  });

  it('combines day of month and day of week with OR when both are set', () => {
    // 2026-06-01 is a Monday; the 13th is a Saturday.
    expect(runs(cron('0 12 13 * 1', 'UTC'), '2026-06-01T13:00:00Z', 3)).toEqual([
      '2026-06-08T12:00:00.000Z',
      '2026-06-13T12:00:00.000Z',
      '2026-06-15T12:00:00.000Z',
    ]);
  });

  it('finds a leap day years ahead', () => {
    expect(nextCronRun(parseCron('0 0 29 2 *'), 'UTC', new Date('2026-03-01T00:00:00Z'))).toEqual(
      new Date('2028-02-29T00:00:00Z')
    );
  });

  describe('Europe/Lisbon (WET/WEST: 2026-03-29 01:00 → 02:00, 2026-10-25 02:00 → 01:00)', () => {
    const tz = 'Europe/Lisbon';

    it('keeps 09:00 local across both changes', () => {
      expect(runs(cron('0 9 * * *', tz), '2026-03-27T12:00:00Z', 3)).toEqual([
        '2026-03-28T09:00:00.000Z',
        '2026-03-29T08:00:00.000Z',
        '2026-03-30T08:00:00.000Z',
      ]);
      expect(runs(cron('0 9 * * *', tz), '2026-10-24T00:00:00Z', 2)).toEqual([
        '2026-10-24T08:00:00.000Z',
        '2026-10-25T09:00:00.000Z',
      ]);
    });

    it('runs a skipped wall time (01:30 on 29 March) just after the change', () => {
      expect(runs(cron('30 1 * * *', tz), '2026-03-28T00:00:00Z', 3)).toEqual([
        '2026-03-28T01:30:00.000Z',
        // 01:30 doesn't exist: 02:30 WEST, the same instant 01:30 WET would have been.
        '2026-03-29T01:30:00.000Z',
        '2026-03-30T00:30:00.000Z',
      ]);
    });

    it('runs a repeated wall time (01:30 on 25 October) once, the first time', () => {
      expect(runs(cron('30 1 * * *', tz), '2026-10-24T12:00:00Z', 2)).toEqual([
        '2026-10-25T00:30:00.000Z',
        '2026-10-26T01:30:00.000Z',
      ]);
      // Asked during the repeated hour, after its first pass: tomorrow.
      expect(runs(cron('30 1 * * *', tz), '2026-10-25T01:10:00Z', 1)).toEqual([
        '2026-10-26T01:30:00.000Z',
      ]);
    });

    it('runs hourly jobs once per wall hour through the repeated hour', () => {
      expect(runs(cron('0 * * * *', tz), '2026-10-24T23:30:00Z', 4)).toEqual([
        '2026-10-25T00:00:00.000Z',
        '2026-10-25T02:00:00.000Z',
        '2026-10-25T03:00:00.000Z',
        '2026-10-25T04:00:00.000Z',
      ]);
      expect(runs(cron('0 * * * *', tz), '2026-03-29T00:30:00Z', 2)).toEqual([
        '2026-03-29T01:00:00.000Z',
        '2026-03-29T02:00:00.000Z',
      ]);
    });
  });

  describe('America/New_York (EST/EDT: 2026-03-08 02:00 → 03:00, 2026-11-01 02:00 → 01:00)', () => {
    const tz = 'America/New_York';

    it('keeps 09:00 local across both changes', () => {
      expect(runs(cron('0 9 * * *', tz), '2026-03-07T12:00:00Z', 2)).toEqual([
        '2026-03-07T14:00:00.000Z',
        '2026-03-08T13:00:00.000Z',
      ]);
      expect(runs(cron('0 9 * * *', tz), '2026-10-31T12:00:00Z', 2)).toEqual([
        '2026-10-31T13:00:00.000Z',
        '2026-11-01T14:00:00.000Z',
      ]);
    });

    it('runs a skipped 02:30 at 03:30 EDT, and a repeated 01:30 once', () => {
      expect(runs(cron('30 2 * * *', tz), '2026-03-07T12:00:00Z', 2)).toEqual([
        '2026-03-08T07:30:00.000Z',
        '2026-03-09T06:30:00.000Z',
      ]);
      expect(runs(cron('30 1 * * *', tz), '2026-10-31T12:00:00Z', 2)).toEqual([
        '2026-11-01T05:30:00.000Z',
        '2026-11-02T06:30:00.000Z',
      ]);
    });

    it('runs weekday mornings across the change', () => {
      // Friday 6 March, then Monday 9 March (EDT).
      expect(runs(cron('0 8 * * 1-5', tz), '2026-03-06T12:00:00Z', 2)).toEqual([
        '2026-03-06T13:00:00.000Z',
        '2026-03-09T12:00:00.000Z',
      ]);
    });
  });
});

describe('interval next run', () => {
  const every = (
    n: number,
    unit: 'minutes' | 'hours' | 'days' | 'weeks',
    startAt: string,
    timeZone: string
  ): Schedule => ({ kind: 'interval', every: n, unit, startAt, timeZone });

  it('starts at the start, then steps', () => {
    const s = every(30, 'minutes', '2026-05-01T10:00', 'UTC');
    expect(runs(s, '2026-04-01T00:00:00Z', 3)).toEqual([
      '2026-05-01T10:00:00.000Z',
      '2026-05-01T10:30:00.000Z',
      '2026-05-01T11:00:00.000Z',
    ]);
    expect(nextScheduledRun(s, new Date('2026-05-03T10:31:00Z'))?.toISOString()).toBe(
      '2026-05-03T11:00:00.000Z'
    );
  });

  it('counts hours as elapsed time across a change (Europe/Lisbon)', () => {
    const s = every(1, 'hours', '2026-10-24T23:00', 'Europe/Lisbon');
    expect(runs(s, '2026-10-24T23:30:00Z', 3)).toEqual([
      '2026-10-25T00:00:00.000Z',
      '2026-10-25T01:00:00.000Z',
      '2026-10-25T02:00:00.000Z',
    ]);
  });

  it('keeps the wall time of day intervals across changes (Europe/Lisbon)', () => {
    const s = every(1, 'days', '2026-03-27T09:00', 'Europe/Lisbon');
    expect(runs(s, '2026-03-27T00:00:00Z', 4)).toEqual([
      '2026-03-27T09:00:00.000Z',
      '2026-03-28T09:00:00.000Z',
      '2026-03-29T08:00:00.000Z',
      '2026-03-30T08:00:00.000Z',
    ]);
    const autumn = every(2, 'days', '2026-10-21T09:00', 'Europe/Lisbon');
    expect(runs(autumn, '2026-10-23T09:00:00Z', 2)).toEqual([
      '2026-10-25T09:00:00.000Z',
      '2026-10-27T09:00:00.000Z',
    ]);
  });

  it('keeps the wall time of week intervals across changes (America/New_York)', () => {
    const s = every(1, 'weeks', '2026-10-20T09:00', 'America/New_York');
    expect(runs(s, '2026-10-21T00:00:00Z', 2)).toEqual([
      '2026-10-27T13:00:00.000Z',
      '2026-11-03T14:00:00.000Z',
    ]);
    // A start in a skipped hour runs just after the change, then at the wall time again.
    const gap = every(1, 'days', '2026-03-08T02:30', 'America/New_York');
    expect(runs(gap, '2026-03-01T00:00:00Z', 2)).toEqual([
      '2026-03-08T07:30:00.000Z',
      '2026-03-09T06:30:00.000Z',
    ]);
  });

  it('is null for invalid schedules', () => {
    expect(nextScheduledRun(every(1, 'days', 'tomorrow', 'UTC'), new Date())).toBeNull();
    expect(nextScheduledRun(cron('nope', 'UTC'), new Date())).toBeNull();
  });
});
