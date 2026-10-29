import {
  type CalendarDateFields,
  type CalendarLayout,
  type CalendarMode,
  type ChoiceColor,
  type FieldMeta,
  type FilterCondition,
  instantInZone,
  isCalendarDateField,
  MAX_CALENDAR_DATE_FIELDS,
  parseInstant,
  type RecordData,
} from '@openrows/shared';
import { choicesOf, fieldDef } from '../../grid/cells/model';

/**
 * The calendar's logic, apart from React: day arithmetic on `YYYY-MM-DD` strings (never a
 * `Date` in the browser's zone, so a date-only value can't shift), the days a layout shows, the
 * events of records (a record per date field pair), how a week's events stack in lanes, and the
 * cell values a drag, a resize or a keyboard move writes. Datetimes sit on their day in the
 * field's time zone and keep their wall-clock time when they move, across DST.
 */

/** Days of the week, Sunday first (Airtable's default week start). */
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
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

const DAY_MS = 86_400_000;
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** `day` moved by `n` days. */
export function addDays(day: string, n: number): string {
  return new Date(dayMs(day) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (negative when `b` is earlier). */
export function daysBetween(a: string, b: string): number {
  return Math.round((dayMs(b) - dayMs(a)) / DAY_MS);
}

/** 0 = Sunday. */
export function weekday(day: string): number {
  return new Date(dayMs(day)).getUTCDay();
}

/** The same day of the month `n` months later, clamped to the month's last day. */
export function addMonths(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}

/** Today in the browser's zone, as a day. */
export function localToday(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The days a layout shows around `anchor`, in weeks (rows): the month's weeks (Sunday to
 * Saturday, 4 to 6 rows), the anchor's week, or the anchor day alone.
 */
export function visibleWeeks(mode: CalendarMode, anchor: string): string[][] {
  if (mode === 'day') return [[anchor]];
  const weekOf = (day: string) => {
    const start = addDays(day, -weekday(day));
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  };
  if (mode === 'week') return [weekOf(anchor)];
  const first = `${anchor.slice(0, 7)}-01`;
  const last = addDays(addMonths(first, 1), -1);
  const weeks: string[][] = [];
  for (let day = first; day <= last; day = addDays(day, 7)) {
    const week = weekOf(day);
    if (week[0] !== weeks.at(-1)?.[0]) weeks.push(week);
  }
  const lastWeek = weeks.at(-1);
  if (lastWeek && (lastWeek[6] ?? '') < last) weeks.push(weekOf(last));
  return weeks;
}

/** The anchor after a "next" or "previous" step of the layout. */
export function stepAnchor(mode: CalendarMode, anchor: string, step: 1 | -1): string {
  if (mode === 'month') return addMonths(`${anchor.slice(0, 7)}-01`, step);
  return addDays(anchor, step * (mode === 'week' ? 7 : 1));
}

/** The toolbar's title: "March 2026", "Mar 1 – 7, 2026" or "Sunday, March 8, 2026". */
export function rangeTitle(mode: CalendarMode, anchor: string): string {
  const [y, m, d] = anchor.split('-').map(Number) as [number, number, number];
  if (mode === 'month') return `${MONTHS[m - 1]} ${y}`;
  if (mode === 'day') {
    const name = new Date(dayMs(anchor)).toLocaleDateString('en-US', {
      weekday: 'long',
      timeZone: 'UTC',
    });
    return `${name}, ${MONTHS[m - 1]} ${d}, ${y}`;
  }
  const week = visibleWeeks('week', anchor)[0] ?? [anchor];
  const a = week[0] ?? anchor;
  const b = week[6] ?? anchor;
  const short = (day: string) => `${MONTHS[Number(day.slice(5, 7)) - 1]?.slice(0, 3)}`;
  const n = (day: string) => Number(day.slice(8, 10));
  if (a.slice(0, 4) !== b.slice(0, 4))
    return `${short(a)} ${n(a)}, ${a.slice(0, 4)} – ${short(b)} ${n(b)}, ${b.slice(0, 4)}`;
  if (a.slice(0, 7) !== b.slice(0, 7)) return `${short(a)} ${n(a)} – ${short(b)} ${n(b)}, ${y}`;
  return `${short(a)} ${n(a)} – ${n(b)}, ${y}`;
}

/** A day as screen readers hear it: "Sunday, March 8, 2026". */
export function dayLabel(day: string): string {
  return rangeTitle('day', day);
}

// ---- fields ------------------------------------------------------------------------------

/** Fields a calendar can place records by, in table order. */
export const dateFieldsOf = (fields: readonly FieldMeta[]) =>
  fields.filter((f) => !f.deletedAt && isCalendarDateField(f));

/** Whether a calendar can write the field (dates and datetimes; not created/modified times). */
export const isEditableDate = (f: FieldMeta) => f.type === 'date' || f.type === 'dateTime';

const zoneOf = (f: FieldMeta) => (fieldDef(f).options as { timeZone?: string }).timeZone ?? 'UTC';
const isZoned = (f: FieldMeta) => f.type !== 'date';

/** The day a value sits on: a date as it is, a datetime's day in the field's zone. */
export function dayOf(field: FieldMeta, value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  if (!isZoned(field)) return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
  try {
    return instantInZone(value, zoneOf(field)).slice(0, 10);
  } catch {
    return null;
  }
}

/** The wall-clock time of a datetime in the field's zone (`HH:mm`), `null` for dates. */
export function timeOf(field: FieldMeta, value: unknown): string | null {
  if (!isZoned(field) || typeof value !== 'string' || value === '') return null;
  try {
    return instantInZone(value, zoneOf(field)).slice(11, 16);
  } catch {
    return null;
  }
}

/**
 * The value moved by `days`: a date's day, or a datetime's day at the same wall-clock time in
 * the field's zone (a time that a DST change skips moves forward, as everywhere else).
 */
export function shiftValue(field: FieldMeta, value: unknown, days: number): string | null {
  const day = dayOf(field, value);
  if (day === null) return null;
  const to = addDays(day, days);
  if (!isZoned(field)) return to;
  const wall = instantInZone(value as string, zoneOf(field)).slice(11, 23);
  return parseInstant(`${to}T${wall}`, zoneOf(field));
}

/** The value a record created on `day` gets: the day, or midnight of it in the field's zone. */
export function valueOnDay(field: FieldMeta, day: string): string | null {
  return isZoned(field) ? parseInstant(day, zoneOf(field)) : day;
}

// ---- events ------------------------------------------------------------------------------

/** Legend colours of the date field pairs, in order (not green: that is the accent's hue). */
export const PAIR_COLORS: readonly ChoiceColor[] = ['blue', 'amber', 'violet', 'teal', 'pink'];

/** One date field pair of the layout, with its fields and legend colour. */
export interface DatePair {
  index: number;
  start: FieldMeta;
  end: FieldMeta | undefined;
  color: ChoiceColor;
}

/** The layout's date field pairs whose fields are live dates (at most five). */
export function datePairsOf(fields: readonly FieldMeta[], layout: CalendarLayout): DatePair[] {
  const byId = new Map(dateFieldsOf(fields).map((f) => [f.id, f]));
  return (layout.dateFields ?? []).slice(0, MAX_CALENDAR_DATE_FIELDS).flatMap((d, index) => {
    const start = byId.get(d.startFieldId);
    if (!start) return [];
    const end = d.endFieldId ? byId.get(d.endFieldId) : undefined;
    return [{ index, start, end, color: PAIR_COLORS[index % PAIR_COLORS.length] ?? 'blue' }];
  });
}

/** What the view query's `dateRange` names. */
export const rangeFieldsOf = (pairs: readonly DatePair[]): CalendarDateFields[] =>
  pairs.map((p) => ({ startFieldId: p.start.id, endFieldId: p.end?.id ?? null }));

/** The records without a start date in any pair: the "undated" side panel's condition. */
export const undatedWithin = (pairs: readonly DatePair[]): FilterCondition[] =>
  pairs.map((p) => ({ fieldId: p.start.id, operator: 'isEmpty' }));

export interface CalendarEvent {
  /** `<recordId>:<pair index>`. */
  key: string;
  record: RecordData;
  pair: DatePair;
  start: string;
  /** Inclusive; `start` for one-day events. */
  end: string;
  /** Start time (datetimes), shown before the title. */
  time: string | null;
  color: ChoiceColor;
  /** Whether a drag, a resize or the keyboard may move it. */
  movable: boolean;
  resizable: boolean;
}

/**
 * The events of records: one per record and date pair whose start is set. An end before the
 * start (or none) makes a one-day event. The colour is the record's choice of `colorField`
 * (slate when it has none), else the pair's legend colour.
 */
export function eventsOf(
  records: readonly RecordData[],
  pairs: readonly DatePair[],
  colorField: FieldMeta | undefined
): CalendarEvent[] {
  const choices = new Map(colorField ? choicesOf(colorField).map((c) => [c.id, c]) : []);
  const events: CalendarEvent[] = [];
  for (const record of records) {
    for (const pair of pairs) {
      const start = dayOf(pair.start, record.fields[pair.start.id]);
      if (!start) continue;
      const endDay = pair.end ? dayOf(pair.end, record.fields[pair.end.id]) : null;
      const end = endDay && endDay > start ? endDay : start;
      const choice = colorField ? choices.get(String(record.fields[colorField.id])) : undefined;
      const movable = isEditableDate(pair.start) && (!pair.end || isEditableDate(pair.end));
      events.push({
        key: `${record.id}:${pair.index}`,
        record,
        pair,
        start,
        end,
        time: timeOf(pair.start, record.fields[pair.start.id]),
        color: colorField ? (choice?.color ?? 'slate') : pair.color,
        movable,
        resizable: movable && pair.end !== undefined,
      });
    }
  }
  return events.sort(
    (a, b) =>
      a.start.localeCompare(b.start) ||
      daysBetween(b.start, b.end) - daysBetween(a.start, a.end) ||
      (a.time ?? '').localeCompare(b.time ?? '') ||
      a.key.localeCompare(b.key)
  );
}

/** An event's piece in one week row: its first column, how many days it covers, its lane. */
export interface Segment {
  event: CalendarEvent;
  col: number;
  span: number;
  lane: number;
  /** Whether the event goes on before this row's first day or after its last. */
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/**
 * Lays a row of days out: each event that meets the row gets a segment in the first lane free
 * over its days (longer events first, as `eventsOf` sorts them).
 */
export function layoutRow(events: readonly CalendarEvent[], days: readonly string[]): Segment[] {
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) return [];
  const lanes: boolean[][] = [];
  const out: Segment[] = [];
  for (const event of events) {
    if (event.end < first || event.start > last) continue;
    const col = Math.max(0, daysBetween(first, event.start));
    const endCol = Math.min(days.length - 1, daysBetween(first, event.end));
    const span = endCol - col + 1;
    let lane = 0;
    for (; ; lane++) {
      const used = lanes[lane] ?? [];
      lanes[lane] = used;
      let free = true;
      for (let c = col; c <= endCol; c++) if (used[c]) free = false;
      if (free) {
        for (let c = col; c <= endCol; c++) used[c] = true;
        break;
      }
    }
    out.push({
      event,
      col,
      span,
      lane,
      continuesBefore: event.start < first,
      continuesAfter: event.end > last,
    });
  }
  return out;
}

/** The fields a move by `days` writes: the start and the end, so the event keeps its length. */
export function movePatch(event: CalendarEvent, days: number): Record<string, unknown> | null {
  if (!event.movable || days === 0) return null;
  const { pair, record } = event;
  const patch: Record<string, unknown> = {
    [pair.start.id]: shiftValue(pair.start, record.fields[pair.start.id], days),
  };
  if (pair.end) {
    const end = record.fields[pair.end.id];
    if (dayOf(pair.end, end) !== null) patch[pair.end.id] = shiftValue(pair.end, end, days);
  }
  return patch;
}

/**
 * The fields a resize to `endDay` writes: the end field's new day (a datetime keeps its time,
 * or the start's time when it had no end), never before the start.
 */
export function resizePatch(event: CalendarEvent, endDay: string): Record<string, unknown> | null {
  const { pair, record } = event;
  if (!event.resizable || !pair.end) return null;
  const to = endDay < event.start ? event.start : endDay;
  if (to === event.end) return null;
  const current = record.fields[pair.end.id];
  const days = daysBetween(event.end, to);
  // A real end moves; a missing one (or one before the start) starts from the start's value.
  if (event.end !== event.start && dayOf(pair.end, current) !== null) {
    return { [pair.end.id]: shiftValue(pair.end, current, days) };
  }
  const startValue = record.fields[pair.start.id];
  const value =
    isZoned(pair.end) && isZoned(pair.start)
      ? shiftValue(pair.start, startValue, daysBetween(event.start, to))
      : valueOnDay(pair.end, to);
  return { [pair.end.id]: value };
}

/**
 * What an Alt+arrow key does to a focused event: Left/Right move it a day, Up/Down a week (a
 * day in the day layout); with Shift, Left/Right shorten or lengthen a range by a day.
 */
export function keyboardChange(
  key: string,
  shift: boolean,
  mode: CalendarMode
): { kind: 'move'; days: number } | { kind: 'resize'; days: number } | null {
  const horizontal = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0;
  if (shift) return horizontal ? { kind: 'resize', days: horizontal } : null;
  if (horizontal) return { kind: 'move', days: horizontal };
  const vertical = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0;
  if (!vertical) return null;
  return { kind: 'move', days: vertical * (mode === 'day' ? 1 : 7) };
}
