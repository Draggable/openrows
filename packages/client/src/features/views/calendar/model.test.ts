import type { FieldMeta, RecordData } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  type CalendarEvent,
  dateFieldsOf,
  datePairsOf,
  dayOf,
  eventsOf,
  keyboardChange,
  layoutRow,
  movePatch,
  rangeFieldsOf,
  rangeTitle,
  resizePatch,
  shiftValue,
  stepAnchor,
  timeOf,
  undatedWithin,
  valueOnDay,
  visibleWeeks,
} from './model';

const field = (id: string, type: string, options: unknown = {}): FieldMeta =>
  ({
    id,
    tableId: 't',
    name: id,
    type,
    options,
    description: null,
    isPrimary: false,
    position: 1,
    deletedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }) as unknown as FieldMeta;

const start = field('start', 'date');
const end = field('end', 'date');
const due = field('due', 'dateTime', { timeZone: 'America/New_York' });
const created = field('created', 'createdTime');
const name = field('name', 'singleLineText');
const stage = field('stage', 'singleSelect', {
  choices: [{ id: 'a', name: 'A', color: 'red' }],
});
const record = (id: string, fields: Record<string, unknown>): RecordData =>
  ({ id, tableId: 't', version: 1, fields }) as unknown as RecordData;

describe('days', () => {
  it('does day arithmetic on strings, across months, years and leap days', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    // No DST in day arithmetic: the browser's zone never takes part.
    expect(addDays('2026-03-07', 2)).toBe('2026-03-09');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15');
  });

  it('shows whole weeks for a month, a week and a single day', () => {
    const march = visibleWeeks('month', '2026-03-18');
    expect(march[0]?.[0]).toBe('2026-03-01');
    expect(march.at(-1)?.at(-1)).toBe('2026-04-04');
    expect(march).toHaveLength(5);
    // February 2026 starts on a Sunday and fits four weeks.
    expect(visibleWeeks('month', '2026-02-10')).toHaveLength(4);
    // August 2026 needs six.
    expect(visibleWeeks('month', '2026-08-10')).toHaveLength(6);
    expect(visibleWeeks('week', '2026-03-18')).toEqual([
      [
        '2026-03-15',
        '2026-03-16',
        '2026-03-17',
        '2026-03-18',
        '2026-03-19',
        '2026-03-20',
        '2026-03-21',
      ],
    ]);
    expect(visibleWeeks('day', '2026-03-18')).toEqual([['2026-03-18']]);
  });

  it('steps and titles each layout', () => {
    expect(stepAnchor('month', '2026-03-31', 1)).toBe('2026-04-01');
    expect(stepAnchor('week', '2026-03-31', -1)).toBe('2026-03-24');
    expect(stepAnchor('day', '2026-03-31', 1)).toBe('2026-04-01');
    expect(rangeTitle('month', '2026-03-18')).toBe('March 2026');
    expect(rangeTitle('week', '2026-03-18')).toBe('Mar 15 – 21, 2026');
    expect(rangeTitle('week', '2026-04-01')).toBe('Mar 29 – Apr 4, 2026');
    expect(rangeTitle('week', '2026-12-31')).toBe('Dec 27, 2026 – Jan 2, 2027');
    expect(rangeTitle('day', '2026-03-08')).toBe('Sunday, March 8, 2026');
  });
});

describe('time zones', () => {
  it('keeps date-only values as they are', () => {
    expect(dayOf(start, '2026-03-08')).toBe('2026-03-08');
    expect(timeOf(start, '2026-03-08')).toBeNull();
    expect(shiftValue(start, '2026-03-08', 1)).toBe('2026-03-09');
    expect(valueOnDay(start, '2026-03-08')).toBe('2026-03-08');
  });

  it("places datetimes on their day in the field's zone", () => {
    // 04:30 UTC is 23:30 the evening before in New York.
    expect(dayOf(due, '2026-03-08T04:30:00.000Z')).toBe('2026-03-07');
    expect(timeOf(due, '2026-03-08T04:30:00.000Z')).toBe('23:30');
    expect(dayOf(field('utc', 'dateTime'), '2026-03-08T04:30:00.000Z')).toBe('2026-03-08');
  });

  it('keeps the wall-clock time when a datetime moves across DST', () => {
    // 09:00 EST (14:00 UTC) on March 7, moved a day: 09:00 EDT (13:00 UTC) on March 8.
    expect(shiftValue(due, '2026-03-07T14:00:00.000Z', 1)).toBe('2026-03-08T13:00:00.000Z');
    // And back over the fall change: 09:00 EDT on October 31 → 09:00 EST on November 1.
    expect(shiftValue(due, '2026-10-31T13:00:00.000Z', 1)).toBe('2026-11-01T14:00:00.000Z');
    // 02:30 doesn't exist on March 8 in New York: it resolves forward to 03:30 EDT.
    expect(shiftValue(due, '2026-03-07T07:30:00.000Z', 1)).toBe('2026-03-08T07:30:00.000Z');
    expect(valueOnDay(due, '2026-03-08')).toBe('2026-03-08T05:00:00.000Z');
    expect(valueOnDay(due, '2026-07-01')).toBe('2026-07-01T04:00:00.000Z');
  });
});

