import type {
  FieldMeta,
  LinkItem,
  RecordData,
  TimelineLayout,
  TimelineScale,
} from '@openrows/shared';
import { choicesOf } from '../../grid/cells/model';
import {
  addDays,
  addMonths,
  type CalendarEvent,
  type DatePair,
  dayOf,
  daysBetween,
  eventsOf,
  shiftValue,
  weekday,
} from '../calendar/model';

/**
 * The timeline's logic, apart from React: the window of days a zoom level shows, the
 * ticks of its header, the bars of records (the calendar's events, so moves and resizes
 * write the same values), grouping by a single select, and the dependency arrows of a Gantt
 * chart (a link field to the same table: a record waits for the records it links to).
 */

/** Pixels per day and days shown per zoom level (every window stays under the query's 400). */
export const SCALES: Record<TimelineScale, { px: number; days: number; step: number }> = {
  day: { px: 44, days: 42, step: 7 },
  week: { px: 14, days: 112, step: 28 },
  month: { px: 4, days: 366, step: 91 },
};

/** The first day of the window around `anchor`: a week before its Sunday, or its month's start. */
export function windowStart(scale: TimelineScale, anchor: string): string {
  const sunday = addDays(anchor, -weekday(anchor));
  if (scale === 'day') return addDays(sunday, -7);
  if (scale === 'week') return addDays(sunday, -28);
  return addMonths(`${anchor.slice(0, 8)}01`, -2);
}

/** The window's days, first and last (inclusive). */
export function windowOf(scale: TimelineScale, anchor: string): { from: string; to: string } {
  const from = windowStart(scale, anchor);
  return { from, to: addDays(from, SCALES[scale].days - 1) };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (day: string) => MONTHS[Number(day.slice(5, 7)) - 1] ?? '';

export interface Tick {
  day: string;
  /** Days from the window's start. */
  offset: number;
  label: string;
}

/**
 * The header of a window: the top band (months, or years at the month scale) and the bottom
 * one (days, weeks starting Sunday, or months).
 */
export function ticksOf(scale: TimelineScale, from: string, days: number) {
  const top: Tick[] = [];
  const bottom: Tick[] = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(from, i);
    const dom = day.slice(8, 10);
    if (scale === 'month') {
      if (dom === '01' || i === 0) bottom.push({ day, offset: i, label: monthName(day) });
      if (day.slice(5) === '01-01' || i === 0) top.push({ day, offset: i, label: day.slice(0, 4) });
      continue;
    }
    if (dom === '01' || i === 0) {
      top.push({ day, offset: i, label: `${monthName(day)} ${day.slice(0, 4)}` });
    }
    if (scale === 'day') bottom.push({ day, offset: i, label: String(Number(dom)) });
    else if (weekday(day) === 0) {
      bottom.push({ day, offset: i, label: `${monthName(day)} ${Number(dom)}` });
    }
  }
  return { top, bottom };
}

/** Fields a timeline can group or colour by. */
export const singleSelectsOf = (fields: readonly FieldMeta[]) =>
  fields.filter((f) => !f.deletedAt && f.type === 'singleSelect');

/** Links to records of the same table: what a Gantt chart's dependencies can be. */
export const selfLinksOf = (fields: readonly FieldMeta[], tableId: string) =>
  fields.filter(
    (f) =>
      !f.deletedAt &&
      f.type === 'link' &&
      (f.options as { linkedTableId?: unknown }).linkedTableId === tableId
  );

/** The layout's date pair, as the calendar model knows it, or `null` without a start field. */
export function timelinePair(
  fields: readonly FieldMeta[],
  layout: TimelineLayout,
  isDate: (f: FieldMeta) => boolean
): DatePair | null {
  const live = fields.filter((f) => !f.deletedAt && isDate(f));
  const start = live.find((f) => f.id === layout.startFieldId);
  if (!start) return null;
  const end = live.find((f) => f.id === layout.endFieldId && f.id !== start.id);
  return { index: 0, start, end, color: 'blue' };
}

/** One row of the timeline: a group header or a record's bar. */
export type TimelineRow =
  | { kind: 'group'; key: string; label: string; count: number; color?: string }
  | { kind: 'bar'; event: CalendarEvent };

/**
 * The rows of the bars: by start (as `eventsOf` sorts them), under a header per choice of the
 * group field (in choice order, the empty group first) when there is one.
 */
export function rowsOf(
  records: readonly RecordData[],
  pair: DatePair,
  colorField: FieldMeta | undefined,
  groupField: FieldMeta | undefined
): TimelineRow[] {
  const events = eventsOf(records, [pair], colorField);
  if (!groupField) return events.map((event) => ({ kind: 'bar', event }));
  const choices = choicesOf(groupField);
  const groups: { key: string; label: string; color?: string }[] = [
    { key: '', label: 'Uncategorized' },
    ...choices.map((c) => ({ key: c.id, label: c.name, color: c.color })),
  ];
  const known = new Set(choices.map((c) => c.id));
  const keyOf = (e: CalendarEvent) => {
    const v = e.record.fields[groupField.id];
    return typeof v === 'string' && known.has(v) ? v : '';
  };
  return groups.flatMap((g) => {
    const mine = events.filter((e) => keyOf(e) === g.key);
    if (mine.length === 0) return [];
    return [
      { kind: 'group' as const, ...g, count: mine.length },
      ...mine.map((event) => ({ kind: 'bar' as const, event })),
    ];
  });
}