describe('events', () => {
  const fields = [name, start, end, due, created, stage];
  const pairs = datePairsOf(fields, {
    dateFields: [
      { startFieldId: 'start', endFieldId: 'end' },
      { startFieldId: 'due' },
      { startFieldId: 'name' },
      { startFieldId: 'created' },
    ],
  });

  it('pairs only date fields, each in a legend colour', () => {
    expect(dateFieldsOf(fields).map((f) => f.id)).toEqual(['start', 'end', 'due', 'created']);
    expect(pairs.map((p) => [p.start.id, p.end?.id, p.color])).toEqual([
      ['start', 'end', 'blue'],
      ['due', undefined, 'amber'],
      ['created', undefined, 'teal'],
    ]);
    expect(rangeFieldsOf(pairs)).toEqual([
      { startFieldId: 'start', endFieldId: 'end' },
      { startFieldId: 'due', endFieldId: null },
      { startFieldId: 'created', endFieldId: null },
    ]);
    expect(undatedWithin(pairs).map((c) => c.operator)).toEqual(['isEmpty', 'isEmpty', 'isEmpty']);
  });

  it('makes an event per record and pair with a start; ends before starts are one day', () => {
    const events = eventsOf(
      [
        record('r1', { start: '2026-03-02', end: '2026-03-04', due: '2026-03-03T14:00:00.000Z' }),
        record('r2', { start: '2026-03-05', end: '2026-03-01' }),
        record('r3', { end: '2026-03-05', created: '2026-03-01T10:00:00.000Z' }),
      ],
      pairs,
      undefined
    );
    expect(events.map((e) => [e.key, e.start, e.end, e.time, e.movable, e.resizable])).toEqual([
      ['r3:3', '2026-03-01', '2026-03-01', '10:00', false, false],
      ['r1:0', '2026-03-02', '2026-03-04', null, true, true],
      ['r1:1', '2026-03-03', '2026-03-03', '09:00', true, false],
      ['r2:0', '2026-03-05', '2026-03-05', null, true, true],
    ]);
  });

  it('colours events by the choice of the colour field', () => {
    const [a, b] = eventsOf(
      [record('r1', { start: '2026-03-02', stage: 'a' }), record('r2', { start: '2026-03-03' })],
      pairs.slice(0, 1),
      stage
    );
    expect([a?.color, b?.color]).toEqual(['red', 'slate']);
  });

  it('lays events out in lanes per week row, continuing over row ends', () => {
    const week = visibleWeeks('week', '2026-03-04')[0] ?? [];
    const events = eventsOf(
      [
        record('long', { start: '2026-02-27', end: '2026-03-03' }),
        record('mid', { start: '2026-03-02', end: '2026-03-10' }),
        record('one', { start: '2026-03-01' }),
        record('later', { start: '2026-03-05' }),
      ],
      pairs.slice(0, 1),
      undefined
    );
    const rows = layoutRow(events, week).map((s) => [
      s.event.record.id,
      s.col,
      s.span,
      s.lane,
      s.continuesBefore,
      s.continuesAfter,
    ]);
    expect(rows).toEqual([
      ['long', 0, 3, 0, true, false],
      ['one', 0, 1, 1, false, false],
      ['mid', 1, 6, 1, false, true],
      ['later', 4, 1, 0, false, false],
    ]);
  });
});

describe('moves and resizes', () => {
  const pairs = datePairsOf([start, end, due], {
    dateFields: [{ startFieldId: 'start', endFieldId: 'end' }, { startFieldId: 'due' }],
  });
  const eventFor = (fields: Record<string, unknown>, pair = 0): CalendarEvent => {
    const e = eventsOf([record('r', fields)], pairs, undefined).find((x) => x.pair.index === pair);
    if (!e) throw new Error('no event');
    return e;
  };

  it('moves the start and end together', () => {
    expect(movePatch(eventFor({ start: '2026-03-02', end: '2026-03-04' }), 3)).toEqual({
      start: '2026-03-05',
      end: '2026-03-07',
    });
    expect(movePatch(eventFor({ start: '2026-03-02' }), -2)).toEqual({ start: '2026-02-28' });
    expect(movePatch(eventFor({ start: '2026-03-02' }), 0)).toBeNull();
    expect(movePatch(eventFor({ due: '2026-03-07T14:00:00.000Z' }, 1), 1)).toEqual({
      due: '2026-03-08T13:00:00.000Z',
    });
  });

  it('resizes the end, never before the start', () => {
    const e = eventFor({ start: '2026-03-02', end: '2026-03-04' });
    expect(resizePatch(e, '2026-03-06')).toEqual({ end: '2026-03-06' });
    expect(resizePatch(e, '2026-02-01')).toEqual({ end: '2026-03-02' });
    expect(resizePatch(e, '2026-03-04')).toBeNull();
    // Without an end yet, the end starts from the start's day.
    expect(resizePatch(eventFor({ start: '2026-03-02' }), '2026-03-03')).toEqual({
      end: '2026-03-03',
    });
    // A pair without an end field can't be resized.
    expect(resizePatch(eventFor({ due: '2026-03-07T14:00:00.000Z' }, 1), '2026-03-09')).toBeNull();
  });

  it('maps Alt+arrow keys to moves and Shift to resizes', () => {
    expect(keyboardChange('ArrowRight', false, 'month')).toEqual({ kind: 'move', days: 1 });
    expect(keyboardChange('ArrowUp', false, 'month')).toEqual({ kind: 'move', days: -7 });
    expect(keyboardChange('ArrowDown', false, 'day')).toEqual({ kind: 'move', days: 1 });
    expect(keyboardChange('ArrowLeft', true, 'week')).toEqual({ kind: 'resize', days: -1 });
    expect(keyboardChange('ArrowUp', true, 'week')).toBeNull();
    expect(keyboardChange('Enter', false, 'week')).toBeNull();
  });
});