/**
 * The fields a drag of a bar's start edge to `startDay` writes: the start's new day (never
 * after the end; a bar without an end can't be resized from its start).
 */
export function startResizePatch(
  event: CalendarEvent,
  startDay: string
): Record<string, unknown> | null {
  const { pair, record } = event;
  if (!event.resizable || !pair.end) return null;
  const to = startDay > event.end ? event.end : startDay;
  if (to === event.start) return null;
  return {
    [pair.start.id]: shiftValue(
      pair.start,
      record.fields[pair.start.id],
      daysBetween(event.start, to)
    ),
  };
}

/** A bar's geometry in the window (px), or `null` when it lies outside. */
export function barBox(
  event: { start: string; end: string },
  from: string,
  days: number,
  px: number
): { left: number; width: number; clippedStart: boolean; clippedEnd: boolean } | null {
  const startCol = daysBetween(from, event.start);
  const endCol = daysBetween(from, event.end);
  if (endCol < 0 || startCol >= days) return null;
  const a = Math.max(0, startCol);
  const b = Math.min(days - 1, endCol);
  return {
    left: a * px,
    width: (b - a + 1) * px,
    clippedStart: startCol < 0,
    clippedEnd: endCol >= days,
  };
}

/** Linked record ids of a link cell. */
export function linkedIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    item && typeof (item as LinkItem).id === 'string' ? [(item as LinkItem).id] : []
  );
}

export interface Dependency {
  from: string;
  to: string;
  /** The record starts before the one it waits for ends. */
  conflict: boolean;
}

/**
 * The dependency arrows among the bars: from each record a bar's dependency field links to
 * (when it has a bar too) to that bar.
 */
export function dependenciesOf(
  events: readonly CalendarEvent[],
  dependencyField: FieldMeta | undefined
): Dependency[] {
  if (!dependencyField) return [];
  const byId = new Map(events.map((e) => [e.record.id, e]));
  const out: Dependency[] = [];
  for (const e of events) {
    for (const id of linkedIds(e.record.fields[dependencyField.id])) {
      const before = byId.get(id);
      if (!before || before === e) continue;
      out.push({ from: id, to: e.record.id, conflict: e.start <= before.end });
    }
  }
  return out;
}

/** The day under `x` px of the window. */
export const dayAt = (from: string, x: number, px: number) => addDays(from, Math.floor(x / px));

/** Whether a value sits on a day (an empty end is fine). */
export const hasDay = (field: FieldMeta, value: unknown) => dayOf(field, value) !== null;

/** The size of an arrow head (px): a path whose end is closer than this to an edge gets none. */
export const ARROW_HEAD = 6;

/**
 * A dependency arrow from the end of one bar (`x1`, `y1`) to the start of another (`x2`, `y2`),
 * clipped to the visible part of the canvas (`minX` to `maxX`: right of the sticky label column,
 * inside the window), so no part of it is ever drawn over the labels. `null` when both ends lie
 * outside or nothing of it is left; `arrow` when its end (and head) is inside.
 */
export function dependencyPath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  minX: number,
  maxX: number
): { d: string; arrow: boolean } | null {
  const inside = (x: number) => x >= minX && x <= maxX;
  if (!inside(x1) && !inside(x2)) return null;
  // Straight down and across when there is room, else around the bar's start.
  const points: [number, number][] =
    x2 - 8 >= x1 + 8
      ? [
          [x1, y1],
          [x1 + 8, y1],
          [x1 + 8, y2],
          [x2, y2],
        ]
      : [
          [x1, y1],
          [x1 + 8, y1],
          [x1 + 8, (y1 + y2) / 2],
          [x2 - 8, (y1 + y2) / 2],
          [x2 - 8, y2],
          [x2, y2],
        ];
  let d = '';
  let pen: [number, number] | null = null;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1] as [number, number];
    const [bx, by] = points[i] as [number, number];
    let from: [number, number];
    let to: [number, number];
    if (ax === bx) {
      // Vertical: kept whole or dropped.
      if (!inside(ax)) continue;
      from = [ax, ay];
      to = [bx, by];
    } else {
      // Horizontal: trimmed to the visible range.
      const lo = Math.max(Math.min(ax, bx), minX);
      const hi = Math.min(Math.max(ax, bx), maxX);
      if (lo > hi) continue;
      from = ax < bx ? [lo, ay] : [hi, ay];
      to = ax < bx ? [hi, by] : [lo, by];
    }
    if (!pen || pen[0] !== from[0] || pen[1] !== from[1]) d += `M${from[0]},${from[1]} `;
    d += `L${to[0]},${to[1]} `;
    pen = to;
  }
  if (!d) return null;
  return { d: d.trim(), arrow: x2 - ARROW_HEAD >= minX && x2 <= maxX };
}

/** Roughly how wide a bar's title is at the small text size (px), padding included. */
export const titleWidth = (title: string) => title.length * 7 + 12;

/**
 * Where a bar shows its title: inside when it fits, else to the right of the bar (`gap` px
 * away, as Airtable does) when there is room before the window's end, else inside, truncated.
 */
export function titlePlacement(
  title: string,
  box: { left: number; width: number },
  canvasWidth: number,
  gap = 6
): 'inside' | 'outside' {
  if (titleWidth(title) <= box.width) return 'inside';
  return box.left + box.width + gap + titleWidth(title) <= canvasWidth ? 'outside' : 'inside';
}
